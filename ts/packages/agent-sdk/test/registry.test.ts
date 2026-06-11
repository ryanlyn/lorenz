import { test } from "vitest";
import { assert } from "@symphony/test-utils";

import { AgentExecutorRegistry, type AgentExecutorProvider } from "@symphony/agent-sdk";

function provider(executor: string): AgentExecutorProvider {
  return {
    executor,
    createExecutor: () => {
      throw new Error("not under test");
    },
  };
}

test("register/get/executors round-trip with sorted listing", () => {
  const registry = new AgentExecutorRegistry();
  const acp = provider("acp");
  registry.register(acp);
  registry.register(provider("docker"));

  assert.equal(registry.get("acp"), acp);
  assert.equal(registry.get("unknown"), undefined);
  assert.equal(registry.get(undefined), undefined);
  assert.deepEqual(registry.executors(), ["acp", "docker"]);
});

test("re-registering the same provider is idempotent; a different one for the selector throws", () => {
  const registry = new AgentExecutorRegistry();
  const acp = provider("acp");
  registry.register(acp);
  registry.register(acp);
  assert.deepEqual(registry.executors(), ["acp"]);
  assert.throws(
    () => registry.register(provider("acp")),
    /agent executor provider already registered: acp/,
  );
  assert.throws(() => registry.register(provider(" ")), /selector must not be blank/);
});

test("require explains unknown selectors and lists the registered ones", () => {
  const registry = new AgentExecutorRegistry();
  registry.register(provider("acp"));
  assert.throws(
    () => registry.require("docker"),
    /unsupported agent executor: docker \(known executors: acp\)/,
  );
  assert.equal(registry.require("acp").executor, "acp");
});
