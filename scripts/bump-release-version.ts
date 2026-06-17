import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

type PackageJson = JsonObject & {
  name?: string;
  version?: string;
};

type PackageFile = {
  relativePath: string;
  absolutePath: string;
  packageJson: PackageJson;
};

export type BumpReleaseVersionOptions = {
  workspaceRoot?: string;
  baseVersion?: string;
  version?: string;
  dryRun?: boolean;
};

export type BumpReleaseVersionResult = {
  previousVersion: string;
  nextVersion: string;
  packageFiles: string[];
};

const scriptPath = fileURLToPath(import.meta.url);
const defaultWorkspaceRoot = path.resolve(path.dirname(scriptPath), "..");
const firstPartyPackageRoots = ["apps", "packages", "extensions"];
const cliPackagePath = "apps/cli/package.json";

export async function bumpReleaseVersion(
  options: BumpReleaseVersionOptions = {},
): Promise<BumpReleaseVersionResult> {
  if (options.baseVersion && options.version) {
    throw new Error("Use either --base-version or --version, not both.");
  }

  const workspaceRoot = path.resolve(options.workspaceRoot ?? defaultWorkspaceRoot);
  const packageFiles = await readFirstPartyPackageFiles(workspaceRoot);
  const cliPackage = packageFiles.find(
    (packageFile) => packageFile.relativePath === cliPackagePath,
  );
  if (!cliPackage?.packageJson.version) {
    throw new Error(`Cannot bump release version: ${cliPackagePath} has no version.`);
  }

  const currentVersions = new Set<string>();
  for (const packageFile of packageFiles) {
    const version = packageFile.packageJson.version;
    if (!version) {
      throw new Error(`Cannot bump release version: ${packageFile.relativePath} has no version.`);
    }
    currentVersions.add(version);
  }

  if (currentVersions.size !== 1) {
    throw new Error(
      `Cannot bump release version: first-party package versions must match (${[
        ...currentVersions,
      ].join(", ")}).`,
    );
  }

  const previousVersion = cliPackage.packageJson.version;
  const baseVersion = options.baseVersion
    ? maxStableVersion(previousVersion, options.baseVersion)
    : previousVersion;
  const nextVersion = options.version ?? incrementPatchVersion(baseVersion);
  assertStableVersion(nextVersion);

  if (!options.dryRun) {
    await Promise.all(
      packageFiles.map(async (packageFile) => {
        packageFile.packageJson.version = nextVersion;
        await writeJson(packageFile.absolutePath, packageFile.packageJson);
      }),
    );
  }

  return {
    previousVersion,
    nextVersion,
    packageFiles: packageFiles.map((packageFile) => packageFile.relativePath),
  };
}

async function readFirstPartyPackageFiles(workspaceRoot: string): Promise<PackageFile[]> {
  const relativePaths = ["package.json"];

  for (const root of firstPartyPackageRoots) {
    const rootPath = path.join(workspaceRoot, root);
    const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch((error) => {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    });

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      const relativePath = path.posix.join(root, entry.name, "package.json");
      if (await pathExists(path.join(workspaceRoot, relativePath))) {
        relativePaths.push(relativePath);
      }
    }
  }

  return Promise.all(
    relativePaths.map(async (relativePath) => {
      const absolutePath = path.join(workspaceRoot, relativePath);
      return {
        relativePath,
        absolutePath,
        packageJson: await readJson<PackageJson>(absolutePath),
      };
    }),
  );
}

function incrementPatchVersion(version: string): string {
  const { major, minor, patch } = parseStableVersion(version);
  return `${major}.${minor}.${patch + 1}`;
}

function maxStableVersion(left: string, right: string): string {
  return compareStableVersions(left, right) >= 0 ? left : right;
}

function compareStableVersions(left: string, right: string): number {
  const leftVersion = parseStableVersion(left);
  const rightVersion = parseStableVersion(right);
  const fields = ["major", "minor", "patch"] as const;

  for (const field of fields) {
    const delta = leftVersion[field] - rightVersion[field];
    if (delta !== 0) return delta;
  }

  return 0;
}

function assertStableVersion(version: string): void {
  parseStableVersion(version);
}

function parseStableVersion(version: string): { major: number; minor: number; patch: number } {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Release versions must be stable semver versions: ${version}`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new Error(`Release version contains an invalid number: ${version}`);
  }

  return { major, minor, patch };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function printHelp(): void {
  console.log(`Usage: tsx scripts/bump-release-version.ts [options]

Bumps every first-party package.json version used by the Lorenz release train.
By default this increments the current @lorenz/cli patch version.

Options:
  --base-version <value>  Increment patch from this stable semver version
  --version <value>       Set an exact stable semver version
  --dry-run               Print the next version without writing package.json files
  --help                  Show this help
`);
}

function parseArgs(args: string[]): BumpReleaseVersionOptions & { help?: boolean } {
  const options: BumpReleaseVersionOptions & { help?: boolean } = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--":
        break;
      case "--base-version":
        options.baseVersion = requiredValue(args, ++index, arg);
        break;
      case "--version":
        options.version = requiredValue(args, ++index, arg);
        break;
      case "--dry-run":
        options.dryRun = true;
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

  const result = await bumpReleaseVersion(options);
  console.log(result.nextVersion);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
