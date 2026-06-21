// The axis-generic extension loader resolves out-of-tree extensions with native
// `import()` + `pathToFileURL` and NO jiti / alias resolver / source transform.
// That native-import path is invisible to the architecture:check depcruise rules
// (the specifier is an opaque string) AND it is sensitive to the install layout:
// `import(bareSpecifier)` resolves relative to the MODULE doing the import, so the
// loader only finds a bundled extension when the loader itself sits inside the
// release's `node_modules`. lorenz already hit an import()-under-npx-bundling
// regression - PR #398 ("bundle internal packages to fix npx install crash") moved
// every workspace package to a real `node_modules/@lorenz/<name>` bundled node
// (no `file:` symlinks, deps pinned to the bundled version) precisely so Node's
// module resolution finds them in any consumer install layout.
//
// These tests stage that exact bundled-release layout (the same shape
// `scripts/stage-release.ts` produces) in a temp dir from the REAL built loader
// and SDK dist, then drive the REAL loaders from INSIDE the staged tree. They
// prove the generalized loader survives the npx-bundled build for both axes
// (trackers and worker-drivers) through both specifier forms (a bundled BARE
// package name resolved through the module graph, and a `pathToFileURL` path),
// and - via the negative guard - that a broken release layout (the SDK missing
// from the bundle) FAILS resolution, so this test catches a #398-style regression
// rather than silently passing.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { assert, tempDir } from "@lorenz/test-utils";
import { test } from "vitest";

import type { ensureTrackerProviderLoaded } from "../apps/cli/src/trackerLoader.js";
import type { ensureWorkerDriverLoaded } from "../apps/cli/src/workerDriverLoader.js";

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// ---------------------------------------------------------------------------
// staging a bundled-release tree (mirrors scripts/stage-release.ts)
// ---------------------------------------------------------------------------

/** Where a bundled package lands in the release tree (`node_modules/@scope/name`). */
function bundledDir(releaseRoot: string, packageName: string): string {
  return path.join(releaseRoot, "node_modules", ...packageName.split("/"));
}

/**
 * Stage a real workspace package into the release tree as a bundled node: copy its
 * built `dist/` verbatim and write a release-shaped `package.json` that pins every
 * internal dependency to the bundled version - NO `workspace:`/`file:` specifiers,
 * exactly what `stage-release.ts` emits. Returns the bundled package's version so
 * dependents can pin it.
 */
async function stageBundledPackage(
  releaseRoot: string,
  workspaceRelativeDir: string,
  pinnedVersions: Map<string, string>,
): Promise<string> {
  const sourceDir = path.join(workspaceRoot, workspaceRelativeDir);
  const sourcePackage = JSON.parse(
    await fs.readFile(path.join(sourceDir, "package.json"), "utf8"),
  ) as {
    name: string;
    version: string;
    type?: string;
    main?: string;
    exports?: unknown;
    dependencies?: Record<string, string>;
  };

  const targetDir = bundledDir(releaseRoot, sourcePackage.name);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.cp(path.join(sourceDir, "dist"), path.join(targetDir, "dist"), {
    recursive: true,
    filter: (entry) => !entry.endsWith(".tsbuildinfo"),
  });

  // Rewrite every internal dep to the pinned bundled version, dropping any dep the
  // staged closure does not include (the loader runtime path never touches them).
  const dependencies: Record<string, string> = {};
  for (const [dependencyName] of Object.entries(sourcePackage.dependencies ?? {})) {
    const pinned = pinnedVersions.get(dependencyName);
    if (pinned !== undefined) dependencies[dependencyName] = pinned;
  }

  await fs.writeFile(
    path.join(targetDir, "package.json"),
    `${JSON.stringify(
      {
        name: sourcePackage.name,
        version: sourcePackage.version,
        type: sourcePackage.type ?? "module",
        main: sourcePackage.main ?? "./dist/index.js",
        exports: sourcePackage.exports ?? { ".": "./dist/index.js" },
        ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
      },
      null,
      2,
    )}\n`,
  );

  pinnedVersions.set(sourcePackage.name, sourcePackage.version);
  return sourcePackage.version;
}

