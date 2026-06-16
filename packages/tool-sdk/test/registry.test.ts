import { test } from "vitest";
import { assert } from "@lorenz/test-utils";
import type { Settings } from "@lorenz/domain";

import {
  ToolRegistry,
  executeMountedTool,
  mountedToolSpecs,
  type ToolProvider,
} from "@lorenz/tool-sdk";

const settings = { tracker: {} } as unknown as Settings;

function pack(name: string, tools: string[], behavior?: () => unknown): ToolProvider {
  return {
    name,
    toolSpecs: () =>
      tools.map((tool) => ({ name: tool, description: tool, inputSchema: { type: "object" } })),
    executeTool: async (tool) => ({
      success: true,
      result: { pack: name, tool, value: behavior?.() },
    }),
  };
}

test("register/get/names round-trip; duplicate names rejected; blank rejected", () => {
  const registry = new ToolRegistry();
  const linear = pack("linear", ["linear_graphql"]);
  registry.register(linear);
  registry.register(linear);
  registry.register(pack("tracker", ["tracker_query"]));
  assert.deepEqual(registry.names(), ["linear", "tracker"]);
  assert.throws(
    () => registry.register(pack("linear", [])),
    /tool provider already registered for name: linear/,
  );
  assert.throws(() => registry.register(pack("  ", [])), /name must not be blank/);
});

test("require lists known packs, and explains registration when empty", () => {
  const registry = new ToolRegistry();
  assert.throws(
    () => registry.require("linear"),
    /no tool packs registered - register tool packs at the composition root/,
  );
  registry.register(pack("tracker", []));
  assert.throws(
    () => registry.require("linear"),
    /unsupported tool pack: linear \(known tool packs: tracker\)/,
  );
});

test("mountedToolSpecs flattens packs and fails loudly on tool-name collisions", () => {
  const specs = mountedToolSpecs(
    [pack("tracker", ["tracker_query"]), pack("linear", ["linear_graphql"])],
    settings,
  );
  assert.deepEqual(
    specs.map((spec) => spec.name),
    ["tracker_query", "linear_graphql"],
  );
  assert.throws(
    () =>
      mountedToolSpecs(
        [pack("tracker", ["tracker_query"]), pack("other", ["tracker_query"])],
        settings,
      ),
    /tool name collision: tracker_query is declared by both the "tracker" and "other" packs/,
  );
});

test("executeMountedTool routes to the declaring pack and reports unknown tools", async () => {
  const packs = [pack("tracker", ["tracker_query"]), pack("linear", ["linear_graphql"])];
  const routed = await executeMountedTool(
    packs,
    "linear_graphql",
    {},
    { settings, fetchImpl: fetch, env: {} },
  );
  assert.equal(routed.success, true);
  assert.deepEqual(routed.result, { pack: "linear", tool: "linear_graphql", value: undefined });

  const unknown = await executeMountedTool(
    packs,
    "local_query",
    {},
    { settings, fetchImpl: fetch, env: {} },
  );
  assert.equal(unknown.success, false);
  assert.match(unknown.error ?? "", /Unsupported tool: "local_query"/);
});

test("a throwing pack surfaces as a failed result, not a transport error", async () => {
  const exploding = pack("boom", ["boom_tool"], () => {
    throw new Error("pack exploded");
  });
  const result = await executeMountedTool(
    [exploding],
    "boom_tool",
    {},
    { settings, fetchImpl: fetch, env: {} },
  );
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /pack exploded/);
});
