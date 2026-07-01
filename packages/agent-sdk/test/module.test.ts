import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import {
  AGENT_EXECUTOR_SDK_VERSION,
  assertAgentExecutorModule,
  defineAgentExecutor,
  type AgentExecutorModule,
} from "@lorenz/agent-sdk";

function validModule(overrides: Partial<AgentExecutorModule> = {}): AgentExecutorModule {
  return {
    executor: "acme",
    sdkVersion: AGENT_EXECUTOR_SDK_VERSION,
    createExecutor: () => {
      throw new Error("not under test");
    },
    ...overrides,
  };
}

test("assert accepts a minimal valid module and narrows it", () => {
  const value: unknown = validModule();
  assertAgentExecutorModule(value, "test");
  assert.equal(value.executor, "acme");
  assert.equal(value.sdkVersion, AGENT_EXECUTOR_SDK_VERSION);
});

test("assert rejects non-object values", () => {
  assert.throws(
    () => assertAgentExecutorModule(null, "specifier"),
    /agent_executor_module_invalid: specifier did not yield an agent executor module object \(got null\)/,
  );
  assert.throws(
    () => assertAgentExecutorModule("nope", "specifier"),
    /agent_executor_module_invalid: specifier did not yield an agent executor module object \(got string\)/,
  );
});

test("assert rejects a missing or blank executor", () => {
  assert.throws(
    () => assertAgentExecutorModule({ sdkVersion: 1, createExecutor: () => undefined }, "src"),
    /agent_executor_module_invalid: src is missing a non-empty string `executor`/,
  );
  assert.throws(
    () => assertAgentExecutorModule(validModule({ executor: "  " }), "src"),
    /agent_executor_module_invalid: src is missing a non-empty string `executor`/,
  );
});

test("assert rejects a missing createExecutor function", () => {
  assert.throws(
    () => assertAgentExecutorModule({ executor: "acme", sdkVersion: 1 }, "src"),
    /agent_executor_module_invalid: src \(executor: acme\) is missing a `createExecutor\(kind, settings, env\)` function/,
  );
});

test("assert rejects a non-numeric sdkVersion", () => {
  assert.throws(
    () => assertAgentExecutorModule({ executor: "acme", createExecutor: () => undefined }, "src"),
    /agent_executor_module_invalid: src \(executor: acme\) is missing a numeric `sdkVersion`/,
  );
});

test("assert rejects an sdkVersion mismatch loudly", () => {
  assert.throws(
    () =>
      assertAgentExecutorModule(validModule({ sdkVersion: AGENT_EXECUTOR_SDK_VERSION + 1 }), "src"),
    new RegExp(
      `agent_executor_sdk_mismatch: src targets SDK v${AGENT_EXECUTOR_SDK_VERSION + 1}, this build supports v${AGENT_EXECUTOR_SDK_VERSION}`,
    ),
  );
});

test("define round-trips a valid module and asserts at authoring time", () => {
  const module = validModule();
  assert.equal(defineAgentExecutor(module), module);
  assert.throws(
    () =>
      defineAgentExecutor({
        executor: "acme",
        sdkVersion: AGENT_EXECUTOR_SDK_VERSION,
      } as unknown as AgentExecutorModule),
    /agent_executor_module_invalid: defineAgentExecutor \(executor: acme\) is missing a `createExecutor/,
  );
});
