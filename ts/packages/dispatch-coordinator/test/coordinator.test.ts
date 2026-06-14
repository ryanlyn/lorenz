// STEP 1 (T1c): DispatchCoordinator 1:1 passthrough over WorkerPool.
//
// These tests pin the byte-identical-at-the-runtime-boundary contract: with the
// default null McpEndpointManager (perRunEndpoint=false, mcpEndpoint=null), the
// coordinator delegates every operation to the underlying WorkerPool with NO change
// in observable behaviour. Concretely:
//   - acquireRunSlot delegates to pool.acquire; a `leased` result mints a RunSlot
//     (mcpEndpoint=null) whose release/fail delegate to the wrapped WorkerLease with
//     identical poison/healthy classification; every typed `no_capacity` reason
//     is preserved verbatim.
//   - a thrown pool fault PROPAGATES (rethrown verbatim) so the runtime's catch
//     emits worker_pool_acquire_error.
//   - the coordinator itself is the orchestrator's capacity authority:
//     governs()/canAcquire() re-read live pool state per call, and the singleton
//     survives reconcile so a captured reference never strands.
//   - reconcile/drain/hydrate/snapshot delegate to the pool (snapshot extended
//     with an empty slots array).
//
// Tests import the COMPILED barrel (../src/index.js) because the suite runs
// against tsc --build output (composite project, tests excluded from the build).

import { test } from "vitest";
import type { WorkerPoolSettings, Settings } from "@symphony/domain";
import type {
  AcquireRequest,
  AcquireResult,
  WorkerLease,
  WorkerOutcome,
  WorkerPool,
  WorkerPoolSnapshot,
} from "@symphony/worker-pool";
import type { AgentMcpEndpointLease } from "@symphony/mcp";
import { assert } from "@symphony/test-utils";

import {
  createDispatchCoordinator,
  EndpointOpenError,
  RunSlotCollisionError,
} from "../src/index.js";
import { nullEndpointManager } from "../src/nullEndpointManager.js";
import { createPerRunEndpointManager } from "../src/mcpEndpointManager.js";
import type { AcquireRunSlotRequest, McpEndpointManager } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fakes (mirror the runtime.test FakeWorkerPool / FakeLease shapes so the
// passthrough is pinned against the same surface the runtime exercises).
// ---------------------------------------------------------------------------

interface FakeLease extends WorkerLease {
  readonly settles: Array<{ kind: "release" | "fail"; arg?: string }>;
  readonly heartbeats: { count: number };
}

function makeFakeLease(
  options: {
    leaseId?: string;
    workerId?: string;
    workerHost?: string;
    acquiredAtMs?: number;
    stale?: boolean;
  } = {},
): FakeLease {
  const settles: Array<{ kind: "release" | "fail"; arg?: string }> = [];
  const heartbeats = { count: 0 };
  const stale = options.stale ?? false;
  return {
    leaseId: options.leaseId ?? "lease-1",
    workerId: options.workerId ?? "worker-1",
    workerHost: options.workerHost ?? "fake://worker-worker-1",
    acquiredAtMs: options.acquiredAtMs ?? 0,
    expiresAtMs: null,
    settles,
    heartbeats,
    async release(outcome?: WorkerOutcome): Promise<void> {
      // A stale-generation lease guards its own settle (leaseId no longer
      // matches the worker record), so the op is a no-op that never records.
      if (stale) return;
      settles.push({ kind: "release", arg: outcome });
    },
    async fail(reason: string): Promise<void> {
      if (stale) return;
      settles.push({ kind: "fail", arg: reason });
    },
    heartbeat(): void {
      heartbeats.count += 1;
    },
  };
}

interface FakeWorkerPool extends WorkerPool {
  readonly acquireCalls: AcquireRequest[];
  readonly reconcileCalls: WorkerPoolSettings[];
  readonly swapDriverCalls: WorkerPoolSettings[];
  readonly drainCalls: Array<{ deadlineMs: number }>;
  readonly hydrateCalls: { count: number };
  lastLease: FakeLease | null;
  /** Fires every registered onMachineRecycling callback with `workerId` (test trigger). */
  triggerRecycling(workerId: string): void;
}

function makeFakeWorkerPool(
  options: {
    result?: AcquireResult | (() => AcquireResult) | (() => never);
    lease?: FakeLease;
    canAcquire?: boolean | (() => boolean);
    isEnabled?: boolean | (() => boolean);
    snapshot?: WorkerPoolSnapshot;
    /** When set, pool.reconcile THROWS this (models a reload to an unavailable driver). */
    reconcileError?: Error;
  } = {},
): FakeWorkerPool {
  const acquireCalls: AcquireRequest[] = [];
  const reconcileCalls: WorkerPoolSettings[] = [];
  const swapDriverCalls: WorkerPoolSettings[] = [];
  const drainCalls: Array<{ deadlineMs: number }> = [];
  const hydrateCalls = { count: 0 };
  const recyclingCallbacks: Array<(workerId: string) => void> = [];
  const pool: FakeWorkerPool = {
    acquireCalls,
    reconcileCalls,
    swapDriverCalls,
    drainCalls,
    hydrateCalls,
    lastLease: null,
    triggerRecycling(workerId: string): void {
      for (const cb of recyclingCallbacks) cb(workerId);
    },
    async acquire(req): Promise<AcquireResult> {
      acquireCalls.push(req);
      if (options.result) {
        // A `() => never` thrower is invoked here and propagates out of acquire.
        return typeof options.result === "function" ? options.result() : options.result;
      }
      const lease = options.lease ?? makeFakeLease();
      pool.lastLease = lease;
      return { status: "leased", lease };
    },
    canAcquire(): boolean {
      return typeof options.canAcquire === "function"
        ? options.canAcquire()
        : (options.canAcquire ?? true);
    },
    isEnabled(): boolean {
      return typeof options.isEnabled === "function"
        ? options.isEnabled()
        : (options.isEnabled ?? true);
    },
    reconcile(next): void {
      reconcileCalls.push(next);
      // Models pool.reconcile -> swapDriver -> registry resolution throwing on a
      // reload to an unavailable driver kind (the pool itself rolls back; the
      // coordinator must NOT have committed currentSettings to the rejected config).
      if (options.reconcileError) throw options.reconcileError;
    },
    swapDriver(next): void {
      swapDriverCalls.push(next);
    },
    onMachineRecycling(cb): void {
      recyclingCallbacks.push(cb);
    },
    async hydrate(): Promise<void> {
      hydrateCalls.count += 1;
    },
    async drain(opts): Promise<void> {
      drainCalls.push({ deadlineMs: opts.deadlineMs });
    },
    snapshot(): WorkerPoolSnapshot {
      return options.snapshot ?? baseSnapshot();
    },
  };
  return pool;
}

function baseSnapshot(overrides: Partial<WorkerPoolSnapshot> = {}): WorkerPoolSnapshot {
  return {
    enabled: true,
    driver: "fake",
    total: 0,
    warmIdle: 0,
    leased: 0,
    provisioning: 0,
    degraded: 0,
    inFlight: 0,
    spend: { concurrentWorkers: 0, workerSecondsUsed: 0, dailyWorkerSecondsUsed: 0, dayKey: "" },
    workers: [],
    ...overrides,
  };
}

// A `WorkerPoolSettings`-typed stub for reconcile/drain delegation assertions: the
// coordinator never reads its fields in STEP 1 (it forwards the reference), so a
// tagged cast is enough to prove the SAME object reference is passed through.
function settingsStub(tag: string): WorkerPoolSettings {
  return { __tag: tag } as unknown as WorkerPoolSettings;
}

// A full-Settings stub for the request: the coordinator forwards `req.settings`
// verbatim to mcpEndpointManager.open. The fakes/null/recording managers in this
// suite never read its fields (the real-manager threading is pinned by
// test/worker-pool-endpoint-real-manager.test.ts), so a tagged cast is enough to
// satisfy the (now required) field without coupling these unit tests to the full
// Settings shape.
const requestSettings = { __tag: "request-settings" } as unknown as Settings;

const acquireReq: AcquireRunSlotRequest = {
  issueId: "issue-1",
  slotIndex: 0,
  labels: ["mt-1"],
  affinityKey: "fake://prior",
  timeoutMs: 12_345,
  settings: requestSettings,
};

function makeCoordinator(
  pool: FakeWorkerPool,
  manager: McpEndpointManager = nullEndpointManager,
): ReturnType<typeof createDispatchCoordinator> {
  return createDispatchCoordinator({
    pool,
    mcpEndpointManager: manager,
    settings: settingsStub("initial"),
  });
}

// ---------------------------------------------------------------------------
// acquireRunSlot: leased -> RunSlot passthrough
// ---------------------------------------------------------------------------

test("acquireRunSlot delegates to pool.acquire and forwards the request verbatim", async () => {
  const lease = makeFakeLease({ workerHost: "fake://worker-7" });
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool);

  const result = await coordinator.acquireRunSlot(acquireReq);

  assert.equal(result.status, "bound");
  // The acquire request is forwarded 1:1: same issue/slot/labels/affinity/timeout.
  assert.equal(pool.acquireCalls.length, 1);
  const call = pool.acquireCalls[0];
  assert.equal(call?.issueId, "issue-1");
  assert.equal(call?.slotIndex, 0);
  assert.deepEqual(call?.labels, ["mt-1"]);
  assert.equal(call?.affinityKey, "fake://prior");
  assert.equal(call?.timeoutMs, 12_345);
});

