// Out-of-tree agent-executor loading: a configured `agents.<kind>.executor`
// accepts a module specifier (npm name, `./relative` or `/absolute` path,
// optional `#exportName` suffix) that the daemon dynamic-imports at startup and
// registers into the executor registry under the EXACT configured string. These
// tests drive the generic loader through temp-dir fixture modules - the FOURTH
// instantiation of the axis-generic extension loader, proving it carries the same
// audited mechanics as the worker-driver, tracker, and tool loaders: startup load
// + createExecutor through the loaded provider, the named-export form, the SDK
// version handshake, malformed-module rejection, the known-executors/did-you-mean
// resolution error, the cache-busting rejection, the module-pinned re-encounter
// event, and exact-selector-wins. The `executor`-as-identity field (vs the
// tracker's `kind`) and the `executors()`->`kinds()` registry adapter are the two
// agent-axis specifics this suite locks down.

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { test } from "vitest";
import { assert, tempDir } from "@lorenz/test-utils";
import { AgentExecutorRegistry, type AgentExecutorProvider } from "@lorenz/agent-sdk";

import { ensureAgentExecutorLoaded, parseAgentExecutorRef } from "../src/agentExecutorLoader.js";

// Fixture modules import defineAgentExecutor exactly like a third-party package
// would. A temp-dir module cannot resolve the bare `@lorenz/agent-sdk` name (no
// node_modules above it), so the fixture imports the same built module by file
// URL - byte-identical code, different resolution. This is also the npx-bundling
// shape: the loader uses native import() + pathToFileURL, never a path-alias
// resolver.
const sdkHref = pathToFileURL(createRequire(import.meta.url).resolve("@lorenz/agent-sdk")).href;

/**
 * Source of a self-contained agent-executor module. createExecutor returns a
 * minimal executor whose `kind` echoes the requested agent kind so a load +
 * construct round-trip can run without any runtime dependency.
 */
function executorModuleSource(options: {
  executor: string;
  sdkVersion?: number;
  named?: boolean;
}): string {
  const { executor, sdkVersion = 1, named = false } = options;
  return `
import { defineAgentExecutor } from ${JSON.stringify(sdkHref)};

const providerModule = defineAgentExecutor({
  executor: ${JSON.stringify(executor)},
  sdkVersion: ${sdkVersion},
  createExecutor(kind) {
    return {
      kind,
      async startSession() {
        throw new Error("fixture executor does not start sessions");
      },
      async runTurn() {
        return [];
      },
    };
  },
});

${named ? `export const ${executor} = providerModule;` : "export default providerModule;"}
`;
}

async function writeFixture(dir: string, fileName: string, source: string): Promise<string> {
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, source);
  return filePath;
}

