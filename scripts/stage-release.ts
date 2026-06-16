import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import YAML from "yaml";

type JsonObject = Record<string, unknown>;

type PackageJson = {
  name: string;
  version?: string;
  private?: boolean;
  type?: string;
  main?: string;
  types?: string;
  exports?: unknown;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type WorkspacePackage = {
  name: string;
  relativeDir: string;
  absoluteDir: string;
  packageJson: PackageJson;
};

export type ReleaseManifest = {
  schemaVersion: 1;
  version: string;
  entrypoint: string;
  dashboardDist: string;
  installCommand: string;
  packages: Array<{ name: string; path: string }>;
  vendoredRuntimeDependencies: Array<{ name: string; path: string }>;
  externalDependencies: string[];
  nativeDependencies: string[];
};

export type StageReleaseOptions = {
  workspaceRoot?: string;
  outputRoot?: string;
  releaseName?: string;
  version?: string;
  force?: boolean;
  archive?: boolean;
};

export type StagedRelease = {
  releaseDir: string;
  archivePath?: string;
  manifest: ReleaseManifest;
};

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const defaultWorkspaceRoot = path.resolve(path.dirname(scriptPath), "..");
const packageSearchRoots = ["apps", "packages", "extensions", "vendor"];
const releaseEntrypoint = "bin/lorenz";
const dashboardDist = "apps/lorenz-dashboard/dist";
const nativeDependencyNames = new Set(["better-sqlite3"]);

type VendoredRuntimeDependency = {
  packageName: string;
  dependentPackage: string;
  targetDir: string;
};

// Some external dependencies are dependency-free JS whose only heavy payload is platform-specific
// prebuilt agent binaries shipped as optionalDependencies (hundreds of MB each). We vendor that JS
// into the release with the optional binaries stripped, then point the CLI at the host's own
// claude/codex (see hostBinaries below). This keeps the install small and deterministic across npx,
// mise, and manual installs without depending on install flags or npm overrides (which npm only
// honours for the root project, not for a package installed as a dependency).
const vendoredRuntimeDependencies: VendoredRuntimeDependency[] = [
  {
    packageName: "@anthropic-ai/claude-agent-sdk",
    dependentPackage: "@agentclientprotocol/claude-agent-acp",
    targetDir: "runtime-deps/anthropic-claude-agent-sdk",
  },
  {
    packageName: "@openai/codex",
    dependentPackage: "@agentclientprotocol/codex-acp",
    targetDir: "runtime-deps/openai-codex",
  },
];

const vendoredRuntimeDependencyTargets = new Map(
  vendoredRuntimeDependencies.map((dependency) => [dependency.packageName, dependency.targetDir]),
);

export async function stageRelease(options: StageReleaseOptions = {}): Promise<StagedRelease> {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? defaultWorkspaceRoot);
  const allPackages = await readWorkspacePackages(workspaceRoot);
  const cliPackage = allPackages.get("@lorenz/cli");
  if (!cliPackage) {
    throw new Error("Cannot stage CLI release: @lorenz/cli package was not found.");
  }

  const version = options.version ?? cliPackage.packageJson.version ?? "0.0.0";
  const releaseName = options.releaseName ?? `lorenz-v${version}`;
  const outputRoot = path.resolve(
    options.outputRoot ?? path.join(workspaceRoot, "dist", "release"),
  );
  const releaseDir = path.join(outputRoot, releaseName);
  const catalog = await readDefaultCatalog(workspaceRoot);
  const packages = resolvePackageClosure(cliPackage, allPackages);
  const releasePackages = [...packages.values()].sort((left, right) =>
    left.relativeDir.localeCompare(right.relativeDir),
  );

  await assertRequiredBuildOutputs(workspaceRoot, releasePackages);
  await prepareOutputDir(releaseDir, Boolean(options.force));

  for (const workspacePackage of releasePackages) {
    await stageWorkspacePackage(releaseDir, workspacePackage, packages, catalog);
  }

  await stageVendoredRuntimeDependencies(releaseDir, allPackages);

  await copyDirectory(
    path.join(workspaceRoot, dashboardDist),
    path.join(releaseDir, dashboardDist),
  );

  const externalDependencies = collectExternalDependencies(releasePackages, catalog);
  await writeRootPackageJson(releaseDir, version, releasePackages, externalDependencies);
  await writeEntrypoint(releaseDir);
  await copyReleaseMetadata(workspaceRoot, releaseDir);

  const manifest = releaseManifest(version, releasePackages, externalDependencies);
  await writeJson(path.join(releaseDir, "RELEASE-MANIFEST.json"), manifest);

  const archivePath = options.archive
    ? await createArchive(outputRoot, releaseName, releaseDir, Boolean(options.force))
    : undefined;

  return archivePath ? { releaseDir, archivePath, manifest } : { releaseDir, manifest };
}

