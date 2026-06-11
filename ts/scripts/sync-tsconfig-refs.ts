import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type DependencySection =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies"
  | "optionalDependencies";

type JsonObject = Record<string, unknown>;

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type WorkspaceProject = {
  dir: string;
  packageJson: PackageJson;
  packageJsonPath: string;
  relativeDir: string;
  tsconfig: JsonObject | null;
  tsconfigPath: string;
};

const dependencySections: DependencySection[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const workspaceProjectRoots = ["packages", "extensions", "apps"];
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv.includes("--write") ? "write" : "check";

if (process.argv.some((arg) => arg.startsWith("-") && arg !== "--write" && arg !== "--check")) {
  console.error("Usage: tsx scripts/sync-tsconfig-refs.ts [--check|--write]");
  process.exit(1);
}

const projects = await readWorkspaceProjects();
const packageDirsByName = new Map<string, string>();

for (const project of projects) {
  if (project.packageJson.name?.startsWith("@symphony/")) {
    packageDirsByName.set(project.packageJson.name, project.dir);
  }
}

const plannedWrites: string[] = [];
const errors: string[] = [];

await reconcileRootTsconfig();
await reconcileProjectTsconfigs();

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

if (plannedWrites.length > 0 && mode === "check") {
  for (const file of plannedWrites) {
    console.error(`${path.relative(workspaceRoot, file)} is out of date`);
  }
  console.error("Run: pnpm tsconfig:refs");
  process.exit(1);
}

if (plannedWrites.length > 0) {
  for (const file of plannedWrites) {
    console.log(`updated ${path.relative(workspaceRoot, file)}`);
  }
}

async function reconcileRootTsconfig(): Promise<void> {
  const tsconfigPath = path.join(workspaceRoot, "tsconfig.json");
  const tsconfig = await readJson<JsonObject>(tsconfigPath);
  tsconfig.references = buildableProjects().map((project) => ({
    path: `./${project.relativeDir}`,
  }));
  await writeOrCheckJson(tsconfigPath, tsconfig);
}

async function reconcileProjectTsconfigs(): Promise<void> {
  for (const project of projects) {
    if (!project.tsconfig) continue;

    project.tsconfig.references = referencePathsFor(project).map((referencePath) => ({
      path: referencePath,
    }));
    await writeOrCheckJson(project.tsconfigPath, project.tsconfig);
  }
}

function buildableProjects(): WorkspaceProject[] {
  return projects.filter((project) => project.tsconfig && isBuildableTsconfig(project.tsconfig));
}

function isBuildableTsconfig(tsconfig: JsonObject): boolean {
  if (typeof tsconfig.extends === "string" && tsconfig.extends.includes("tsconfig.base.json")) {
    return true;
  }

  const compilerOptions = tsconfig.compilerOptions;
  return (
    typeof compilerOptions === "object" &&
    compilerOptions !== null &&
    "composite" in compilerOptions &&
    compilerOptions.composite === true
  );
}

function referencePathsFor(project: WorkspaceProject): string[] {
  const references: string[] = [];
  const seen = new Set<string>();

  for (const section of dependencySections) {
    for (const dependencyName of Object.keys(project.packageJson[section] ?? {})) {
      if (!dependencyName.startsWith("@symphony/")) continue;

      const dependencyDir = packageDirsByName.get(dependencyName);
      if (!dependencyDir) {
        errors.push(
          `${project.packageJsonPath} declares ${dependencyName}, but no workspace package matches it`,
        );
        continue;
      }

      if (dependencyDir === project.dir) continue;

      const referencePath = normalizeReferencePath(path.relative(project.dir, dependencyDir));
      if (!seen.has(referencePath)) {
        seen.add(referencePath);
        references.push(referencePath);
      }
    }
  }

  return references;
}

function normalizeReferencePath(relativePath: string): string {
  const normalized = relativePath.split(path.sep).join("/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

async function readWorkspaceProjects(): Promise<WorkspaceProject[]> {
  const projects: WorkspaceProject[] = [];

  for (const root of workspaceProjectRoots) {
    const rootDir = path.join(workspaceRoot, root);
    const entries = await fs.readdir(rootDir, { withFileTypes: true });

    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;

      const dir = path.join(rootDir, entry.name);
      const packageJsonPath = path.join(dir, "package.json");
      const packageJson = await readJsonIfPresent<PackageJson>(packageJsonPath);
      if (!packageJson) continue;

      const tsconfigPath = path.join(dir, "tsconfig.json");
      const tsconfig = await readJsonIfPresent<JsonObject>(tsconfigPath);

      projects.push({
        dir,
        packageJson,
        packageJsonPath,
        relativeDir: normalizeReferencePath(path.relative(workspaceRoot, dir)).slice(2),
        tsconfig,
        tsconfigPath,
      });
    }
  }

  return projects;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

async function readJsonIfPresent<T>(file: string): Promise<T | null> {
  try {
    return await readJson<T>(file);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeOrCheckJson(file: string, value: unknown): Promise<void> {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  const current = await fs.readFile(file, "utf8");
  if (current === next) return;

  plannedWrites.push(file);
  if (mode === "write") {
    await fs.writeFile(file, next);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
