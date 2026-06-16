import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { TrackerRegistry, type TrackerProvider } from "@lorenz/tracker-sdk";

function provider(kind: string): TrackerProvider {
  return {
    kind,
    createClient: () => {
      throw new Error("not under test");
    },
  };
}

test("register/get/kinds round-trip and sorted kind listing", () => {
  const registry = new TrackerRegistry();
  const linear = provider("linear");
  registry.register(linear);
  registry.register(provider("local"));
  registry.register(provider("jira"));

  assert.equal(registry.get("linear"), linear);
  assert.equal(registry.get("unknown"), undefined);
  assert.equal(registry.get(undefined), undefined);
  assert.deepEqual(registry.kinds(), ["jira", "linear", "local"]);
});

test("registering the same provider twice is idempotent; a different one for the kind throws", () => {
  const registry = new TrackerRegistry();
  const linear = provider("linear");
  registry.register(linear);
  registry.register(linear);
  assert.deepEqual(registry.kinds(), ["linear"]);
  assert.throws(
    () => registry.register(provider("linear")),
    /tracker provider already registered for kind: linear/,
  );
});

test("blank kinds are rejected", () => {
  const registry = new TrackerRegistry();
  assert.throws(() => registry.register(provider("  ")), /kind must not be blank/);
});

test("require explains unknown kinds and lists the registered ones", () => {
  const registry = new TrackerRegistry();
  registry.register(provider("linear"));
  assert.throws(() => registry.require(undefined), /tracker\.kind is required/);
  assert.throws(
    () => registry.require("jira"),
    /unsupported tracker\.kind: jira \(known kinds: linear\)/,
  );
  assert.equal(registry.require("linear").kind, "linear");
});
