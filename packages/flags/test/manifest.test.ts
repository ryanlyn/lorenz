import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import {
  defineFeatures,
  defineFlags,
  feature,
  flag,
  presetValueEqual,
  validateManifest,
} from "../src/manifest.js";
import type { FlagManifest } from "../src/types.js";

import { manifest } from "./fixture.js";

test("a well-formed manifest validates", () => {
  validateManifest(manifest);
});

test("validateManifest rejects a flag whose default fails its own schema", () => {
  const flags = defineFlags({
    count: flag.int({ default: 1.5, description: "Should be an int." }),
  });
  assert.throws(
    () => validateManifest({ flags, features: {} }),
    /default is invalid: must be an integer/,
  );
});

test("validateManifest rejects a preset that targets an unknown flag", () => {
  const flags = defineFlags({ known: flag.int({ default: 1, description: "Known." }) });
  const features = {
    // Bypass the typed builder to construct an intentionally-bad preset.
    broken: feature({ default: false, description: "Bad.", preset: { missing: 1 } }),
  };
  assert.throws(
    () => validateManifest({ flags, features } as unknown as FlagManifest),
    /presets unknown flag `missing`/,
  );
});

test("validateManifest allows two features presetting a shared flag to differing values", () => {
  // Legal for mutually-exclusive features; the conflict is authoritative only over the enabled set.
  const flags = defineFlags({ timeout_ms: flag.int({ default: 10, description: "T." }) });
  const features = defineFeatures(flags, {
    a: feature({ default: false, description: "A.", preset: { timeout_ms: 1 } }),
    b: feature({ default: false, description: "B.", preset: { timeout_ms: 2 } }),
  });
  validateManifest({ flags, features });
});

test("defineFlags rejects non-snake-case keys", () => {
  assert.throws(
    () => defineFlags({ camelCase: flag.bool({ default: false, description: "Nope." }) }),
    /must be lower_snake_case/,
  );
});

test("defineFeatures rejects non-snake-case feature names", () => {
  const flags = defineFlags({ ok: flag.bool({ default: false, description: "OK." }) });
  assert.throws(
    () =>
      defineFeatures(flags, {
        camelFeature: feature({ default: false, description: "Nope.", preset: {} }),
      }),
    /must be lower_snake_case/,
  );
});

test("flag.enum carries its allowed values for help and error text", () => {
  const def = flag.enum({ values: ["a", "b", "c"], default: "a", description: "Pick." });
  assert.deepEqual(def.values, ["a", "b", "c"]);
  assert.equal(def.kind, "enum");
});

test("presetValueEqual compares scalars by identity", () => {
  assert.equal(presetValueEqual(1, 1), true);
  assert.equal(presetValueEqual("a", "a"), true);
  assert.equal(presetValueEqual(1, 2), false);
  assert.equal(presetValueEqual("a", "b"), false);
});