test("acquireRunSlot on leased mints a RunSlot mirroring the WorkerLease identity with mcpEndpoint=null", async () => {
  const lease = makeFakeLease({
    leaseId: "lease-xyz",
    workerId: "worker-9",
    workerHost: "fake://worker-9",
    acquiredAtMs: 4_242,
  });
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool);

  const result = await coordinator.acquireRunSlot({
    ...acquireReq,
    issueId: "issue-z",
    slotIndex: 2,
  });
  assert.equal(result.status, "bound");
  if (result.status !== "bound") return;
  const slot = result.slot;

  // The minted RunSlot mirrors the lease + request identity; STEP 1 endpoint is null.
  assert.equal(slot.leaseId, "lease-xyz");
  assert.equal(slot.machineLeaseId, "worker-9");
  assert.equal(slot.workerHost, "fake://worker-9");
  assert.equal(slot.acquiredAtMs, 4_242);
  assert.equal(slot.issueId, "issue-z");
  assert.equal(slot.slotIndex, 2);
  assert.equal(slot.mcpEndpoint, null);
  // runKey is the issue-scoped per-run key (`${issueId}#${slotIndex}`) feeding the
  // per-run endpoint/tunnel.
  assert.equal(slot.runKey, "issue-z#2");
});

test("RunSlot.heartbeat forwards to the wrapped WorkerLease.heartbeat", async () => {
  const lease = makeFakeLease();
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool);

  const result = await coordinator.acquireRunSlot(acquireReq);
  assert.equal(result.status, "bound");
  if (result.status !== "bound") return;

  result.slot.heartbeat();
  result.slot.heartbeat();
  assert.equal(lease.heartbeats.count, 2);
});

// ---------------------------------------------------------------------------
// RunSlot.release / fail: poison/healthy parity with WorkerLease
// ---------------------------------------------------------------------------

test("RunSlot.release('healthy') delegates to WorkerLease.release('healthy')", async () => {
  const lease = makeFakeLease();
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool);

  const result = await coordinator.acquireRunSlot(acquireReq);
  if (result.status !== "bound") throw new Error("expected bound");

  await result.slot.release("healthy");
  assert.deepEqual(lease.settles, [{ kind: "release", arg: "healthy" }]);
});

test("RunSlot.release('poison') delegates to WorkerLease.release('poison') (poison classification preserved)", async () => {
  const lease = makeFakeLease();
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool);

  const result = await coordinator.acquireRunSlot(acquireReq);
  if (result.status !== "bound") throw new Error("expected bound");

  await result.slot.release("poison");
  assert.deepEqual(lease.settles, [{ kind: "release", arg: "poison" }]);
});

test("RunSlot.fail(reason) delegates to WorkerLease.fail(reason) verbatim", async () => {
  const lease = makeFakeLease();
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool);

  const result = await coordinator.acquireRunSlot(acquireReq);
  if (result.status !== "bound") throw new Error("expected bound");

  await result.slot.fail("ssh_timeout: host 60000");
  assert.deepEqual(lease.settles, [{ kind: "fail", arg: "ssh_timeout: host 60000" }]);
});

test("RunSlot.release is exactly-once: a second release/fail is a no-op (idempotent settle)", async () => {
  const lease = makeFakeLease();
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool);

  const result = await coordinator.acquireRunSlot(acquireReq);
  if (result.status !== "bound") throw new Error("expected bound");

  await result.slot.release("healthy");
  await result.slot.release("poison");
  await result.slot.fail("late");
  // Only the FIRST settle reaches the underlying lease; the rest no-op.
  assert.deepEqual(lease.settles, [{ kind: "release", arg: "healthy" }]);
});

test("RunSlot.fail then release is exactly-once: only the first fail reaches the lease", async () => {
  const lease = makeFakeLease();
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool);

  const result = await coordinator.acquireRunSlot(acquireReq);
  if (result.status !== "bound") throw new Error("expected bound");

  await result.slot.fail("boom");
  await result.slot.release("healthy");
  assert.deepEqual(lease.settles, [{ kind: "fail", arg: "boom" }]);
});

test("RunSlot settle delegates even to a stale lease (WorkerLease's own leaseId guard is the no-op)", async () => {
  // The coordinator must NOT classify staleness itself; it delegates to WorkerLease,
  // whose leaseId+settled guard makes a stale generation a no-op. With a stale
  // fake lease the call reaches release() but the lease records nothing.
  const lease = makeFakeLease({ stale: true });
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool);

  const result = await coordinator.acquireRunSlot(acquireReq);
  if (result.status !== "bound") throw new Error("expected bound");

  await result.slot.release("healthy");
  // The stale lease guarded its own settle: nothing recorded, no throw.
  assert.deepEqual(lease.settles, []);
});

// ---------------------------------------------------------------------------
// acquireRunSlot: no_capacity reason passthrough (every typed reason)
// ---------------------------------------------------------------------------

const noCapacityReasons = [
  "acquire_timeout",
  "spend_cap",
  "pool_disabled",
  "driver_error",
] as const;

for (const reason of noCapacityReasons) {
  test(`acquireRunSlot maps no_capacity '${reason}' to the SAME typed no_capacity reason`, async () => {
    const pool = makeFakeWorkerPool({ result: { status: "no_capacity", reason } });
    const coordinator = makeCoordinator(pool);

    const result = await coordinator.acquireRunSlot(acquireReq);
    assert.equal(result.status, "no_capacity");
    if (result.status !== "no_capacity") return;
    assert.equal(result.reason, reason);
  });
}

test("no_capacity result never mints a RunSlot and never settles a lease", async () => {
  const pool = makeFakeWorkerPool({ result: { status: "no_capacity", reason: "acquire_timeout" } });
  const coordinator = makeCoordinator(pool);

  const result = await coordinator.acquireRunSlot(acquireReq);
  assert.equal(result.status, "no_capacity");
  // snapshot.slots stays empty: a no_capacity acquire registers nothing.
  assert.equal(coordinator.snapshot().slots.length, 0);
});

// ---------------------------------------------------------------------------
// acquireRunSlot: thrown pool fault PROPAGATES (rethrow verbatim)
// ---------------------------------------------------------------------------

test("a thrown pool.acquire fault PROPAGATES verbatim (so the runtime emits worker_pool_acquire_error)", async () => {
  const fault = new Error("ledger_write_failed: disk full");
  const pool = makeFakeWorkerPool({
    result: () => {
      throw fault;
    },
  });
  const coordinator = makeCoordinator(pool);

  let thrown: unknown;
  try {
    await coordinator.acquireRunSlot(acquireReq);
  } catch (error) {
    thrown = error;
  }
  // The EXACT error object is rethrown (identity, not a wrapper) so the runtime's
  // catch surfaces the original message in worker_pool_acquire_error.
  assert.equal(thrown, fault);
});

test("a thrown pool fault leaves the slot registry empty (no orphan RunSlot)", async () => {
  const pool = makeFakeWorkerPool({
    result: () => {
      throw new Error("driver boom");
    },
  });
  const coordinator = makeCoordinator(pool);

  await assert.rejects(() => coordinator.acquireRunSlot(acquireReq), /driver boom/);
  assert.equal(coordinator.snapshot().slots.length, 0);
});

// ---------------------------------------------------------------------------
// capacity authority: the coordinator itself satisfies the orchestrator's
// CapacityProbe shape (governs/canAcquire), re-reading live pool state per call
// ---------------------------------------------------------------------------

test("governs()/canAcquire() delegate to the live pool (isEnabled/canAcquire)", () => {
  let enabled = true;
  let acquirable = true;
  const pool = makeFakeWorkerPool({
    isEnabled: () => enabled,
    canAcquire: () => acquirable,
  });
  const coordinator = makeCoordinator(pool);

  // governs() reads pool.isEnabled() live; canAcquire() reads pool.canAcquire() live.
  assert.equal(coordinator.governs(), true);
  assert.equal(coordinator.canAcquire(), true);
  enabled = false;
  acquirable = false;
  assert.equal(coordinator.governs(), false);
  assert.equal(coordinator.canAcquire(), false);
});

test("governs() re-reads live pool state after reconcile (the captured authority is never stranded)", async () => {
  let enabled = true;
  const pool = makeFakeWorkerPool({ isEnabled: () => enabled });
  const coordinator = makeCoordinator(pool);

  // The orchestrator captures the coordinator ONCE in its ctor; the coordinator is
  // a reload-surviving singleton, so the same reference reflects post-reconcile
  // pool state.
  assert.equal(coordinator.governs(), true);

  await coordinator.reconcile(settingsStub("next"));
  enabled = false;
  assert.equal(coordinator.governs(), false);
});

test("onCapacityAvailable(cb) forwards to pool.onCapacityAvailable when the pool provides the hook", () => {
  const callbacks: Array<() => void> = [];
  const pool = makeFakeWorkerPool();
  pool.onCapacityAvailable = (cb: () => void): void => {
    callbacks.push(cb);
  };
  const coordinator = makeCoordinator(pool);

  let fired = 0;
  coordinator.onCapacityAvailable(() => {
    fired += 1;
  });
  assert.equal(callbacks.length, 1);
  callbacks[0]?.();
  assert.equal(fired, 1);
});

test("onCapacityAvailable(cb) is a safe no-op for a pool without the hook (legacy passthrough)", () => {
  const pool = makeFakeWorkerPool();
  const coordinator = makeCoordinator(pool);
  // makeFakeWorkerPool models the older/partial pool surface (no onCapacityAvailable),
  // so registration must not throw and the runtime keeps interval-only polling.
  coordinator.onCapacityAvailable(() => {});
});

// ---------------------------------------------------------------------------
// reconcile / drain / hydrate delegation
// ---------------------------------------------------------------------------