async function readWorkspacePackages(
  workspaceRoot: string,
): Promise<Map<string, WorkspacePackage>> {
  const packages = new Map<string, WorkspacePackage>();

  for (const searchRoot of packageSearchRoots) {
    const absoluteSearchRoot = path.join(workspaceRoot, searchRoot);
    const entries = await fs.readdir(absoluteSearchRoot, { withFileTypes: true }).catch((error) => {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const relativeDir = path.posix.join(searchRoot, entry.name);
      const absoluteDir = path.join(workspaceRoot, relativeDir);
      const packagePath = path.join(absoluteDir, "package.json");
      const packageJson = await readJson<PackageJson>(packagePath).catch((error) => {
        if (isNodeError(error) && error.code === "ENOENT") return null;
        throw error;
      });
      if (!packageJson) continue;

      packages.set(packageJson.name, {
        name: packageJson.name,
        relativeDir,
        absoluteDir,
        packageJson,
      });
    }
  }

  return packages;
}

async function readDefaultCatalog(workspaceRoot: string): Promise<Record<string, string>> {
  const workspaceYaml = YAML.parse(
    await fs.readFile(path.join(workspaceRoot, "pnpm-workspace.yaml"), "utf8"),
  ) as { catalog?: Record<string, string> } | null;

  return workspaceYaml?.catalog ?? {};
}

function resolvePackageClosure(
  rootPackage: WorkspacePackage,
  allPackages: Map<string, WorkspacePackage>,
): Map<string, WorkspacePackage> {
  const selected = new Map<string, WorkspacePackage>();
  const pending = [rootPackage];

  for (const workspacePackage of pending) {
    if (selected.has(workspacePackage.name)) continue;

    selected.set(workspacePackage.name, workspacePackage);

    for (const [dependencyName, specifier] of Object.entries(
      workspacePackage.packageJson.dependencies ?? {},
    )) {
      if (!specifier.startsWith("workspace:")) continue;

      const dependency = allPackages.get(dependencyName);
      if (!dependency) {
        throw new Error(
          `${workspacePackage.name} depends on missing workspace package ${dependencyName}.`,
        );
      }
      pending.push(dependency);
    }
  }

  return selected;
}

async function assertRequiredBuildOutputs(
  workspaceRoot: string,
  packages: WorkspacePackage[],
): Promise<void> {
  const missing: string[] = [];

  for (const workspacePackage of packages) {
    const distDir = path.join(workspacePackage.absoluteDir, "dist");
    if (!(await pathExists(distDir))) {
      missing.push(path.posix.join(workspacePackage.relativeDir, "dist"));
    }

    if (workspacePackage.name === "@lorenz/cli") {
      await requireFile(path.join(workspacePackage.absoluteDir, "dist", "bin", "cli.js"), missing);
      await requireFile(path.join(workspacePackage.absoluteDir, "bin", "lorenz.js"), missing);
    }

    if (workspacePackage.name === "@agentclientprotocol/claude-agent-acp") {
      await requireFile(path.join(workspacePackage.absoluteDir, "dist", "bundle.js"), missing);
    }
  }

  if (!(await pathExists(path.join(workspaceRoot, dashboardDist)))) {
    missing.push(dashboardDist);
  }

  if (missing.length > 0) {
    throw new Error(
      [
        "Cannot stage CLI release because required build outputs are missing:",
        ...missing.map((entry) => `- ${entry}`),
        "Run `mise run build` from ts/ before staging the release.",
      ].join("\n"),
    );
  }
}

async function requireFile(filePath: string, missing: string[]): Promise<void> {
  if (await pathExists(filePath)) return;
  missing.push(pathRelativeToCwd(filePath));
}

async function prepareOutputDir(releaseDir: string, force: boolean): Promise<void> {
  if (await pathExists(releaseDir)) {
    if (!force) {
      throw new Error(
        `Release directory already exists: ${releaseDir}. Pass --force to replace it.`,
      );
    }
    await fs.rm(releaseDir, { recursive: true, force: true });
  }

  await fs.mkdir(releaseDir, { recursive: true });
}

async function stageWorkspacePackage(
  releaseDir: string,
  workspacePackage: WorkspacePackage,
  selectedPackages: Map<string, WorkspacePackage>,
  catalog: Record<string, string>,
): Promise<void> {
  const targetDir = path.join(releaseDir, workspacePackage.relativeDir);
  await fs.mkdir(targetDir, { recursive: true });
  await copyDirectory(
    path.join(workspacePackage.absoluteDir, "dist"),
    path.join(targetDir, "dist"),
  );

  if (workspacePackage.name === "@lorenz/cli") {
    await copyDirectory(
      path.join(workspacePackage.absoluteDir, "bin"),
      path.join(targetDir, "bin"),
    );
    await makeExecutable(path.join(targetDir, "bin", "lorenz.js"));
  }

  await writeJson(
    path.join(targetDir, "package.json"),
    releasePackageJson(workspacePackage, selectedPackages, catalog),
  );
}

async function stageVendoredRuntimeDependencies(
  releaseDir: string,
  allPackages: Map<string, WorkspacePackage>,
): Promise<void> {
  for (const dependency of vendoredRuntimeDependencies) {
    const dependent = allPackages.get(dependency.dependentPackage);
    if (!dependent) {
      throw new Error(
        `Cannot vendor ${dependency.packageName}: ${dependency.dependentPackage} was not found in the workspace.`,
      );
    }

    const installedDir = path.join(
      dependent.absoluteDir,
      "node_modules",
      ...dependency.packageName.split("/"),
    );
    const sourceDir = await fs.realpath(installedDir).catch((error) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error(
          `Cannot vendor ${dependency.packageName}: not installed under ${dependency.dependentPackage}. Run pnpm install from ts/.`,
        );
      }
      throw error;
    });

    const targetDir = path.join(releaseDir, ...dependency.targetDir.split("/"));
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    await fs.cp(sourceDir, targetDir, {
      recursive: true,
      dereference: true,
      filter: (entry) => !entry.endsWith(".tsbuildinfo"),
    });

    // Drop the platform-specific binary packages so installs never fetch them; the CLI resolves
    // the host claude/codex instead.
    const targetPackageJsonPath = path.join(targetDir, "package.json");
    const packageJson = await readJson<PackageJson>(targetPackageJsonPath);
    delete packageJson.optionalDependencies;
    packageJson.private = true;
    await writeJson(targetPackageJsonPath, packageJson);
  }
}

