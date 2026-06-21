// Out-of-tree tracker loading: `tracker.kind` accepts a module specifier (npm
// name, `./relative` or `/absolute` path, optional `#exportName` suffix) that the
// daemon dynamic-imports at startup and registers into the tracker registry under
// the EXACT configured string. These tests drive the generic loader through
// temp-dir fixture modules - the SECOND instantiation of the axis-generic
// extension loader, proving it carries the same audited mechanics as the
// worker-driver loader: startup load + dispatch through the loaded provider, the
// named-export form, the SDK version handshake, malformed-module rejection, the
// known-kinds/did-you-mean resolution error, the cache-busting-query rejection,
// the module-pinned re-encounter event, and the end-to-end loadWorkflow wiring
// (parse + dispatch validation) via the prepareRegistries hook.

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, test } from "vitest";
import { parseConfig, validateDispatchConfig } from "@lorenz/config";
import { assert, tempDir } from "@lorenz/test-utils";
import { defaultAgentExecutorRegistry } from "@lorenz/agent-sdk";
import { TrackerRegistry, type TrackerProvider } from "@lorenz/tracker-sdk";
import { loadWorkflow } from "@lorenz/workflow";

import { prepareTrackerExtensions, registerBuiltinBackends } from "../src/daemon.js";
import { ensureTrackerProviderLoaded, parseTrackerRef } from "../src/trackerLoader.js";

// The end-to-end dispatch-validation test resolves the default agent executor
// (`acp`); populate the process-default executor registry the same way the CLI
// entrypoints do. The tracker stays in a PRIVATE registry per test.
beforeAll(() => {
  registerBuiltinBackends();
});

// Fixture modules import defineTrackerProvider exactly like a third-party package
// would. A temp-dir module cannot resolve the bare `@lorenz/tracker-sdk` name (no
// node_modules above it), so the fixture imports the same built module by file URL
// - byte-identical code, different resolution. This is also the npx-bundling shape:
// the loader uses native import() + pathToFileURL, never a path-alias resolver.
const sdkHref = pathToFileURL(createRequire(import.meta.url).resolve("@lorenz/tracker-sdk")).href;

/**
 * Source of a self-contained tracker module. The provider's runtime client serves
 * one synthetic in-memory issue so dispatch validation and a fetch round-trip can
 * run against it without any network.
 */
function trackerModuleSource(options: {
  kind: string;
  sdkVersion?: number;
  named?: boolean;
}): string {
  const { kind, sdkVersion = 1, named = false } = options;
  return `
import { defineTrackerProvider } from ${JSON.stringify(sdkHref)};

const providerModule = defineTrackerProvider({
  kind: ${JSON.stringify(kind)},
  sdkVersion: ${sdkVersion},
  defaultEndpoint: "https://acme.example",
  createClient(settings, context) {
    return {
      async fetchCandidateIssues() {
        return [
          {
            id: ${JSON.stringify(kind)} + "-1",
            identifier: ${JSON.stringify(kind.toUpperCase())} + "-1",
            title: "synthetic issue",
            state: "open",
            stateType: "started",
            description: "",
            url: "https://acme.example/1",
            labels: [],
            blockers: [],
          },
        ];
      },
      async fetchIssuesByIds(ids) {
        return [];
      },
    };
  },
});

${named ? `export const ${kind} = providerModule;` : "export default providerModule;"}
`;
}

async function writeFixture(dir: string, fileName: string, source: string): Promise<string> {
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, source);
  return filePath;
}

/** A private registry seeded with one built-in stub (plus optional extra kinds). */
function privateRegistry(extraKinds: string[] = []): TrackerRegistry {
  const registry = new TrackerRegistry();
  registry.register({
    kind: "fake",
    createClient: () => {
      throw new Error("stub provider fake must not build a client");
    },
  } satisfies TrackerProvider);
  for (const kind of extraKinds) {
    registry.register({
      kind,
      createClient: () => {
        throw new Error(`stub provider ${kind} must not build a client`);
      },
    } satisfies TrackerProvider);
  }
  return registry;
}

function recordingLog(): {
  events: Record<string, unknown>[];
  logEvent: (event: Record<string, unknown>) => void;
} {
  const events: Record<string, unknown>[] = [];
  return { events, logEvent: (event) => void events.push(event) };
}

// ---------------------------------------------------------------------------
// startup load + dispatch through the loaded provider
// ---------------------------------------------------------------------------