/**
 * Stage a minimal `@lorenz/cli` package carrying ONLY the loader runtime: the
 * axis-generic core plus the two axis loaders under test, copied verbatim from the
 * real built `apps/cli/dist`. Importing a loader from this staged path is what
 * anchors its `import(specifier)` resolution at the release's bundled
 * `node_modules` - the production npx layout, where the CLI's compiled loaders
 * live at `node_modules/@lorenz/cli/dist/*.js`.
 */
async function stageLoaderPackage(
  releaseRoot: string,
  pinnedVersions: Map<string, string>,
): Promise<void> {
  const cliPackage = JSON.parse(
    await fs.readFile(path.join(workspaceRoot, "apps/cli/package.json"), "utf8"),
  ) as { name: string; version: string };
  const targetDir = bundledDir(releaseRoot, cliPackage.name);
  const distDir = path.join(targetDir, "dist");
  await fs.mkdir(distDir, { recursive: true });

  for (const fileName of ["extensionLoader.js", "trackerLoader.js", "workerDriverLoader.js"]) {
    await fs.copyFile(
      path.join(workspaceRoot, "apps/cli/dist", fileName),
      path.join(distDir, fileName),
    );
  }

  await fs.writeFile(
    path.join(targetDir, "package.json"),
    `${JSON.stringify(
      {
        name: cliPackage.name,
        version: cliPackage.version,
        type: "module",
        exports: {
          "./trackerLoader": "./dist/trackerLoader.js",
          "./workerDriverLoader": "./dist/workerDriverLoader.js",
        },
      },
      null,
      2,
    )}\n`,
  );
  pinnedVersions.set(cliPackage.name, cliPackage.version);
}

/**
 * Stage a full bundled-release tree: the real tracker + worker SDK closures and the
 * loader package, then import the two REAL loaders from inside the tree so their
 * `import()` resolution anchors at the bundled `node_modules`. The returned loaders
 * are the production code, exercised through the production resolution path.
 */
async function stageReleaseTree(releaseRoot: string): Promise<{
  ensureTrackerProviderLoaded: typeof ensureTrackerProviderLoaded;
  ensureWorkerDriverLoaded: typeof ensureWorkerDriverLoaded;
  trackerSdkHref: string;
  workerSdkHref: string;
}> {
  const pinned = new Map<string, string>();
  // Order matters only for the pin map: stage a package before its dependents so
  // the dependent pins the version the bundle actually carries.
  await stageBundledPackage(releaseRoot, "packages/domain", pinned);
  await stageBundledPackage(releaseRoot, "packages/tool-sdk", pinned);
  await stageBundledPackage(releaseRoot, "packages/tracker-sdk", pinned);
  await stageBundledPackage(releaseRoot, "packages/worker-sdk", pinned);
  await stageLoaderPackage(releaseRoot, pinned);

  const trackerLoaderUrl = pathToFileURL(
    bundledDir(releaseRoot, "@lorenz/cli/dist/trackerLoader.js"),
  ).href;
  const workerLoaderUrl = pathToFileURL(
    bundledDir(releaseRoot, "@lorenz/cli/dist/workerDriverLoader.js"),
  ).href;

  const trackerLoaderModule = (await import(trackerLoaderUrl)) as {
    ensureTrackerProviderLoaded: typeof ensureTrackerProviderLoaded;
  };
  const workerLoaderModule = (await import(workerLoaderUrl)) as {
    ensureWorkerDriverLoaded: typeof ensureWorkerDriverLoaded;
  };

  return {
    ensureTrackerProviderLoaded: trackerLoaderModule.ensureTrackerProviderLoaded,
    ensureWorkerDriverLoaded: workerLoaderModule.ensureWorkerDriverLoaded,
    // The bare names an out-of-tree extension imports; under the staged tree they
    // resolve to the bundled SDKs (the whole point of #398's bundled node layout).
    trackerSdkHref: "@lorenz/tracker-sdk",
    workerSdkHref: "@lorenz/worker-sdk",
  };
}

// ---------------------------------------------------------------------------
// minimal registries satisfying the loader's ExtensionRegistry surface
// ---------------------------------------------------------------------------