test("reconcile(next) delegates to pool.reconcile(next) with the SAME settings reference", async () => {
  const pool = makeFakeWorkerPool();
  const coordinator = makeCoordinator(pool);
  const next = settingsStub("reconciled");

  await coordinator.reconcile(next);
  assert.equal(pool.reconcileCalls.length, 1);
  assert.equal(pool.reconcileCalls[0], next);
});

test("reconcile awaits the injected driverLoader BEFORE pool.reconcile when next is enabled", async () => {
  // Load-before-reconcile: the loader dynamic-imports + registers an
  // out-of-tree driver module so pool.reconcile -> swapDriver -> registry
  // resolve stays synchronous and finds the module already registered.
  const order: string[] = [];
  const pool = makeFakeWorkerPool();
  const originalReconcile = pool.reconcile.bind(pool);
  pool.reconcile = (next): void => {
    order.push("pool.reconcile");
    originalReconcile(next);
  };
  const loadedDrivers: string[] = [];
  const coordinator = createDispatchCoordinator({
    pool,
    mcpEndpointManager: nullEndpointManager,
    settings: settingsStub("initial"),
    driverLoader: async (driver) => {
      order.push("driverLoader");
      loadedDrivers.push(driver);
    },
  });

  await coordinator.reconcile({
    __tag: "module",
    enabled: true,
    driver: "./acme-driver.mjs",
  } as unknown as WorkerPoolSettings);
  assert.deepEqual(order, ["driverLoader", "pool.reconcile"]);
  assert.deepEqual(loadedDrivers, ["./acme-driver.mjs"]);
});

test("reconcile SKIPS the driverLoader when next is disabled (mirrors the pool's disable path)", async () => {
  // A reload that disables the pool drains it; no driver resolution happens on
  // that path (the pool skips swapDriver), so no module load may happen either.
  let loaderCalls = 0;
  const pool = makeFakeWorkerPool();
  const coordinator = createDispatchCoordinator({
    pool,
    mcpEndpointManager: nullEndpointManager,
    settings: settingsStub("initial"),
    driverLoader: async () => {
      loaderCalls += 1;
    },
  });

  await coordinator.reconcile({
    __tag: "disabled",
    enabled: false,
    driver: "./acme-driver.mjs",
  } as unknown as WorkerPoolSettings);
  assert.equal(loaderCalls, 0);
  assert.equal(pool.reconcileCalls.length, 1);
});

test("a driverLoader rejection aborts reconcile BEFORE the pool is touched (transactional last-good)", async () => {
  // A module load failure on reload must reject without reconciling the pool:
  // the runtime's catch keeps last-good settings and the live pool stays on the
  // previous (working) driver.
  const pool = makeFakeWorkerPool();
  const coordinator = createDispatchCoordinator({
    pool,
    mcpEndpointManager: nullEndpointManager,
    settings: settingsStub("initial"),
    driverLoader: async () => {
      throw new Error("worker_pool_driver_unavailable: ./missing.mjs");
    },
  });

  await assert.rejects(
    () =>
      coordinator.reconcile({
        __tag: "load-failure",
        enabled: true,
        driver: "./missing.mjs",
      } as unknown as WorkerPoolSettings),
    /worker_pool_driver_unavailable/,
  );
  assert.equal(pool.reconcileCalls.length, 0);
});

test("drain(opts) delegates to pool.drain(opts) with the deadline", async () => {
  const pool = makeFakeWorkerPool();
  const coordinator = makeCoordinator(pool);

  await coordinator.drain({ deadlineMs: 9_999 });
  assert.deepEqual(pool.drainCalls, [{ deadlineMs: 9_999 }]);
});

test("hydrate() delegates to pool.hydrate()", async () => {
  const pool = makeFakeWorkerPool();
  const coordinator = makeCoordinator(pool);

  await coordinator.hydrate();
  assert.equal(pool.hydrateCalls.count, 1);
});

// ---------------------------------------------------------------------------
// snapshot: pool snapshot extended with an empty slots array
// ---------------------------------------------------------------------------

test("snapshot() returns the pool snapshot extended with an empty slots array (STEP 1 stub)", () => {
  const poolSnapshot = baseSnapshot({
    total: 3,
    leased: 1,
    inFlight: 1,
    workers: [
      {
        workerId: "worker-1",
        workerHost: "fake://worker-1",
        state: "leased",
        inFlight: 1,
        markedForDestroy: false,
      },
    ],
  });
  const pool = makeFakeWorkerPool({ snapshot: poolSnapshot });
  const coordinator = makeCoordinator(pool);

  const snap = coordinator.snapshot();
  // Every pool snapshot field is preserved verbatim.
  assert.equal(snap.total, 3);
  assert.equal(snap.leased, 1);
  assert.equal(snap.inFlight, 1);
  assert.deepEqual(snap.workers, poolSnapshot.workers);
  // The coordinator appends an empty slots array (the STEP 1 stub; no live slot accounting yet).
  assert.deepEqual(snap.slots, []);
});

// ---------------------------------------------------------------------------
// capabilities: perRunEndpoint mirrors the injected manager
// ---------------------------------------------------------------------------

test("capabilities.perRunEndpoint mirrors the injected manager (false for the null passthrough)", () => {
  const pool = makeFakeWorkerPool();
  const coordinator = makeCoordinator(pool, nullEndpointManager);
  assert.equal(coordinator.capabilities.perRunEndpoint, false);
});

test("capabilities.perRunEndpoint reflects a manager advertising perRunEndpoint=true", () => {
  const perRunManager: McpEndpointManager = {
    perRunEndpoint: true,
    async open(): Promise<null> {
      return null;
    },
    async release(): Promise<void> {},
  };
  const pool = makeFakeWorkerPool();
  const coordinator = makeCoordinator(pool, perRunManager);
  assert.equal(coordinator.capabilities.perRunEndpoint, true);
});

// ---------------------------------------------------------------------------
// STEP 2 (T2c): open-after-bind / close-before-settle / recycle ordering
// ---------------------------------------------------------------------------

// A fake AgentMcpEndpointLease whose release() is observable. The coordinator
// owns this lease end-to-end (it never calls release() itself; it routes through
// the manager), so the lease's own release records only that the MANAGER closed
// it via the manager.release(lease) path.
function makeFakeEndpoint(id: string): AgentMcpEndpointLease & { released: { count: number } } {
  const released = { count: 0 };
  return {
    url: `http://127.0.0.1:46000/mcp#${id}`,
    token: `tok-${id}`,
    acpServer: () => ({ type: "http", name: "symphony_linear", url: "", headers: [] }),
    async release(): Promise<void> {
      released.count += 1;
    },
    released,
  };
}

// A recording per-run manager that opens a fresh fake endpoint per call and closes
// it on release, appending to a shared ORDER log so a test can pin the
// close-before-settle / open-after-bind interleave against the lease settles.
function makeRecordingManager(
  order: string[],
  options: { openThrows?: Error } = {},
): McpEndpointManager & {
  readonly openCalls: Array<{ workerHost: string; runKey: string }>;
  readonly opened: Array<AgentMcpEndpointLease & { released: { count: number } }>;
} {
  const openCalls: Array<{ workerHost: string; runKey: string }> = [];
  const opened: Array<AgentMcpEndpointLease & { released: { count: number } }> = [];
  return {
    openCalls,
    opened,
    perRunEndpoint: true,
    async open(req): Promise<AgentMcpEndpointLease | null> {
      openCalls.push({ workerHost: req.workerHost, runKey: req.runKey });
      if (options.openThrows) {
        order.push("open:throw");
        throw options.openThrows;
      }
      order.push("open");
      const endpoint = makeFakeEndpoint(String(opened.length));
      opened.push(endpoint);
      return endpoint;
    },
    async release(lease): Promise<void> {
      order.push(lease === null ? "release:null" : "release:endpoint");
      if (lease) await lease.release();
    },
  };
}

// A FakeLease variant that appends its settle to the shared ORDER log so the
// close-before-settle ordering can be asserted against the manager.release entry.
function makeOrderedLease(
  order: string[],
  options: { workerId?: string; workerHost?: string } = {},
): FakeLease {
  const settles: Array<{ kind: "release" | "fail"; arg?: string }> = [];
  const heartbeats = { count: 0 };
  return {
    leaseId: "lease-1",
    workerId: options.workerId ?? "worker-1",
    workerHost: options.workerHost ?? "fake://worker-1",
    acquiredAtMs: 0,
    expiresAtMs: null,
    settles,
    heartbeats,
    async release(outcome?: WorkerOutcome): Promise<void> {
      order.push(`lease:release:${outcome ?? "healthy"}`);
      settles.push({ kind: "release", arg: outcome });
    },
    async fail(reason: string): Promise<void> {
      order.push(`lease:fail:${reason}`);
      settles.push({ kind: "fail", arg: reason });
    },
    heartbeat(): void {
      heartbeats.count += 1;
    },
  };
}

// Drains the pending microtask queue so a fire-and-forget settle chain (the
// recycle-driven slot.fail) completes before the assertion. A single macrotask
// turn (setTimeout 0) runs after every currently-queued microtask, which is
// enough for the close-endpoint -> settle-lease -> deregister chain.
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("open-after-bind: a per-run manager mints the endpoint and the slot carries it", async () => {
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  const lease = makeFakeLease({ workerId: "worker-7", workerHost: "ssh://host-7" });
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool, manager);

  const result = await coordinator.acquireRunSlot({ ...acquireReq, slotIndex: 3 });
  assert.equal(result.status, "bound");
  if (result.status !== "bound") return;

  // open() was called AFTER the lease bind, keyed by the bound lease's workerHost
  // and the issue-scoped runKey=`${issueId}#${slotIndex}`, and the minted endpoint is
  // attached to the slot.
  assert.equal(manager.openCalls.length, 1);
  assert.equal(manager.openCalls[0]?.workerHost, "ssh://host-7");
  assert.equal(manager.openCalls[0]?.runKey, "issue-1#3");
  assert.equal(result.slot.mcpEndpoint, manager.opened[0]);
});