function releasePackageJson(
  workspacePackage: WorkspacePackage,
  selectedPackages: Map<string, WorkspacePackage>,
  catalog: Record<string, string>,
): PackageJson {
  const source = workspacePackage.packageJson;
  const releasePackage = withoutUndefined({
    name: source.name,
    version: source.version,
    private: true,
    type: source.type,
    main: source.main,
    types: source.types,
    exports: source.exports,
    bin: source.bin,
  }) as PackageJson;
  const dependencies = rewriteDependencies(
    source.dependencies ?? {},
    workspacePackage,
    selectedPackages,
    catalog,
  );

  if (Object.keys(dependencies).length > 0) {
    releasePackage.dependencies = dependencies;
  }

  return releasePackage;
}

function rewriteDependencies(
  dependencies: Record<string, string>,
  owner: WorkspacePackage,
  selectedPackages: Map<string, WorkspacePackage>,
  catalog: Record<string, string>,
): Record<string, string> {
  const rewritten: Record<string, string> = {};

  for (const [dependencyName, specifier] of Object.entries(dependencies).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (specifier.startsWith("workspace:")) {
      const dependency = selectedPackages.get(dependencyName);
      if (!dependency) {
        throw new Error(`${owner.name} has unstaged workspace dependency ${dependencyName}.`);
      }

      rewritten[dependencyName] = fileSpecifierBetween(owner.relativeDir, dependency.relativeDir);
      continue;
    }

    const vendoredTarget = vendoredRuntimeDependencyTargets.get(dependencyName);
    if (vendoredTarget) {
      rewritten[dependencyName] = fileSpecifierBetween(owner.relativeDir, vendoredTarget);
      continue;
    }

    rewritten[dependencyName] = resolveCatalogSpecifier(dependencyName, specifier, catalog);
  }

  return rewritten;
}

