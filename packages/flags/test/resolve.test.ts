import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { flagInputsFromEnv } from "../src/env.js";
import { flagInputsFromCli, flagInputsFromFile } from "../src/layers.js";
import { resolveFlags } from "../src/resolve.js";
import type { RawLayer, RawLayers } from "../src/types.js";

import { manifest } from "./fixture.js";

const NO_WARN = { warn: () => {} };

function emptyLayer(): RawLayer {
  return { flags: [], features: [] };
}

function layers(partial: Partial<RawLayers>): RawLayers {
  return {
    cli: partial.cli ?? emptyLayer(),
    file: partial.file ?? emptyLayer(),
    env: partial.env ?? emptyLayer(),
  };
}

function cli(flagTokens: string[], featureTokens: string[] = []): RawLayer {
  return flagInputsFromCli(manifest, flagTokens, featureTokens);
}

test("empty layers resolve to manifest defaults with default provenance", () => {
  const snapshot = resolveFlags(manifest, layers({}), NO_WARN);
  assert.equal(snapshot.get("timeout_ms"), 30000);
  assert.equal(snapshot.get("log_level"), "info");
  assert.equal(snapshot.get("label"), "default");
  assert.equal(snapshot.feature("fast_mode"), false);
  assert.equal(snapshot.source("timeout_ms"), "default");
});

test("explicit flag beats an enabled feature preset (example A)", () => {
  const snapshot = resolveFlags(
    manifest,
    layers({ cli: cli(["timeout_ms=5000"], ["fast_mode"]) }),
    NO_WARN,
  );
  assert.equal(snapshot.get("timeout_ms"), 5000);
  assert.equal(snapshot.source("timeout_ms"), "cli");
  assert.equal(snapshot.get("retries"), 1);
  assert.equal(snapshot.source("retries"), "feature");
  assert.equal(snapshot.get("log_level"), "info");
  assert.equal(snapshot.feature("fast_mode"), true);
});

test("flag precedence is cli > file > env > default", () => {
  const all = resolveFlags(
    manifest,
    layers({
      cli: cli(["timeout_ms=1"]),
      file: flagInputsFromFile(manifest, { flags: { timeout_ms: 2 } }),
      env: flagInputsFromEnv(manifest, { LORENZ_FLAG_TIMEOUT_MS: "3" }),
    }),
    NO_WARN,
  );
  assert.equal(all.get("timeout_ms"), 1);
  assert.equal(all.source("timeout_ms"), "cli");

  const fileBeatsEnv = resolveFlags(
    manifest,
    layers({
      file: flagInputsFromFile(manifest, { flags: { timeout_ms: 2 } }),
      env: flagInputsFromEnv(manifest, { LORENZ_FLAG_TIMEOUT_MS: "3" }),
    }),
    NO_WARN,
  );
  assert.equal(fileBeatsEnv.get("timeout_ms"), 2);
  assert.equal(fileBeatsEnv.source("timeout_ms"), "file");

  const envOnly = resolveFlags(
    manifest,
    layers({ env: flagInputsFromEnv(manifest, { LORENZ_FLAG_TIMEOUT_MS: "3" }) }),
    NO_WARN,
  );
  assert.equal(envOnly.get("timeout_ms"), 3);
  assert.equal(envOnly.source("timeout_ms"), "env");
});

test("first-mentioning layer wins for feature enablement, even disabling a lower layer", () => {
  // file says off, env says on -> file wins -> chatty preset never applies.
  const off = resolveFlags(
    manifest,
    layers({
      file: flagInputsFromFile(manifest, { features: { chatty: false } }),
      env: flagInputsFromEnv(manifest, { LORENZ_FEATURE_CHATTY: "true" }),
    }),
    NO_WARN,
  );
  assert.equal(off.feature("chatty"), false);
  assert.equal(off.get("log_level"), "info");
  assert.equal(off.source("log_level"), "default");

  // env only -> on -> preset applies.
  const on = resolveFlags(
    manifest,
    layers({ env: flagInputsFromEnv(manifest, { LORENZ_FEATURE_CHATTY: "true" }) }),
    NO_WARN,
  );
  assert.equal(on.feature("chatty"), true);
  assert.equal(on.get("log_level"), "debug");
  assert.equal(on.source("log_level"), "feature");
  assert.equal(on.get("verbose"), true);
});