test("close-before-settle: slot.release closes the endpoint BEFORE settling the lease", async () => {
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  const lease = makeOrderedLease(order, { workerHost: "ssh://host-1" });
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool, manager);

  const result = await coordinator.acquireRunSlot(acquireReq);
  if (result.status !== "bound") throw new Error("expected bound");

  await result.slot.release("healthy");
  // The endpoint close strictly precedes the lease settle (no hung endpoint to a
  // worker that is about to be returned/recycled), then the slot deregisters.
  assert.deepEqual(order, ["open", "release:endpoint", "lease:release:healthy"]);
  // The endpoint was closed exactly once.
  assert.equal(manager.opened[0]?.released.count, 1);
  assert.equal(coordinator.snapshot().slots.length, 0);
});

test("open-throw: the just-bound lease is settled HEALTHY and a structured EndpointOpenError is rethrown (no half-open child)", async () => {
  const order: string[] = [];
  const cause = new Error("tunnel_exhausted: no free remote port");
  const manager = makeRecordingManager(order, { openThrows: cause });
  const lease = makeOrderedLease(order, { workerHost: "ssh://host-1" });
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool, manager);

  let thrown: unknown;
  try {
    await coordinator.acquireRunSlot(acquireReq);
  } catch (error) {
    thrown = error;
  }

  // The endpoint open threw, so the just-bound WorkerLease is settled HEALTHY (the
  // worker is fine; only the endpoint failed) and NO endpoint close runs (there is no
  // half-open child / lease to release).
  assert.deepEqual(order, ["open:throw", "lease:release:healthy"]);
  // A structured acquire error is rethrown (NOT the raw manager error) carrying the
  // cause, so the runtime maps it to worker_pool_acquire_error.
  assert.ok(thrown instanceof EndpointOpenError);
  if (thrown instanceof EndpointOpenError) {
    assert.equal(thrown.cause, cause);
    assert.equal(thrown.workerHost, "ssh://host-1");
  }
  // No half-open slot is registered.
  assert.equal(coordinator.snapshot().slots.length, 0);
});

test("open-throw: if settling the just-bound lease ALSO throws, the original endpoint error still surfaces", async () => {
  const order: string[] = [];
  const cause = new Error("open boom");
  const manager = makeRecordingManager(order, { openThrows: cause });
  // A lease whose healthy settle rejects (e.g. a transient mutex hiccup). The
  // coordinator must not mask the endpoint-open failure with the settle failure.
  const lease: FakeLease = {
    ...makeFakeLease({ workerHost: "ssh://host-1" }),
    async release(): Promise<void> {
      throw new Error("settle boom");
    },
  };
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool, manager);

  await assert.rejects(
    () => coordinator.acquireRunSlot(acquireReq),
    (error) => error instanceof EndpointOpenError,
  );
  assert.equal(coordinator.snapshot().slots.length, 0);
});

test("recycle ordering: onMachineRecycling fails the open slot on that worker CLEANLY (endpoint closed, lease settled, deregistered)", async () => {
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  const lease = makeOrderedLease(order, { workerId: "worker-9", workerHost: "ssh://host-9" });
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool, manager);

  const result = await coordinator.acquireRunSlot(acquireReq);
  if (result.status !== "bound") throw new Error("expected bound");
  assert.equal(coordinator.snapshot().slots.length, 1);

  // The pool is recycling worker-9 (poison/reaper). The coordinator's registered
  // callback fails the slot bound to that worker: close the endpoint THEN settle the
  // lease THEN deregister - so no hung endpoint is left to the dead host.
  pool.triggerRecycling("worker-9");
  // The callback's clean fail (close endpoint -> settle lease -> deregister) is
  // fire-and-forget inside the coordinator; drain the microtask chain to let it
  // complete (a macrotask turn flushes every pending microtask).
  await flushMicrotasks();

  assert.equal(manager.opened[0]?.released.count, 1);
  // The endpoint was closed before the lease settle (ordering preserved).
  const closeIdx = order.indexOf("release:endpoint");
  const settleIdx = order.findIndex((entry) => entry.startsWith("lease:"));
  assert.ok(closeIdx >= 0 && settleIdx >= 0 && closeIdx < settleIdx);
  // The slot was deregistered: a poisoned machine leaves no slot behind.
  assert.equal(coordinator.snapshot().slots.length, 0);
});

test("recycle ordering: recycling an UNRELATED worker leaves the slot untouched", async () => {
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  const lease = makeOrderedLease(order, { workerId: "worker-9", workerHost: "ssh://host-9" });
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool, manager);

  const result = await coordinator.acquireRunSlot(acquireReq);
  if (result.status !== "bound") throw new Error("expected bound");

  // A different worker is recycled; the slot on worker-9 must stay registered and open.
  pool.triggerRecycling("worker-other");
  await flushMicrotasks();

  assert.equal(coordinator.snapshot().slots.length, 1);
  assert.equal(manager.opened[0]?.released.count, 0);
  await result.slot.release("healthy");
});

test("recycle then normal release is exactly-once: the slot's lease settles only once", async () => {
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  const lease = makeOrderedLease(order, { workerId: "worker-9", workerHost: "ssh://host-9" });
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool, manager);

  const result = await coordinator.acquireRunSlot(acquireReq);
  if (result.status !== "bound") throw new Error("expected bound");

  pool.triggerRecycling("worker-9");
  await flushMicrotasks();
  // A normal release racing in AFTER the recycle-driven fail must no-op (exactly
  // once across BOTH paths): the lease settles exactly one time, the endpoint
  // closes exactly one time.
  await result.slot.release("healthy");

  assert.equal(lease.settles.length, 1);
  assert.equal(manager.opened[0]?.released.count, 1);
});

test("drain awaits recycle-triggered per-run cleanup (endpoint release) before returning", async () => {
  const endpoint = makeFakeEndpoint("drain");
  // A manager whose close is genuinely deferred onto a MACROTASK, so a drain that
  // fails to AWAIT the recycle-triggered fail would return with the endpoint still
  // open (released.count === 0).
  const manager: McpEndpointManager = {
    perRunEndpoint: true,
    async open(): Promise<AgentMcpEndpointLease | null> {
      return endpoint;
    },
    async release(lease): Promise<void> {
      if (lease === null) return;
      await new Promise((resolve) => setTimeout(resolve, 15));
      await lease.release();
    },
  };
  const lease = makeFakeLease({ workerId: "worker-1", workerHost: "ssh://host-1" });
  const pool = makeFakeWorkerPool({ lease });
  // Model the real pool: the drain force-destroy fires the recycle callback for the
  // bound worker synchronously, starting the slot's fire-and-forget fail().
  pool.drain = async (opts): Promise<void> => {
    pool.drainCalls.push({ deadlineMs: opts.deadlineMs });
    pool.triggerRecycling("worker-1");
  };
  const coordinator = makeCoordinator(pool, manager);

  const bound = await coordinator.acquireRunSlot(acquireReq);
  if (bound.status !== "bound") throw new Error("expected bound");
  assert.equal(coordinator.snapshot().slots.length, 1);

  await coordinator.drain({ deadlineMs: 1_000 });

  // drain awaited the recycle-triggered endpoint close to COMPLETION before
  // returning - without the await, released.count would still be 0 here (the
  // macrotask close had not fired) and the daemon would stop the server mid-cleanup.
  assert.equal(endpoint.released.count, 1);
  // The recycled slot was deregistered too.
  assert.equal(coordinator.snapshot().slots.length, 0);
});

test("single-slot (default slotsPerMachine=1) opens EXACTLY ONE endpoint per run", async () => {
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  const lease = makeFakeLease({ workerHost: "ssh://host-1" });
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool, manager);

  const result = await coordinator.acquireRunSlot(acquireReq);
  if (result.status !== "bound") throw new Error("expected bound");

  // Exactly one open, and a heartbeat/resume within the run never re-opens.
  result.slot.heartbeat();
  assert.equal(manager.openCalls.length, 1);
  assert.equal(manager.opened.length, 1);
  await result.slot.release("healthy");
});

// ---------------------------------------------------------------------------
// STEP 3 (T3b): (issueId, slotIndex) uniqueness invariant feeding runKey
// ---------------------------------------------------------------------------

// A pool that hands out a SCRIPTED sequence of leased results, one per acquire
// call, so a test can construct the exact same-issue (issueId, slotIndex)-on-one-worker
// collision the co-residence dossier warns about (two distinct lease generations
// landing on ONE machine for the SAME slot).
function makeScriptedWorkerPool(leases: FakeLease[], reconcileError?: Error): FakeWorkerPool {
  let next = 0;
  return makeFakeWorkerPool({
    result: () => {
      const lease = leases[next];
      next += 1;
      if (!lease) throw new Error("scripted pool exhausted");
      return { status: "leased", lease };
    },
    reconcileError,
  });
}

