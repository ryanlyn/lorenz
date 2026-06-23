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

test("buildWorkerPool builds the DEFAULT enabled local pool for an absent worker_pool", async () => {
  // parseConfig({}) defaults to an enabled `local` pool at slotsPerMachine=1 with
  // min=0/warm=0/max=1. buildWorkerPool constructs it; nothing provisions eagerly (warm=0/min=0).
  const settings = parseConfig({}, {});
  assert.equal(settings.worker.workerPool?.enabled, true);
  assert.equal(settings.worker.workerPool?.driver, "local");
  assert.equal(settings.worker.workerPool?.min, 0);
  assert.equal(settings.worker.workerPool?.warm, 0);
  const workerPool = await buildWorkerPool(settings, {});
  assert.ok(workerPool);
  const snapshot = workerPool!.snapshot();
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.driver, "local");
  // No worker is provisioned eagerly at min=0/warm=0: the local worker is minted on first acquire.
  assert.equal(snapshot.workers.length, 0);
  await workerPool!.drain({ deadlineMs: 1_000 });
});

test("there is no operator-facing worker_pool.enabled opt-out", () => {
  // The pool is the single dispatch path; an operator who wants "no pool" gets the inert default
  // local pool. The `.strict()` config schema rejects `enabled`. The internal disabled-pool ->
  // undefined contract (the shape the reload-drain produces) is covered by the test below.
  assert.throws(
    () => parseConfig({ worker: { worker_pool: { enabled: false, driver: "fake" } } }, {}),
    /unsupported keys: enabled/,
  );
});

test("buildWorkerPool returns undefined for an internally disabled pool", async () => {
  // The reload-drain reconciles a removed pool to an internally disabled settings object, and
  // buildWorkerPool must short-circuit it so a drained pool is never rebuilt. Construct the disabled
  // shape directly (config cannot express it) to pin the internal `enabled:false` -> undefined contract.
  const settings = parseConfig({ worker: { worker_pool: { driver: "fake" } } }, {});
  const disabled = {
    ...settings,
    worker: {
      ...settings.worker,
      workerPool: { ...settings.worker.workerPool!, enabled: false },
    },
  };
  assert.equal(disabled.worker.workerPool?.enabled, false);
  assert.equal(await buildWorkerPool(disabled, {}), undefined);
});

