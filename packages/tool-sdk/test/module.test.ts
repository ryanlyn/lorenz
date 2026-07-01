import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import {
  TOOL_SDK_VERSION,
  assertToolProviderModule,
  defineToolProvider,
  type ToolProviderModule,
} from "@lorenz/tool-sdk";

function validModule(overrides: Partial<ToolProviderModule> = {}): ToolProviderModule {
  return {
    name: "acme",
    sdkVersion: TOOL_SDK_VERSION,
    toolSpecs: () => [],
    executeTool: async () => ({ success: true }),
    ...overrides,
  };
}

test("assert accepts a minimal valid module and narrows it", () => {
  const value: unknown = validModule();
  assertToolProviderModule(value, "test");
  assert.equal(value.name, "acme");
  assert.equal(value.sdkVersion, TOOL_SDK_VERSION);
});

test("assert rejects non-object values", () => {
  assert.throws(
    () => assertToolProviderModule(null, "specifier"),
    /tool_provider_module_invalid: specifier did not yield a tool provider module object \(got null\)/,
  );
  assert.throws(
    () => assertToolProviderModule(42, "specifier"),
    /tool_provider_module_invalid: specifier did not yield a tool provider module object \(got number\)/,
  );
});

test("assert rejects a missing or blank name", () => {
  assert.throws(
    () =>
      assertToolProviderModule(
        { sdkVersion: 1, toolSpecs: () => [], executeTool: async () => ({}) },
        "src",
      ),
    /tool_provider_module_invalid: src is missing a non-empty string `name`/,
  );
  assert.throws(
    () => assertToolProviderModule(validModule({ name: "  " }), "src"),
    /tool_provider_module_invalid: src is missing a non-empty string `name`/,
  );
});

test("assert rejects a missing toolSpecs or executeTool function", () => {
  assert.throws(
    () =>
      assertToolProviderModule(
        { name: "acme", sdkVersion: 1, executeTool: async () => ({}) },
        "src",
      ),
    /tool_provider_module_invalid: src \(name: acme\) is missing a `toolSpecs\(settings\)` function/,
  );
  assert.throws(
    () => assertToolProviderModule({ name: "acme", sdkVersion: 1, toolSpecs: () => [] }, "src"),
    /tool_provider_module_invalid: src \(name: acme\) is missing an `executeTool\(name, input, context\)` function/,
  );
});

test("assert rejects a non-numeric sdkVersion", () => {
  assert.throws(
    () =>
      assertToolProviderModule(
        { name: "acme", toolSpecs: () => [], executeTool: async () => ({}) },
        "src",
      ),
    /tool_provider_module_invalid: src \(name: acme\) is missing a numeric `sdkVersion`/,
  );
});

test("assert rejects an sdkVersion mismatch loudly", () => {
  assert.throws(
    () => assertToolProviderModule(validModule({ sdkVersion: TOOL_SDK_VERSION + 1 }), "src"),
    new RegExp(
      `tool_provider_sdk_mismatch: src targets SDK v${TOOL_SDK_VERSION + 1}, this build supports v${TOOL_SDK_VERSION}`,
    ),
  );
});

test("define round-trips a valid module and asserts at authoring time", () => {
  const module = validModule();
  assert.equal(defineToolProvider(module), module);
  assert.throws(
    () =>
      defineToolProvider({
        name: "acme",
        sdkVersion: TOOL_SDK_VERSION,
        toolSpecs: () => [],
      } as unknown as ToolProviderModule),
    /tool_provider_module_invalid: defineToolProvider \(name: acme\) is missing an `executeTool/,
  );
});