test("two enabled features presetting a flag to differing values is a hard, aggregated error", () => {
  assert.throws(
    () => resolveFlags(manifest, layers({ cli: cli([], ["fast_mode", "safe_mode"]) }), NO_WARN),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return (
        /2 problems/.test(message) &&
        /preset conflict on flag `timeout_ms`/.test(message) &&
        /preset conflict on flag `retries`/.test(message) &&
        /fast_mode/.test(message) &&
        /safe_mode/.test(message)
      );
    },
  );
});

test("an explicit flag defuses a multi-feature preset conflict", () => {
  const snapshot = resolveFlags(
    manifest,
    layers({ cli: cli(["timeout_ms=2000", "retries=2"], ["fast_mode", "safe_mode"]) }),
    NO_WARN,
  );
  assert.equal(snapshot.get("timeout_ms"), 2000);
  assert.equal(snapshot.source("timeout_ms"), "cli");
  assert.equal(snapshot.get("retries"), 2);
  assert.equal(snapshot.source("retries"), "cli");
});

test("identical preset values from two enabled features merge without conflict", () => {
  const snapshot = resolveFlags(
    manifest,
    layers({ cli: cli([], ["fast_mode", "chatty"]) }),
    NO_WARN,
  );
  // fast_mode and chatty share no flag, so both apply cleanly.
  assert.equal(snapshot.get("timeout_ms"), 1000);
  assert.equal(snapshot.get("log_level"), "debug");
});

test("unknown CLI keys aggregate into one error", () => {
  // The env layer reads only explicitly-declared names, so an undeclared LORENZ_FLAG_NOPE is
  // silently ignored rather than aggregated here.
  assert.throws(
    () =>
      resolveFlags(
        manifest,
        layers({
          cli: cli(["not_a_flag=1"], ["turbo"]),
          env: flagInputsFromEnv(manifest, { LORENZ_FLAG_NOPE: "1" }),
        }),
        NO_WARN,
      ),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return (
        /2 problems/.test(message) &&
        /unknown flag `not_a_flag`/.test(message) &&
        /unknown feature `turbo`/.test(message) &&
        !/LORENZ_FLAG_NOPE/.test(message)
      );
    },
  );
});

test("invalid values produce friendly, source-named messages", () => {
  assert.throws(
    () =>
      resolveFlags(
        manifest,
        layers({ cli: cli(["timeout_ms=abc", "retries=-1", "log_level=trace", "verbose=maybe"]) }),
        NO_WARN,
      ),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return (
        /invalid value for --flag timeout_ms=abc: must be an integer/.test(message) &&
        /invalid value for --flag retries=-1: must be a non-negative integer/.test(message) &&
        /invalid value for --flag log_level=trace: must be one of: info, debug/.test(message) &&
        /invalid value for --flag verbose=maybe: must be true or false/.test(message)
      );
    },
  );
});

test("numeric coercion is hardened against whitespace, hex, and non-finite spellings", () => {
  const ok = resolveFlags(
    manifest,
    layers({
      env: flagInputsFromEnv(manifest, {
        LORENZ_FLAG_TIMEOUT_MS: "1e3",
        LORENZ_FLAG_POOL__SIZE: "  5  ",
      }),
    }),
    NO_WARN,
  );
  assert.equal(ok.get("timeout_ms"), 1000);
  assert.equal(ok.get("pool.size"), 5);

  for (const bad of [" ", "0x10", "Infinity", "NaN"]) {
    assert.throws(
      () =>
        resolveFlags(
          manifest,
          layers({ env: flagInputsFromEnv(manifest, { LORENZ_FLAG_TIMEOUT_MS: bad }) }),
          NO_WARN,
        ),
      /must be an integer/,
    );
  }
});

test("boolean tokens are case-insensitive across layers", () => {
  const upper = resolveFlags(manifest, layers({ cli: cli(["verbose=TRUE"]) }), NO_WARN);
  assert.equal(upper.get("verbose"), true);
  const env = resolveFlags(
    manifest,
    layers({ env: flagInputsFromEnv(manifest, { LORENZ_FLAG_VERBOSE: "False" }) }),
    NO_WARN,
  );
  assert.equal(env.get("verbose"), false);
});

test("the resolved snapshot is frozen and rejects unknown reads", () => {
  const snapshot = resolveFlags(manifest, layers({}), NO_WARN);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.values), true);
  assert.throws(() => snapshot.get("nope" as never), /unknown flag/);
  assert.throws(() => snapshot.feature("nope" as never), /unknown feature/);
});