test("startup: ensureTrackerProviderLoaded registers a default-export module under the specifier", async () => {
  const dir = await tempDir("tracker-loader");
  const specifier = await writeFixture(
    dir,
    "acme-tracker.mjs",
    trackerModuleSource({ kind: "acme" }),
  );
  const registry = privateRegistry();
  const { events, logEvent } = recordingLog();

  await ensureTrackerProviderLoaded(specifier, registry, { baseDir: dir, logEvent });

  // Registered under the EXACT configured string, resolvable by the config parser.
  const provider = registry.get(specifier);
  assert.ok(provider);
  // The factory's kind IS the specifier (override-by-spread), not the module's
  // self-declared `acme`, so `validateDispatchConfig`'s require() resolves it.
  assert.equal(provider!.kind, specifier);
  // The loaded hooks survive the spread: defaultEndpoint + createClient delegate.
  assert.equal(provider!.defaultEndpoint, "https://acme.example");

  const loaded = events.find((event) => event.event === "tracker_provider_loaded");
  assert.ok(loaded);
  assert.equal(loaded!.specifier, specifier);
  // The audit event records the module's SELF-declared kind, not the specifier.
  assert.equal(loaded!.kind, "acme");
  assert.equal(loaded!.sdkVersion, 1);
  assert.match(String(loaded!.resolvedFrom), /^file:\/\/.*acme-tracker\.mjs$/);
});

test("startup: a relative specifier resolves against baseDir and dispatches a synthetic issue", async () => {
  const dir = await tempDir("tracker-loader");
  await writeFixture(dir, "rel-tracker.mjs", trackerModuleSource({ kind: "rel" }));
  const registry = privateRegistry();

  await ensureTrackerProviderLoaded("./rel-tracker.mjs", registry, { baseDir: dir });

  const provider = registry.get("./rel-tracker.mjs");
  assert.ok(provider);
  // Dispatch through the loaded client: it serves the fixture's synthetic issue.
  const settings = parseConfig({ tracker: { kind: "./rel-tracker.mjs" } }, {}, {}, registry);
  const client = provider!.createClient(settings, { env: {} });
  const issues = await client.fetchCandidateIssues();
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.identifier, "REL-1");
});

// ---------------------------------------------------------------------------
// end-to-end wiring: loadWorkflow -> prepareRegistries -> validateDispatchConfig
// ---------------------------------------------------------------------------

test("loadWorkflow: prepareTrackerExtensions loads the tracker before parse, and dispatch validates", async () => {
  const dir = await tempDir("tracker-loader");
  await writeFixture(dir, "wf-tracker.mjs", trackerModuleSource({ kind: "wf" }));
  const registry = privateRegistry();
  const workflowPath = path.join(dir, "WORKFLOW.md");
  await fs.writeFile(
    workflowPath,
    ["---", "tracker:", "  kind: ./wf-tracker.mjs", "---", "Body."].join("\n"),
  );

  const workflow = await loadWorkflow(workflowPath, {}, {
    trackers: registry,
    prepareRegistries: (rawConfig, ctx) =>
      prepareTrackerExtensions(rawConfig, { baseDir: ctx.baseDir, trackers: registry }),
  });

  // The configured kind is the specifier verbatim, registered before parse.
  assert.equal(workflow.settings.tracker.kind, "./wf-tracker.mjs");
  assert.ok(registry.get("./wf-tracker.mjs"));
  // Dispatch validation resolves the out-of-tree provider exactly like a built-in
  // (its validateDispatch hook is absent, so the require() + hook-call is the proof).
  validateDispatchConfig(workflow.settings, registry, defaultAgentExecutorRegistry);
});

// ---------------------------------------------------------------------------
// named-export form (#name)
// ---------------------------------------------------------------------------

test("a #exportName suffix selects a named export", async () => {
  const dir = await tempDir("tracker-loader");
  await writeFixture(dir, "named-tracker.mjs", trackerModuleSource({ kind: "acme", named: true }));
  const registry = privateRegistry();
  const { events, logEvent } = recordingLog();

  const kind = "./named-tracker.mjs#acme";
  await ensureTrackerProviderLoaded(kind, registry, { baseDir: dir, logEvent });

  const provider = registry.get(kind);
  assert.ok(provider);
  assert.equal(provider!.kind, kind);
  assert.equal(events.filter((event) => event.event === "tracker_provider_loaded").length, 1);
});

test("a #exportName miss fails loud listing the available exports", async () => {
  const dir = await tempDir("tracker-loader");
  await writeFixture(dir, "named-tracker.mjs", trackerModuleSource({ kind: "acme", named: true }));
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureTrackerProviderLoaded("./named-tracker.mjs#nope", registry, { baseDir: dir }),
    /tracker_provider_module_invalid: .*no export named "nope".*acme/,
  );
});

// ---------------------------------------------------------------------------
// version handshake + malformed modules (fail-loud)
// ---------------------------------------------------------------------------

test("an sdkVersion mismatch fails loud with tracker_provider_sdk_mismatch", async () => {
  const dir = await tempDir("tracker-loader");
  // defineTrackerProvider would reject v2 at authoring time, so the fixture exports
  // the raw object - exactly what an incompatible third-party module looks like.
  await writeFixture(
    dir,
    "future-tracker.mjs",
    `export default { kind: "future", sdkVersion: 2, createClient: () => { throw new Error("unreachable"); } };`,
  );
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureTrackerProviderLoaded("./future-tracker.mjs", registry, { baseDir: dir }),
    /tracker_provider_sdk_mismatch: \.\/future-tracker\.mjs targets SDK v2, this build supports v1/,
  );
  assert.equal(registry.get("./future-tracker.mjs"), undefined);
});

