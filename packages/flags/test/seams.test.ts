import { afterEach, test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { getDefaultFlags } from "../src/default.js";
import { buildTestFlags, resetFlags, setFlagsForTesting, withFlags } from "../src/testing.js";

import { manifest } from "./fixture.js";

afterEach(() => {
  resetFlags();
});

test("buildTestFlags applies typed overrides at the explicit band", () => {
  const snapshot = buildTestFlags(manifest, {
    features: { fast_mode: true },
    flags: { timeout_ms: 12345 },
  });
  // Explicit override beats the enabled feature preset, same rule as production.
  assert.equal(snapshot.get("timeout_ms"), 12345);
  assert.equal(snapshot.source("timeout_ms"), "cli");
  assert.equal(snapshot.get("retries"), 1);
  assert.equal(snapshot.source("retries"), "feature");
  assert.equal(snapshot.feature("fast_mode"), true);
});

test("a feature preset applies through buildTestFlags when the flag is unset", () => {
  const snapshot = buildTestFlags(manifest, { features: { chatty: true } });
  assert.equal(snapshot.get("log_level"), "debug");
  assert.equal(snapshot.source("log_level"), "feature");
});

test("getDefaultFlags throws before a snapshot is installed", () => {
  resetFlags();
  assert.throws(() => getDefaultFlags(), /have not been initialized/);
});

test("setFlagsForTesting installs the ambient snapshot", () => {
  setFlagsForTesting(manifest, { flags: { label: "scoped" } });
  assert.equal(getDefaultFlags().get("label"), "scoped");
});

test("withFlags scopes the ambient snapshot and restores the prior install", () => {
  setFlagsForTesting(manifest, { flags: { label: "outer" } });
  withFlags(manifest, { flags: { label: "inner" } }, () => {
    assert.equal(getDefaultFlags().get("label"), "inner");
  });
  assert.equal(getDefaultFlags().get("label"), "outer");
});

test("withFlags restores the prior install even when the body throws", () => {
  setFlagsForTesting(manifest, { flags: { label: "outer" } });
  assert.throws(() =>
    withFlags(manifest, { flags: { label: "inner" } }, () => {
      throw new Error("boom");
    }),
  );
  assert.equal(getDefaultFlags().get("label"), "outer");
});

test("withFlags rejects an async callback rather than restoring flags early", () => {
  setFlagsForTesting(manifest, { flags: { label: "outer" } });
  assert.throws(
    () => withFlags(manifest, { flags: { label: "inner" } }, () => Promise.resolve("nope")),
    /requires a synchronous callback/,
  );
  assert.equal(getDefaultFlags().get("label"), "outer");
});
