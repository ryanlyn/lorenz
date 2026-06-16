import { beforeAll, test } from "vitest";
import { parseConfig } from "@lorenz/config";
import { assert } from "@lorenz/test-utils";

import { registerBuiltinBackends } from "../src/daemon.js";
import { assertSlotsPerMachineGate } from "../src/main.js";

import {
  buildWorkerPool,
  buildDispatchCoordinator,
  createWorkerPool,
  createDispatchCoordinator,
  WorkerDriverRegistry,
  defaultWorkerDriverRegistry,
  FakeWorkerDriver,
  registerFakeWorkerDriver,
} from "@lorenz/cli";

// buildWorkerPool resolves `worker.worker_pool.driver` through the process-default
// worker-driver registry, so populate it the same way the CLI entrypoints do.
beforeAll(() => {
  registerBuiltinBackends();
});

test("buildWorkerPool returns undefined when the pool is disabled (byte-identical path)", async () => {
  const settings = parseConfig({}, {});
  assert.equal(settings.worker.workerPool, undefined);
  assert.equal(await buildWorkerPool(settings, {}), undefined);
});

test("buildWorkerPool returns undefined when worker_pool is present but enabled:false", async () => {
  const settings = parseConfig({ worker: { worker_pool: { enabled: false, driver: "fake" } } }, {});
  assert.equal(settings.worker.workerPool?.enabled, false);
  assert.equal(await buildWorkerPool(settings, {}), undefined);
});

test("buildWorkerPool constructs an enabled fake pool with a workspace-scoped ledger path", async () => {
  const settings = parseConfig(
    { worker: { worker_pool: { enabled: true, driver: "fake", max: 2, warm: 1 } } },
    {},
  );
  const workerPool = await buildWorkerPool(settings, {});
  assert.ok(workerPool);

  const snapshot = workerPool!.snapshot();
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.driver, "fake");
  // Drain must be awaitable so main.ts can await runtime.drainWorkerPool() on exit.
  assert.equal(typeof workerPool!.drain, "function");
  assert.equal(typeof workerPool!.hydrate, "function");
  assert.equal(typeof workerPool!.canAcquire, "function");
});

test("buildWorkerPool rejects with worker_pool_driver_unavailable for an unregistered enabled kind", async () => {
  // "nope" is never registered by registerBuiltinBackends and resolves as no
  // module, so the loader aborts pool construction with the known-kinds hint.
  const settings = parseConfig({ worker: { worker_pool: { enabled: true, driver: "nope" } } }, {});
  await assert.rejects(
    () => buildWorkerPool(settings, {}),
    /worker_pool_driver_unavailable: nope.*(known kinds: .*fake)/,
  );
});

test("CLI re-exports the worker-pool driver public API for live/e2e tests", () => {
  assert.equal(typeof createWorkerPool, "function");
  assert.equal(typeof createDispatchCoordinator, "function");
  assert.equal(typeof WorkerDriverRegistry, "function");
  assert.equal(typeof registerFakeWorkerDriver, "function");
  assert.equal(typeof FakeWorkerDriver, "function");
  assert.ok(defaultWorkerDriverRegistry instanceof WorkerDriverRegistry);
  // The builtin drivers registered above resolve through the default registry.
  assert.ok(defaultWorkerDriverRegistry.kinds().includes("fake"));
});

// --- STEP 3 post-construction gate ---------------------------------------
// `assertSlotsPerMachineGate` is the single mechanical safety that lives where
// the coordinator capability is actually known (after buildDispatchCoordinator).
// It enforces TWO conditions for slotsPerMachine>1: the runtime perRunEndpoint
// capability AND the explicit operator co-residence opt-in. slotsPerMachine===1
// always passes (the gate never triggers) so the default path is byte-identical.

const capable = { capabilities: { perRunEndpoint: true } } as const;
const incapable = { capabilities: { perRunEndpoint: false } } as const;

function gateSettings(workerPool: Record<string, unknown> | undefined) {
  return parseConfig(workerPool ? { worker: { worker_pool: workerPool } } : {});
}

test("gate: slotsPerMachine>1 with perRunEndpoint=false throws", () => {
  const settings = gateSettings({
    enabled: true,
    driver: "fake",
    max_in_flight: 2,
    co_residence: true,
  });
  assert.throws(
    () => assertSlotsPerMachineGate(settings, incapable),
    /per-run.*endpoint|perRunEndpoint/i,
  );
});

test("gate: slotsPerMachine>1 with perRunEndpoint=true but coResidence absent throws", () => {
  const settings = gateSettings({ enabled: true, driver: "fake", max_in_flight: 2 });
  assert.equal(settings.worker.workerPool?.coResidence, undefined);
  assert.throws(() => assertSlotsPerMachineGate(settings, capable), /co.?residence/i);
});

test("gate: slotsPerMachine>1 with perRunEndpoint=true but coResidence=false throws", () => {
  const settings = gateSettings({
    enabled: true,
    driver: "fake",
    max_in_flight: 2,
    co_residence: false,
  });
  assert.throws(() => assertSlotsPerMachineGate(settings, capable), /co.?residence/i);
});

test("gate: slotsPerMachine>1 with perRunEndpoint AND coResidence passes", () => {
  const settings = gateSettings({
    enabled: true,
    driver: "fake",
    max_in_flight: 2,
    co_residence: true,
  });
  // Does not throw.
  assertSlotsPerMachineGate(settings, capable);
});

test("gate: DISABLED pool with max_in_flight>1 does not abort daemon startup", async () => {
  // A dormant max_in_flight>1 on a DISABLED pool must not gate startup: the pool
  // is off (runs go static/local), so buildDispatchCoordinator returns undefined
  // and assertSlotsPerMachineGate(settings, undefined) must NOT throw. Before the
  // fix this fail-closed regression aborted the daemon over a value never used.
  const settings = gateSettings({ enabled: false, driver: "fake", max_in_flight: 2 });
  assert.equal(settings.worker.workerPool?.enabled, false);
  assert.equal(settings.worker.workerPool?.slotsPerMachine, 2);
  const coordinator = await buildDispatchCoordinator(settings, {});
  assert.equal(coordinator, undefined);
  // Does not throw: daemon startup proceeds on the static/local path.
  assertSlotsPerMachineGate(settings, coordinator);
});

test("gate: default slotsPerMachine=1 always passes regardless of capability/opt-in", () => {
  // Enabled pool, default slots, no capability, no opt-in: gate never triggers.
  const enabledDefault = gateSettings({ enabled: true, driver: "fake" });
  assert.equal(enabledDefault.worker.workerPool?.slotsPerMachine, 1);
  assertSlotsPerMachineGate(enabledDefault, incapable);
  assertSlotsPerMachineGate(enabledDefault, capable);

  // Absent worker_pool / absent coordinator: byte-identical no-op.
  const noPool = gateSettings(undefined);
  assert.equal(noPool.worker.workerPool, undefined);
  assertSlotsPerMachineGate(noPool, undefined);
});