interface MiniFactory {
  kind: string;
}

/** The minimal `ExtensionRegistry<TFactory>` shape the loader closes over. */
function miniRegistry<TFactory extends MiniFactory>(builtins: TFactory[] = []): {
  get(kind: string | undefined): TFactory | undefined;
  register(factory: TFactory): void;
  kinds(): string[];
} {
  const byKind = new Map<string, TFactory>();
  for (const factory of builtins) byKind.set(factory.kind, factory);
  return {
    get: (kind) => (kind === undefined ? undefined : byKind.get(kind)),
    register: (factory) => void byKind.set(factory.kind, factory),
    kinds: () => [...byKind.keys()],
  };
}

function recordingLog(): {
  events: Record<string, unknown>[];
  logEvent: (event: Record<string, unknown>) => void;
} {
  const events: Record<string, unknown>[] = [];
  return { events, logEvent: (event) => void events.push(event) };
}

// ---------------------------------------------------------------------------
// out-of-tree extension fixtures (import the bundled SDK by BARE name)
// ---------------------------------------------------------------------------

/**
 * A tracker extension that imports the SDK by its BARE name - the production
 * authoring shape. Under the staged release tree this bare import resolves to the
 * bundled `node_modules/@lorenz/tracker-sdk`; if that bundled node is missing the
 * import fails, which is exactly the #398 regression class.
 */
function trackerExtensionSource(sdkImport: string, kind: string): string {
  return `
import { defineTrackerProvider } from ${JSON.stringify(sdkImport)};

export default defineTrackerProvider({
  kind: ${JSON.stringify(kind)},
  sdkVersion: 1,
  defaultEndpoint: "https://acme.example",
  createClient() {
    return {
      async fetchCandidateIssues() { return []; },
      async fetchIssuesByIds() { return []; },
    };
  },
});
`;
}

function workerExtensionSource(sdkImport: string, kind: string): string {
  return `
import { defineWorkerDriver } from ${JSON.stringify(sdkImport)};

export default defineWorkerDriver({
  kind: ${JSON.stringify(kind)},
  sdkVersion: 1,
  create() {
    return {
      kind: ${JSON.stringify(kind)},
      capabilities: { sshAddressable: false, ephemeral: true, usesLedger: false },
      async provision() { throw new Error("not provisioned in this test"); },
      async probe() { return { ok: true }; },
      async destroy() {},
      async list() { return []; },
    };
  },
});
`;
}

/**
 * Install an out-of-tree extension as a BUNDLED bare package in the release tree
 * (`node_modules/<packageName>`), the shape an operator gets from `npm install`
 * inside an npx-installed lorenz. Returns the bare specifier the loader is given.
 */
async function installBundledExtension(
  releaseRoot: string,
  packageName: string,
  source: string,
): Promise<string> {
  const targetDir = bundledDir(releaseRoot, packageName);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(path.join(targetDir, "index.mjs"), source);
  await fs.writeFile(
    path.join(targetDir, "package.json"),
    `${JSON.stringify(
      { name: packageName, version: "1.0.0", type: "module", main: "./index.mjs" },
      null,
      2,
    )}\n`,
  );
  return packageName;
}

// ===========================================================================
// trackers: bundled bare package resolves through the module graph
// ===========================================================================

test("trackers: a bundled bare-specifier extension resolves under the release layout", async () => {
  const releaseRoot = await tempDir("extension-release");
  const { ensureTrackerProviderLoaded, trackerSdkHref } = await stageReleaseTree(releaseRoot);

  const specifier = await installBundledExtension(
    releaseRoot,
    "@acme/lorenz-tracker",
    trackerExtensionSource(trackerSdkHref, "acme"),
  );
  const registry = miniRegistry([{ kind: "linear" }]);
  const { events, logEvent } = recordingLog();

  // baseDir is irrelevant for a bare specifier - resolution anchors at the loader's
  // bundled location, NOT baseDir. Point it somewhere with no node_modules to prove
  // the bundled-graph resolution, not a baseDir walk, is what finds the package.
  await ensureTrackerProviderLoaded(specifier, registry, {
    baseDir: path.join(releaseRoot, "nowhere"),
    logEvent,
  });

  const provider = registry.get(specifier);
  assert.ok(provider, "the bundled bare extension must register under its specifier");
  assert.equal(provider!.kind, specifier);
  const loaded = events.find((event) => event.event === "tracker_provider_loaded");
  assert.ok(loaded, "a load event proves the import resolved, not a registry hit");
  // The module's self-declared kind in the audit event proves its bare SDK import
  // (`@lorenz/tracker-sdk`) resolved from the bundle: defineTrackerProvider ran.
  assert.equal(loaded!.kind, "acme");
  assert.equal(loaded!.sdkVersion, 1);
});

