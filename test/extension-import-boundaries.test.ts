// Import-boundary guard for loader-resolved extensions.
//
// `pnpm architecture:check` (dependency-cruiser) enforces the layer model over the
// STATIC import graph: its `extensions-depend-on-sdk-layers-only` rule keeps an
// in-tree `extensions/*` provider implementable from the SDK surface alone, and
// `engine-must-not-import-extensions` keeps the engine from reaching back into one.
// But the generic extension loader (apps/cli/src/extensionLoader.ts) reaches an
// out-of-tree extension through a native `import(specifier)` whose argument is an
// opaque runtime string. depcruise cannot see that string, so a loaded extension
// that imports an ENGINE package - the very core it is meant to extend - sails past
// architecture:check (and architecture:check does not even scan test/). This guard
// exists to cover exactly that blind spot.
//
// The guard cruises two in-repo fixtures (test/fixtures/extension-import-boundaries)
// through dependency-cruiser PROGRAMMATICALLY - reusing the REAL `.dependency-cruiser.cjs`
// resolve options and the REAL `extensions-depend-on-sdk-layers-only` exclusion set
// so it tracks the architecture model rather than re-deriving a drift-prone copy -
// and asserts the SDK+domain-only fixture is clean while the engine-importing
// fixture is FLAGGED on exactly the engine edge.
//
// Residual (documented, not silently accepted): this is a guard over a FIXTURE
// pair, not over arbitrary operator extensions - those live outside the repo and
// cannot be cruised at build time. The trust boundary for third-party code remains
// the same as a workspace hook: a dynamic import runs arbitrary code, audited by
// the `<axis>_loaded` event. What this guard pins is that lorenz's OWN extension
// authoring contract (SDK + domain only) is mechanically checkable for code the
// loader resolves, and that a regression letting an extension import the engine is
// caught - mirroring the static rule into the dynamic-import blind spot.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { assert } from "@lorenz/test-utils";
import { test } from "vitest";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const fixturesDir = "test/fixtures/extension-import-boundaries";

interface DepcruiserConfig {
  forbidden: {
    name: string;
    from: { path?: string };
    to: { path?: string; pathNot?: string[] };
  }[];
  options: {
    doNotFollow?: { path?: string };
    tsPreCompilationDeps?: boolean;
    enhancedResolveOptions?: Record<string, unknown>;
  };
}

interface CruiseModule {
  source: string;
  dependencies: { resolved: string; couldNotResolve: boolean }[];
}

interface CruiseViolation {
  from: string;
  to: string;
  rule: { name: string };
}

interface CruiseResult {
  output: {
    modules: CruiseModule[];
    summary: { error: number; violations: CruiseViolation[] };
  };
}

/**
 * Load the REAL repo architecture config so the guard inherits its resolve options
 * and its layer-exclusion set instead of re-deriving them (re-derived constants
 * drift from the rules they are meant to mirror).
 */
async function loadConfig(): Promise<DepcruiserConfig> {
  const configUrl = pathToFileURL(path.join(repoRoot, ".dependency-cruiser.cjs")).href;
  const imported = (await import(configUrl)) as { default?: DepcruiserConfig } & DepcruiserConfig;
  return imported.default ?? imported;
}

/**
 * Cruise the fixtures directory with a single forbidden rule: a loaded extension may
 * touch ONLY the SDK + domain (+ extension-support) layers. The `to` exclusion set is
 * taken verbatim from the config's `extensions-depend-on-sdk-layers-only` rule, minus
 * its in-tree self-directory exemption (`^$1/`, meaningless for an out-of-tree fixture),
 * so this guard and the static architecture rule cannot diverge.
 */
