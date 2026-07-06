// Out-of-tree tool-pack loading driven through temp-dir fixture modules: startup
// load + execute, the named-export form, the SDK version handshake,
// malformed-module rejection, the did-you-mean resolution error, cache-busting
// rejection, the module-pinned re-encounter event, and exact-name-wins. The
// `name`-as-identity field and the `names()`->`kinds()` registry adapter are the
// tool-axis specifics this suite locks down.

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { test } from "vitest";
import { assert, tempDir } from "@lorenz/test-utils";
import { ToolRegistry, type ToolProvider } from "@lorenz/tool-sdk";

import { ensureToolProviderLoaded, parseToolRef } from "../src/toolLoader.js";

// Fixture modules import defineToolProvider exactly like a third-party package
// would. A temp-dir module cannot resolve the bare `@lorenz/tool-sdk` name (no
// node_modules above it), so the fixture imports the same built module by file
// URL - byte-identical code, different resolution. This is also the npx-bundling
// shape: the loader uses native import() + pathToFileURL, never a path-alias
// resolver.
const sdkHref = pathToFileURL(createRequire(import.meta.url).resolve("@lorenz/tool-sdk")).href;

/**
 * Source of a self-contained tool module. The pack advertises one echo tool and
 * executes it in-memory so a load + execute round-trip can run without any
 * network or settings dependency.
 */
function toolModuleSource(options: { name: string; sdkVersion?: number; named?: boolean }): string {
  const { name, sdkVersion = 1, named = false } = options;
  return `
import { defineToolProvider } from ${JSON.stringify(sdkHref)};

const providerModule = defineToolProvider({
  name: ${JSON.stringify(name)},
  sdkVersion: ${sdkVersion},
  toolSpecs() {
    return [
      {
        name: ${JSON.stringify(`${name}_echo`)},
        description: "echo the input back",
        inputSchema: { type: "object", properties: { value: { type: "string" } } },
      },
    ];
  },
  async executeTool(toolName, input) {
    return { success: true, result: { tool: toolName, echoed: input } };
  },
});

${named ? `export const ${name} = providerModule;` : "export default providerModule;"}
`;
}

async function writeFixture(dir: string, fileName: string, source: string): Promise<string> {
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, source);
  return filePath;
}

/** A private registry seeded with one built-in stub (plus optional extra names). */
function privateRegistry(extraNames: string[] = []): ToolRegistry {
  const registry = new ToolRegistry();
  const stub = (name: string): ToolProvider => ({
    name,
    toolSpecs: () => [],
    executeTool: async () => {
      throw new Error(`stub pack ${name} must not execute a tool`);
    },
  });
  registry.register(stub("jira"));
  for (const name of extraNames) registry.register(stub(name));
  return registry;
}

function recordingLog(): {
  events: Record<string, unknown>[];
  logEvent: (event: Record<string, unknown>) => void;
} {
  const events: Record<string, unknown>[] = [];
  return { events, logEvent: (event) => void events.push(event) };
}

// startup load + execute through the loaded pack

test("startup: ensureToolProviderLoaded registers a default-export module under the specifier", async () => {
  const dir = await tempDir("tool-loader");
  const specifier = await writeFixture(dir, "acme-tools.mjs", toolModuleSource({ name: "acme" }));
  const registry = privateRegistry();
  const { events, logEvent } = recordingLog();

  await ensureToolProviderLoaded(specifier, registry, { baseDir: dir, logEvent });

  // Registered under the EXACT configured string, resolvable by the MCP mount.
  const provider = registry.get(specifier);
  assert.ok(provider);
  // The factory's name IS the specifier (override-by-spread), not the module's
  // self-declared `acme`, so the mount's require() resolves it.
  assert.equal(provider!.name, specifier);

  const loaded = events.find((event) => event.event === "tool_provider_loaded");
  assert.ok(loaded);
  assert.equal(loaded!.specifier, specifier);
  // The audit event records the module's SELF-declared name (mapped to `kind`).
  assert.equal(loaded!.kind, "acme");
  assert.equal(loaded!.sdkVersion, 1);
  assert.match(String(loaded!.resolvedFrom), /^file:\/\/.*acme-tools\.mjs$/);
});

test("startup: a relative specifier resolves against baseDir and executes a tool", async () => {
  const dir = await tempDir("tool-loader");
  await writeFixture(dir, "rel-tools.mjs", toolModuleSource({ name: "rel" }));
  const registry = privateRegistry();

  await ensureToolProviderLoaded("./rel-tools.mjs", registry, { baseDir: dir });

  const provider = registry.get("./rel-tools.mjs");
  assert.ok(provider);
  // The loaded hooks survive the spread: toolSpecs + executeTool delegate.
  const specs = provider!.toolSpecs({} as never);
  assert.equal(specs.length, 1);
  assert.equal(specs[0]!.name, "rel_echo");
  const result = await provider!.executeTool("rel_echo", { value: "hi" }, {} as never);
  assert.equal(result.success, true);
  assert.deepEqual(result.result, { tool: "rel_echo", echoed: { value: "hi" } });
});

// named-export form (#name)

test("a #exportName suffix selects a named export", async () => {
  const dir = await tempDir("tool-loader");
  await writeFixture(dir, "named-tools.mjs", toolModuleSource({ name: "acme", named: true }));
  const registry = privateRegistry();
  const { events, logEvent } = recordingLog();

  const name = "./named-tools.mjs#acme";
  await ensureToolProviderLoaded(name, registry, { baseDir: dir, logEvent });

  const provider = registry.get(name);
  assert.ok(provider);
  assert.equal(provider!.name, name);
  assert.equal(events.filter((event) => event.event === "tool_provider_loaded").length, 1);
});

