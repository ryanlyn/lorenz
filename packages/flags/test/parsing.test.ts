import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { resetFlagDeprecationWarnings } from "../src/deprecations.js";
import { buildEnvLookup } from "../src/env.js";
import { flagInputsFromCli, flagInputsFromFile } from "../src/layers.js";
import { defineFlags, flag } from "../src/manifest.js";
import { resolveFlags } from "../src/resolve.js";
import type { RawLayer, RawLayers } from "../src/types.js";

import { manifest } from "./fixture.js";

function emptyLayer(): RawLayer {
  return { flags: [], features: [] };
}

function withCli(layer: RawLayer): RawLayers {
  return { cli: layer, file: emptyLayer(), env: emptyLayer() };
}

function capture(): { warn: (message: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (message) => messages.push(message), messages };
}

test("the CLI parser defers malformed and non-boolean tokens as issues", () => {
  const layer = flagInputsFromCli(manifest, ["timeout_ms"], ["chatty=perhaps"]);
  assert.equal(layer.flags.length, 0);
  assert.equal(layer.features.length, 0);
  assert.equal(layer.issues?.length, 2);
});

test("the CLI flag parser splits on the first '=' so values may contain '='", () => {
  const layer = flagInputsFromCli(manifest, ["label=a=b=c"], []);
  assert.equal(layer.flags[0]?.rawValue, "a=b=c");
});

test("the file parser passes native YAML scalars through to the right validator", () => {
  const snapshot = resolveFlags(
    manifest,
    {
      cli: emptyLayer(),
      file: flagInputsFromFile(manifest, { flags: { timeout_ms: 8, verbose: true, label: "x" } }),
      env: emptyLayer(),
    },
    { warn: () => {} },
  );
  assert.equal(snapshot.get("timeout_ms"), 8);
  assert.equal(snapshot.get("verbose"), true);
  assert.equal(snapshot.get("label"), "x");
});

test("a YAML null for an enum flag is reported as an invalid value, not a crash", () => {
  assert.throws(
    () =>
      resolveFlags(
        manifest,
        {
          cli: emptyLayer(),
          file: flagInputsFromFile(manifest, { flags: { log_level: null } }),
          env: emptyLayer(),
        },
        { warn: () => {} },
      ),
    /must be one of: info, debug/,
  );
});

test("a non-map flags section is a structural issue", () => {
  const layer = flagInputsFromFile(manifest, { flags: "nope" });
  assert.equal(layer.issues?.length, 1);
  assert.match(layer.issues?.[0]?.message ?? "", /must be a map/);
});

test("buildEnvLookup throws on a manifest-level env-name collision", () => {
  const flags = defineFlags({
    x: flag.bool({ default: false, description: "x." }),
    y: flag.bool({ default: false, description: "y.", envName: "LORENZ_FLAG_X" }),
  });
  assert.throws(() => buildEnvLookup({ flags, features: {} }), /maps to both/);
});

test("an explicitly-set deprecated flag warns once per process", () => {
  resetFlagDeprecationWarnings();
  const first = capture();
  resolveFlags(manifest, withCli(flagInputsFromCli(manifest, ["legacy_timeout=5000"], [])), first);
  assert.equal(first.messages.length, 1);
  assert.match(
    first.messages[0] ?? "",
    /`legacy_timeout` is deprecated\. Express the value in milliseconds\./,
  );

  const second = capture();
  resolveFlags(manifest, withCli(flagInputsFromCli(manifest, ["legacy_timeout=6000"], [])), second);
  assert.equal(second.messages.length, 0);

  resetFlagDeprecationWarnings();
  const third = capture();
  resolveFlags(manifest, withCli(flagInputsFromCli(manifest, ["legacy_timeout=7000"], [])), third);
  assert.equal(third.messages.length, 1);
});

test("a deprecated feature warns when explicitly enabled", () => {
  resetFlagDeprecationWarnings();
  const captured = capture();
  resolveFlags(manifest, withCli(flagInputsFromCli(manifest, [], ["legacy"])), captured);
  assert.equal(captured.messages.length, 1);
  assert.match(captured.messages[0] ?? "", /`legacy` is deprecated\./);
});

test("a deprecated key set to an invalid value does not consume its warning slot", () => {
  resetFlagDeprecationWarnings();
  const failed = capture();
  assert.throws(() =>
    resolveFlags(
      manifest,
      withCli(flagInputsFromCli(manifest, ["legacy_timeout=abc"], [])),
      failed,
    ),
  );
  assert.equal(failed.messages.length, 0);

  // A corrected run in the same process still warns.
  const corrected = capture();
  resolveFlags(
    manifest,
    withCli(flagInputsFromCli(manifest, ["legacy_timeout=8000"], [])),
    corrected,
  );
  assert.equal(corrected.messages.length, 1);
});

test("a deprecated key reached only via its default never warns", () => {
  resetFlagDeprecationWarnings();
  const captured = capture();
  resolveFlags(manifest, withCli(emptyLayer()), captured);
  assert.equal(captured.messages.length, 0);
});