test("acquireRunSlot REJECTS a second (issueId, slotIndex) on the SAME machine (assert-and-reject collision)", async () => {
  // Two distinct lease generations (leaseId a/b) both land on worker-1 for the SAME
  // (issueId='issue-1', slotIndex=0). The first binds a RunSlot; the second is a
  // (issueId, slotIndex)-on-one-machine collision and MUST be rejected, never
  // silently disambiguated (openQuestion #1: assert-and-reject preferred).
  const a = makeFakeLease({ leaseId: "a", workerId: "worker-1", workerHost: "ssh://host-1" });
  const b = makeFakeLease({ leaseId: "b", workerId: "worker-1", workerHost: "ssh://host-1" });
  const pool = makeScriptedWorkerPool([a, b]);
  const coordinator = makeCoordinator(pool);

  const first = await coordinator.acquireRunSlot({
    ...acquireReq,
    issueId: "issue-1",
    slotIndex: 0,
  });
  assert.equal(first.status, "bound");

  let thrown: unknown;
  try {
    await coordinator.acquireRunSlot({ ...acquireReq, issueId: "issue-1", slotIndex: 0 });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof RunSlotCollisionError);
  if (thrown instanceof RunSlotCollisionError) {
    assert.equal(thrown.issueId, "issue-1");
    assert.equal(thrown.slotIndex, 0);
    assert.equal(thrown.machineLeaseId, "worker-1");
  }
  // The colliding second lease was settled HEALTHY (the worker is fine) and NO second
  // slot registered: exactly the first slot remains live.
  assert.deepEqual(b.settles, [{ kind: "release", arg: "healthy" }]);
  assert.equal(coordinator.snapshot().slots.length, 1);
});

test("(issueId, slotIndex) uniqueness: runKey AND workspace-suffix uniqueness hold SIMULTANEOUSLY across co-resident slots", async () => {
  // Two DISTINCT slots of one issue co-residing on ONE worker (slotsPerMachine>1):
  // distinct slotIndex => distinct runKey (per-run endpoint/tunnel key) AND distinct
  // workspace slot suffix, so neither the tunnel nor the workspace is shared.
  const s0 = makeFakeLease({ leaseId: "g0", workerId: "worker-1", workerHost: "ssh://host-1" });
  const s1 = makeFakeLease({ leaseId: "g1", workerId: "worker-1", workerHost: "ssh://host-1" });
  const pool = makeScriptedWorkerPool([s0, s1]);
  const coordinator = makeCoordinator(pool);

  const r0 = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "issue-1", slotIndex: 0 });
  const r1 = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "issue-1", slotIndex: 1 });
  if (r0.status !== "bound" || r1.status !== "bound") throw new Error("expected bound");

  // runKey is the issue-scoped `${issueId}#${slotIndex}`: distinct per slot (the
  // slotIndex differs), so the two co-resident slots get distinct per-run
  // endpoint/tunnel keys; the workspace dir stays distinct via its own slotIndex
  // suffix simultaneously.
  assert.equal(r0.slot.runKey, "issue-1#0");
  assert.equal(r1.slot.runKey, "issue-1#1");
  assert.ok(r0.slot.runKey !== r1.slot.runKey);
  // Both live on the SAME machine yet have distinct slot identities.
  assert.equal(r0.slot.machineLeaseId, "worker-1");
  assert.equal(r1.slot.machineLeaseId, "worker-1");
  assert.ok(r0.slot.slotId !== r1.slot.slotId);
  assert.equal(coordinator.snapshot().slots.length, 2);
});

test("runKey is ISSUE-SCOPED: two DIFFERENT issues at slotIndex 0 co-resident on ONE machine get DISTINCT runKeys", async () => {
  // Codex HIGH #2: with slotsPerMachine>1, DIFFERENT issues can co-reside on ONE
  // workerHost. A bare `${slotIndex}` runKey would make both non-ensemble issues
  // (slotIndex 0) key to "0", so `${workerHost}#${runKey}` collides ACROSS issues ->
  // shared tunnel/port, broken per-run isolation. The runKey must be ISSUE-SCOPED
  // (`${issueId}#${slotIndex}`) so co-resident runs of different issues get DISTINCT
  // per-run endpoint/tunnel keys.
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  const a = makeFakeLease({ leaseId: "a", workerId: "worker-1", workerHost: "ssh://host-1" });
  const b = makeFakeLease({ leaseId: "b", workerId: "worker-1", workerHost: "ssh://host-1" });
  const pool = makeScriptedWorkerPool([a, b]);
  const coordinator = makeCoordinator(pool, manager);

  const ra = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "issue-a", slotIndex: 0 });
  const rb = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "issue-b", slotIndex: 0 });
  if (ra.status !== "bound" || rb.status !== "bound") throw new Error("expected bound");

  // Both at slotIndex 0 on the SAME machine, yet DISTINCT issue-scoped runKeys.
  assert.equal(ra.slot.runKey, "issue-a#0");
  assert.equal(rb.slot.runKey, "issue-b#0");
  assert.ok(ra.slot.runKey !== rb.slot.runKey);

  // The per-run manager opened each endpoint with the DISTINCT issue-scoped runKey
  // (the key that feeds `${workerHost}#${runKey}` in the tunnel pool), so the two
  // co-resident runs never share a tunnel/port.
  assert.equal(manager.openCalls[0]?.runKey, "issue-a#0");
  assert.equal(manager.openCalls[1]?.runKey, "issue-b#0");
});

test("same (issueId, slotIndex) on DIFFERENT machines is NOT a collision (cross-machine is allowed)", async () => {
  // The invariant is scoped per-machine: the SAME (issueId, slotIndex) on a
  // DIFFERENT worker is a legitimate concurrent placement, not a collision.
  const a = makeFakeLease({ leaseId: "a", workerId: "worker-1", workerHost: "ssh://host-1" });
  const b = makeFakeLease({ leaseId: "b", workerId: "worker-2", workerHost: "ssh://host-2" });
  const pool = makeScriptedWorkerPool([a, b]);
  const coordinator = makeCoordinator(pool);

  const r0 = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "issue-1", slotIndex: 0 });
  const r1 = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "issue-1", slotIndex: 0 });
  assert.equal(r0.status, "bound");
  assert.equal(r1.status, "bound");
  assert.equal(coordinator.snapshot().slots.length, 2);
});

test("(issueId, slotIndex) freed by release can be re-acquired on the SAME machine (no false collision)", async () => {
  // After the first slot settles (deregisters), the SAME (issueId, slotIndex) on the
  // SAME worker is free again - a retry re-binding it must NOT trip the collision guard.
  const a = makeFakeLease({ leaseId: "a", workerId: "worker-1", workerHost: "ssh://host-1" });
  const b = makeFakeLease({ leaseId: "b", workerId: "worker-1", workerHost: "ssh://host-1" });
  const pool = makeScriptedWorkerPool([a, b]);
  const coordinator = makeCoordinator(pool);

  const first = await coordinator.acquireRunSlot({
    ...acquireReq,
    issueId: "issue-1",
    slotIndex: 0,
  });
  if (first.status !== "bound") throw new Error("expected bound");
  await first.slot.release("healthy");

  // The slot is deregistered; re-acquiring the same (issueId, slotIndex) on worker-1 binds cleanly.
  const second = await coordinator.acquireRunSlot({
    ...acquireReq,
    issueId: "issue-1",
    slotIndex: 0,
  });
  assert.equal(second.status, "bound");
  assert.equal(coordinator.snapshot().slots.length, 1);
});

test("collision rejection does NOT open an endpoint (the colliding endpoint is never minted)", async () => {
  // The collision is detected BEFORE the per-run endpoint is opened, so a per-run
  // manager mints exactly ONE endpoint (for the first slot), never a second.
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  const a = makeFakeLease({ leaseId: "a", workerId: "worker-1", workerHost: "ssh://host-1" });
  const b = makeFakeLease({ leaseId: "b", workerId: "worker-1", workerHost: "ssh://host-1" });
  const pool = makeScriptedWorkerPool([a, b]);
  const coordinator = makeCoordinator(pool, manager);

  await coordinator.acquireRunSlot({ ...acquireReq, issueId: "issue-1", slotIndex: 0 });
  await assert.rejects(
    () => coordinator.acquireRunSlot({ ...acquireReq, issueId: "issue-1", slotIndex: 0 }),
    (error) => error instanceof RunSlotCollisionError,
  );
  // Exactly one endpoint opened (the first slot); the collision minted none.
  assert.equal(manager.openCalls.length, 1);
  assert.equal(manager.opened.length, 1);
});

// ---------------------------------------------------------------------------
// createPerRunEndpointManager: local-vs-remote routing + perRunEndpoint=true
// ---------------------------------------------------------------------------

test("createPerRunEndpointManager advertises perRunEndpoint=true", () => {
  const manager = createPerRunEndpointManager({
    acquireForRun: async () => makeFakeEndpoint("x"),
  });
  assert.equal(manager.perRunEndpoint, true);
});

test("createPerRunEndpointManager opens a per-run endpoint for an ssh-addressable host", async () => {
  const calls: Array<{ workerHost: string; runKey: string }> = [];
  const endpoint = makeFakeEndpoint("a");
  const manager = createPerRunEndpointManager({
    acquireForRun: async (_settings, workerHost, runKey) => {
      calls.push({ workerHost, runKey });
      return endpoint;
    },
  });

  const settings = settingsStub("s") as unknown as Parameters<
    McpEndpointManager["open"]
  >[0]["settings"];
  const lease = await manager.open({ settings, workerHost: "ssh://host-1", runKey: "2" });
  assert.equal(lease, endpoint);
  assert.deepEqual(calls, [{ workerHost: "ssh://host-1", runKey: "2" }]);
});

