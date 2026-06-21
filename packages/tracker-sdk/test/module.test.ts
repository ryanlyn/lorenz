import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import {
  TRACKER_SDK_VERSION,
  assertTrackerProviderModule,
  defineTrackerProvider,
  type TrackerProviderModule,
} from "@lorenz/tracker-sdk";

function validModule(overrides: Partial<TrackerProviderModule> = {}): TrackerProviderModule {
  return {
    kind: "acme",
    sdkVersion: TRACKER_SDK_VERSION,
    createClient: () => {
      throw new Error("not under test");
    },
    ...overrides,
  };
}

test("assert accepts a minimal valid module and narrows it", () => {
  const value: unknown = validModule();
  assertTrackerProviderModule(value, "test");
  assert.equal(value.kind, "acme");
  assert.equal(value.sdkVersion, TRACKER_SDK_VERSION);
});

test("assert rejects non-object values", () => {
  assert.throws(
    () => assertTrackerProviderModule(null, "specifier"),
    /tracker_provider_module_invalid: specifier did not yield a tracker provider module object \(got null\)/,
  );
  assert.throws(
    () => assertTrackerProviderModule(() => undefined, "specifier"),
    /tracker_provider_module_invalid: specifier did not yield a tracker provider module object \(got function\)/,
  );
});

test("assert rejects a missing or blank kind", () => {
  assert.throws(
    () => assertTrackerProviderModule({ sdkVersion: 1, createClient: () => undefined }, "src"),
    /tracker_provider_module_invalid: src is missing a non-empty string `kind`/,
  );
  assert.throws(
    () => assertTrackerProviderModule(validModule({ kind: "  " }), "src"),
    /tracker_provider_module_invalid: src is missing a non-empty string `kind`/,
  );
});

test("assert rejects a missing createClient function", () => {
  assert.throws(
    () =>
      assertTrackerProviderModule(
        { kind: "acme", sdkVersion: 1, createClient: "nope" },
        "src",
      ),
    /tracker_provider_module_invalid: src \(kind: acme\) is missing a `createClient\(settings, context\)` function/,
  );
});

test("assert rejects a non-numeric sdkVersion", () => {
  assert.throws(
    () => assertTrackerProviderModule({ kind: "acme", createClient: () => undefined }, "src"),
    /tracker_provider_module_invalid: src \(kind: acme\) is missing a numeric `sdkVersion`/,
  );
});

test("assert rejects an sdkVersion mismatch loudly", () => {
  assert.throws(
    () => assertTrackerProviderModule(validModule({ sdkVersion: TRACKER_SDK_VERSION + 1 }), "src"),
    new RegExp(
      `tracker_provider_sdk_mismatch: src targets SDK v${TRACKER_SDK_VERSION + 1}, this build supports v${TRACKER_SDK_VERSION}`,
    ),
  );
});

test("define round-trips a valid module and asserts at authoring time", () => {
  const module = validModule();
  assert.equal(defineTrackerProvider(module), module);
  assert.throws(
    () => defineTrackerProvider({ kind: "acme", sdkVersion: 99 } as unknown as TrackerProviderModule),
    /tracker_provider_module_invalid: defineTrackerProvider \(kind: acme\) is missing a `createClient/,
  );
});
