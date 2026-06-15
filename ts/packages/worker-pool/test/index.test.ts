import { assert } from "@lorenz/test-utils";
import { test } from "vitest";
import type { WorkerPoolSettings } from "@lorenz/domain";
import { systemClock, withDerivedMaxInFlight } from "@lorenz/domain";

// Everything under test is pulled from the public barrel so this file exercises
// the package exactly as a downstream consumer (the runtime/CLI) would.
import * as barrel from "../src/index.js";
import {
  WorkerDriverRegistry,
  createWorkerPool,
  createMutex,
  defaultWorkerDriverRegistry,
  FakeWorkerDriver,
  POOL_OWNED_LABEL,
  registerFakeWorkerDriver,
} from "../src/index.js";

// A full settings object so `createWorkerPool` has every knob it reads; only
// `enabled`/`driver` matter for these wiring tests but the type wants the rest.
function poolSettings(overrides: Partial<WorkerPoolSettings> = {}): WorkerPoolSettings {
  const { maxInFlight, slotsPerMachine, ...rest } = overrides;
  return withDerivedMaxInFlight({
    enabled: true,
    driver: "fake",
    min: 0,
    max: 1,
    warm: 0,
    slotsPerMachine: slotsPerMachine ?? maxInFlight ?? 1,
    ttlMs: 3_600_000,
    idleReapMs: 300_000,
    acquireTimeoutMs: 1_000,
    reapIntervalMs: 15_000,
    staleHeartbeatMs: 600_000,
    drainDeadlineMs: 30_000,
    ...rest,
  });
}

const baseDeps = {
  clock: systemClock,
  logEvent: () => undefined,
};

test("the barrel has NO import side effects: nothing is registered into the default registry", () => {
  // Importing the barrel must register nothing: drivers live in extensions (and
  // the fake in the SDK), and only the composition root wires them in. This
  // test runs FIRST in this file, before any test below touches the default
  // registry, so the assertion observes the pure import-time state.
  assert.deepEqual(defaultWorkerDriverRegistry.kinds(), []);
  assert.equal(defaultWorkerDriverRegistry.get("fake"), undefined);
});

test("the barrel exposes exactly the pool engine surface plus the SDK re-exports (no conformance)", () => {
  // Pin the runtime (value) export list so a side-door export - including the
  // SDK conformance kit, which must stay behind `@lorenz/worker-sdk/conformance` -
  // cannot creep into the engine barrel unnoticed.
  assert.deepEqual(Object.keys(barrel).sort(), [
    "FakeWorkerDriver",
    "POOL_OWNED_LABEL",
    "WorkerDriverRegistry",
    "createMutex",
    "createWorkerPool",
    "defaultWorkerDriverRegistry",
    "registerFakeWorkerDriver",
  ]);
});

test("the barrel re-exports the SDK driver surface as usable values", () => {
  assert.equal(typeof WorkerDriverRegistry, "function");
  assert.equal(typeof FakeWorkerDriver, "function");
  assert.equal(typeof registerFakeWorkerDriver, "function");
  assert.equal(typeof createMutex, "function");
  assert.equal(POOL_OWNED_LABEL, "lorenz.pool=worker-pool");
  assert.ok(defaultWorkerDriverRegistry instanceof WorkerDriverRegistry);
});

test("createWorkerPool resolves the driver from an explicit registry passed via deps.drivers", () => {
  const drivers = new WorkerDriverRegistry();
  registerFakeWorkerDriver({ workerDrivers: drivers });

  const pool = createWorkerPool(poolSettings(), { ...baseDeps, drivers });

  // A live pool exposes the public surface and can accept work immediately.
  assert.ok(typeof pool.acquire === "function");
  assert.equal(pool.canAcquire(), true);

  const snapshot = pool.snapshot();
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.driver, "fake");
});

test("createWorkerPool fails loud with worker_pool_driver_unavailable for an unregistered kind, listing the known kinds", () => {
  const drivers = new WorkerDriverRegistry();
  registerFakeWorkerDriver({ workerDrivers: drivers });

  assert.throws(
    () => createWorkerPool(poolSettings({ driver: "static-ssh" }), { ...baseDeps, drivers }),
    /worker_pool_driver_unavailable: static-ssh \(known kinds: fake\)/,
  );
});

test("createWorkerPool falls back to the process-wide default registry when deps.drivers is absent", () => {
  // An empty default registry fails loud at construction (the daemon fails fast)...
  assert.throws(
    () => createWorkerPool(poolSettings(), baseDeps),
    /worker_pool_driver_unavailable: fake/,
  );

  // ...and once the composition root registers a driver into the default
  // registry, the same no-registry construction succeeds. This test pins the
  // defaultWorkerDriverRegistry fallback and therefore mutates the process-wide
  // registry; it runs LAST so the import-side-effect test above stays pure.
  registerFakeWorkerDriver();
  const pool = createWorkerPool(poolSettings(), baseDeps);
  assert.equal(pool.snapshot().driver, "fake");
});