test("createPerRunEndpointManager returns null for a local (falsy) workerHost (acp keeps its own endpoint)", async () => {
  let acquireCalled = false;
  const manager = createPerRunEndpointManager({
    acquireForRun: async () => {
      acquireCalled = true;
      return makeFakeEndpoint("a");
    },
  });
  const settings = settingsStub("s") as unknown as Parameters<
    McpEndpointManager["open"]
  >[0]["settings"];

  const lease = await manager.open({ settings, workerHost: "", runKey: "0" });
  assert.equal(lease, null);
  assert.equal(acquireCalled, false);
});

test("createPerRunEndpointManager.release closes the lease; release(null) is a no-op", async () => {
  const manager = createPerRunEndpointManager({
    acquireForRun: async () => makeFakeEndpoint("a"),
  });
  const endpoint = makeFakeEndpoint("a");
  await manager.release(endpoint);
  assert.equal(endpoint.released.count, 1);
  // null lease (the local path) is a safe no-op.
  await manager.release(null);
});

// ---------------------------------------------------------------------------
// STEP 3 (T3c #1): tunnel-exhaustion ceiling -> typed no_capacity 'tunnel_exhausted'
// ---------------------------------------------------------------------------
//
// When settings.maxConcurrentTunnels is set, opening another per-run endpoint
// that would exceed it must surface as a TYPED no_capacity 'tunnel_exhausted',
// NEVER an unhandled throw inside acquireRunSlot. The ceiling counts LIVE per-run
// endpoints (slots whose mcpEndpoint !== null) in the coordinator's authoritative
// registry, so it is a precise refcount that the per-run open + the slot settle
// keep exact. The just-bound WorkerLease is settled HEALTHY (the worker is fine; only
// the tunnel budget is exhausted) and NO slot is registered, so a sibling run sees
// a clean recover-and-re-evaluate (worker_host_capacity) instead of a fault.

// A coordinator over a scripted pool with explicit WorkerPoolSettings (so the tunnel
// ceiling reads a real maxConcurrentTunnels). The pool hands out leases on
// distinct workers by default so the (issueId, slotIndex) collision guard never
// trips - the ceiling is the thing under test.
function makeCoordinatorWithSettings(
  pool: FakeWorkerPool,
  manager: McpEndpointManager,
  settings: Partial<WorkerPoolSettings>,
): ReturnType<typeof createDispatchCoordinator> {
  return createDispatchCoordinator({
    pool,
    mcpEndpointManager: manager,
    settings: { __tag: "ceiling", ...settings } as unknown as WorkerPoolSettings,
  });
}

// A scripted pool that hands out one lease per acquire on a DISTINCT worker/host so
// each acquire opens its own per-run tunnel (no co-residence collision).
function makeMultiWorkerPool(count: number): FakeWorkerPool {
  const leases: FakeLease[] = [];
  for (let i = 0; i < count; i += 1) {
    leases.push(
      makeFakeLease({ leaseId: `g${i}`, workerId: `worker-${i}`, workerHost: `ssh://host-${i}` }),
    );
  }
  return makeScriptedWorkerPool(leases);
}

test("tunnel ceiling: opening past maxConcurrentTunnels returns no_capacity 'tunnel_exhausted' (not a throw)", async () => {
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  const pool = makeMultiWorkerPool(3);
  // Ceiling of 2 live tunnels.
  const coordinator = makeCoordinatorWithSettings(pool, manager, { maxConcurrentTunnels: 2 });

  const r0 = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "i", slotIndex: 0 });
  const r1 = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "i", slotIndex: 1 });
  assert.equal(r0.status, "bound");
  assert.equal(r1.status, "bound");
  // Two live tunnels: the third acquire is over the ceiling and is rejected as a
  // TYPED no_capacity (never thrown).
  const r2 = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "i", slotIndex: 2 });
  assert.equal(r2.status, "no_capacity");
  if (r2.status !== "no_capacity") return;
  assert.equal(r2.reason, "tunnel_exhausted");
  // Only two endpoints were ever opened (the ceiling short-circuits BEFORE the open).
  assert.equal(manager.openCalls.length, 2);
  assert.equal(coordinator.snapshot().slots.length, 2);
});

test("tunnel ceiling: the over-ceiling lease is settled HEALTHY (the worker is fine) and never poisoned", async () => {
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  const overflow = makeFakeLease({
    leaseId: "of",
    workerId: "worker-of",
    workerHost: "ssh://host-of",
  });
  // First lease occupies the only tunnel slot; the second (overflow) trips the ceiling.
  const pool = makeScriptedWorkerPool([
    makeFakeLease({ leaseId: "g0", workerId: "worker-0", workerHost: "ssh://host-0" }),
    overflow,
  ]);
  const coordinator = makeCoordinatorWithSettings(pool, manager, { maxConcurrentTunnels: 1 });

  const first = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "i", slotIndex: 0 });
  assert.equal(first.status, "bound");
  const second = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "i", slotIndex: 1 });
  assert.equal(second.status, "no_capacity");
  // The over-ceiling worker itself is healthy - its lease was released 'healthy',
  // NEVER failed/poisoned (the tunnel budget, not the worker, is the constraint).
  assert.deepEqual(overflow.settles, [{ kind: "release", arg: "healthy" }]);
});

test("tunnel ceiling: releasing a slot frees a tunnel so the next acquire binds again", async () => {
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  const pool = makeMultiWorkerPool(3);
  const coordinator = makeCoordinatorWithSettings(pool, manager, { maxConcurrentTunnels: 1 });

  const r0 = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "i", slotIndex: 0 });
  if (r0.status !== "bound") throw new Error("expected bound");
  // At the ceiling: the next acquire is rejected.
  const blocked = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "i", slotIndex: 1 });
  assert.equal(blocked.status, "no_capacity");

  // Free the live tunnel, then the next acquire binds again (the refcount dropped).
  await r0.slot.release("healthy");
  const r1 = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "i", slotIndex: 2 });
  assert.equal(r1.status, "bound");
  assert.equal(coordinator.snapshot().slots.length, 1);
});

test("tunnel ceiling: reconcile RAISES the ceiling and the next acquire binds (settings survive reload)", async () => {
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  const pool = makeMultiWorkerPool(3);
  const coordinator = makeCoordinatorWithSettings(pool, manager, { maxConcurrentTunnels: 1 });

  const r0 = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "i", slotIndex: 0 });
  assert.equal(r0.status, "bound");
  const blocked = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "i", slotIndex: 1 });
  assert.equal(blocked.status, "no_capacity");

  // A config reload raises the ceiling to 2 - the live registry (one slot) is
  // preserved across reconcile, and the ceiling re-reads the new settings.
  await coordinator.reconcile({
    __tag: "raised",
    maxConcurrentTunnels: 2,
  } as unknown as WorkerPoolSettings);
  const r1 = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "i", slotIndex: 2 });
  assert.equal(r1.status, "bound");
  assert.equal(coordinator.snapshot().slots.length, 2);
});

test("tunnel ceiling: a REJECTED reconcile (pool.reconcile throws) does NOT advance the ceiling (transactional)", async () => {
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  // pool.reconcile THROWS (models a reload to an unavailable driver). The pool
  // rolls itself back; the coordinator must NOT commit currentSettings to the
  // rejected config (so the tunnel ceiling stays at the last-good value).
  const reloadFailure = new Error("worker_pool_driver_unavailable");
  const pool = makeScriptedWorkerPool(
    [
      makeFakeLease({ leaseId: "g0", workerId: "worker-0", workerHost: "ssh://host-0" }),
      makeFakeLease({ leaseId: "g1", workerId: "worker-1", workerHost: "ssh://host-1" }),
    ],
    reloadFailure,
  );
  const coordinator = makeCoordinatorWithSettings(pool, manager, { maxConcurrentTunnels: 1 });

  const r0 = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "i", slotIndex: 0 });
  assert.equal(r0.status, "bound");

  // A reload that WOULD raise the ceiling to 5 is rejected by the pool.
  await assert.rejects(
    () =>
      coordinator.reconcile({
        __tag: "rejected",
        maxConcurrentTunnels: 5,
      } as unknown as WorkerPoolSettings),
    /worker_pool_driver_unavailable/,
  );

  // The ceiling is STILL the last-good 1: a second acquire (which the rejected
  // ceiling of 5 would have admitted) is gated as tunnel_exhausted, proving
  // currentSettings was NOT advanced to the rejected config.
  const blocked = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "i", slotIndex: 1 });
  assert.equal(blocked.status, "no_capacity");
  if (blocked.status !== "no_capacity") return;
  assert.equal(blocked.reason, "tunnel_exhausted");
  assert.equal(coordinator.snapshot().slots.length, 1);
});

test("tunnel ceiling: absent maxConcurrentTunnels never gates (no ceiling configured)", async () => {
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  const pool = makeMultiWorkerPool(4);
  // No maxConcurrentTunnels: every acquire binds (the ceiling is opt-in).
  const coordinator = makeCoordinatorWithSettings(pool, manager, {});

  for (let slotIndex = 0; slotIndex < 4; slotIndex += 1) {
    const result = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "i", slotIndex });
    assert.equal(result.status, "bound");
  }
  assert.equal(coordinator.snapshot().slots.length, 4);
});

test("tunnel ceiling: the NULL passthrough never trips the ceiling (no per-run endpoint is minted)", async () => {
  // perRunEndpoint=false mints no tunnels, so even an absurdly low ceiling never
  // gates - the default single-tenant path stays byte-identical.
  const pool = makeMultiWorkerPool(3);
  const coordinator = makeCoordinatorWithSettings(pool, nullEndpointManager, {
    maxConcurrentTunnels: 1,
  });

  for (let slotIndex = 0; slotIndex < 3; slotIndex += 1) {
    const result = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "i", slotIndex });
    assert.equal(result.status, "bound");
  }
  assert.equal(coordinator.snapshot().slots.length, 3);
});