/** A private registry seeded with one built-in stub (plus optional extra selectors). */
function privateRegistry(extraExecutors: string[] = []): AgentExecutorRegistry {
  const registry = new AgentExecutorRegistry();
  const stub = (executor: string): AgentExecutorProvider => ({
    executor,
    createExecutor: () => {
      throw new Error(`stub executor ${executor} must not be constructed`);
    },
  });
  registry.register(stub("acp"));
  for (const executor of extraExecutors) registry.register(stub(executor));
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
// startup load + construct through the loaded provider
// ---------------------------------------------------------------------------

test("startup: ensureAgentExecutorLoaded registers a default-export module under the specifier", async () => {
  const dir = await tempDir("agent-executor-loader");
  const specifier = await writeFixture(
    dir,
    "acme-executor.mjs",
    executorModuleSource({ executor: "acme" }),
  );
  const registry = privateRegistry();
  const { events, logEvent } = recordingLog();

  await ensureAgentExecutorLoaded(specifier, registry, { baseDir: dir, logEvent });

  // Registered under the EXACT configured string, resolvable by the agent-runner.
  const provider = registry.get(specifier);
  assert.ok(provider);
  // The factory's executor IS the specifier (override-by-spread), not the
  // module's self-declared `acme`, so the runner's require() resolves it.
  assert.equal(provider!.executor, specifier);

  const loaded = events.find((event) => event.event === "agent_executor_loaded");
  assert.ok(loaded);
  assert.equal(loaded!.specifier, specifier);
  // The audit event records the module's SELF-declared executor (mapped to `kind`).
  assert.equal(loaded!.kind, "acme");
  assert.equal(loaded!.sdkVersion, 1);
  assert.match(String(loaded!.resolvedFrom), /^file:\/\/.*acme-executor\.mjs$/);
});

test("startup: a relative specifier resolves against baseDir and constructs an executor", async () => {
  const dir = await tempDir("agent-executor-loader");
  await writeFixture(dir, "rel-executor.mjs", executorModuleSource({ executor: "rel" }));
  const registry = privateRegistry();

  await ensureAgentExecutorLoaded("./rel-executor.mjs", registry, { baseDir: dir });

  const provider = registry.get("./rel-executor.mjs");
  assert.ok(provider);
  // The loaded createExecutor hook survives the spread and echoes the kind.
  const executor = await provider!.createExecutor("worker", {} as never);
  assert.equal(executor.kind, "worker");
});

// ---------------------------------------------------------------------------
// named-export form (#name)
// ---------------------------------------------------------------------------

test("a #exportName suffix selects a named export", async () => {
  const dir = await tempDir("agent-executor-loader");
  await writeFixture(dir, "named-executor.mjs", executorModuleSource({ executor: "acme", named: true }));
  const registry = privateRegistry();
  const { events, logEvent } = recordingLog();

  const executor = "./named-executor.mjs#acme";
  await ensureAgentExecutorLoaded(executor, registry, { baseDir: dir, logEvent });

  const provider = registry.get(executor);
  assert.ok(provider);
  assert.equal(provider!.executor, executor);
  assert.equal(events.filter((event) => event.event === "agent_executor_loaded").length, 1);
});

test("a #exportName miss fails loud listing the available exports", async () => {
  const dir = await tempDir("agent-executor-loader");
  await writeFixture(dir, "named-executor.mjs", executorModuleSource({ executor: "acme", named: true }));
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureAgentExecutorLoaded("./named-executor.mjs#nope", registry, { baseDir: dir }),
    /agent_executor_module_invalid: .*no export named "nope".*acme/,
  );
});

// ---------------------------------------------------------------------------
// version handshake + malformed modules (fail-loud)
// ---------------------------------------------------------------------------

test("an sdkVersion mismatch fails loud with agent_executor_sdk_mismatch", async () => {
  const dir = await tempDir("agent-executor-loader");
  // defineAgentExecutor would reject v2 at authoring time, so the fixture exports
  // the raw object - exactly what an incompatible third-party module looks like.
  await writeFixture(
    dir,
    "future-executor.mjs",
    `export default { executor: "future", sdkVersion: 2, createExecutor: () => { throw new Error("unreachable"); } };`,
  );
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureAgentExecutorLoaded("./future-executor.mjs", registry, { baseDir: dir }),
    /agent_executor_sdk_mismatch: \.\/future-executor\.mjs targets SDK v2, this build supports v1/,
  );
  assert.equal(registry.get("./future-executor.mjs"), undefined);
});

test("a malformed module (no createExecutor) fails loud with agent_executor_module_invalid", async () => {
  const dir = await tempDir("agent-executor-loader");
  await writeFixture(
    dir,
    "broken-executor.mjs",
    `export default { executor: "broken", sdkVersion: 1 };`,
  );
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureAgentExecutorLoaded("./broken-executor.mjs", registry, { baseDir: dir }),
    /agent_executor_module_invalid: \.\/broken-executor\.mjs.*createExecutor/,
  );
});