async function cruiseFixtures(config: DepcruiserConfig): Promise<CruiseResult> {
  const extensionRule = config.forbidden.find(
    (rule) => rule.name === "extensions-depend-on-sdk-layers-only",
  );
  // The architecture config must define extensions-depend-on-sdk-layers-only; this
  // guard mirrors that rule into the loader's dynamic-import blind spot.
  assert.ok(extensionRule);

  // Drop the in-tree own-directory exemption; keep the SDK/domain/support layers.
  const sdkAndDomainLayers = (extensionRule.to.pathNot ?? []).filter(
    (pattern) => pattern !== "^$1/",
  );
  // The inherited exclusion set must still permit the SDK and domain layers.
  assert.ok(
    sdkAndDomainLayers.some((pattern) => pattern.includes("domain")) &&
      sdkAndDomainLayers.some((pattern) => pattern.includes("sdk")),
  );

  const { cruise } = (await import("dependency-cruiser")) as {
    cruise: (
      roots: string[],
      options: Record<string, unknown>,
    ) => Promise<CruiseResult>;
  };

  return cruise([fixturesDir], {
    validate: true,
    tsPreCompilationDeps: config.options.tsPreCompilationDeps ?? true,
    doNotFollow: config.options.doNotFollow,
    enhancedResolveOptions: config.options.enhancedResolveOptions,
    ruleSet: {
      forbidden: [
        {
          name: "loaded-extension-touches-sdk-and-domain-only",
          severity: "error",
          from: { path: `^${fixturesDir}/` },
          to: { path: "^(?:packages|extensions|apps)/", pathNot: sdkAndDomainLayers },
        },
      ],
    },
  });
}

function moduleFor(result: CruiseResult, fixtureFile: string): CruiseModule {
  const source = `${fixturesDir}/${fixtureFile}`;
  const module = result.output.modules.find((entry) => entry.source === source);
  // The cruise must include the fixture file.
  assert.ok(module);
  return module!;
}

test("a loaded extension importing only SDK + domain layers passes the boundary guard", async () => {
  const result = await cruiseFixtures(await loadConfig());

  // Guard against a vacuous pass: a fixture whose imports did not RESOLVE (e.g. dist
  // missing) would trivially produce no boundary violation. Assert the SDK edge
  // actually resolved so the clean result is causal, not an artifact of a broken graph.
  const goodModule = moduleFor(result, "sdk-only-tracker.ts");
  const resolvedSdk = goodModule.dependencies.find(
    (dependency) =>
      !dependency.couldNotResolve && dependency.resolved.includes("packages/tracker-sdk/"),
  );
  // The SDK import must resolve, otherwise a clean result is vacuous, not causal.
  assert.ok(resolvedSdk);

  // An SDK + domain-only extension must touch no engine layer.
  const goodViolations = result.output.summary.violations.filter(
    (violation) => violation.from === `${fixturesDir}/sdk-only-tracker.ts`,
  );
  assert.deepEqual(goodViolations, []);
});

test("a loaded extension importing an engine package is flagged by the boundary guard", async () => {
  const result = await cruiseFixtures(await loadConfig());

  // The engine import must resolve (so the violation reflects a real edge), then be
  // flagged. If the engine edge did not resolve, the rule would never fire and the
  // guard would be toothless - assert resolution first.
  const badModule = moduleFor(result, "engine-leaking-tracker.ts");
  const resolvedEngine = badModule.dependencies.find(
    (dependency) =>
      !dependency.couldNotResolve && dependency.resolved.includes("packages/runtime/"),
  );
  // The engine import must resolve, otherwise the guard cannot prove it is forbidden.
  assert.ok(resolvedEngine);

  const badViolations = result.output.summary.violations.filter(
    (violation) => violation.from === `${fixturesDir}/engine-leaking-tracker.ts`,
  );
  assert.equal(
    badViolations.length,
    1,
    "the engine import is the single boundary violation the fixture introduces",
  );
  const [violation] = badViolations;
  assert.equal(violation!.rule.name, "loaded-extension-touches-sdk-and-domain-only");
  assert.match(
    violation!.to,
    /^packages\/runtime\//,
    "the flagged edge must be the engine package the extension reached into",
  );
});
