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

// --- STAGE 2: an EXPLICIT enabled local pool is byte-identical at slotsPerMachine=1 ---
// Before any default is changed (stage 3), prove that wiring an explicit
// `worker_pool: { enabled:true, driver:"local" }` at the default slotsPerMachine=1
// routes through buildDispatchCoordinator / the REAL per-run McpEndpointManager and
// reproduces today's local single-tenant execution EXACTLY:
//   - the leased slot's workerHost is the EMPTY string (the local driver yields it),
//   - the slot's mcpEndpoint is null (the per-run manager mints NO tunnel for an
//     empty host, so acp keeps its own in-process endpoint - no token, no ssh -N),
//   - the co-residence gate is inert at slotsPerMachine=1 for BOTH a capable and an
//     incapable coordinator capability.
// This isolates "does the local driver behave locally end-to-end" from "is it the
// default", so a stage-3 default regression is unambiguous. These are NEW positive
// assertions; they do not touch the disabled-path tests above (re-anchored in stage 4).

function localPoolSettings(extra: Record<string, unknown> = {}) {
  // warm:0 / min:0 keeps the pool lazy so nothing provisions eagerly; the single
  // local worker is minted on-demand by acquire. max:1 + slotsPerMachine=1 is the
  // single-tenant shape a default-on local pool will use.
  return parseConfig({
    worker: { worker_pool: { enabled: true, driver: "local", warm: 0, min: 0, max: 1, ...extra } },
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
    // run through acp's own in-process MCP endpoint - byte-identical to the pre-pool
    // local dispatch path.
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

test("wiring: the local pool coordinator advertises perRunEndpoint=true yet the empty host opens no tunnel", async () => {
  // The coordinator is wired with the CONCRETE per-run manager (perRunEndpoint=true),
  // so the capability surface is identical to a remote pool; the byte-identical local
  // behaviour comes purely from the empty host short-circuiting open() to null, NOT
  // from a degraded capability.
  const settings = localPoolSettings();
  const coordinator = await buildDispatchCoordinator(settings, {});
  assert.ok(coordinator);
  try {
    assert.equal(coordinator!.capabilities.perRunEndpoint, true);
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