test("buildWorkerPool constructs an enabled fake pool with a workspace-scoped ledger path", async () => {
  const settings = parseConfig(
    { worker: { worker_pool: { driver: "fake", max: 2, warm: 1 } } },
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
  const settings = parseConfig({ worker: { worker_pool: { driver: "nope" } } }, {});
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

// --- post-construction gate ----------------------------------------------
// `assertSlotsPerMachineGate` is the single mechanical safety that lives where
// the coordinator capability is actually known (after buildDispatchCoordinator).
// It enforces TWO conditions for slotsPerMachine>1: the runtime
// perRunClaimEnforcement capability AND the explicit operator co-residence opt-in.
// slotsPerMachine===1 always passes (the gate never triggers) so the default path
// is byte-identical.

const capable = { capabilities: { perRunClaimEnforcement: true } } as const;
const incapable = { capabilities: { perRunClaimEnforcement: false } } as const;

function gateSettings(workerPool: Record<string, unknown> | undefined) {
  return parseConfig(workerPool ? { worker: { worker_pool: workerPool } } : {});
}

test("gate: slotsPerMachine>1 with perRunClaimEnforcement=false throws", () => {
  const settings = gateSettings({
    driver: "fake",
    max_in_flight: 2,
    co_residence: true,
  });
  assert.throws(
    () => assertSlotsPerMachineGate(settings, incapable),
    /per-run scoped claims|perRunClaimEnforcement/i,
  );
});

test("gate: slotsPerMachine>1 with perRunClaimEnforcement=true but coResidence absent throws", () => {
  const settings = gateSettings({ driver: "fake", max_in_flight: 2 });
  assert.equal(settings.worker.workerPool?.coResidence, undefined);
  assert.throws(() => assertSlotsPerMachineGate(settings, capable), /co.?residence/i);
});

test("gate: slotsPerMachine>1 with perRunClaimEnforcement=true but coResidence=false throws", () => {
  const settings = gateSettings({
    driver: "fake",
    max_in_flight: 2,
    co_residence: false,
  });
  assert.throws(() => assertSlotsPerMachineGate(settings, capable), /co.?residence/i);
});

test("gate: slotsPerMachine>1 with perRunClaimEnforcement AND coResidence passes", () => {
  const settings = gateSettings({
    driver: "fake",
    max_in_flight: 2,
    co_residence: true,
  });
  // Does not throw.
  assertSlotsPerMachineGate(settings, capable);
});

test("gate: an internally DISABLED pool with max_in_flight>1 does not abort daemon startup", async () => {
  // The INTERNAL disabled shape (produced by the reload-drain) must not gate startup. A dormant
  // max_in_flight>1 on a disabled pool does not gate: the pool is off (runs go static/local), so
  // buildDispatchCoordinator returns undefined and assertSlotsPerMachineGate(settings, undefined)
  // does NOT throw. Construct the disabled shape directly (config cannot express it).
  const parsed = gateSettings({ driver: "fake", max_in_flight: 2 });
  const settings = {
    ...parsed,
    worker: {
      ...parsed.worker,
      workerPool: { ...parsed.worker.workerPool!, enabled: false },
    },
  };
  assert.equal(settings.worker.workerPool?.enabled, false);
  assert.equal(settings.worker.workerPool?.slotsPerMachine, 2);
  const coordinator = await buildDispatchCoordinator(settings, {});
  assert.equal(coordinator, undefined);
  // Does not throw: daemon startup proceeds on the static/local path.
  assertSlotsPerMachineGate(settings, coordinator);
});

test("gate: default slotsPerMachine=1 always passes regardless of capability/opt-in", () => {
  // Enabled pool, default slots, no capability, no opt-in: gate never triggers.
  const enabledDefault = gateSettings({ driver: "fake" });
  assert.equal(enabledDefault.worker.workerPool?.slotsPerMachine, 1);
  assertSlotsPerMachineGate(enabledDefault, incapable);
  assertSlotsPerMachineGate(enabledDefault, capable);

  // An absent worker_pool defaults to the enabled `local` pool at slotsPerMachine=1, so the gate is
  // inert (slotsPerMachine===1 never triggers): it passes for both a present and an absent coordinator.
  const defaultPool = gateSettings(undefined);
  assert.equal(defaultPool.worker.workerPool?.driver, "local");
  assert.equal(defaultPool.worker.workerPool?.slotsPerMachine, 1);
  assertSlotsPerMachineGate(defaultPool, undefined);
  assertSlotsPerMachineGate(defaultPool, capable);
});

// An EXPLICIT enabled local pool at slotsPerMachine=1 routes through buildDispatchCoordinator /
// the REAL per-run McpEndpointManager and runs local single-tenant execution:
//   - the leased slot's workerHost is the EMPTY string (the local driver yields it),
//   - the slot's mcpEndpoint is null (the per-run manager mints NO tunnel for an
//     empty host, so acp keeps its own in-process endpoint - no token, no ssh -N),
//   - the co-residence gate is inert at slotsPerMachine=1 for BOTH a capable and an
//     incapable coordinator capability.

function localPoolSettings(extra: Record<string, unknown> = {}) {
  // warm:0 / min:0 keeps the pool lazy so nothing provisions eagerly; the single
  // local worker is minted on-demand by acquire. max:1 + slotsPerMachine=1 is the
  // single-tenant shape the default-on local pool uses.
  return parseConfig({
    worker: { worker_pool: { driver: "local", warm: 0, min: 0, max: 1, ...extra } },
  });
}

test("wiring: an explicit enabled local pool leases an EMPTY-host slot with a null MCP endpoint (no tunnel)", async () => {
  const settings = localPoolSettings();
  assert.equal(settings.worker.workerPool?.enabled, true);
  assert.equal(settings.worker.workerPool?.driver, "local");
  assert.equal(settings.worker.workerPool?.slotsPerMachine, 1);

  const coordinator = await buildDispatchCoordinator(settings, {});
  assert.ok(coordinator);

  try {
    const result = await coordinator!.acquireRunSlot({
      issueId: "issue-local-1",
      slotIndex: 0,
      labels: [],
      timeoutMs: 5_000,
      // The FULL parsed Settings, exactly as the runtime threads it. The empty host
      // short-circuits the manager to null BEFORE acquireAgentMcpEndpointForRun reads
      // settings.server.port, so no @lorenz/mcp / tunnel machinery is ever touched.
      settings,
    });
    assert.equal(result.status, "bound");
    if (result.status !== "bound") return;

    // The local driver's empty workerHost is the load-bearing contract: it routes the
    // run through acp's own in-process MCP endpoint (the local dispatch path).
    assert.equal(result.slot.workerHost, "");
    // The per-run manager minted NO endpoint for the empty host: acp keeps its own
    // endpoint, no per-run token, no reverse tunnel (`ssh -N`) child.
    assert.equal(result.slot.mcpEndpoint, null);
    // runKey is still the issue-scoped key; the slot is registered exactly once.
    assert.equal(result.slot.runKey, "issue-local-1#0");
    assert.equal(coordinator!.snapshot().slots.length, 1);

    // Settling the slot releases the worker HEALTHY with no endpoint to close.
    await result.slot.release("healthy");
    assert.equal(coordinator!.snapshot().slots.length, 0);
  } finally {
    // Stop the reaper timer so the test leaves no background interval running.
    await coordinator!.drain({ deadlineMs: 1_000 });
  }
});

test("wiring: the local pool coordinator advertises perRunClaimEnforcement=true yet the empty host opens no tunnel", async () => {
  // The coordinator is wired with the CONCRETE per-run manager (perRunClaimEnforcement=true), so
  // the capability surface is identical to a remote pool; the local behaviour comes purely from the
  // empty host short-circuiting open() to null, NOT from a degraded capability.
  const settings = localPoolSettings();
  const coordinator = await buildDispatchCoordinator(settings, {});
  assert.ok(coordinator);
  try {
    assert.equal(coordinator!.capabilities.perRunClaimEnforcement, true);
  } finally {
    await coordinator!.drain({ deadlineMs: 1_000 });
  }
});

test("gate: an explicit local pool at slotsPerMachine=1 is inert for both capable and incapable capabilities", () => {
  // The local pool defaults to slotsPerMachine=1, so the co-residence gate never
  // fires regardless of the coordinator capability - the single-tenant local path
  // is never gated.
  const settings = localPoolSettings();
  assert.equal(settings.worker.workerPool?.slotsPerMachine, 1);
  assertSlotsPerMachineGate(settings, incapable);
  assertSlotsPerMachineGate(settings, capable);
});

// The IMPLICIT-DEFAULT local pool (absent worker_pool) runs local single-tenant dispatch.
// parseConfig({}) defaults to the enabled local pool. Built via buildDispatchCoordinator, the
// default pool leases an empty-host slot with a null MCP lease, and provisions NO worker until the
// first acquire.

test("wiring: the IMPLICIT default local pool leases an empty-host slot and provisions nothing eagerly", async () => {
  const settings = parseConfig({});
  assert.equal(settings.worker.workerPool?.enabled, true);
  assert.equal(settings.worker.workerPool?.driver, "local");
  assert.equal(settings.worker.workerPool?.min, 0);
  assert.equal(settings.worker.workerPool?.warm, 0);

  const coordinator = await buildDispatchCoordinator(settings, {});
  assert.ok(coordinator);
  try {
    // min=0/warm=0: nothing is provisioned before the first acquire.
    assert.equal(coordinator!.snapshot().slots.length, 0);

    const result = await coordinator!.acquireRunSlot({
      issueId: "issue-default-local",
      slotIndex: 0,
      labels: [],
      timeoutMs: 5_000,
      settings,
    });
    assert.equal(result.status, "bound");
    if (result.status !== "bound") return;
    // Empty workerHost -> null MCP lease -> acp keeps its own in-process endpoint (no tunnel).
    assert.equal(result.slot.workerHost, "");
    assert.equal(result.slot.mcpEndpoint, null);
    await result.slot.release("healthy");
  } finally {
    await coordinator!.drain({ deadlineMs: 1_000 });
  }
});