test("trackers: a pathToFileURL specifier resolves under the release layout", async () => {
  const releaseRoot = await tempDir("extension-release");
  const { ensureTrackerProviderLoaded, trackerSdkHref } = await stageReleaseTree(releaseRoot);

  // A path-specifier extension placed INSIDE the tree (so its own bare SDK import
  // still resolves through the bundled node_modules), loaded via an absolute path.
  const extDir = path.join(releaseRoot, "operator-extensions");
  await fs.mkdir(extDir, { recursive: true });
  const extPath = path.join(extDir, "acme-tracker.mjs");
  await fs.writeFile(extPath, trackerExtensionSource(trackerSdkHref, "acme-path"));
  const registry = miniRegistry();

  await ensureTrackerProviderLoaded(extPath, registry, { baseDir: extDir });

  const provider = registry.get(extPath);
  assert.ok(provider, "the absolute-path extension must register under its specifier");
  assert.equal(provider!.kind, extPath);
});

// ===========================================================================
// worker-drivers: the byte-identical first instance also survives bundling
// ===========================================================================

test("worker-drivers: a bundled bare-specifier extension resolves under the release layout", async () => {
  const releaseRoot = await tempDir("extension-release");
  const { ensureWorkerDriverLoaded, workerSdkHref } = await stageReleaseTree(releaseRoot);

  const specifier = await installBundledExtension(
    releaseRoot,
    "@acme/lorenz-worker-driver",
    workerExtensionSource(workerSdkHref, "acme-worker"),
  );
  const registry = miniRegistry([{ kind: "fake" }]);
  const { events, logEvent } = recordingLog();

  await ensureWorkerDriverLoaded(specifier, registry, {
    baseDir: path.join(releaseRoot, "nowhere"),
    logEvent,
  });

  const factory = registry.get(specifier);
  assert.ok(factory, "the bundled bare driver must register under its specifier");
  assert.equal(factory!.kind, specifier);
  const loaded = events.find((event) => event.event === "worker_pool_driver_loaded");
  assert.ok(loaded);
  assert.equal(loaded!.kind, "acme-worker");
  assert.equal(loaded!.sdkVersion, 1);
});

// ===========================================================================
// negative guard: a BROKEN release layout must FAIL resolution
// ===========================================================================

test("a broken release layout (SDK not bundled) fails bare-specifier resolution", async () => {
  const releaseRoot = await tempDir("extension-release");
  const { ensureTrackerProviderLoaded, trackerSdkHref } = await stageReleaseTree(releaseRoot);

  const specifier = await installBundledExtension(
    releaseRoot,
    "@acme/lorenz-tracker",
    trackerExtensionSource(trackerSdkHref, "acme"),
  );

  // Simulate the #398 regression: the SDK is not bundled alongside the loader, so
  // the extension's bare `@lorenz/tracker-sdk` import has nowhere to resolve.
  await fs.rm(bundledDir(releaseRoot, "@lorenz/tracker-sdk"), { recursive: true, force: true });

  const registry = miniRegistry();
  await assert.rejects(
    () => ensureTrackerProviderLoaded(specifier, registry, {}),
    // The loader wraps the failed import in its actionable resolution error; the
    // underlying cause is the SDK module being unresolvable in the broken layout.
    /tracker_provider_unavailable: @acme\/lorenz-tracker/,
  );
  assert.equal(
    registry.get(specifier),
    undefined,
    "a broken layout must register nothing",
  );
});