test("tunnel ceiling: a local-host slot (null endpoint) does NOT consume tunnel budget", async () => {
  // The concrete manager mints nothing for a local host, so that slot holds no
  // tunnel and must not count against the ceiling: a real remote run can still bind.
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  // First lease is a LOCAL host (manager returns null), second is remote.
  const pool = makeScriptedWorkerPool([
    makeFakeLease({ leaseId: "g0", workerId: "worker-0", workerHost: "" }),
    makeFakeLease({ leaseId: "g1", workerId: "worker-1", workerHost: "ssh://host-1" }),
  ]);
  // Wrap the recording manager so a local host mints no endpoint (mirrors the
  // concrete per-run manager's host routing).
  const routingManager: McpEndpointManager = {
    perRunEndpoint: true,
    async open(req): Promise<AgentMcpEndpointLease | null> {
      if (req.workerHost.length === 0) return null;
      return manager.open(req);
    },
    async release(lease): Promise<void> {
      await manager.release(lease);
    },
  };
  const coordinator = makeCoordinatorWithSettings(pool, routingManager, {
    maxConcurrentTunnels: 1,
  });

  const local = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "i", slotIndex: 0 });
  assert.equal(local.status, "bound");
  if (local.status === "bound") assert.equal(local.slot.mcpEndpoint, null);
  // The local slot holds no tunnel, so the single tunnel budget is still free.
  const remote = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "i", slotIndex: 1 });
  assert.equal(remote.status, "bound");
  assert.equal(manager.openCalls.length, 1);
});

// ---------------------------------------------------------------------------
// STEP 3 (T3c #2): per-issue RunSlot accounting (precise live-slot refcount)
// ---------------------------------------------------------------------------
//
// The coordinator holds the authoritative per-(issueId, slotIndex, leaseId)
// RunSlot registry. Per-issue fairness is a PRECISE refcount of LIVE RunSlots:
// it increments on a successful bind and decrements only when the settling slot
// releases. snapshot().slots reflects exactly the live slots, so a consumer can
// derive the per-issue count by filtering on issueId.

function liveSlotsForIssue(
  coordinator: ReturnType<typeof createDispatchCoordinator>,
  issueId: string,
): number {
  return coordinator.snapshot().slots.filter((slot) => slot.issueId === issueId).length;
}

test("per-issue accounting: snapshot().slots is an exact refcount of LIVE slots per issue", async () => {
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  // Two slots for issue-a, one for issue-b, all on distinct workers.
  const pool = makeScriptedWorkerPool([
    makeFakeLease({ leaseId: "a0", workerId: "worker-0", workerHost: "ssh://host-0" }),
    makeFakeLease({ leaseId: "a1", workerId: "worker-1", workerHost: "ssh://host-1" }),
    makeFakeLease({ leaseId: "b0", workerId: "worker-2", workerHost: "ssh://host-2" }),
  ]);
  const coordinator = makeCoordinator(pool, manager);

  const a0 = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "issue-a", slotIndex: 0 });
  await coordinator.acquireRunSlot({ ...acquireReq, issueId: "issue-a", slotIndex: 1 });
  await coordinator.acquireRunSlot({ ...acquireReq, issueId: "issue-b", slotIndex: 0 });
  if (a0.status !== "bound") throw new Error("expected bound");

  // issue-a holds two live slots; issue-b holds one; the total is three.
  assert.equal(liveSlotsForIssue(coordinator, "issue-a"), 2);
  assert.equal(liveSlotsForIssue(coordinator, "issue-b"), 1);
  assert.equal(coordinator.snapshot().slots.length, 3);

  // Settling ONE of issue-a's slots decrements only issue-a's count (precise per
  // settling slot, not per machine).
  await a0.slot.release("healthy");
  assert.equal(liveSlotsForIssue(coordinator, "issue-a"), 1);
  assert.equal(liveSlotsForIssue(coordinator, "issue-b"), 1);
  assert.equal(coordinator.snapshot().slots.length, 2);
});

test("per-issue accounting: a no_capacity acquire never increments the refcount", async () => {
  const pool = makeFakeWorkerPool({ result: { status: "no_capacity", reason: "spend_cap" } });
  const coordinator = makeCoordinator(pool);

  const result = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "issue-a" });
  assert.equal(result.status, "no_capacity");
  assert.equal(liveSlotsForIssue(coordinator, "issue-a"), 0);
});

test("per-issue accounting: a recycle-driven fail decrements the refcount (registry stays exact)", async () => {
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  const lease = makeOrderedLease(order, { workerId: "worker-9", workerHost: "ssh://host-9" });
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool, manager);

  const result = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "issue-a" });
  if (result.status !== "bound") throw new Error("expected bound");
  assert.equal(liveSlotsForIssue(coordinator, "issue-a"), 1);

  // A machine recycle fails the slot cleanly; the per-issue refcount drops to zero.
  pool.triggerRecycling("worker-9");
  await flushMicrotasks();
  assert.equal(liveSlotsForIssue(coordinator, "issue-a"), 0);
  assert.equal(coordinator.snapshot().slots.length, 0);
});

test("per-issue accounting: co-resident slots of one issue on ONE machine are counted individually", async () => {
  // slotsPerMachine>1 co-residence: two DISTINCT slots of one issue on ONE worker.
  // The per-issue refcount is the count of LIVE slots (2), independent of the
  // machine-level maxWorkersPerIssue cap (which the pool enforces over machines).
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  const pool = makeScriptedWorkerPool([
    makeFakeLease({ leaseId: "g0", workerId: "worker-1", workerHost: "ssh://host-1" }),
    makeFakeLease({ leaseId: "g1", workerId: "worker-1", workerHost: "ssh://host-1" }),
  ]);
  const coordinator = makeCoordinator(pool, manager);

  const r0 = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "issue-a", slotIndex: 0 });
  const r1 = await coordinator.acquireRunSlot({ ...acquireReq, issueId: "issue-a", slotIndex: 1 });
  if (r0.status !== "bound" || r1.status !== "bound") throw new Error("expected bound");

  // Both co-resident slots live on the SAME machine yet count as two live slots.
  assert.equal(liveSlotsForIssue(coordinator, "issue-a"), 2);
  assert.equal(r0.slot.machineLeaseId, "worker-1");
  assert.equal(r1.slot.machineLeaseId, "worker-1");
});

// ---------------------------------------------------------------------------
// Codex iter-4 HIGH #1: endpoint-release failure must NOT strand a leased worker
// ---------------------------------------------------------------------------
//
// In the RunSlot settle path the endpoint cleanup must be BEST-EFFORT: if
// mcpEndpointManager.release(endpoint) REJECTS (e.g. local mcp server stop /
// tunnel close throws), the wrapped WorkerLease must STILL settle (release/fail per
// outcome) AND the slot must STILL deregister, so capacity + tunnel accounting is
// released regardless. The endpoint error is surfaced/logged, NEVER thrown to the
// caller as an unsettled lease.

test("settle: endpoint-release REJECTION still settles the WorkerLease, deregisters the slot, and surfaces the error (HIGH #1)", async () => {
  const order: string[] = [];
  const releaseError = new Error("tunnel_close_failed: local mcp server stop threw");
  // A per-run manager whose endpoint open succeeds but whose release REJECTS.
  const endpoint = makeFakeEndpoint("x");
  const manager: McpEndpointManager = {
    perRunEndpoint: true,
    async open(): Promise<AgentMcpEndpointLease | null> {
      order.push("open");
      return endpoint;
    },
    async release(): Promise<void> {
      order.push("release:throw");
      throw releaseError;
    },
  };
  const lease = makeOrderedLease(order, { workerHost: "ssh://host-1" });
  const pool = makeFakeWorkerPool({ lease });
  const events: Array<Record<string, unknown>> = [];
  const coordinator = createDispatchCoordinator({
    pool,
    mcpEndpointManager: manager,
    settings: settingsStub("high1"),
    logEvent: (event) => events.push(event),
  });

  const result = await coordinator.acquireRunSlot(acquireReq);
  if (result.status !== "bound") throw new Error("expected bound");
  assert.equal(coordinator.snapshot().slots.length, 1);

  // The slot release must NOT reject even though endpoint close throws.
  await result.slot.release("healthy");

  // The wrapped WorkerLease still settled (release('healthy')) despite the endpoint
  // close failure, and the slot deregistered (capacity released regardless).
  assert.deepEqual(lease.settles, [{ kind: "release", arg: "healthy" }]);
  assert.equal(coordinator.snapshot().slots.length, 0);
  // The endpoint close was attempted BEFORE the lease settle (ordering preserved).
  assert.deepEqual(order, ["open", "release:throw", "lease:release:healthy"]);
  // The endpoint error was surfaced/logged (not thrown to the caller).
  const logged = events.find((e) => e.event === "worker_pool_endpoint_release_failed");
  assert.ok(logged);
});

test("settle: endpoint-release REJECTION on a poison fail still fails the WorkerLease and deregisters (HIGH #1)", async () => {
  const order: string[] = [];
  const manager: McpEndpointManager = {
    perRunEndpoint: true,
    async open(): Promise<AgentMcpEndpointLease | null> {
      order.push("open");
      return makeFakeEndpoint("y");
    },
    async release(): Promise<void> {
      order.push("release:throw");
      throw new Error("endpoint close boom");
    },
  };
  const lease = makeOrderedLease(order, { workerHost: "ssh://host-1" });
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool, manager);

  const result = await coordinator.acquireRunSlot(acquireReq);
  if (result.status !== "bound") throw new Error("expected bound");

  // A failing slot whose endpoint close throws still fails the wrapped lease.
  await result.slot.fail("ssh_timeout: host 60000");
  assert.deepEqual(lease.settles, [{ kind: "fail", arg: "ssh_timeout: host 60000" }]);
  assert.equal(coordinator.snapshot().slots.length, 0);
});