test("a module without a default export fails loud and points at #name", async () => {
  const dir = await tempDir("agent-executor-loader");
  await writeFixture(dir, "no-default.mjs", `export const somethingElse = 1;`);
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureAgentExecutorLoaded("./no-default.mjs", registry, { baseDir: dir }),
    /agent_executor_module_invalid: \.\/no-default\.mjs has no default export.*somethingElse/,
  );
});

// ---------------------------------------------------------------------------
// bare-specifier resolution failures + cache-busting rejection
// ---------------------------------------------------------------------------

test("an unknown bare specifier fails loud listing the known executors", async () => {
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureAgentExecutorLoaded("definitely-not-a-real-executor-pkg", registry, {}),
    /agent_executor_unavailable: definitely-not-a-real-executor-pkg.*known kinds: .*acp/,
  );
});

test("a near-miss bare specifier appends a did-you-mean hint", async () => {
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureAgentExecutorLoaded("apc", registry, {}),
    /agent_executor_unavailable: apc.*did you mean "acp"\?/,
  );
});

test("cache-busting query strings are rejected", async () => {
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureAgentExecutorLoaded("./executor.mjs?bust=1", registry, {}),
    /agent_executor_invalid_specifier: .*query strings are not supported/,
  );
});

test("parseAgentExecutorRef splits the #exportName suffix and keeps plain specifiers whole", () => {
  assert.deepEqual(parseAgentExecutorRef("@acme/executor"), {
    specifier: "@acme/executor",
    exportName: undefined,
  });
  assert.deepEqual(parseAgentExecutorRef("./executors/acme.mjs#acmeExecutor"), {
    specifier: "./executors/acme.mjs",
    exportName: "acmeExecutor",
  });
  assert.throws(() => parseAgentExecutorRef("#name"), /empty module specifier/);
  assert.throws(() => parseAgentExecutorRef("./executor.mjs#"), /empty #exportName/);
});

// ---------------------------------------------------------------------------
// exact-selector-wins + reload semantics (pinning on a re-encounter)
// ---------------------------------------------------------------------------

test("an EXACT registered selector wins before parsing as a module", async () => {
  // A registered selector that also looks like a bare package name must resolve
  // from the registry, never be dynamic-imported.
  const registry = privateRegistry();
  const { events, logEvent } = recordingLog();

  await ensureAgentExecutorLoaded("acp", registry, { logEvent });

  // No load happened: the built-in selector short-circuits before parseRef/import.
  assert.equal(events.filter((event) => event.event === "agent_executor_loaded").length, 0);
  assert.equal(registry.get("acp")!.executor, "acp");
});

test("reload: re-encountering an already-loaded specifier emits agent_executor_module_pinned", async () => {
  const dir = await tempDir("agent-executor-loader");
  const specifier = await writeFixture(
    dir,
    "pinned-executor.mjs",
    executorModuleSource({ executor: "pinned" }),
  );
  const registry = privateRegistry();
  const { events, logEvent } = recordingLog();

  await ensureAgentExecutorLoaded(specifier, registry, { baseDir: dir, logEvent });
  const provider = registry.get(specifier);

  // A reload that keeps the same specifier: no re-import (Node's ESM cache pins
  // the code for the daemon lifetime), same provider, observable pinned event.
  await ensureAgentExecutorLoaded(specifier, registry, { baseDir: dir, logEvent });
  assert.equal(registry.get(specifier), provider);
  assert.equal(events.filter((event) => event.event === "agent_executor_loaded").length, 1);
  assert.deepEqual(
    events.filter((event) => event.event === "agent_executor_module_pinned"),
    [{ event: "agent_executor_module_pinned", specifier }],
  );

  // A registered SELECTOR hit (the built-in path) stays silent: no pinned event
  // for an executor this loader never imported.
  await ensureAgentExecutorLoaded("acp", registry, { baseDir: dir, logEvent });
  assert.equal(
    events.filter((event) => event.event === "agent_executor_module_pinned").length,
    1,
  );
});