test("a #exportName miss fails loud listing the available exports", async () => {
  const dir = await tempDir("tool-loader");
  await writeFixture(dir, "named-tools.mjs", toolModuleSource({ name: "acme", named: true }));
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureToolProviderLoaded("./named-tools.mjs#nope", registry, { baseDir: dir }),
    /tool_provider_module_invalid: .*no export named "nope".*acme/,
  );
});

// version handshake + malformed modules (fail-loud)

test("an sdkVersion mismatch fails loud with tool_provider_sdk_mismatch", async () => {
  const dir = await tempDir("tool-loader");
  // defineToolProvider would reject v2 at authoring time, so the fixture exports
  // the raw object - exactly what an incompatible third-party module looks like.
  await writeFixture(
    dir,
    "future-tools.mjs",
    `export default { name: "future", sdkVersion: 2, toolSpecs: () => [], executeTool: async () => ({ success: true }) };`,
  );
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureToolProviderLoaded("./future-tools.mjs", registry, { baseDir: dir }),
    /tool_provider_sdk_mismatch: \.\/future-tools\.mjs targets SDK v2, this build supports v1/,
  );
  assert.equal(registry.get("./future-tools.mjs"), undefined);
});

test("a malformed module (no executeTool) fails loud with tool_provider_module_invalid", async () => {
  const dir = await tempDir("tool-loader");
  await writeFixture(
    dir,
    "broken-tools.mjs",
    `export default { name: "broken", sdkVersion: 1, toolSpecs: () => [] };`,
  );
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureToolProviderLoaded("./broken-tools.mjs", registry, { baseDir: dir }),
    /tool_provider_module_invalid: \.\/broken-tools\.mjs.*executeTool/,
  );
});

test("a module without a default export fails loud and points at #name", async () => {
  const dir = await tempDir("tool-loader");
  await writeFixture(dir, "no-default.mjs", `export const somethingElse = 1;`);
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureToolProviderLoaded("./no-default.mjs", registry, { baseDir: dir }),
    /tool_provider_module_invalid: \.\/no-default\.mjs has no default export.*somethingElse/,
  );
});

// bare-specifier resolution failures + cache-busting rejection

test("an unknown bare specifier fails loud listing the known names", async () => {
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureToolProviderLoaded("definitely-not-a-real-tool-pkg", registry, {}),
    /tool_provider_unavailable: definitely-not-a-real-tool-pkg.*known kinds: .*jira/,
  );
});

test("a near-miss bare specifier appends a did-you-mean hint", async () => {
  const registry = privateRegistry(["github"]);

  await assert.rejects(
    () => ensureToolProviderLoaded("gthub", registry, {}),
    /tool_provider_unavailable: gthub.*did you mean "github"\?/,
  );
});

test("cache-busting query strings are rejected", async () => {
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureToolProviderLoaded("./tools.mjs?bust=1", registry, {}),
    /tool_provider_invalid_specifier: .*query strings are not supported/,
  );
});

test("parseToolRef splits the #exportName suffix and keeps plain specifiers whole", () => {
  assert.deepEqual(parseToolRef("@acme/tools"), {
    specifier: "@acme/tools",
    exportName: undefined,
  });
  assert.deepEqual(parseToolRef("./tools/acme.mjs#acmeTools"), {
    specifier: "./tools/acme.mjs",
    exportName: "acmeTools",
  });
  assert.throws(() => parseToolRef("#name"), /empty module specifier/);
  assert.throws(() => parseToolRef("./tools.mjs#"), /empty #exportName/);
});

// exact-name-wins + reload semantics (pinning on a re-encounter)

test("an EXACT registered name wins before parsing as a module", async () => {
  // A registered pack name that also looks like a bare package name must resolve
  // from the registry, never be dynamic-imported.
  const registry = privateRegistry(["github"]);
  const { events, logEvent } = recordingLog();

  await ensureToolProviderLoaded("github", registry, { logEvent });

  // No load happened: the built-in name short-circuits before parseRef/import.
  assert.equal(events.filter((event) => event.event === "tool_provider_loaded").length, 0);
  assert.equal(registry.get("github")!.name, "github");
});

test("reload: re-encountering an already-loaded specifier emits tool_provider_module_pinned", async () => {
  const dir = await tempDir("tool-loader");
  const specifier = await writeFixture(
    dir,
    "pinned-tools.mjs",
    toolModuleSource({ name: "pinned" }),
  );
  const registry = privateRegistry();
  const { events, logEvent } = recordingLog();

  await ensureToolProviderLoaded(specifier, registry, { baseDir: dir, logEvent });
  const provider = registry.get(specifier);

  // A reload that keeps the same specifier: no re-import (Node's ESM cache pins
  // the code for the daemon lifetime), same provider, observable pinned event.
  await ensureToolProviderLoaded(specifier, registry, { baseDir: dir, logEvent });
  assert.equal(registry.get(specifier), provider);
  assert.equal(events.filter((event) => event.event === "tool_provider_loaded").length, 1);
  assert.deepEqual(
    events.filter((event) => event.event === "tool_provider_module_pinned"),
    [{ event: "tool_provider_module_pinned", specifier }],
  );

  // A registered NAME hit (the built-in path) stays silent: no pinned event for a
  // pack this loader never imported.
  await ensureToolProviderLoaded("jira", registry, { baseDir: dir, logEvent });
  assert.equal(events.filter((event) => event.event === "tool_provider_module_pinned").length, 1);
});