test("a malformed module (no createClient) fails loud with tracker_provider_module_invalid", async () => {
  const dir = await tempDir("tracker-loader");
  await writeFixture(dir, "broken-tracker.mjs", `export default { kind: "broken", sdkVersion: 1 };`);
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureTrackerProviderLoaded("./broken-tracker.mjs", registry, { baseDir: dir }),
    /tracker_provider_module_invalid: \.\/broken-tracker\.mjs.*createClient/,
  );
});

test("a module without a default export fails loud and points at #name", async () => {
  const dir = await tempDir("tracker-loader");
  await writeFixture(dir, "no-default.mjs", `export const somethingElse = 1;`);
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureTrackerProviderLoaded("./no-default.mjs", registry, { baseDir: dir }),
    /tracker_provider_module_invalid: \.\/no-default\.mjs has no default export.*somethingElse/,
  );
});

// ---------------------------------------------------------------------------
// bare-specifier resolution failures + cache-busting rejection
// ---------------------------------------------------------------------------

test("an unknown bare specifier fails loud listing the known kinds", async () => {
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureTrackerProviderLoaded("definitely-not-a-real-tracker-pkg", registry, {}),
    /tracker_provider_unavailable: definitely-not-a-real-tracker-pkg.*known kinds: .*fake/,
  );
});

test("a near-miss bare specifier appends a did-you-mean hint", async () => {
  const registry = privateRegistry(["linear"]);

  await assert.rejects(
    () => ensureTrackerProviderLoaded("linaer", registry, {}),
    /tracker_provider_unavailable: linaer.*did you mean "linear"\?/,
  );
});

test("cache-busting query strings are rejected", async () => {
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureTrackerProviderLoaded("./tracker.mjs?bust=1", registry, {}),
    /tracker_provider_invalid_specifier: .*query strings are not supported/,
  );
});

test("parseTrackerRef splits the #exportName suffix and keeps plain specifiers whole", () => {
  assert.deepEqual(parseTrackerRef("@acme/tracker"), {
    specifier: "@acme/tracker",
    exportName: undefined,
  });
  assert.deepEqual(parseTrackerRef("./trackers/acme.mjs#acmeTracker"), {
    specifier: "./trackers/acme.mjs",
    exportName: "acmeTracker",
  });
  assert.throws(() => parseTrackerRef("#name"), /empty module specifier/);
  assert.throws(() => parseTrackerRef("./tracker.mjs#"), /empty #exportName/);
});

// ---------------------------------------------------------------------------
// exact-kind-wins + reload semantics (pinning on a re-encounter)
// ---------------------------------------------------------------------------

test("an EXACT registered kind wins before parsing as a module", async () => {
  // A registered kind that also looks like a bare package name must resolve from
  // the registry, never be dynamic-imported.
  const registry = privateRegistry(["linear"]);
  const { events, logEvent } = recordingLog();

  await ensureTrackerProviderLoaded("linear", registry, { logEvent });

  // No load happened: the built-in kind short-circuits before parseRef/import.
  assert.equal(events.filter((event) => event.event === "tracker_provider_loaded").length, 0);
  assert.equal(registry.get("linear")!.kind, "linear");
});

test("reload: re-encountering an already-loaded specifier emits tracker_provider_module_pinned", async () => {
  const dir = await tempDir("tracker-loader");
  const specifier = await writeFixture(
    dir,
    "pinned-tracker.mjs",
    trackerModuleSource({ kind: "pinned" }),
  );
  const registry = privateRegistry();
  const { events, logEvent } = recordingLog();

  await ensureTrackerProviderLoaded(specifier, registry, { baseDir: dir, logEvent });
  const provider = registry.get(specifier);

  // A reload that keeps the same specifier: no re-import (Node's ESM cache pins
  // the code for the daemon lifetime), same provider, observable pinned event.
  await ensureTrackerProviderLoaded(specifier, registry, { baseDir: dir, logEvent });
  assert.equal(registry.get(specifier), provider);
  assert.equal(events.filter((event) => event.event === "tracker_provider_loaded").length, 1);
  assert.deepEqual(
    events.filter((event) => event.event === "tracker_provider_module_pinned"),
    [{ event: "tracker_provider_module_pinned", specifier }],
  );

  // A registered KIND hit (the built-in path) stays silent: no pinned event for a
  // provider this loader never imported.
  await ensureTrackerProviderLoaded("fake", registry, { baseDir: dir, logEvent });
  assert.equal(
    events.filter((event) => event.event === "tracker_provider_module_pinned").length,
    1,
  );
});