function resolveCatalogSpecifier(
  dependencyName: string,
  specifier: string,
  catalog: Record<string, string>,
): string {
  if (specifier === "catalog:") {
    const catalogSpecifier = catalog[dependencyName];
    if (!catalogSpecifier) {
      throw new Error(`No default catalog entry exists for dependency ${dependencyName}.`);
    }
    return catalogSpecifier;
  }

  if (specifier.startsWith("catalog:")) {
    throw new Error(
      `Named catalog specifiers are not supported in the CLI release yet: ${specifier}`,
    );
  }

  return specifier;
}

function fileSpecifierBetween(fromRelativeDir: string, toRelativeDir: string): string {
  const relative = path.posix.relative(fromRelativeDir, toRelativeDir);
  return `file:${relative.startsWith(".") ? relative : `./${relative}`}`;
}

async function writeRootPackageJson(
  releaseDir: string,
  version: string,
  packages: WorkspacePackage[],
  externalDependencies: Record<string, string>,
): Promise<void> {
  // npm does not install the registry dependencies of a `file:` directory dependency, so a
  // consumer that runs the release as a dependency (npx, npm install <tarball>) only gets symlinks
  // to the workspace packages and none of their external deps. Declaring every workspace package
  // and every external dependency at the root makes npm install the full graph in either layout:
  // the staged directory used as the install root, or the package hoisted under node_modules.
  const dependencies = Object.fromEntries(
    [
      ...packages.map(
        (workspacePackage) =>
          [workspacePackage.name, `file:${workspacePackage.relativeDir}`] as const,
      ),
      ...vendoredRuntimeDependencies.map(
        (dependency) => [dependency.packageName, `file:${dependency.targetDir}`] as const,
      ),
      ...Object.entries(externalDependencies),
    ].sort(([left], [right]) => left.localeCompare(right)),
  );

  await writeJson(path.join(releaseDir, "package.json"), {
    name: "lorenz",
    version,
    description:
      "Lorenz is a control plane for dispatching and structuring order across dynamic agent systems.",
    license: "Apache-2.0",
    repository: {
      type: "git",
      url: "git+https://github.com/ryanlyn/lorenz.git",
    },
    homepage: "https://github.com/ryanlyn/lorenz#readme",
    type: "module",
    bin: {
      lorenz: `./${releaseEntrypoint}`,
    },
    scripts: {
      start: "node ./node_modules/@lorenz/cli/dist/bin/cli.js",
    },
    dependencies,
    engines: {
      node: ">=24",
    },
    publishConfig: {
      access: "public",
    },
  });
}

async function writeEntrypoint(releaseDir: string): Promise<void> {
  const entrypointPath = path.join(releaseDir, releaseEntrypoint);
  await fs.mkdir(path.dirname(entrypointPath), { recursive: true });
  await fs.writeFile(
    entrypointPath,
    `#!/usr/bin/env node

// Resolve @lorenz/cli through Node's module resolution rather than a fixed relative path so the
// launcher works in both install layouts: the release directory used as the install root, and the
// release hoisted under a parent node_modules (npx, npm install <tarball>, global install).
try {
  const cliUrl = new URL("./bin/cli.js", import.meta.resolve("@lorenz/cli"));
  await import(cliUrl.href);
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
    console.error("lorenz could not resolve @lorenz/cli. Install the release dependencies with npm install --omit=dev.");
    process.exitCode = 1;
  } else {
    throw error;
  }
}
`,
  );
  await makeExecutable(entrypointPath);
}

async function copyReleaseMetadata(workspaceRoot: string, releaseDir: string): Promise<void> {
  await copyOptionalFile(path.join(workspaceRoot, "README.md"), path.join(releaseDir, "README.md"));
  await copyOptionalFile(
    path.join(workspaceRoot, "..", "LICENSE"),
    path.join(releaseDir, "LICENSE"),
  );
}

