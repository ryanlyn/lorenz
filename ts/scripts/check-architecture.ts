import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Enforces the dependency rules documented in ARCHITECTURE.md over the workspace
 * package.json graph. The goal is that the SDK-core/extension split cannot silently
 * erode: an engine package importing a tracker provider fails `mise run check`, not a
 * code review.
 *
 * Layers (dependencies must point strictly downward):
 *   apps          - anything
 *   bundles       - extension bundles (`trackers`): extensions + SDKs
 *   extensions    - tracker providers (`*-tracker`): leaf + SDK layers only
 *   engine        - everything else: must not depend on extensions or bundles
 *   sdk           - `tracker-sdk`, `agent-sdk`: leaf layer only
 *   leaf          - `domain`, `ports`: no internal dependencies at all
 */

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LEAF = new Set(["domain", "ports"]);
const SDK = new Set(["tracker-sdk", "agent-sdk"]);
const BUNDLES = new Set(["trackers"]);
/** Shared issue-normalization helpers usable by extensions as well as the engine. */
const EXTENSION_SUPPORT = new Set(["issue"]);

type Layer = "leaf" | "sdk" | "extension-support" | "extension" | "bundle" | "engine" | "app";

function layerOf(shortName: string, isApp: boolean): Layer {
  if (isApp) return "app";
  if (LEAF.has(shortName)) return "leaf";
  if (SDK.has(shortName)) return "sdk";
  if (EXTENSION_SUPPORT.has(shortName)) return "extension-support";
  if (BUNDLES.has(shortName)) return "bundle";
  if (shortName.endsWith("-tracker")) return "extension";
  return "engine";
}

/** Layers each layer is allowed to depend on. */
const ALLOWED: Record<Layer, ReadonlySet<Layer>> = {
  leaf: new Set([]),
  sdk: new Set(["leaf"]),
  "extension-support": new Set(["leaf"]),
  extension: new Set(["leaf", "sdk", "extension-support"]),
  bundle: new Set(["leaf", "sdk", "extension-support", "extension"]),
  engine: new Set(["leaf", "sdk", "extension-support", "engine"]),
  app: new Set(["leaf", "sdk", "extension-support", "extension", "bundle", "engine", "app"]),
};

interface WorkspacePackage {
  name: string;
  shortName: string;
  layer: Layer;
  dir: string;
  symphonyDeps: string[];
}

async function readPackages(): Promise<WorkspacePackage[]> {
  const packages: WorkspacePackage[] = [];
  for (const [root, isApp] of [
    ["packages", false],
    ["apps", true],
  ] as const) {
    const rootDir = path.join(workspaceRoot, root);
    for (const entry of await fs.readdir(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(rootDir, entry.name);
      let manifest: { name?: string; dependencies?: Record<string, string> };
      try {
        manifest = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as {
          name?: string;
          dependencies?: Record<string, string>;
        };
      } catch {
        continue;
      }
      const name = manifest.name ?? entry.name;
      const shortName = name.replace(/^@symphony\//, "");
      packages.push({
        name,
        shortName,
        layer: layerOf(shortName, isApp),
        dir: path.relative(workspaceRoot, dir),
        symphonyDeps: Object.keys(manifest.dependencies ?? {}).filter((dep) =>
          dep.startsWith("@symphony/"),
        ),
      });
    }
  }
  return packages;
}

const packages = await readPackages();
const layerByName = new Map(packages.map((pkg) => [pkg.name, pkg.layer]));

const violations: string[] = [];
for (const pkg of packages) {
  const allowed = ALLOWED[pkg.layer];
  for (const dep of pkg.symphonyDeps) {
    const depLayer = layerByName.get(dep);
    if (depLayer === undefined) {
      violations.push(`${pkg.dir}: depends on unknown workspace package ${dep}`);
      continue;
    }
    if (!allowed.has(depLayer)) {
      violations.push(
        `${pkg.dir} (${pkg.layer}) must not depend on ${dep} (${depLayer}); ` +
          `see ARCHITECTURE.md layering rules`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error("Architecture violations:\n");
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error(`\n${violations.length} violation(s).`);
  process.exit(1);
}

console.log(`architecture: ${packages.length} workspace packages conform to the layering rules`);