// ---------------------------------------------------------------------------
// Codex iter-4 HIGH #2: tunnel ceiling must not be raceable under concurrent acquires
// ---------------------------------------------------------------------------
//
// The maxConcurrentTunnels check counted only slots ALREADY registered, but
// registration happens AFTER `await mcpEndpointManager.open(...)`. Two concurrent
// acquires could both see liveTunnelCount() < ceiling, then both open -> cap
// violated. A SYNCHRONOUS reservation taken BEFORE awaiting open (and counted by
// the ceiling) must close the race: with maxConcurrentTunnels:1 and two CONCURRENT
// acquires whose opens are DELAYED, exactly ONE tunnel opens and the other returns
// no_capacity:'tunnel_exhausted'.

// A per-run manager whose open() blocks on an externally-resolved gate so two
// acquires can be in-flight (past the ceiling check) simultaneously.
function makeGatedManager(): McpEndpointManager & {
  readonly openCalls: { count: number };
  releaseGate(): void;
} {
  const openCalls = { count: 0 };
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  return {
    openCalls,
    releaseGate(): void {
      resolveGate();
    },
    perRunEndpoint: true,
    async open(): Promise<AgentMcpEndpointLease | null> {
      openCalls.count += 1;
      await gate;
      return makeFakeEndpoint(String(openCalls.count));
    },
    async release(): Promise<void> {},
  };
}

test("tunnel ceiling: two CONCURRENT acquires with DELAYED opens never exceed maxConcurrentTunnels:1 (HIGH #2)", async () => {
  const manager = makeGatedManager();
  const pool = makeMultiWorkerPool(2);
  const coordinator = makeCoordinatorWithSettings(pool, manager, { maxConcurrentTunnels: 1 });

  // Fire BOTH acquires before either open resolves (the gate is still closed).
  const p0 = coordinator.acquireRunSlot({ ...acquireReq, issueId: "i", slotIndex: 0 });
  const p1 = coordinator.acquireRunSlot({ ...acquireReq, issueId: "i", slotIndex: 1 });
  // Let both acquires run up to their (gated) open.
  await flushMicrotasks();
  // Release the gate so any started open resolves.
  manager.releaseGate();
  const [r0, r1] = await Promise.all([p0, p1]);

  const statuses = [r0.status, r1.status].sort();
  // Exactly ONE bound, exactly ONE tunnel_exhausted - the reservation closed the race.
  assert.deepEqual(statuses, ["bound", "no_capacity"]);
  const exhausted = [r0, r1].find((r) => r.status === "no_capacity");
  if (exhausted && exhausted.status === "no_capacity") {
    assert.equal(exhausted.reason, "tunnel_exhausted");
  }
  // The losing acquire must NOT have opened a tunnel: only ONE open was ever issued.
  assert.equal(manager.openCalls.count, 1);
  assert.equal(coordinator.snapshot().slots.length, 1);
});

// ---------------------------------------------------------------------------
// Codex iter-6 HIGH: needsMcpEndpoint gates the per-run endpoint + tunnel ceiling
// ---------------------------------------------------------------------------
//
// A Codex/appserver run runs its dynamic tools in-process and IGNORES the per-run
// mcpEndpoint - only ACP/Claude needs /mcp over the reverse tunnel. So a
// worker-pool run for an executor that needs NO endpoint must NOT open one, must NOT
// take a tunnel-ceiling reservation, and must NOT be gated by maxConcurrentTunnels
// (it consumes no `ssh -N` child). It dispatches as a normal bound slot whose
// mcpEndpoint stays null. An ACP run (needsMcpEndpoint=true / unset) keeps the
// per-run endpoint path unchanged.

// A per-run manager whose open() ALWAYS throws, so a test can prove a
// needsMcpEndpoint=false acquire never even calls open (it dispatches regardless).
function makeThrowingOpenManager(order: string[]): McpEndpointManager & {
  readonly openCalls: { count: number };
} {
  const openCalls = { count: 0 };
  return {
    openCalls,
    perRunEndpoint: true,
    async open(): Promise<AgentMcpEndpointLease | null> {
      openCalls.count += 1;
      order.push("open:throw");
      throw new Error("mcp_endpoint_open_failed: remote port-forward restricted");
    },
    async release(): Promise<void> {
      order.push("release");
    },
  };
}

test("needsMcpEndpoint=false: a remote leased slot dispatches WITHOUT opening an endpoint even when open() throws (HIGH)", async () => {
  const order: string[] = [];
  const manager = makeThrowingOpenManager(order);
  const lease = makeFakeLease({ workerHost: "ssh://host-codex" });
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool, manager);

  // A Codex/appserver run needs no per-run endpoint: the coordinator must SKIP
  // mcpEndpointManager.open entirely (so a throwing/failing manager never gets a
  // chance to skip the dispatch) and bind the slot with a null endpoint.
  const result = await coordinator.acquireRunSlot({ ...acquireReq, needsMcpEndpoint: false });
  assert.equal(result.status, "bound");
  if (result.status !== "bound") return;
  assert.equal(result.slot.mcpEndpoint, null);
  // open() was NEVER called - the manager could not throw the run out of dispatch.
  assert.equal(manager.openCalls.count, 0);
  assert.deepEqual(order, []);
  assert.equal(coordinator.snapshot().slots.length, 1);
});

test("needsMcpEndpoint=false: a remote slot does NOT consume tunnel budget / trip maxConcurrentTunnels (HIGH)", async () => {
  // With maxConcurrentTunnels:0 ANY tunnel reservation would exhaust immediately.
  // A needs-no-endpoint run must neither reserve nor be gated: it binds normally.
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  const pool = makeMultiWorkerPool(3);
  const coordinator = makeCoordinatorWithSettings(pool, manager, { maxConcurrentTunnels: 0 });

  for (let slotIndex = 0; slotIndex < 3; slotIndex += 1) {
    const result = await coordinator.acquireRunSlot({
      ...acquireReq,
      issueId: "i",
      slotIndex,
      needsMcpEndpoint: false,
    });
    assert.equal(result.status, "bound");
    if (result.status === "bound") assert.equal(result.slot.mcpEndpoint, null);
  }
  // Never gated as tunnel_exhausted, never opened an endpoint.
  assert.equal(manager.openCalls.length, 0);
  assert.equal(coordinator.snapshot().slots.length, 3);
});

test("needsMcpEndpoint=false slots leave the ceiling free for a later needs-endpoint run (no budget consumed)", async () => {
  // A no-endpoint slot must not silently eat a tunnel: with a ceiling of 1, a
  // no-endpoint run binds AND a subsequent needs-endpoint remote run still opens
  // the single available tunnel.
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  const pool = makeScriptedWorkerPool([
    makeFakeLease({ leaseId: "g0", workerId: "worker-0", workerHost: "ssh://host-0" }),
    makeFakeLease({ leaseId: "g1", workerId: "worker-1", workerHost: "ssh://host-1" }),
  ]);
  const coordinator = makeCoordinatorWithSettings(pool, manager, { maxConcurrentTunnels: 1 });

  const noEndpoint = await coordinator.acquireRunSlot({
    ...acquireReq,
    issueId: "i",
    slotIndex: 0,
    needsMcpEndpoint: false,
  });
  assert.equal(noEndpoint.status, "bound");
  // The needs-endpoint remote run still gets the only tunnel (the no-endpoint slot
  // consumed none of the budget).
  const needsEndpoint = await coordinator.acquireRunSlot({
    ...acquireReq,
    issueId: "i",
    slotIndex: 1,
    needsMcpEndpoint: true,
  });
  assert.equal(needsEndpoint.status, "bound");
  if (needsEndpoint.status === "bound")
    assert.equal(needsEndpoint.slot.mcpEndpoint, manager.opened[0]);
  assert.equal(manager.openCalls.length, 1);
});

test("needsMcpEndpoint=true (ACP): the per-run endpoint path is unchanged (endpoint opened, gated by ceiling)", async () => {
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  const lease = makeFakeLease({ workerHost: "ssh://host-acp" });
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool, manager);

  const result = await coordinator.acquireRunSlot({ ...acquireReq, needsMcpEndpoint: true });
  assert.equal(result.status, "bound");
  if (result.status !== "bound") return;
  // The endpoint was opened and attached - the ACP path is byte-identical to today.
  assert.equal(manager.openCalls.length, 1);
  assert.equal(result.slot.mcpEndpoint, manager.opened[0]);
});

test("needsMcpEndpoint unset (legacy passthrough): the per-run endpoint path defaults to opening (ACP behaviour)", async () => {
  // A caller that pre-dates the field omits it entirely; the coordinator defaults
  // to the existing open-the-endpoint behaviour so legacy ACP wiring is unchanged.
  const order: string[] = [];
  const manager = makeRecordingManager(order);
  const lease = makeFakeLease({ workerHost: "ssh://host-legacy" });
  const pool = makeFakeWorkerPool({ lease });
  const coordinator = makeCoordinator(pool, manager);

  const result = await coordinator.acquireRunSlot(acquireReq);
  assert.equal(result.status, "bound");
  if (result.status !== "bound") return;
  assert.equal(manager.openCalls.length, 1);
  assert.equal(result.slot.mcpEndpoint, manager.opened[0]);
});