function collectExternalDependencies(
  packages: WorkspacePackage[],
  catalog: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};

  for (const workspacePackage of packages) {
    for (const [dependencyName, specifier] of Object.entries(
      workspacePackage.packageJson.dependencies ?? {},
    )) {
      if (specifier.startsWith("workspace:")) continue;
      // Vendored runtime deps ship inside the release as file: packages, not registry installs.
      if (vendoredRuntimeDependencyTargets.has(dependencyName)) continue;

      const version = resolveCatalogSpecifier(dependencyName, specifier, catalog);
      const existing = resolved[dependencyName];
      if (existing !== undefined && existing !== version) {
        // The release hoists every external to a single root version. Workspace packages are
        // visited in sorted relativeDir order, so the first occurrence (apps/ before vendor/) wins.
        console.warn(
          `Multiple versions requested for ${dependencyName}: keeping ${existing}, ignoring ${version} from ${workspacePackage.name}.`,
        );
        continue;
      }
      resolved[dependencyName] = version;
    }
  }

  return resolved;
}

function releaseManifest(
  version: string,
  packages: WorkspacePackage[],
  externalDependencies: Record<string, string>,
): ReleaseManifest {
  const externalNames = Object.keys(externalDependencies).sort();
  const nativeDependencies = externalNames.filter((dependencyName) =>
    nativeDependencyNames.has(dependencyName),
  );

  return {
    schemaVersion: 1,
    version,
    entrypoint: releaseEntrypoint,
    dashboardDist,
    installCommand: "npm install --omit=dev",
    packages: packages.map((workspacePackage) => ({
      name: workspacePackage.name,
      path: workspacePackage.relativeDir,
    })),
    vendoredRuntimeDependencies: vendoredRuntimeDependencies.map((dependency) => ({
      name: dependency.packageName,
      path: dependency.targetDir,
    })),
    externalDependencies: externalNames,
    nativeDependencies,
  };
}

async function createArchive(
  outputRoot: string,
  releaseName: string,
  releaseDir: string,
  force: boolean,
): Promise<string> {
  const archivePath = `${releaseDir}.tar.gz`;
  if ((await pathExists(archivePath)) && !force) {
    throw new Error(`Release archive already exists: ${archivePath}. Pass --force to replace it.`);
  }

  if (force) {
    await fs.rm(archivePath, { force: true });
  }

  await execFileAsync("tar", ["-czf", archivePath, "-C", outputRoot, releaseName]);
  return archivePath;
}

async function copyDirectory(source: string, target: string): Promise<void> {
  await fs.cp(source, target, {
    recursive: true,
    preserveTimestamps: true,
    filter: (sourcePath) => !sourcePath.endsWith(".tsbuildinfo"),
  });
}

async function copyOptionalFile(source: string, target: string): Promise<void> {
  if (!(await pathExists(source))) return;
  await fs.copyFile(source, target);
}

async function makeExecutable(filePath: string): Promise<void> {
  await fs.chmod(
    filePath,
    constants.S_IRWXU |
      constants.S_IRGRP |
      constants.S_IXGRP |
      constants.S_IROTH |
      constants.S_IXOTH,
  );
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function withoutUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function pathRelativeToCwd(filePath: string): string {
  return path.relative(process.cwd(), filePath).split(path.sep).join(path.posix.sep);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function printHelp(): void {
  console.log(`Usage: tsx scripts/stage-release.ts [options]

Options:
  --out-dir <path>   Directory that receives the staged release
  --name <name>      Release directory name
  --version <value>  Release package version
  --tarball          Also create a .tar.gz archive next to the release directory
  --force            Replace an existing release directory or archive
  --help             Show this help
`);
}

function parseArgs(args: string[]): StageReleaseOptions & { help?: boolean } {
  const options: StageReleaseOptions & { help?: boolean } = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--":
        break;
      case "--out-dir":
        options.outputRoot = requiredValue(args, ++index, arg);
        break;
      case "--name":
        options.releaseName = requiredValue(args, ++index, arg);
        break;
      case "--version":
        options.version = requiredValue(args, ++index, arg);
        break;
      case "--tarball":
        options.archive = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

async function runCli(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const result = await stageRelease(options);
  console.log(`Staged Lorenz CLI release at ${result.releaseDir}`);
  if (result.archivePath) {
    console.log(`Created archive at ${result.archivePath}`);
  }
  console.log(`Packages: ${result.manifest.packages.length}`);
  console.log(`Next step: ${result.manifest.installCommand}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
