import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assert } from "@lorenz/test-utils";
import { afterEach, beforeEach, test } from "vitest";
import type { WorkerPoolSettings } from "@lorenz/domain";
import { withDerivedMaxInFlight } from "@lorenz/domain";
import type { ClockPort, TimerHandle } from "@lorenz/domain";
import { WorkerDriverRegistry, FakeWorkerDriver, POOL_OWNED_LABEL } from "@lorenz/worker-sdk";
import type {
  WorkerDescriptor,
  WorkerDriver,
  WorkerHealth,
  DriverCapabilities,
  ProvisionRequest,
  TeardownReason,
} from "@lorenz/worker-sdk";

import { createWorkerPool } from "../src/pool.js";
import type { WorkerLease, LedgerRow } from "../src/types.js";

// A manual clock for accounting math (`now`/`advance`/`set` control the logical
// wall clock that spend/ttl/idle read) while `setTimeout`/`clearTimeout` use the
// REAL event loop so the pool's waiter timeouts and the drain deadline actually
// fire. The returned timer handles carry an `unref` so the pool can detach them.
function controllableClock(startMs: number): {
  clock: ClockPort;
  advance(ms: number): void;
  set(ms: number): void;
} {
  let current = startMs;
  return {
    clock: {
      now: () => new Date(current),
      monotonicMs: () => current,
      setTimeout: (callback, delayMs): TimerHandle => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
    },
    advance(ms: number): void {
      current += ms;
    },
    set(ms: number): void {
      current = ms;
    },
  };
}

// Builds a full WorkerPoolSettings with sane defaults, overridable per-test. Mirrors
// the daemon defaults so a test only states the knobs it cares about.
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

// Each test wires the pool to its OWN registry (passed via `deps.drivers`), so
// nothing here relies on the process-wide default registry being pre-populated.
let drivers: WorkerDriverRegistry;

// A fresh fake driver registered under the `fake` kind so createWorkerPool can
// resolve it. Returns the instance so a test can inject failures / inspect it.
let lastDriver: FakeWorkerDriver | null = null;
function registerFake(): void {
  drivers = new WorkerDriverRegistry();
  drivers.register({
    kind: "fake",
    create: (_options, driverDeps) => {
      lastDriver = new FakeWorkerDriver(driverDeps);
      return lastDriver;
    },
  });
}

// Replaces the per-test registry with one resolving each instance by its kind.
function registerDrivers(...instances: WorkerDriver[]): void {
  drivers = new WorkerDriverRegistry();
  for (const instance of instances) {
    drivers.register({ kind: instance.kind, create: () => instance });
  }
}

// A driver whose `list()` is fully controllable so a test can stage the workers
// that "survived" a restart (carrying the pool-owned label so the pool re-adopts
// them) plus an unlabeled foreign instance (never adopted). `usesLedger` is
// togglable so the hydrate-orphan test can exercise the live ledger path. Tracks
// every `destroy` so a test can assert what the pool tore down.
class SurvivorDriver implements WorkerDriver {
  readonly kind = "fake" as const;
  readonly capabilities: DriverCapabilities;
  readonly destroyed: string[] = [];
  // A PERMANENT list() failure (set once, never cleared): every list() rejects.
  listError: Error | null = null;
  // A TRANSIENT list() failure budget: the first `listFailsRemaining` calls reject
  // (each decrements the budget) and then list() recovers, so a test can prove the
  // hydrate retry loop eventually succeeds and adopts the survivors.
  listFailsRemaining = 0;
  // Count of every list() invocation (failed or not) so a test can assert the
  // bounded retry actually re-attempted before giving up / recovering.
  listCalls = 0;

  constructor(
    private readonly survivors: WorkerDescriptor[],
    usesLedger = false,
  ) {
    this.capabilities = { sshAddressable: false, ephemeral: false, usesLedger };
  }

  async provision(req: ProvisionRequest): Promise<WorkerDescriptor> {
    const workerHost = `fake://worker-${req.workerId}`;
    return Promise.resolve({
      workerId: req.workerId,
      workerHost,
      driverRef: workerHost,
      createdAtMs: 0,
      labels: [...req.labels],
      metadata: {},
    });
  }

  async probe(): Promise<WorkerHealth> {
    return Promise.resolve({ ok: true });
  }

  async destroy(worker: WorkerDescriptor, _opts: { timeoutMs: number; reason: TeardownReason }) {
    this.destroyed.push(worker.workerId);
    const index = this.survivors.findIndex((entry) => entry.workerId === worker.workerId);
    if (index !== -1) this.survivors.splice(index, 1);
    return Promise.resolve();
  }

  async list(): Promise<WorkerDescriptor[]> {
    this.listCalls += 1;
    if (this.listError) return Promise.reject(this.listError);
    if (this.listFailsRemaining > 0) {
      this.listFailsRemaining -= 1;
      return Promise.reject(new Error("transient list() failure"));
    }
    return Promise.resolve([...this.survivors]);
  }
}

// Registers a survivor driver under the `fake` kind so createWorkerPool resolves it.
function registerSurvivor(driver: SurvivorDriver): void {
  registerDrivers(driver);
}

// A driver whose `provision` is deferred behind an externally-resolved gate, so
// a test can interleave an event (drain start, a second concurrent acquire) IN
// BETWEEN the pool deciding to grow and the provision resolving. Every live worker
// is tracked so a test can assert what actually got created/destroyed (a leaked
// paid worker shows up as a worker that was provisioned but never destroyed).
class DeferredDriver implements WorkerDriver {
  readonly kind = "fake" as const;
  readonly capabilities: DriverCapabilities = {
    sshAddressable: false,
    ephemeral: true,
    usesLedger: false,
  };
  readonly provisioned: string[] = [];
  readonly destroyed: string[] = [];
  readonly workers = new Set<string>();
  // Resolvers for each pending provision, in call order.
  private readonly gates: Array<() => void> = [];

  async provision(req: ProvisionRequest): Promise<WorkerDescriptor> {
    await new Promise<void>((resolve) => {
      this.gates.push(resolve);
    });
    this.provisioned.push(req.workerId);
    this.workers.add(req.workerId);
    const workerHost = `fake://worker-${req.workerId}`;
    return {
      workerId: req.workerId,
      workerHost,
      driverRef: workerHost,
      createdAtMs: 0,
      labels: [...req.labels],
      metadata: {},
    };
  }

  async probe(): Promise<WorkerHealth> {
    return Promise.resolve({ ok: true });
  }

  async destroy(worker: WorkerDescriptor, _opts: { timeoutMs: number; reason: TeardownReason }) {
    this.destroyed.push(worker.workerId);
    this.workers.delete(worker.workerId);
    return Promise.resolve();
  }

  async list(): Promise<WorkerDescriptor[]> {
    return Promise.resolve(
      [...this.workers].map((workerId) => {
        const workerHost = `fake://worker-${workerId}`;
        return {
          workerId,
          workerHost,
          driverRef: workerHost,
          createdAtMs: 0,
          labels: [POOL_OWNED_LABEL],
          metadata: {},
        };
      }),
    );
  }

  /** Number of provisions currently parked on the gate. */
  pendingCount(): number {
    return this.gates.length;
  }

  /** Releases the oldest parked provision so it resolves. */
  releaseNext(): void {
    const gate = this.gates.shift();
    if (gate) gate();
  }

  /** Releases every parked provision. */
  releaseAll(): void {
    while (this.gates.length > 0) this.releaseNext();
  }
}

function registerDeferred(driver: DeferredDriver): void {
  registerDrivers(driver);
}

// A driver whose `destroy` parks on an externally-resolved gate, so a test can
// interleave a late lease settle IN BETWEEN the drain's force-destroy starting
// (record set DESTROYING, driver.destroy awaited) and the destroy completing.
// `provision` is immediate; `list()` mirrors the live workers so a hydrate/reconcile
// over this driver stays coherent.
class DeferredDestroyDriver implements WorkerDriver {
  readonly kind = "fake" as const;
  readonly capabilities: DriverCapabilities = {
    sshAddressable: false,
    ephemeral: true,
    usesLedger: false,
  };
  readonly destroyed: string[] = [];
  readonly workers = new Set<string>();
  private readonly gates: Array<() => void> = [];
  private seq = 0;

  async provision(req: ProvisionRequest): Promise<WorkerDescriptor> {
    this.workers.add(req.workerId);
    const workerHost = `fake://worker-${req.workerId}`;
    return Promise.resolve({
      workerId: req.workerId,
      workerHost,
      driverRef: workerHost,
      createdAtMs: this.seq++,
      labels: [...req.labels],
      metadata: {},
    });
  }

  async probe(): Promise<WorkerHealth> {
    return Promise.resolve({ ok: true });
  }

  async destroy(worker: WorkerDescriptor, _opts: { timeoutMs: number; reason: TeardownReason }) {
    // Park on a gate so the test can interleave a late settle mid-destroy.
    await new Promise<void>((resolve) => {
      this.gates.push(resolve);
    });
    this.destroyed.push(worker.workerId);
    this.workers.delete(worker.workerId);
  }

  async list(): Promise<WorkerDescriptor[]> {
    return Promise.resolve(
      [...this.workers].map((workerId) => ({
        workerId,
        workerHost: `fake://worker-${workerId}`,
        driverRef: `fake://worker-${workerId}`,
        createdAtMs: 0,
        labels: [POOL_OWNED_LABEL],
        metadata: {},
      })),
    );
  }

  pendingDestroys(): number {
    return this.gates.length;
  }

  releaseNextDestroy(): void {
    const gate = this.gates.shift();
    if (gate) gate();
  }
}

function registerDeferredDestroy(driver: DeferredDestroyDriver): void {
  registerDrivers(driver);
}

// A ledger-backed (usesLedger:true) driver whose `provision` parks on a gate so
// a test can read the on-disk WAL AFTER the provisional row is written but BEFORE
// the post-provision correlate upsert. Mirrors live workers in `list()`.
class LedgerDeferredDriver implements WorkerDriver {
  readonly kind = "fake" as const;
  readonly capabilities: DriverCapabilities = {
    sshAddressable: false,
    ephemeral: true,
    usesLedger: true,
  };
  readonly workers = new Set<string>();
  private readonly gates: Array<() => void> = [];

  async provision(req: ProvisionRequest): Promise<WorkerDescriptor> {
    await new Promise<void>((resolve) => {
      this.gates.push(resolve);
    });
    this.workers.add(req.workerId);
    const workerHost = `fake://worker-${req.workerId}`;
    return {
      workerId: req.workerId,
      workerHost,
      driverRef: `ref-${req.workerId}`,
      createdAtMs: 0,
      labels: [...req.labels],
      metadata: {},
    };
  }

  async probe(): Promise<WorkerHealth> {
    return Promise.resolve({ ok: true });
  }

  async destroy(worker: WorkerDescriptor, _opts: { timeoutMs: number; reason: TeardownReason }) {
    this.workers.delete(worker.workerId);
    return Promise.resolve();
  }

  async list(): Promise<WorkerDescriptor[]> {
    return Promise.resolve(
      [...this.workers].map((workerId) => ({
        workerId,
        workerHost: `fake://worker-${workerId}`,
        driverRef: `ref-${workerId}`,
        createdAtMs: 0,
        labels: [POOL_OWNED_LABEL],
        metadata: {},
      })),
    );
  }

  pendingCount(): number {
    return this.gates.length;
  }

  releaseNext(): void {
    const gate = this.gates.shift();
    if (gate) gate();
  }
}

// A pool-owned survivor descriptor (carries the label the pool re-adopts on).
function survivorWorker(workerId: string): WorkerDescriptor {
  const workerHost = `fake://worker-${workerId}`;
  return {
    workerId,
    workerHost,
    driverRef: workerHost,
    createdAtMs: 0,
    labels: [POOL_OWNED_LABEL],
    metadata: {},
  };
}

function acquireReq(
  overrides: Partial<{
    issueId: string;
    slotIndex: number;
    labels: ReadonlyArray<string>;
    affinityKey: string | null;
    timeoutMs: number;
    signal: AbortSignal;
  }> = {},
): {
  issueId: string;
  slotIndex: number;
  labels: ReadonlyArray<string>;
  affinityKey?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
} {
  return {
    issueId: "issue-1",
    slotIndex: 0,
    labels: [],
    timeoutMs: 1_000,
    ...overrides,
  };
}

let tmpDir: string | null = null;

beforeEach(() => {
  registerFake();
  lastDriver = null;
  tmpDir = null;
});

afterEach(async () => {
  // The pool's ledger I/O is fire-and-forget (e.g. `void ledger.delete(...)` on a
  // drain recycle), so a write can briefly race the cleanup and recreate a file
  // mid-removal (ENOTEMPTY). Retry the removal a few times to absorb that race.
  if (tmpDir) {
    const dir = tmpDir;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }
});

test("acquire grows under max when no warm worker", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  const result = await pool.acquire(acquireReq());

  assert.equal(result.status, "leased");
  if (result.status === "leased") {
    assert.equal(result.lease.workerHost.startsWith("fake://worker-"), true);
  }
  const snap = pool.snapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.leased, 1);
  assert.equal(snap.inFlight, 1);
  await pool.drain({ deadlineMs: 1_000 });
});

test("acquire grows a worker that never becomes ready: probes, destroys it, reports no_capacity (no leak, never leased)", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0, min: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });
  assert.ok(lastDriver);
  const driver = lastDriver as FakeWorkerDriver;
  // The first on-demand grow mints worker-0; force its readiness probe to fail so the
  // worker is never SSH-reachable (a cold cloud worker whose sshd never comes up). Without
  // the readiness gate this unready host would be leased to the runner.
  driver.injectProbeFailure("worker-0", "sshd_not_up");

  const result = await pool.acquire(acquireReq());

  // The unready worker is NOT leased - the acquire reports capacity-unavailable...
  assert.equal(result.status, "no_capacity");
  // ...the worker was destroyed (no paid-worker leak: the fake daemon holds none)...
  assert.equal((await driver.list()).length, 0);
  // ...and it never entered inventory.
  assert.equal(pool.snapshot().total, 0);

  // A subsequent grow of a HEALTHY worker (worker-1, probe ok) leases normally.
  const second = await pool.acquire(acquireReq());
  assert.equal(second.status, "leased");
  await pool.drain({ deadlineMs: 1_000 });
});

test("reconcile to disabled drains even when the target driver would fail to construct", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0, min: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });
  const first = await pool.acquire(acquireReq());
  assert.equal(first.status, "leased");
  if (first.status !== "leased") return;
  await first.lease.release("healthy");
  assert.equal(pool.snapshot().total, 1);

  // Disable the pool AND point it at a driver kind NOT registered in this test (so
  // swapDriver would throw resolving it). reconcile must NOT throw - it skips the
  // swap when disabled - and must still drain the live worker to zero. Without the fix it
  // would throw in swapDriver and strand the pool enabled with the worker still alive.
  pool.reconcile(poolSettings({ enabled: false, driver: "modal", max: 1, warm: 0, min: 0 }));
  await pool.drain({ deadlineMs: 1_000 });
  assert.equal(pool.snapshot().total, 0);
});

test("acquire leased when warm worker free (release returns it to WARM_IDLE)", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  const first = await pool.acquire(acquireReq());
  assert.equal(first.status, "leased");
  if (first.status !== "leased") return;
  const firstWorkerId = first.lease.workerId;
  await first.lease.release("healthy");

  let snap = pool.snapshot();
  assert.equal(snap.warmIdle, 1);
  assert.equal(snap.leased, 0);
  assert.equal(snap.inFlight, 0);

  // The free warm worker is reused (no growth, same workerId) rather than a new provision.
  const second = await pool.acquire(acquireReq());
  assert.equal(second.status, "leased");
  if (second.status !== "leased") return;
  assert.equal(second.lease.workerId, firstWorkerId);
  snap = pool.snapshot();
  assert.equal(snap.total, 1);
  await pool.drain({ deadlineMs: 1_000 });
});

test("onCapacityAvailable fires when a release returns a worker to warm; never while leased or draining", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });
  let fired = 0;
  pool.onCapacityAvailable?.(() => {
    fired += 1;
  });

  const first = await pool.acquire(acquireReq());
  assert.equal(first.status, "leased");
  if (first.status !== "leased") return;
  // The single worker is leased and the pool cannot grow: no capacity announcement.
  assert.equal(fired, 0);

  // The release returns the worker to WARM_IDLE: capacity is announced exactly once.
  await first.lease.release("healthy");
  assert.equal(fired, 1);

  // A draining (capacity-less) pool never announces, even though its teardown
  // paths run the same waiter wake-up that fired above.
  const beforeDrain = fired;
  await pool.drain({ deadlineMs: 1_000 });
  assert.equal(fired, beforeDrain);
});

test("onCapacityAvailable is suppressed when a FIFO waiter consumed the freed worker", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0, acquireTimeoutMs: 10_000 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });
  let fired = 0;
  pool.onCapacityAvailable?.(() => {
    fired += 1;
  });

  const first = await pool.acquire(acquireReq());
  assert.equal(first.status, "leased");
  if (first.status !== "leased") return;

  // A second acquire parks on the FIFO waiter queue (no capacity, cannot grow).
  const blocked = pool.acquire(acquireReq({ issueId: "issue-2" }));
  await first.lease.release("healthy");
  const second = await blocked;
  assert.equal(second.status, "leased");
  // The waiter had first claim and consumed the freed worker, leaving canAcquire()
  // false, so no capacity announcement reached the listener.
  assert.equal(fired, 0);

  if (second.status === "leased") await second.lease.release("healthy");
  // With no waiter left, the final release announces the warm worker.
  assert.equal(fired, 1);
  await pool.drain({ deadlineMs: 1_000 });
});

test("acquire blocks to acquireTimeoutMs then no_capacity:acquire_timeout", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0, acquireTimeoutMs: 30 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");

  // The single worker is leased; a second acquire has no capacity and cannot grow,
  // so it blocks up to acquireTimeoutMs then surfaces the timeout reason.
  const blocked = await pool.acquire(acquireReq({ issueId: "issue-2", timeoutMs: 30 }));
  assert.equal(blocked.status, "no_capacity");
  if (blocked.status === "no_capacity") {
    assert.equal(blocked.reason, "acquire_timeout");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("released worker wakes a blocked waiter (FIFO) before the timeout", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0, acquireTimeoutMs: 10_000 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;

  // This acquire blocks because the only worker is leased.
  const waiterPromise = pool.acquire(acquireReq({ issueId: "issue-2" }));

  // Releasing the held worker must hand it to the queued waiter (not time out).
  await held.lease.release("healthy");

  const waiter = await waiterPromise;
  assert.equal(waiter.status, "leased");
  if (waiter.status === "leased") {
    assert.equal(waiter.lease.workerId, held.lease.workerId);
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("abort signal resolves acquire to no_capacity promptly", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0, acquireTimeoutMs: 10_000 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");

  const controller = new AbortController();
  const blockedPromise = pool.acquire(
    acquireReq({ issueId: "issue-2", signal: controller.signal, timeoutMs: 10_000 }),
  );
  // Aborting must resolve the acquire to no_capacity without waiting the full
  // acquireTimeoutMs (so the poll thread is never blocked).
  controller.abort();
  const blocked = await blockedPromise;
  assert.equal(blocked.status, "no_capacity");
  if (blocked.status === "no_capacity") {
    assert.equal(blocked.reason, "acquire_timeout");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("no_capacity:pool_disabled when enabled false", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ enabled: false }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  const result = await pool.acquire(acquireReq());
  assert.equal(result.status, "no_capacity");
  if (result.status === "no_capacity") {
    assert.equal(result.reason, "pool_disabled");
  }
  assert.equal(pool.canAcquire(), false);
});

test("no_capacity:spend_cap when maxConcurrentWorkers reached BEFORE leasing", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(
    poolSettings({ max: 4, warm: 0, spend: { maxConcurrentWorkers: 1 } }),
    {
      clock,
      drivers,
      logEvent: () => undefined,
    },
  );

  const first = await pool.acquire(acquireReq());
  assert.equal(first.status, "leased");

  // The concurrent-worker cap is 1; a second worker cannot be provisioned even though
  // `max` is 4, so the second acquire fails with spend_cap (not a fresh worker).
  const second = await pool.acquire(acquireReq({ issueId: "issue-2", timeoutMs: 30 }));
  assert.equal(second.status, "no_capacity");
  if (second.status === "no_capacity") {
    assert.equal(second.reason, "spend_cap");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("no_capacity:spend_cap when dailyWorkerSeconds exhausted", async () => {
  const start = Date.UTC(2026, 4, 29, 12, 0, 0);
  const { clock, advance } = controllableClock(start);
  const pool = createWorkerPool(
    poolSettings({ max: 4, warm: 0, spend: { dailyWorkerSeconds: 5 } }),
    {
      clock,
      drivers,
      logEvent: () => undefined,
    },
  );

  // Lease, hold for 6 seconds, release -> 6 worker-seconds accrued, over the 5s cap.
  const first = await pool.acquire(acquireReq());
  assert.equal(first.status, "leased");
  if (first.status !== "leased") return;
  advance(6_000);
  await first.lease.release("healthy");

  const second = await pool.acquire(acquireReq({ issueId: "issue-2", timeoutMs: 30 }));
  assert.equal(second.status, "no_capacity");
  if (second.status === "no_capacity") {
    assert.equal(second.reason, "spend_cap");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("canAcquire false when full and cannot grow; true when can grow under caps", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  // Empty pool but growth is possible under max -> canAcquire true.
  assert.equal(pool.canAcquire(), true);

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");

  // The single worker is leased and max is reached -> cannot grow, no warm free.
  assert.equal(pool.canAcquire(), false);

  if (held.status === "leased") await held.lease.release("healthy");
  // A warm worker is now free -> canAcquire true again.
  assert.equal(pool.canAcquire(), true);
  await pool.drain({ deadlineMs: 1_000 });
});

test("sticky affinityKey re-acquires same workerId", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 2, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  const first = await pool.acquire(acquireReq());
  assert.equal(first.status, "leased");
  if (first.status !== "leased") return;
  const host = first.lease.workerHost;
  const workerId = first.lease.workerId;
  await first.lease.release("healthy");

  // Provision a second warm worker so there are two idle workers to choose from.
  const other = await pool.acquire(acquireReq({ issueId: "issue-x" }));
  assert.equal(other.status, "leased");
  if (other.status !== "leased") return;
  await other.lease.release("healthy");

  // A retry that names the prior workerHost as its affinityKey must re-land on
  // the SAME worker, not the other warm worker.
  const retry = await pool.acquire(acquireReq({ affinityKey: host }));
  assert.equal(retry.status, "leased");
  if (retry.status === "leased") {
    assert.equal(retry.lease.workerId, workerId);
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("two concurrent acquires never select same warm slot (synchronous stamp)", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 2, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  // Pre-warm exactly one worker, then release it so a single WARM_IDLE worker exists.
  const seed = await pool.acquire(acquireReq());
  assert.equal(seed.status, "leased");
  if (seed.status !== "leased") return;
  await seed.lease.release("healthy");

  // Two acquires race for that one warm worker. The synchronous select-and-stamp
  // guarantees they cannot both grab the same WARM_IDLE worker; one reuses it, the
  // other grows a new worker. Both succeed and the workerIds are distinct.
  const [a, b] = await Promise.all([
    pool.acquire(acquireReq({ issueId: "issue-a" })),
    pool.acquire(acquireReq({ issueId: "issue-b" })),
  ]);
  assert.equal(a.status, "leased");
  assert.equal(b.status, "leased");
  if (a.status !== "leased" || b.status !== "leased") return;
  assert.notEqual(a.lease.workerId, b.lease.workerId);
  await pool.drain({ deadlineMs: 1_000 });
});

test("TWO concurrent growth decisions never exceed max (reservation counter)", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0, acquireTimeoutMs: 50 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  // Two acquires hit an empty pool simultaneously. The synchronous reservation
  // counter, taken BEFORE the provision await, lets only ONE grow; the other
  // cannot exceed max -> times out with no_capacity. The pool never exceeds max.
  const [a, b] = await Promise.all([
    pool.acquire(acquireReq({ issueId: "issue-a", timeoutMs: 50 })),
    pool.acquire(acquireReq({ issueId: "issue-b", timeoutMs: 50 })),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ["leased", "no_capacity"]);
  assert.equal(pool.snapshot().total, 1);
  await pool.drain({ deadlineMs: 1_000 });
});

test("reservation released on provision reject (no permanent block)", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0, acquireTimeoutMs: 30 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });
  assert.ok(lastDriver);
  // Make every provision reject by injecting failures for the deterministic ids
  // the pool will mint. The reservation must be released on reject so a later
  // acquire (after clearing the failure) can still grow under max.
  const driver = lastDriver as FakeWorkerDriver;
  for (let i = 0; i < 8; i += 1) {
    driver.injectProvisionFailure(`worker-${i}`, "boom");
  }

  const failed = await pool.acquire(acquireReq({ timeoutMs: 30 }));
  assert.equal(failed.status, "no_capacity");

  // Reservation released: a subsequent successful provision can grow.
  for (let i = 0; i < 8; i += 1) {
    driver.clearProvisionFailure(`worker-${i}`);
  }
  const ok = await pool.acquire(acquireReq({ issueId: "issue-2" }));
  assert.equal(ok.status, "leased");
  await pool.drain({ deadlineMs: 1_000 });
});

test("driver_error returned when growth provision rejects and no warm worker exists", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0, acquireTimeoutMs: 30 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });
  const driver = lastDriver as FakeWorkerDriver;
  for (let i = 0; i < 8; i += 1) {
    driver.injectProvisionFailure(`worker-${i}`, "boom");
  }

  const result = await pool.acquire(acquireReq({ timeoutMs: 30 }));
  assert.equal(result.status, "no_capacity");
  if (result.status === "no_capacity") {
    // A failed growth with nothing else to wait on surfaces a driver_error
    // (distinct from a pure timeout) so the caller can log the cause.
    assert.ok(result.reason === "driver_error" || result.reason === "acquire_timeout");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("maxInFlight>1 allows N leases on one worker; N+1 blocks", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(
    poolSettings({ max: 1, warm: 0, maxInFlight: 2, acquireTimeoutMs: 30 }),
    {
      clock,
      drivers,
      logEvent: () => undefined,
    },
  );

  const a = await pool.acquire(acquireReq({ issueId: "issue-a" }));
  const b = await pool.acquire(acquireReq({ issueId: "issue-b" }));
  assert.equal(a.status, "leased");
  assert.equal(b.status, "leased");
  if (a.status !== "leased" || b.status !== "leased") return;
  // Both leases land on the SAME worker (maxInFlight=2, max=1).
  assert.equal(a.lease.workerId, b.lease.workerId);
  assert.equal(pool.snapshot().inFlight, 2);

  // The third lease exceeds both maxInFlight and max -> blocks then times out.
  const c = await pool.acquire(acquireReq({ issueId: "issue-c", timeoutMs: 30 }));
  assert.equal(c.status, "no_capacity");
  await pool.drain({ deadlineMs: 1_000 });
});

test("maxWorkersPerIssue caps one issue's workers so an ensemble cannot monopolize", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(
    poolSettings({ max: 4, warm: 0, maxWorkersPerIssue: 1, acquireTimeoutMs: 30 }),
    { clock, drivers, logEvent: () => undefined },
  );

  // issue-A's first slot leases one worker.
  const a0 = await pool.acquire(acquireReq({ issueId: "issue-A", slotIndex: 0 }));
  assert.equal(a0.status, "leased");

  // issue-A's second slot is blocked by the per-issue cap of 1, even though the
  // global pool has capacity for 3 more workers.
  const a1 = await pool.acquire(acquireReq({ issueId: "issue-A", slotIndex: 1, timeoutMs: 30 }));
  assert.equal(a1.status, "no_capacity");

  // A DIFFERENT issue can still acquire (the cap is per-issue, not global).
  const b0 = await pool.acquire(acquireReq({ issueId: "issue-B", slotIndex: 0 }));
  assert.equal(b0.status, "leased");
  await pool.drain({ deadlineMs: 1_000 });
});

test("maxWorkersPerIssue releases the per-issue slot when a lease is returned", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(
    poolSettings({ max: 4, warm: 0, maxWorkersPerIssue: 1, acquireTimeoutMs: 30 }),
    { clock, drivers, logEvent: () => undefined },
  );

  const a0 = await pool.acquire(acquireReq({ issueId: "issue-A", slotIndex: 0 }));
  assert.equal(a0.status, "leased");
  if (a0.status !== "leased") return;
  await a0.lease.release("healthy");

  // After release, the issue is back under its cap and can acquire again.
  const a1 = await pool.acquire(acquireReq({ issueId: "issue-A", slotIndex: 1 }));
  assert.equal(a1.status, "leased");
  await pool.drain({ deadlineMs: 1_000 });
});

test("snapshot reports total/warmIdle/leased/inFlight/spend/markedForDestroy accurately", async () => {
  const start = Date.UTC(2026, 4, 29, 0, 0, 0);
  const { clock, advance } = controllableClock(start);
  const pool = createWorkerPool(poolSettings({ max: 2, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  const a = await pool.acquire(acquireReq({ issueId: "issue-a" }));
  const b = await pool.acquire(acquireReq({ issueId: "issue-b" }));
  assert.equal(a.status, "leased");
  assert.equal(b.status, "leased");
  if (a.status !== "leased" || b.status !== "leased") return;

  let snap = pool.snapshot();
  assert.equal(snap.enabled, true);
  assert.equal(snap.driver, "fake");
  assert.equal(snap.total, 2);
  assert.equal(snap.leased, 2);
  assert.equal(snap.warmIdle, 0);
  assert.equal(snap.inFlight, 2);
  assert.equal(snap.spend.concurrentWorkers, 2);
  assert.equal(snap.spend.dayKey, "2026-05-29");
  assert.equal(snap.workers.length, 2);
  for (const worker of snap.workers) {
    assert.equal(worker.state, "LEASED");
    assert.equal(worker.inFlight, 1);
    assert.equal(worker.markedForDestroy, false);
  }

  advance(2_000);
  await a.lease.release("healthy");
  snap = pool.snapshot();
  assert.equal(snap.leased, 1);
  assert.equal(snap.warmIdle, 1);
  assert.equal(snap.inFlight, 1);
  // Worker-seconds accrue on release: a held for 2s.
  assert.equal(snap.spend.workerSecondsUsed >= 2, true);
  await pool.drain({ deadlineMs: 1_000 });
});

test("a long heartbeating run accrues worker-seconds from its own acquire time (heartbeats do NOT reset the bill)", async () => {
  const { clock, advance } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;

  // A 600s run that heartbeats every 30s. Each heartbeat stamps lastHeartbeatMs,
  // but the spend bill must be the WHOLE 600s window (from acquire to settle),
  // not the gap since the last heartbeat (~0s, the old defeated accrual).
  for (let elapsed = 0; elapsed < 600_000; elapsed += 30_000) {
    advance(30_000);
    held.lease.heartbeat();
  }
  await held.lease.release("healthy");

  const snap = pool.snapshot();
  assert.equal(snap.spend.workerSecondsUsed >= 600, true);
  await pool.drain({ deadlineMs: 1_000 });
});

test("two overlapping leases on one worker (maxInFlight=2) each accrue their own window", async () => {
  const { clock, advance } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0, maxInFlight: 2 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  // Lease A acquires at t=0.
  const a = await pool.acquire(acquireReq({ issueId: "issue-a" }));
  assert.equal(a.status, "leased");
  if (a.status !== "leased") return;

  // 100s later lease B acquires the SAME worker (overlapping window).
  advance(100_000);
  const b = await pool.acquire(acquireReq({ issueId: "issue-b" }));
  assert.equal(b.status, "leased");
  if (b.status !== "leased") return;
  assert.equal(a.lease.workerId, b.lease.workerId);

  // Both heartbeat, then both settle at t=300s. A's window is 300s, B's is 200s;
  // billing each from its OWN acquire time yields 300 + 200 = 500 worker-seconds.
  advance(200_000);
  a.lease.heartbeat();
  b.lease.heartbeat();
  await a.lease.release("healthy");
  await b.lease.release("healthy");

  const snap = pool.snapshot();
  assert.equal(snap.spend.workerSecondsUsed >= 500, true);
  await pool.drain({ deadlineMs: 1_000 });
});

test("a heartbeating run that exceeds maxWorkerSeconds is denied on the next acquire", async () => {
  const { clock, advance } = controllableClock(0);
  const pool = createWorkerPool(
    poolSettings({ max: 1, warm: 0, spend: { maxWorkerSeconds: 500 } }),
    {
      clock,
      drivers,
      logEvent: () => undefined,
    },
  );

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;

  // A 600s run that heartbeats every 30s. Even though every heartbeat resets the
  // staleness stamp, the cap must fire on the full 600s window.
  for (let elapsed = 0; elapsed < 600_000; elapsed += 30_000) {
    advance(30_000);
    held.lease.heartbeat();
  }
  await held.lease.release("healthy");

  // 600 worker-seconds accrued, over the 500s cap -> the next acquire is denied.
  const next = await pool.acquire(acquireReq({ issueId: "issue-2", timeoutMs: 30 }));
  assert.equal(next.status, "no_capacity");
  if (next.status === "no_capacity") {
    assert.equal(next.reason, "spend_cap");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("drain rejects new acquires, force-destroys ALL workers (zero remain even with held lease)", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 2, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");

  await pool.drain({ deadlineMs: 10 });

  // Every worker is gone after drain, even the one whose lease was never released
  // (the leak fix). A post-drain acquire is rejected.
  const snap = pool.snapshot();
  assert.equal(snap.total, 0);
  assert.equal(snap.inFlight, 0);

  const blocked = await pool.acquire(acquireReq({ issueId: "issue-2" }));
  assert.equal(blocked.status, "no_capacity");
  if (blocked.status === "no_capacity") {
    assert.equal(blocked.reason, "pool_disabled");
  }
});

test("drain is idempotent and resolves", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });
  await pool.acquire(acquireReq());

  await pool.drain({ deadlineMs: 10 });
  // A second drain must resolve without throwing.
  await pool.drain({ deadlineMs: 10 });
  assert.equal(pool.snapshot().total, 0);
});

test("drain waits for an in-flight lease released before the deadline", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });
  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  const lease: WorkerLease = held.lease;

  // Release shortly after drain begins; drain should observe inFlight->0 and
  // still tear the worker down (zero workers remain).
  const drainPromise = pool.drain({ deadlineMs: 5_000 });
  await lease.release("healthy");
  await drainPromise;

  assert.equal(pool.snapshot().total, 0);
  assert.equal(pool.snapshot().inFlight, 0);
});

test("a late settle during a deadline-exceeded drain cannot flip a destroyed worker back to WARM_IDLE", async () => {
  const { clock } = controllableClock(0);
  const driver = new DeferredDestroyDriver();
  registerDeferredDestroy(driver);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  // Hold a lease so drain cannot settle before the deadline.
  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;

  // Drain with a deadline that fires (the in-flight lease never settles in time),
  // so runDrain proceeds into the force-destroy loop and parks on the gated
  // driver.destroy with the record set DESTROYING.
  const drainPromise = pool.drain({ deadlineMs: 10 });
  await waitUntil(() => driver.pendingDestroys() === 1);

  // While the drain's recycle is parked mid-destroy (record set DESTROYING), a
  // late healthy settle runs. Its onLeaseSettle, while draining, flips the worker to
  // WARM_IDLE. If the drain destroy runs OUTSIDE the per-worker mutex (the bug), the
  // settle interleaves with the in-progress recycle and the record is observably
  // WARM_IDLE mid-destroy — a "destroyed" worker resurrected to idle, which a
  // concurrent snapshot/select could then hand back out. The fix serializes both
  // under the per-worker mutex so the worker is NEVER observed WARM_IDLE once its
  // teardown has begun: the settle either runs fully before the destroy starts
  // (then is overwritten to DESTROYED) or fully after (and no-ops on DESTROYED).
  const settlePromise = held.lease.release("healthy");

  // Poll the record's state while the destroy is parked. Under the bug the late
  // settle flips DESTROYING->WARM_IDLE; under the fix the mutex holds the settle
  // behind the destroy so WARM_IDLE is never observed once teardown has begun.
  let resurrectedToWarmIdle = false;
  for (let i = 0; i < 25 && driver.pendingDestroys() === 1; i += 1) {
    const row = pool.snapshot().workers.find((b) => b.workerId === held.lease.workerId);
    if (row?.state === "WARM_IDLE") {
      resurrectedToWarmIdle = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(resurrectedToWarmIdle, false);

  // Let the parked destroy complete, then both the drain and the late settle.
  driver.releaseNextDestroy();
  await Promise.all([drainPromise, settlePromise]);

  // Zero workers remain, none flipped back to WARM_IDLE, and the driver's worker set
  // is empty (no paid worker leaked), with exactly one destroy issued.
  const snap = pool.snapshot();
  assert.equal(snap.total, 0);
  assert.equal(snap.warmIdle, 0);
  assert.equal(snap.inFlight, 0);
  assert.equal(driver.workers.size, 0);
  assert.equal(driver.destroyed.length, 1);
});

test("reaper-vs-release on inFlight->0 destroys exactly once (per-worker mutex)", async () => {
  // A worker that is marked for destroy (e.g. poisoned) and then released must be
  // torn down exactly once; the per-worker mutex serializes the release-driven
  // recycle so inFlight never underflows and only one destroy is issued.
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });
  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;

  // Poison the worker: on settle it is marked for destroy and recycled.
  await held.lease.fail("ssh_timeout");

  const snap = pool.snapshot();
  // The poisoned worker was recycled (removed), inFlight is 0, never negative.
  assert.equal(snap.inFlight, 0);
  assert.equal(snap.total, 0);
  await pool.drain({ deadlineMs: 1_000 });
});

// Polls a predicate on the real event loop so a fire-and-forget async grow/drain
// settles before the assertion (the manual clock never advances on its own). The
// predicate may be sync or async (e.g. polling on-disk ledger state).
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("reconcile false->true grows from zero; true->false drains to zero", async () => {
  const { clock } = controllableClock(0);
  // The pool starts DISABLED (no workers, acquire rejected).
  const pool = createWorkerPool(poolSettings({ enabled: false, min: 2, max: 3, warm: 2 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });
  assert.equal(pool.snapshot().total, 0);
  assert.equal(pool.canAcquire(), false);

  // false -> true: the reload re-enables the pool and grows from zero toward the
  // warm/min target WITHOUT reconstructing the pool object.
  const same = pool;
  pool.reconcile(poolSettings({ enabled: true, min: 2, max: 3, warm: 2 }));
  assert.equal(same, pool);
  await waitUntil(() => pool.snapshot().total >= 2);
  let snap = pool.snapshot();
  assert.equal(snap.enabled, true);
  assert.equal(snap.total, 2);
  assert.equal(snap.warmIdle, 2);

  // true -> false: the reload disables the pool and drains it to zero.
  pool.reconcile(poolSettings({ enabled: false, min: 2, max: 3, warm: 2 }));
  await waitUntil(() => pool.snapshot().total === 0);
  snap = pool.snapshot();
  assert.equal(snap.enabled, false);
  assert.equal(snap.total, 0);
  // A drained, disabled pool rejects acquires with pool_disabled.
  const blocked = await pool.acquire(acquireReq());
  assert.equal(blocked.status, "no_capacity");
  if (blocked.status === "no_capacity") {
    assert.equal(blocked.reason, "pool_disabled");
  }
});

test("reconcile disable then re-enable resets draining so acquire serves again", async () => {
  const { clock } = controllableClock(0);
  // The pool starts ENABLED and serves a lease.
  const pool = createWorkerPool(poolSettings({ enabled: true, min: 0, max: 1, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });
  const first = await pool.acquire(acquireReq());
  assert.equal(first.status, "leased");
  if (first.status !== "leased") return;
  await first.lease.release("healthy");

  // enabled true -> false: the reload drains the pool to zero, setting `draining`.
  pool.reconcile(poolSettings({ enabled: false, min: 0, max: 1, warm: 0 }));
  await waitUntil(() => pool.snapshot().total === 0);
  assert.equal(pool.snapshot().enabled, false);

  // enabled false -> true: the re-enable must clear `draining` so acquire is not
  // permanently short-circuited. Without the reset, every acquire returns
  // pool_disabled forever (the dead-pool defect).
  pool.reconcile(poolSettings({ enabled: true, min: 0, max: 1, warm: 0 }));
  assert.equal(pool.canAcquire(), true);
  const served = await pool.acquire(acquireReq({ issueId: "issue-2" }));
  assert.equal(served.status, "leased");
  await pool.drain({ deadlineMs: 1_000 });
});

test("reconcile raising warm tops up; lowering max defers shrink to reaper (oldest-idle first), never destroys leased synchronously; never reconstructs", async () => {
  const { clock, advance } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ enabled: true, min: 0, max: 4, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  // Raising `warm` tops the pool up toward the new target (grow, not reconstruct).
  const same = pool;
  pool.reconcile(poolSettings({ enabled: true, min: 0, max: 4, warm: 3 }));
  assert.equal(same, pool);
  await waitUntil(() => pool.snapshot().warmIdle >= 3);
  assert.equal(pool.snapshot().total, 3);

  // Lease one worker (so it is LEASED), and stagger idle times so oldest-idle is
  // deterministic across the remaining warm workers.
  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  const leasedWorkerId = held.lease.workerId;
  advance(1_000);

  // Lowering `max` to 1 must NOT destroy anything synchronously (defer to reaper)
  // and must NOT destroy the LEASED worker synchronously. The excess oldest-idle
  // workers are flagged markedForDestroy; the leased worker stays LEASED and unflagged
  // until idle workers alone cover the shrink.
  const before = pool.snapshot();
  assert.equal(before.total, 3);
  pool.reconcile(poolSettings({ enabled: true, min: 0, max: 1, warm: 0 }));

  // No synchronous teardown: all three workers still present immediately after.
  const after = pool.snapshot();
  assert.equal(after.total, 3);
  // The leased worker is never destroyed synchronously and (since 2 idle workers cover
  // the 2-worker overshoot) is not even flagged.
  const leasedRow = after.workers.find((worker) => worker.workerId === leasedWorkerId);
  assert.ok(leasedRow);
  assert.equal(leasedRow?.state, "LEASED");
  assert.equal(leasedRow?.markedForDestroy, false);
  // Exactly the two excess idle workers are flagged for the deferred reaper shrink.
  const flagged = after.workers.filter((worker) => worker.markedForDestroy);
  assert.equal(flagged.length, 2);
  for (const worker of flagged) {
    assert.equal(worker.state, "WARM_IDLE");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("hydrate replays ledger + driver.list() and re-adopts workers", async () => {
  const { clock } = controllableClock(0);
  // Two pool-owned survivors plus one UNLABELED foreign instance the pool must
  // never adopt.
  const foreign: WorkerDescriptor = {
    workerId: "foreign-1",
    workerHost: "fake://worker-foreign-1",
    driverRef: "fake://worker-foreign-1",
    createdAtMs: 0,
    labels: [],
    metadata: {},
  };
  const driver = new SurvivorDriver([
    survivorWorker("worker-A"),
    survivorWorker("worker-B"),
    foreign,
  ]);
  registerSurvivor(driver);

  const pool = createWorkerPool(poolSettings({ enabled: true, min: 0, max: 4, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  await pool.hydrate();

  const snap = pool.snapshot();
  // Both labeled survivors are re-adopted as idle (no run is active on restart);
  // the unlabeled foreign worker is NOT adopted.
  assert.equal(snap.total, 2);
  assert.equal(snap.warmIdle, 2);
  assert.equal(snap.leased, 0);
  assert.equal(snap.inFlight, 0);
  const ids = snap.workers.map((worker) => worker.workerId).sort();
  assert.deepEqual(ids, ["worker-A", "worker-B"]);
  for (const worker of snap.workers) {
    assert.equal(worker.state, "WARM_IDLE");
    assert.equal(worker.inFlight, 0);
  }

  // A re-adopted survivor is immediately leasable (no re-provision needed).
  const leased = await pool.acquire(acquireReq());
  assert.equal(leased.status, "leased");
  if (leased.status === "leased") {
    assert.ok(leased.lease.workerId === "worker-A" || leased.lease.workerId === "worker-B");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("hydrate force-returns orphan leased rows whose run is gone", async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-pool-hydrate-test-"));
  const ledgerPath = path.join(tmpDir, "worker-pool", "ledger.json");
  const { clock } = controllableClock(0);

  // The driver's authoritative list still shows worker-survivor but NOT worker-gone:
  // the machine that hosted worker-gone vanished while its run is gone.
  const driver = new SurvivorDriver([survivorWorker("worker-survivor")], /* usesLedger */ true);
  registerSurvivor(driver);

  // Seed the ledger with a row for the survivor AND an orphan row for the gone worker.
  const rows: LedgerRow[] = [
    {
      workerId: "worker-survivor",
      driverRef: "fake://worker-worker-survivor",
      workerHost: "fake://worker-worker-survivor",
      labels: [POOL_OWNED_LABEL],
      status: "active",
      createdAtMs: 0,
      updatedAtMs: 0,
    },
    {
      workerId: "worker-gone",
      driverRef: "fake://worker-worker-gone",
      workerHost: "fake://worker-worker-gone",
      labels: [POOL_OWNED_LABEL],
      status: "active",
      createdAtMs: 0,
      updatedAtMs: 0,
    },
  ];
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, `${JSON.stringify({ rows }, null, 2)}\n`, "utf8");

  const pool = createWorkerPool(poolSettings({ enabled: true, min: 0, max: 4, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
    ledgerPath,
  });

  await pool.hydrate();

  // Only the surviving worker is re-adopted; the orphan worker is not in inventory.
  const snap = pool.snapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.workers[0]?.workerId, "worker-survivor");

  // The orphan ledger row was force-returned (dropped); only the survivor row
  // remains on disk.
  const onDisk = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as { rows: LedgerRow[] };
  const remainingIds = onDisk.rows.map((row) => row.workerId);
  assert.deepEqual(remainingIds, ["worker-survivor"]);
  // No drain here: the survivor is idle (no in-flight lease), and a drain's
  // fire-and-forget ledger delete would race the tmpdir cleanup. The on-disk
  // assertion above already proves the orphan row was force-returned.
});

test("drain durably flushes the daily total: persisted spend equals in-memory total", async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-pool-spend-test-"));
  const ledgerPath = path.join(tmpDir, "worker-pool", "ledger.json");
  const { clock, advance } = controllableClock(Date.UTC(2026, 4, 29, 12, 0, 0));

  // A ledger-backed driver so the spend sidecar (spend.json) is live. `list()`
  // starts empty; the short test completes before any reaper reconcile fires.
  const driver = new SurvivorDriver([], /* usesLedger */ true);
  registerSurvivor(driver);

  const pool = createWorkerPool(poolSettings({ enabled: true, min: 0, max: 1, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
    ledgerPath,
  });

  // Settle N runs, each accruing some worker-seconds (the hot-path records are
  // fire-and-forget). A crash here could drop the last unpersisted deltas.
  const N = 5;
  for (let i = 0; i < N; i += 1) {
    const held = await pool.acquire(acquireReq({ issueId: `issue-${i}` }));
    assert.equal(held.status, "leased");
    if (held.status !== "leased") return;
    advance(7_000);
    await held.lease.release("healthy");
  }

  const inMemory = pool.snapshot().spend.dailyWorkerSecondsUsed;
  assert.equal(inMemory >= N * 7, true);

  // A clean drain must flush the authoritative in-memory daily total durably.
  await pool.drain({ deadlineMs: 1_000 });

  // The persisted sidecar (what a restart seeds from) equals the in-memory total.
  // A missing sidecar (the hot-path fire-and-forget writes never landed) is the
  // crash-window defect: read it as a zeroed total so the mismatch is explicit.
  const spendPath = path.join(path.dirname(ledgerPath), "spend.json");
  let onDisk: { workerSecondsToday: number; dayKey: string };
  try {
    onDisk = JSON.parse(await fs.readFile(spendPath, "utf8")) as {
      workerSecondsToday: number;
      dayKey: string;
    };
  } catch {
    onDisk = { workerSecondsToday: 0, dayKey: "2026-05-29" };
  }
  assert.equal(onDisk.workerSecondsToday, inMemory);
  assert.equal(onDisk.dayKey, "2026-05-29");
});

test("a worker provisioned mid-drain does not leak past the force-destroy loop", async () => {
  const { clock } = controllableClock(0);
  const driver = new DeferredDriver();
  registerDeferred(driver);
  const pool = createWorkerPool(poolSettings({ max: 2, warm: 0, acquireTimeoutMs: 5_000 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  // Start an acquire that decides to grow; its provision parks on the gate.
  const acquiring = pool.acquire(acquireReq());
  await waitUntil(() => driver.pendingCount() === 1);

  // Drain begins WHILE the provision is in flight. runDrain snapshots inventory
  // (currently empty) and waits for in-flight to settle.
  const draining = pool.drain({ deadlineMs: 200 });

  // Now the provision resolves. The pool must NOT add a leased, paid worker to a
  // pool that is already draining (or it must immediately destroy it).
  driver.releaseNext();
  const result = await acquiring;
  await draining;

  // The drain completed; the worker the driver created must not survive it.
  assert.equal(driver.workers.size, 0);
  assert.equal(pool.snapshot().total, 0);
  // If the acquire was leased on a now-draining pool, that lease is dead: a worker
  // outliving a completed drain is the leak. A no_capacity result is acceptable.
  if (result.status === "leased") {
    // It was leased: then the worker MUST have been destroyed by drain (asserted
    // above) - releasing it must not resurrect it.
    await result.lease.release("healthy");
    assert.equal(driver.workers.size, 0);
    assert.equal(pool.snapshot().total, 0);
  }
});

test("maxWorkersPerIssue is not exceeded by two concurrent same-issue grows", async () => {
  const { clock } = controllableClock(0);
  const driver = new DeferredDriver();
  registerDeferred(driver);
  const pool = createWorkerPool(
    poolSettings({ max: 4, warm: 0, maxWorkersPerIssue: 1, acquireTimeoutMs: 80 }),
    { clock, drivers, logEvent: () => undefined },
  );

  // Two concurrent acquires for the SAME issue against an empty pool. Both reach
  // the grow path before either provision resolves (the per-issue cap is 1, so at
  // most one should ever lease). The denied one parks then times out quickly.
  const first = pool.acquire(acquireReq({ issueId: "issue-1", slotIndex: 0, timeoutMs: 80 }));
  const second = pool.acquire(acquireReq({ issueId: "issue-1", slotIndex: 1, timeoutMs: 80 }));

  // Wait for at least one provision to park, then release everything that parked.
  await waitUntil(() => driver.pendingCount() >= 1);
  driver.releaseAll();
  const [a, b] = await Promise.all([first, second]);

  // Exactly ONE of the two concurrent same-issue acquires may lease a distinct
  // worker; the other must be denied by the per-issue cap (no_capacity).
  const leased = [a, b].filter((r) => r.status === "leased");
  assert.equal(leased.length, 1);

  // And the pool must hold at most one live worker for issue-1.
  assert.equal(pool.snapshot().total <= 1, true);

  await pool.drain({ deadlineMs: 1_000 });
});

test("a lease straddling UTC midnight bills the NEXT day and the next-day acquire over the daily cap is BLOCKED; persisted == in-memory after drain", async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-pool-midnight-test-"));
  const ledgerPath = path.join(tmpDir, "worker-pool", "ledger.json");

  // Start at 23:59:50 UTC on day N. A ledger-backed driver keeps the spend
  // sidecar live so the persisted total can be compared against in-memory.
  const dayN = Date.UTC(2026, 4, 29, 23, 59, 50);
  const { clock, set } = controllableClock(dayN);
  const driver = new SurvivorDriver([], /* usesLedger */ true);
  registerSurvivor(driver);

  const pool = createWorkerPool(
    poolSettings({ enabled: true, min: 0, max: 1, warm: 0, spend: { dailyWorkerSeconds: 100 } }),
    { clock, drivers, logEvent: () => undefined, ledgerPath },
  );

  // Acquire at 23:59:50 day N, then advance the clock 600s INTO day N+1 and
  // release: the 600s window straddles midnight. The bill must land on day N+1
  // (the day the lease settled), not the zeroed/old day. 600 > the 100s daily
  // cap, so the next acquire (also day N+1) must be BLOCKED by spend_cap.
  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  set(Date.UTC(2026, 4, 30, 0, 9, 50)); // 23:59:50 + 600s = 00:09:50 day N+1
  await held.lease.release("healthy");

  const snap = pool.snapshot();
  // The accumulator is keyed on the NEW day and carries the full 600s window.
  assert.equal(snap.spend.dayKey, "2026-05-30");
  assert.equal(snap.spend.dailyWorkerSecondsUsed >= 600, true);

  // The next-day acquire is over the 100s daily cap -> blocked with spend_cap
  // (the cap is NOT bypassed across the midnight boundary).
  const next = await pool.acquire(acquireReq({ issueId: "issue-2", timeoutMs: 30 }));
  assert.equal(next.status, "no_capacity");
  if (next.status === "no_capacity") {
    assert.equal(next.reason, "spend_cap");
  }

  // A clean drain flushes the authoritative daily total to the NEW day's sidecar.
  const inMemory = pool.snapshot().spend.dailyWorkerSecondsUsed;
  await pool.drain({ deadlineMs: 1_000 });

  const spendPath = path.join(path.dirname(ledgerPath), "spend.json");
  const onDisk = JSON.parse(await fs.readFile(spendPath, "utf8")) as {
    workerSecondsToday: number;
    dayKey: string;
  };
  assert.equal(onDisk.workerSecondsToday, inMemory);
  assert.equal(onDisk.dayKey, "2026-05-30");
});

test("an orphaned drain whose deadline fires after a re-enable does NOT destroy the live re-enabled pool; a genuine drain still destroys all workers", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(
    poolSettings({ enabled: true, min: 0, max: 2, warm: 0, drainDeadlineMs: 40 }),
    { clock, drivers, logEvent: () => undefined },
  );

  // Hold a lease so the disable-driven drain CANNOT settle before its deadline:
  // runDrain parks on the in-flight barrier waiting for the 40ms deadline timer.
  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  const leasedWorkerId = held.lease.workerId;

  // reconcile disable: drain begins and parks (the held lease never settles).
  pool.reconcile(poolSettings({ enabled: false, min: 0, max: 2, warm: 0, drainDeadlineMs: 40 }));
  assert.equal(pool.snapshot().enabled, false);

  // reconcile re-enable BEFORE the stale drain deadline fires: this clears
  // draining and grows a warm worker (target warm=2, leased worker already live, so one
  // fresh warm worker is provisioned), so the pool is LIVE again with two workers.
  pool.reconcile(poolSettings({ enabled: true, min: 0, max: 2, warm: 2, drainDeadlineMs: 40 }));
  await waitUntil(() => pool.snapshot().total >= 2);

  // Let the orphaned drain's deadline timer fire. Under the bug its destroy loop
  // force-destroys the now-LIVE pool's workers (total -> 0). Under the fix the
  // stale-epoch / cleared-draining guard makes the loop bail, leaving the live
  // workers intact.
  await new Promise((resolve) => setTimeout(resolve, 80));

  const snap = pool.snapshot();
  // The leased worker AND the freshly grown warm worker both survive the stale drain.
  assert.equal(snap.total, 2);
  assert.ok(snap.workers.some((worker) => worker.workerId === leasedWorkerId));
  assert.equal(snap.enabled, true);

  // The pool is still genuinely live: a release returns the worker to WARM_IDLE and
  // a fresh acquire still serves.
  await held.lease.release("healthy");
  const served = await pool.acquire(acquireReq({ issueId: "issue-2" }));
  assert.equal(served.status, "leased");
  if (served.status === "leased") await served.lease.release("healthy");

  // A genuine drain (no racing re-enable) still destroys EVERY worker.
  await pool.drain({ deadlineMs: 1_000 });
  assert.equal(pool.snapshot().total, 0);
});

test("hydrate advances workerSeq past adopted worker-<n> ids so the next grow does not collide (non-numeric ids tolerated)", async () => {
  const { clock } = controllableClock(0);
  // Survivors: a numeric worker-3 (the highest numeric suffix) and a non-numeric
  // worker-foo that must be tolerated (ignored when computing the max suffix).
  const driver = new SurvivorDriver([survivorWorker("worker-3"), survivorWorker("worker-foo")]);
  registerSurvivor(driver);

  const pool = createWorkerPool(poolSettings({ enabled: true, min: 0, max: 4, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  await pool.hydrate();
  assert.equal(pool.snapshot().total, 2);

  // Lease both adopted survivors so the next acquire must GROW a fresh worker.
  const a = await pool.acquire(acquireReq({ issueId: "issue-a" }));
  const b = await pool.acquire(acquireReq({ issueId: "issue-b" }));
  assert.equal(a.status, "leased");
  assert.equal(b.status, "leased");
  if (a.status !== "leased" || b.status !== "leased") return;

  // The grow mints worker-4 (one past the highest adopted numeric suffix), NOT worker-0
  // (which the un-advanced workerSeq would mint, risking a second lease colliding
  // with a survivor id once the sequence cycled back through worker-3).
  const grown = await pool.acquire(acquireReq({ issueId: "issue-c" }));
  assert.equal(grown.status, "leased");
  if (grown.status === "leased") {
    assert.equal(grown.lease.workerId, "worker-4");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("grow writes a provisional ledger row BEFORE provision then upserts active after (WAL wired)", async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-pool-wal-test-"));
  const ledgerPath = path.join(tmpDir, "worker-pool", "ledger.json");
  const { clock } = controllableClock(0);

  // A ledger-backed deferred driver: its provision parks on a gate so a test can
  // read the on-disk ledger AFTER the provisional write but BEFORE the correlate.
  const driver = new LedgerDeferredDriver();
  registerDrivers(driver);

  const pool = createWorkerPool(poolSettings({ enabled: true, min: 0, max: 1, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
    ledgerPath,
  });

  const acquiring = pool.acquire(acquireReq());
  // Wait until the provision has parked: by now the WAL provisional row must be on
  // disk (written BEFORE driver.provision is awaited).
  await waitUntil(() => driver.pendingCount() === 1);

  const beforeCorrelate = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as {
    rows: LedgerRow[];
  };
  assert.equal(beforeCorrelate.rows.length, 1);
  assert.equal(beforeCorrelate.rows[0]?.status, "provisional");
  assert.equal(beforeCorrelate.rows[0]?.driverRef, null);
  assert.equal(beforeCorrelate.rows[0]?.workerHost, null);
  const provisionalWorkerId = beforeCorrelate.rows[0]?.workerId;

  // Let provision resolve; the pool upserts the correlated active row.
  driver.releaseNext();
  const result = await acquiring;
  assert.equal(result.status, "leased");

  const afterCorrelate = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as { rows: LedgerRow[] };
  assert.equal(afterCorrelate.rows.length, 1);
  assert.equal(afterCorrelate.rows[0]?.workerId, provisionalWorkerId);
  assert.equal(afterCorrelate.rows[0]?.status, "active");
  assert.ok(afterCorrelate.rows[0]?.driverRef);
  assert.ok(afterCorrelate.rows[0]?.workerHost);

  await pool.drain({ deadlineMs: 1_000 });
  // After drain the worker is recycled and its ledger row deleted.
  await waitUntil(async () => {
    const onDisk = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as { rows: LedgerRow[] };
    return onDisk.rows.length === 0;
  });
});

test("crash-before-correlate: hydrate reconciles a provisional row against a list() survivor", async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-pool-wal-recover-test-"));
  const ledgerPath = path.join(tmpDir, "worker-pool", "ledger.json");
  const { clock } = controllableClock(0);

  // The prior process crashed AFTER provision succeeded but BEFORE it upserted the
  // correlated row, so the ledger holds a PROVISIONAL row. The worker did get created
  // at the driver (labeled), and now list() shows it. Hydrate must re-adopt the
  // survivor (label-driven) and not drop the row as an orphan.
  const driver = new SurvivorDriver([survivorWorker("worker-7")], /* usesLedger */ true);
  registerSurvivor(driver);

  const rows: LedgerRow[] = [
    {
      workerId: "worker-7",
      driverRef: null,
      workerHost: null,
      labels: [POOL_OWNED_LABEL],
      status: "provisional",
      createdAtMs: 0,
      updatedAtMs: 0,
    },
  ];
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, `${JSON.stringify({ rows }, null, 2)}\n`, "utf8");

  const pool = createWorkerPool(poolSettings({ enabled: true, min: 0, max: 4, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
    ledgerPath,
  });

  await pool.hydrate();

  // The survivor whose provisional row never correlated is re-adopted as idle.
  const snap = pool.snapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.workers[0]?.workerId, "worker-7");

  // The provisional row is NOT dropped (its worker survived and was adopted).
  const onDisk = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as { rows: LedgerRow[] };
  assert.deepEqual(
    onDisk.rows.map((row) => row.workerId),
    ["worker-7"],
  );
});

test("crash-before-correlate: a stale provisional row with no surviving worker is reaped after ttl", async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-pool-wal-stale-test-"));
  const ledgerPath = path.join(tmpDir, "worker-pool", "ledger.json");
  // Start well past the ttl window relative to the row's createdAt so the orphan
  // provisional row is older than ttlMs.
  const { clock } = controllableClock(1_000_000);

  // list() shows NO survivor: the provision never actually created a worker (or it
  // already vanished). A young provisional row would be kept (the driver may be
  // briefly inconsistent), but one older than ttlMs is a dead row and is reaped.
  const driver = new SurvivorDriver([], /* usesLedger */ true);
  registerSurvivor(driver);

  const rows: LedgerRow[] = [
    {
      workerId: "worker-stale",
      driverRef: null,
      workerHost: null,
      labels: [POOL_OWNED_LABEL],
      status: "provisional",
      createdAtMs: 0,
      updatedAtMs: 0,
    },
  ];
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, `${JSON.stringify({ rows }, null, 2)}\n`, "utf8");

  const pool = createWorkerPool(
    poolSettings({ enabled: true, min: 0, max: 4, warm: 0, ttlMs: 1_000 }),
    { clock, drivers, logEvent: () => undefined, ledgerPath },
  );

  await pool.hydrate();

  // Nothing adopted (no survivor), and the stale provisional row is reaped.
  assert.equal(pool.snapshot().total, 0);
  const onDisk = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as { rows: LedgerRow[] };
  assert.deepEqual(onDisk.rows, []);
});

test("reaper firing before hydrate does NOT destroy a labeled survivor; hydrate then adopts it", async () => {
  const { clock } = controllableClock(0);
  // A labeled pool-owned survivor sits at the driver, as it would right after a
  // restart. The constructor arms the recurring reaper immediately, but hydrate()
  // (which re-adopts survivors) is called later. A reaper tick that fires in that
  // gap must NOT reap the survivor (it has the pool-owned label and is one of
  // ours), or the restart destroys its own warm worker.
  const driver = new SurvivorDriver([survivorWorker("worker-survivor")]);
  registerSurvivor(driver);

  const pool = createWorkerPool(
    poolSettings({ enabled: true, min: 0, max: 4, warm: 0, reapIntervalMs: 5 }),
    { clock, drivers, logEvent: () => undefined },
  );

  // Let the reaper tick fire at least once BEFORE hydrate runs.
  await new Promise((resolve) => setTimeout(resolve, 30));

  // The survivor was never destroyed by the pre-hydrate reaper tick.
  assert.deepEqual(driver.destroyed, []);

  // Hydrate now re-adopts the survivor as a warm idle worker.
  await pool.hydrate();
  const snap = pool.snapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.warmIdle, 1);
  assert.equal(snap.workers[0]?.workerId, "worker-survivor");

  // And it is still present (not reaped) after a few more post-hydrate ticks,
  // because it is now in inventory (known), so the reconcile leaves it alone.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(driver.destroyed, []);
  assert.equal(pool.snapshot().total, 1);

  await pool.drain({ deadlineMs: 1_000 });
});

test("hydrate on a usesLedger driver whose list() always fails REJECTS (startup fails loud) and never opens the reaper destroy-unknown gate", async () => {
  // FINDING (HIGH): a usesLedger (paid, ephemeral) driver may have provisioned
  // real survivors before the restart. If hydrate() swallows a list() failure and
  // returns as if startup succeeded, those paid workers are neither adopted nor
  // reaped (the reaper's destroy-unknown gate stays closed because hydrated never
  // flips) AND they are invisible to drain -> unmanaged paid workers leak. hydrate()
  // must instead RETRY a bounded number of times and, if list() still fails for a
  // usesLedger driver, THROW so the daemon's `await workerPool.hydrate()` fails
  // startup loudly rather than running blind over unmanaged paid machines.
  const { clock } = controllableClock(0);
  const driver = new SurvivorDriver([survivorWorker("worker-paid")], /* usesLedger */ true);
  driver.listError = new Error("driver list() outage");
  registerSurvivor(driver);

  // A labeled survivor sits at the driver, as it would right after a restart.
  const pool = createWorkerPool(
    poolSettings({ enabled: true, min: 0, max: 4, warm: 0, reapIntervalMs: 5 }),
    { clock, drivers, logEvent: () => undefined },
  );

  // hydrate() must REJECT (startup fails loud) rather than silently returning.
  await assert.rejects(() => pool.hydrate(), /worker_pool_hydrate_failed/);

  // It retried list() a bounded number of times before giving up (more than once).
  assert.equal(driver.listCalls > 1, true);

  // The reaper destroy-unknown gate stayed CLOSED (hydrated never flipped): a few
  // reaper ticks must NOT destroy the labeled-but-unknown paid survivor, since the
  // pool never proved it had re-adopted its inventory. (list() still fails for the
  // reaper too, so the reconcile cannot run, but the gate being closed is the
  // belt-and-braces guarantee.)
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(driver.destroyed, []);

  // The pool was never marked drained-safe; tear it down so the recurring reaper
  // timer stops. (drain force-destroys nothing because inventory is empty.)
  await pool.drain({ deadlineMs: 50 });
});

test("hydrate on a NON-ledger (fake) driver whose list() fails stays TOLERANT (resolves, no throw)", async () => {
  // A fake / static-ssh driver owns no paid survivors, so a transient list()
  // failure on hydrate is harmless: there is nothing to leak. hydrate() must stay
  // tolerant here (resolve, log the skip) so a non-cloud pool still starts up.
  const { clock } = controllableClock(0);
  const driver = new SurvivorDriver([], /* usesLedger */ false);
  driver.listError = new Error("driver list() outage");
  registerSurvivor(driver);

  const pool = createWorkerPool(poolSettings({ enabled: true, min: 0, max: 4, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  // Resolves (does not throw) for a non-ledger driver.
  await pool.hydrate();
  assert.equal(pool.snapshot().total, 0);

  await pool.drain({ deadlineMs: 50 });
});

test("hydrate retries list() and, once it succeeds, adopts the survivors and opens the reaper cleanup gate", async () => {
  // A usesLedger driver whose list() fails the first couple of attempts then
  // recovers: the bounded retry loop must re-attempt (via the injected clock's
  // backoff) until list() succeeds, then re-adopt the labeled survivor as WARM_IDLE
  // and flip `hydrated` so the reaper's destroy-unknown reconcile may resume.
  const { clock } = controllableClock(0);
  const driver = new SurvivorDriver([survivorWorker("worker-recovered")], /* usesLedger */ true);
  driver.listFailsRemaining = 2;
  registerSurvivor(driver);

  const pool = createWorkerPool(
    poolSettings({ enabled: true, min: 0, max: 4, warm: 0, reapIntervalMs: 5 }),
    { clock, drivers, logEvent: () => undefined },
  );

  // hydrate() resolves once list() recovers after the bounded retries.
  await pool.hydrate();
  assert.equal(driver.listCalls >= 3, true);

  // The survivor was re-adopted as a warm idle worker.
  const snap = pool.snapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.warmIdle, 1);
  assert.equal(snap.workers[0]?.workerId, "worker-recovered");

  // The gate opened (hydrated=true): the re-adopted survivor stays known across a
  // few reaper ticks (a known worker is left alone; an UNKNOWN labeled worker would now
  // be reaped, proving the gate is open).
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(pool.snapshot().total, 1);

  await pool.drain({ deadlineMs: 1_000 });
});

test("drain accrues in-flight worker-seconds for a lease still held at the deadline (no spend under-count)", async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-pool-drain-inflight-test-"));
  const ledgerPath = path.join(tmpDir, "worker-pool", "ledger.json");
  const start = Date.UTC(2026, 4, 29, 12, 0, 0);
  const { clock, advance } = controllableClock(start);

  // A ledger-backed driver so the spend sidecar (spend.json) is live and the
  // persisted total can be compared against the in-memory daily total.
  const driver = new SurvivorDriver([], /* usesLedger */ true);
  registerSurvivor(driver);

  const pool = createWorkerPool(poolSettings({ enabled: true, min: 0, max: 1, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
    ledgerPath,
  });

  // Acquire a worker and hold it for 500s WITHOUT releasing it, so its window is
  // entirely in-flight when the drain force-destroys it.
  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  advance(500_000);

  // Drain with a tiny deadline so the held lease is still LEASED when the
  // force-destroy loop runs. Without the fix, the worker-seconds for this window are
  // never accrued (onLeaseSettle never runs and the late release no-ops on the
  // DESTROYED guard), so the daily total under-counts the 500s window.
  await pool.drain({ deadlineMs: 5 });

  const snap = pool.snapshot();
  assert.equal(snap.spend.dailyWorkerSecondsUsed >= 500, true);
  assert.equal(snap.spend.workerSecondsUsed >= 500, true);

  // The persisted sidecar (what a restart seeds from) must match the in-memory
  // daily total the drain flushed.
  const spendPath = path.join(path.dirname(ledgerPath), "spend.json");
  const onDisk = JSON.parse(await fs.readFile(spendPath, "utf8")) as {
    workerSecondsToday: number;
    dayKey: string;
  };
  assert.equal(onDisk.workerSecondsToday, snap.spend.dailyWorkerSecondsUsed);
  assert.equal(onDisk.workerSecondsToday >= 500, true);
  assert.equal(onDisk.dayKey, "2026-05-29");
});

// ---------------------------------------------------------------------------
// T4a/T4b: driver rebuilt in place on a reconcile that changes driver
// construction (Finding #1), with per-worker origin capture so an in-flight lease
// settling AFTER the swap routes destroy() to its ORIGINAL backend.
// ---------------------------------------------------------------------------

// A tracking driver whose every worker `provision`/`destroy` is recorded so a
// test can assert WHICH backend a worker was created on and torn down against. Its
// `kind`/`tag` distinguish two driver objects, and `list()` mirrors the live
// workers so a reaper reconcile over this driver stays coherent. `provisioned`
// stamps the driver tag into the descriptor metadata so a swap test can prove
// a worker was created by the OLD driver yet destroyed against that same OLD one.
class TrackingDriver implements WorkerDriver {
  readonly destroyed: string[] = [];
  readonly provisioned: string[] = [];
  readonly workers = new Set<string>();

  constructor(
    readonly kind: WorkerDriver["kind"],
    readonly tag: string,
    private readonly usesLedger = false,
  ) {}

  get capabilities(): DriverCapabilities {
    return { sshAddressable: false, ephemeral: true, usesLedger: this.usesLedger };
  }

  async provision(req: ProvisionRequest): Promise<WorkerDescriptor> {
    this.provisioned.push(req.workerId);
    this.workers.add(req.workerId);
    const workerHost = `${this.tag}://worker-${req.workerId}`;
    return Promise.resolve({
      workerId: req.workerId,
      workerHost,
      driverRef: workerHost,
      createdAtMs: 0,
      labels: [...req.labels],
      metadata: { driverTag: this.tag },
    });
  }

  async probe(): Promise<WorkerHealth> {
    return Promise.resolve({ ok: true });
  }

  async destroy(worker: WorkerDescriptor, _opts: { timeoutMs: number; reason: TeardownReason }) {
    this.destroyed.push(worker.workerId);
    this.workers.delete(worker.workerId);
    return Promise.resolve();
  }

  async list(): Promise<WorkerDescriptor[]> {
    return Promise.resolve(
      [...this.workers].map((workerId) => ({
        workerId,
        workerHost: `${this.tag}://worker-${workerId}`,
        driverRef: `${this.tag}://worker-${workerId}`,
        createdAtMs: 0,
        labels: [POOL_OWNED_LABEL],
        metadata: { driverTag: this.tag },
      })),
    );
  }
}

// Registers two tracking drivers, one per kind, each remembering how many
// times its factory ran so a test can prove a reconcile rebuilds the driver
// in place (factory re-invoked) or skips the rebuild (factory not re-invoked).
function registerTracking(): {
  builds: { fake: number; "static-ssh": number };
  fake: () => TrackingDriver;
  staticSsh: () => TrackingDriver;
} {
  const builds = { fake: 0, "static-ssh": 0 };
  let fakeInstance: TrackingDriver | null = null;
  let staticInstance: TrackingDriver | null = null;
  drivers = new WorkerDriverRegistry();
  drivers.register({
    kind: "fake",
    create: () => {
      builds.fake += 1;
      fakeInstance = new TrackingDriver("fake", "fake");
      return fakeInstance;
    },
  });
  drivers.register({
    kind: "static-ssh",
    create: () => {
      builds["static-ssh"] += 1;
      staticInstance = new TrackingDriver("static-ssh", "static");
      return staticInstance;
    },
  });
  return {
    builds,
    fake: () => {
      assert.ok(fakeInstance);
      return fakeInstance as TrackingDriver;
    },
    staticSsh: () => {
      assert.ok(staticInstance);
      return staticInstance as TrackingDriver;
    },
  };
}

test("reconcile changing driver rebuilds it in place (resolveDriver re-run, singleton not reconstructed); new provisions route to the new driver", async () => {
  const { clock } = controllableClock(0);
  const tracking = registerTracking();
  const pool = createWorkerPool(poolSettings({ enabled: true, driver: "fake", min: 0, max: 2 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });
  // The driver was resolved exactly once in the ctor.
  assert.equal(tracking.builds.fake, 1);
  assert.equal(tracking.builds["static-ssh"], 0);

  // A worker provisioned before the swap lands on the OLD ("fake") backend.
  const before = await pool.acquire(acquireReq());
  assert.equal(before.status, "leased");
  if (before.status !== "leased") return;
  assert.equal(before.lease.workerHost.startsWith("fake://"), true);
  await before.lease.release("healthy");

  // Reconcile to a DIFFERENT driver kind. The pool is NOT reconstructed (same
  // object) but the driver is rebuilt in place: the static-ssh factory runs.
  const same = pool;
  pool.reconcile(poolSettings({ enabled: true, driver: "static-ssh", min: 0, max: 2 }));
  assert.equal(same, pool);
  assert.equal(tracking.builds["static-ssh"], 1);
  // The fake factory was NOT re-invoked by the swap (no singleton churn).
  assert.equal(tracking.builds.fake, 1);
  assert.equal(pool.snapshot().driver, "static-ssh");

  // The OLD "fake" warm worker left over from before the swap is reconciled away by
  // the reaper (its driverRef no longer matches the new driver's list()), so
  // a fresh provision routes to the NEW ("static") backend.
  await waitUntil(() => {
    const snap = pool.snapshot();
    return snap.workers.every((worker) => worker.workerHost.startsWith("static://"));
  });
  const after = await pool.acquire(acquireReq({ issueId: "issue-2" }));
  assert.equal(after.status, "leased");
  if (after.status === "leased") {
    assert.equal(after.lease.workerHost.startsWith("static://"), true);
    assert.equal(tracking.staticSsh().provisioned.includes(after.lease.workerId), true);
    await after.lease.release("healthy");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("same-driver reconcile skips the swap (no rebuild)", async () => {
  const { clock } = controllableClock(0);
  const tracking = registerTracking();
  const pool = createWorkerPool(poolSettings({ enabled: true, driver: "fake", min: 0, max: 2 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });
  assert.equal(tracking.builds.fake, 1);

  // A reconcile that changes a knob but NOT the driver construction (same kind,
  // same driverOptions) must not rebuild the driver: the factory count holds.
  pool.reconcile(poolSettings({ enabled: true, driver: "fake", min: 0, max: 3 }));
  assert.equal(tracking.builds.fake, 1);
  assert.equal(tracking.builds["static-ssh"], 0);

  // A no-op reconcile (identical settings) likewise never rebuilds.
  pool.reconcile(poolSettings({ enabled: true, driver: "fake", min: 0, max: 3 }));
  assert.equal(tracking.builds.fake, 1);
  await pool.drain({ deadlineMs: 1_000 });
});

test("changing driverOptions (same kind) rebuilds the driver in place", async () => {
  const { clock } = controllableClock(0);
  const tracking = registerTracking();
  const pool = createWorkerPool(
    poolSettings({
      enabled: true,
      driver: "fake",
      min: 0,
      max: 2,
      driverOptions: { region: "a" },
    }),
    { clock, drivers, logEvent: () => undefined },
  );
  assert.equal(tracking.builds.fake, 1);

  // Same kind but a DEEP-changed driverOptions must rebuild the driver so the
  // new options take effect.
  pool.reconcile(
    poolSettings({
      enabled: true,
      driver: "fake",
      min: 0,
      max: 2,
      driverOptions: { region: "b" },
    }),
  );
  assert.equal(tracking.builds.fake, 2);

  // Re-applying the SAME driverOptions does not rebuild again.
  pool.reconcile(
    poolSettings({
      enabled: true,
      driver: "fake",
      min: 0,
      max: 2,
      driverOptions: { region: "b" },
    }),
  );
  assert.equal(tracking.builds.fake, 2);
  await pool.drain({ deadlineMs: 1_000 });
});

test("an in-flight lease settling AFTER a driver swap destroys its worker against the ORIGINAL driver (never orphaned)", async () => {
  const { clock } = controllableClock(0);
  const tracking = registerTracking();
  const pool = createWorkerPool(poolSettings({ enabled: true, driver: "fake", min: 0, max: 2 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  // Acquire a worker on the OLD ("fake") driver and HOLD the lease across the swap.
  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  const oldWorkerId = held.lease.workerId;
  assert.equal(held.lease.workerHost.startsWith("fake://"), true);
  const oldDriver = tracking.fake();
  assert.equal(oldDriver.provisioned.includes(oldWorkerId), true);

  // Reconcile to a NEW driver while the lease is still in flight. swapDriver
  // captures originDriver on the still-leased worker BEFORE reassigning this.driver.
  pool.reconcile(poolSettings({ enabled: true, driver: "static-ssh", min: 0, max: 2 }));
  const newDriver = tracking.staticSsh();
  assert.equal(pool.snapshot().driver, "static-ssh");

  // Now the in-flight lease settles as poison so its worker is recycled at settle
  // time. recycle() must destroy against the worker's captured ORIGINAL driver
  // ("fake"), NOT the new this.driver ("static"), so the paid worker is not
  // orphaned on the old backend.
  await held.lease.fail("ssh_timeout");

  // The OLD driver tore the worker down; the NEW driver never saw a destroy for
  // a worker it never provisioned.
  assert.equal(oldDriver.destroyed.includes(oldWorkerId), true);
  assert.equal(newDriver.destroyed.includes(oldWorkerId), false);
  // No paid worker orphaned on the old backend.
  assert.equal(oldDriver.workers.has(oldWorkerId), false);

  await pool.drain({ deadlineMs: 1_000 });
});

test("a reconcile to an UNAVAILABLE driver throws and mutates NOTHING (last-good workers survive: neither warm-idle nor leased worker is marked for destroy, this.driver unchanged, the leased worker settles healthy and is NOT recycled)", async () => {
  const { clock } = controllableClock(0);
  // Old driver ("fake") is registered; the NEW kind ("static-ssh") is NOT, so
  // the swap's registry require(next.driver) THROWS worker_pool_driver_unavailable.
  const oldDriver = new TrackingDriver("fake", "fake");
  registerDrivers(oldDriver);
  const pool = createWorkerPool(poolSettings({ enabled: true, driver: "fake", min: 0, max: 3 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  // Stage last-good capacity as TWO distinct workers: acquire both (each grows a
  // worker), then release one so it goes WARM_IDLE while the other stays LEASED held
  // across the failed reload.
  const warm = await pool.acquire(acquireReq({ issueId: "issue-warm" }));
  const held = await pool.acquire(acquireReq({ issueId: "issue-held" }));
  assert.equal(warm.status, "leased");
  assert.equal(held.status, "leased");
  if (warm.status !== "leased" || held.status !== "leased") return;
  const warmWorkerId = warm.lease.workerId;
  const heldWorkerId = held.lease.workerId;
  assert.notEqual(warmWorkerId, heldWorkerId);
  await warm.lease.release("healthy");

  const beforeProvisioned = oldDriver.provisioned.length;

  // Reconcile to the UNAVAILABLE driver. swapDriver must do ALL throwing work
  // (resolveDriver) BEFORE mutating any record / this.driver, so a rejected
  // reload leaves the inventory byte-identical and the failure propagates.
  assert.throws(
    () => pool.reconcile(poolSettings({ enabled: true, driver: "static-ssh", min: 0, max: 3 })),
    /worker_pool_driver_unavailable/,
  );

  // NOTHING was mutated: this.driver is unchanged (snapshot still reports the
  // old kind) and NEITHER worker was flagged for destroy.
  const after = pool.snapshot();
  assert.equal(after.driver, "fake");
  assert.equal(after.total, 2);
  const warmRow = after.workers.find((worker) => worker.workerId === warmWorkerId);
  const heldRow = after.workers.find((worker) => worker.workerId === heldWorkerId);
  assert.ok(warmRow);
  assert.ok(heldRow);
  assert.equal(warmRow?.markedForDestroy, false);
  assert.equal(heldRow?.markedForDestroy, false);
  assert.equal(warmRow?.state, "WARM_IDLE");
  assert.equal(heldRow?.state, "LEASED");
  // The old driver provisioned no replacement and destroyed nothing.
  assert.equal(oldDriver.provisioned.length, beforeProvisioned);
  assert.equal(oldDriver.destroyed.length, 0);

  // The still-leased worker settles HEALTHY: because it was never markedForDestroy,
  // onLeaseSettle returns it to WARM_IDLE instead of recycling it. The warm idle
  // worker was likewise never reaped: both last-good workers survive the failed reload.
  await held.lease.release("healthy");
  const settled = pool.snapshot();
  assert.equal(settled.total, 2);
  assert.equal(settled.warmIdle, 2);
  assert.equal(settled.leased, 0);
  assert.equal(oldDriver.destroyed.length, 0);
  assert.equal(oldDriver.workers.has(warmWorkerId), true);
  assert.equal(oldDriver.workers.has(heldWorkerId), true);

  await pool.drain({ deadlineMs: 1_000 });
});

// A tracking driver whose `provision` parks on an externally-resolved gate, so a
// test can drive a driver SWAP IN BETWEEN the pool deciding to grow (provision
// called on this driver) and the provision resolving (the worker landing in
// inventory under the NOW-stale driver). Tags every workerHost so a test can tell
// which backend created / tore down a worker, and tracks every destroy.
class DeferredTrackingDriver implements WorkerDriver {
  readonly destroyed: string[] = [];
  readonly provisioned: string[] = [];
  readonly workers = new Set<string>();
  private readonly gates: Array<() => void> = [];

  constructor(
    readonly kind: WorkerDriver["kind"],
    readonly tag: string,
    private readonly usesLedger = false,
  ) {}

  get capabilities(): DriverCapabilities {
    return { sshAddressable: false, ephemeral: true, usesLedger: this.usesLedger };
  }

  async provision(req: ProvisionRequest): Promise<WorkerDescriptor> {
    await new Promise<void>((resolve) => {
      this.gates.push(resolve);
    });
    this.provisioned.push(req.workerId);
    this.workers.add(req.workerId);
    const workerHost = `${this.tag}://worker-${req.workerId}`;
    return {
      workerId: req.workerId,
      workerHost,
      driverRef: workerHost,
      createdAtMs: 0,
      labels: [...req.labels],
      metadata: { driverTag: this.tag },
    };
  }

  async probe(): Promise<WorkerHealth> {
    return Promise.resolve({ ok: true });
  }

  async destroy(worker: WorkerDescriptor, _opts: { timeoutMs: number; reason: TeardownReason }) {
    this.destroyed.push(worker.workerId);
    this.workers.delete(worker.workerId);
    return Promise.resolve();
  }

  async list(): Promise<WorkerDescriptor[]> {
    return Promise.resolve(
      [...this.workers].map((workerId) => ({
        workerId,
        workerHost: `${this.tag}://worker-${workerId}`,
        driverRef: `${this.tag}://worker-${workerId}`,
        createdAtMs: 0,
        labels: [POOL_OWNED_LABEL],
        metadata: { driverTag: this.tag },
      })),
    );
  }

  pendingCount(): number {
    return this.gates.length;
  }

  releaseNext(): void {
    const gate = this.gates.shift();
    if (gate) gate();
  }
}

test("a driver swap DURING an in-flight grow provision records the worker against the ORIGINAL driver and marks it for destroy (no orphan)", async () => {
  // FINDING (MEDIUM): grow() awaits provision() then inserts the descriptor without
  // capturing which driver created it. A swapDriver DURING the await records a
  // driver-A worker under the new driver B with no originDriver, so a later
  // recycle/destroy routes to B and A's paid machine leaks. The grow must capture
  // the driver (and its generation) BEFORE the await, then on return stamp
  // record.originDriver = the CAPTURED driver and (because a swap happened) mark
  // the worker for destroy.
  const { clock } = controllableClock(0);
  const oldDriver = new DeferredTrackingDriver("fake", "fake", /* usesLedger */ true);
  const newDriver = new DeferredTrackingDriver("static-ssh", "static", /* usesLedger */ true);
  registerDrivers(oldDriver, newDriver);

  const pool = createWorkerPool(poolSettings({ enabled: true, driver: "fake", min: 0, max: 2 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  // Kick off an acquire that grows a worker on the OLD ("fake") driver; its
  // provision parks on the gate (the worker is NOT yet in inventory).
  const acquiring = pool.acquire(acquireReq());
  await waitUntil(() => oldDriver.pendingCount() === 1);

  // SWAP to the new driver WHILE the old provision is still in flight.
  pool.reconcile(poolSettings({ enabled: true, driver: "static-ssh", min: 0, max: 2 }));
  assert.equal(pool.snapshot().driver, "static-ssh");

  // Now let the OLD provision resolve: the worker lands in inventory AFTER the swap.
  oldDriver.releaseNext();
  const result = await acquiring;
  assert.equal(result.status, "leased");
  if (result.status !== "leased") return;
  const workerId = result.lease.workerId;
  // The worker was provisioned on the OLD ("fake") backend, so its workerHost is fake.
  assert.equal(result.lease.workerHost.startsWith("fake://"), true);
  assert.equal(oldDriver.provisioned.includes(workerId), true);

  // The worker was marked for destroy (it was provisioned on the now-stale driver).
  const snapWorker = pool.snapshot().workers.find((worker) => worker.workerId === workerId);
  assert.ok(snapWorker);
  assert.equal(snapWorker?.markedForDestroy, true);

  // Settle the lease: recycle must destroy the worker against its ORIGINAL ("fake")
  // driver, NOT the new ("static") driver, so the paid machine is not orphaned.
  await result.lease.release("healthy");
  await waitUntil(() => oldDriver.destroyed.includes(workerId));
  assert.equal(oldDriver.destroyed.includes(workerId), true);
  assert.equal(newDriver.destroyed.includes(workerId), false);
  // No paid worker orphaned on the old backend.
  assert.equal(oldDriver.workers.has(workerId), false);

  await pool.drain({ deadlineMs: 1_000 });
});

test("a driver swap DURING an in-flight WARM provision records the worker against the ORIGINAL driver and marks it for destroy (no orphan)", async () => {
  // Same orphaned-in-flight-grow shape as above, but for the reaper-driven
  // provisionWarm() path: a warm worker provisioned on driver A whose insert lands
  // after a swap to B must still carry originDriver=A and be marked for destroy.
  const { clock } = controllableClock(0);
  const oldDriver = new DeferredTrackingDriver("fake", "fake", /* usesLedger */ true);
  const newDriver = new DeferredTrackingDriver("static-ssh", "static", /* usesLedger */ true);
  registerDrivers(oldDriver, newDriver);

  // warm=1 so a reconcile's growTowardTarget drives provisionWarm() on the OLD
  // driver; its provision parks on the gate. A short reapIntervalMs so the
  // recurring reaper promptly recycles the (flagged, idle) stale worker once it lands.
  const pool = createWorkerPool(
    poolSettings({ enabled: true, driver: "fake", min: 0, max: 2, warm: 1, reapIntervalMs: 5 }),
    { clock, drivers, logEvent: () => undefined },
  );

  // Trigger a warm top-up on the OLD driver (reconcile with the same driver so
  // no swap yet; growTowardTarget calls provisionWarm which parks on the gate).
  pool.reconcile(
    poolSettings({ enabled: true, driver: "fake", min: 0, max: 2, warm: 1, reapIntervalMs: 5 }),
  );
  await waitUntil(() => oldDriver.pendingCount() >= 1);

  // SWAP to the new driver WHILE the warm provision is still in flight.
  pool.reconcile(
    poolSettings({
      enabled: true,
      driver: "static-ssh",
      min: 0,
      max: 2,
      warm: 1,
      reapIntervalMs: 5,
    }),
  );
  assert.equal(pool.snapshot().driver, "static-ssh");

  // Let the OLD warm provision resolve: the worker lands in inventory AFTER the swap,
  // flagged for destroy with origin captured to the OLD driver.
  oldDriver.releaseNext();
  await waitUntil(() => oldDriver.provisioned.length === 1);
  const workerId = oldDriver.provisioned[0]!;

  // The stale idle worker is recycled against its ORIGINAL ("fake") backend (NOT the
  // new "static" driver), so the paid machine is torn down where it was created
  // rather than orphaned by the reaper's list-reconcile dropping the record.
  await waitUntil(() => oldDriver.destroyed.includes(workerId));
  assert.equal(oldDriver.destroyed.includes(workerId), true);
  assert.equal(newDriver.destroyed.includes(workerId), false);
  assert.equal(oldDriver.workers.has(workerId), false);
  // And it never lingers in inventory under the new driver.
  await waitUntil(() => !pool.snapshot().workers.some((b) => b.workerId === workerId));

  await pool.drain({ deadlineMs: 1_000 });
});

test("driver swap re-threads the reaper driver and the ledger usesLedger gate (no singleton reconstruction)", async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-pool-swap-ledger-test-"));
  const ledgerPath = path.join(tmpDir, "worker-pool", "ledger.json");
  const { clock } = controllableClock(0);

  // Old driver: NON-ledger ("fake"). New driver: ledger-backed ("static-ssh")
  // so the swap must rebuild the ledger gate (usesLedger false -> true) in place.
  const builds = { fake: 0, "static-ssh": 0 };
  let staticInstance: TrackingDriver | null = null;
  drivers = new WorkerDriverRegistry();
  drivers.register({
    kind: "fake",
    create: () => {
      builds.fake += 1;
      return new TrackingDriver("fake", "fake", /* usesLedger */ false);
    },
  });
  drivers.register({
    kind: "static-ssh",
    create: () => {
      builds["static-ssh"] += 1;
      staticInstance = new TrackingDriver("static-ssh", "static", /* usesLedger */ true);
      return staticInstance;
    },
  });

  const pool = createWorkerPool(
    poolSettings({ enabled: true, driver: "fake", min: 0, max: 2, reapIntervalMs: 5 }),
    { clock, drivers, logEvent: () => undefined, ledgerPath },
  );

  // Swap to the ledger-backed driver in place.
  pool.reconcile(
    poolSettings({ enabled: true, driver: "static-ssh", min: 0, max: 2, reapIntervalMs: 5 }),
  );
  assert.equal(builds["static-ssh"], 1);
  assert.ok(staticInstance);

  // The reaper now drives the NEW driver: a worker provisioned post-swap lands on
  // the static backend and the recurring reaper's list() reconcile (which reads
  // reaperInternals.driver) keeps it, proving the reaper driver was re-threaded.
  const leased = await pool.acquire(acquireReq());
  assert.equal(leased.status, "leased");
  if (leased.status !== "leased") return;
  assert.equal(leased.lease.workerHost.startsWith("static://"), true);

  // The ledger gate was rebuilt to usesLedger=true: a WAL row for the new worker is
  // now written to disk (a non-ledger gate would have performed zero fs I/O).
  await waitUntil(async () => {
    try {
      const onDisk = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as { rows: LedgerRow[] };
      return onDisk.rows.some((row) => row.workerId === leased.lease.workerId);
    } catch {
      return false;
    }
  });

  await leased.lease.release("healthy");
  await pool.drain({ deadlineMs: 1_000 });
});

// ---------------------------------------------------------------------------
// onMachineRecycling: the recycle-vs-endpoint ordering invariant (T2c)
// ---------------------------------------------------------------------------

test("onMachineRecycling fires with the workerId on a poison-driven recycle (before the driver.destroy completes)", async () => {
  // A driver whose destroy parks on a gate so the test can prove the recycling
  // callback fired BEFORE the machine is actually torn down (the ordering
  // invariant: the coordinator must see the recycle before the host dies).
  const driver = new DeferredDestroyDriver();
  registerDeferredDestroy(driver);
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  const recycling: string[] = [];
  let destroyedAtCallback: string[] = [];
  pool.onMachineRecycling((workerId) => {
    recycling.push(workerId);
    // Snapshot what the driver has destroyed AT callback time: the destroy is
    // parked on the gate, so nothing is torn down yet (callback fires first).
    destroyedAtCallback = [...driver.destroyed];
  });

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  const workerId = held.lease.workerId;

  // Poison the worker: on settle it is recycled, which must fire the callback.
  const settle = held.lease.fail("ssh_timeout");
  await waitUntil(() => recycling.length === 1);

  assert.deepEqual(recycling, [workerId]);
  // The callback ran BEFORE driver.destroy completed (the destroy is gated).
  assert.deepEqual(destroyedAtCallback, []);

  // Let the destroy complete and the settle resolve.
  driver.releaseNextDestroy();
  await settle;
  await waitUntil(() => driver.destroyed.includes(workerId));
  await pool.drain({ deadlineMs: 1_000 });
});

test("onMachineRecycling fires on the drain force-destroy path too (every teardown routes through recycle)", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  const recycling: string[] = [];
  pool.onMachineRecycling((workerId) => recycling.push(workerId));

  // A still-held lease forces drain to tear the worker down (the force-destroy path).
  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  const workerId = held.lease.workerId;

  await pool.drain({ deadlineMs: 50 });
  assert.deepEqual(recycling, [workerId]);
});

test("onMachineRecycling supports multiple registered callbacks (all fire)", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  const a: string[] = [];
  const b: string[] = [];
  pool.onMachineRecycling((workerId) => a.push(workerId));
  pool.onMachineRecycling((workerId) => b.push(workerId));

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  const workerId = held.lease.workerId;

  await held.lease.fail("ssh_timeout");
  assert.deepEqual(a, [workerId]);
  assert.deepEqual(b, [workerId]);
  await pool.drain({ deadlineMs: 1_000 });
});

test("onMachineRecycling fires exactly once per worker even when a poisoned, marked worker is recycled once", async () => {
  // recycle() is idempotent (a DESTROYED/DESTROYING worker is left alone), so the
  // callback must not double-fire for a single teardown.
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  const recycling: string[] = [];
  pool.onMachineRecycling((workerId) => recycling.push(workerId));

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  const workerId = held.lease.workerId;

  await held.lease.fail("ssh_timeout");
  // Drain after the worker is already gone must not re-fire the callback.
  await pool.drain({ deadlineMs: 1_000 });
  assert.deepEqual(recycling, [workerId]);
});

// --- co-residence (slotsPerMachine>1) regression coverage -----------------
// These three guard the seams that only open once two leases share one worker.

test("co-resident poison is remembered: the worker recycles when the last sibling settles", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0, min: 0, slotsPerMachine: 2 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });

  // max:1 with two slots forces both leases onto the SAME worker.
  const a = await pool.acquire(acquireReq({ issueId: "issue-a", slotIndex: 0 }));
  assert.equal(a.status, "leased");
  if (a.status !== "leased") return;
  const b = await pool.acquire(acquireReq({ issueId: "issue-b", slotIndex: 1 }));
  assert.equal(b.status, "leased");
  if (b.status !== "leased") return;
  assert.equal(a.lease.workerId, b.lease.workerId);
  assert.equal(pool.snapshot().inFlight, 2);

  // One co-resident lease hits a worker-transport fault while the sibling is still live.
  await a.lease.fail("ssh_down");

  // The worker is flagged for destroy NOW (poison remembered) even though a sibling
  // still holds it, so it cannot serve a fresh lease and cannot grow (max reached):
  // a new acquire times out instead of landing on a known-bad worker.
  let snap = pool.snapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.inFlight, 1);
  assert.equal(
    snap.workers.find((worker) => worker.workerId === a.lease.workerId)?.markedForDestroy,
    true,
  );
  const blocked = await pool.acquire(acquireReq({ issueId: "issue-c", timeoutMs: 30 }));
  assert.equal(blocked.status, "no_capacity");

  // When the healthy sibling finally releases, the worker is RECYCLED (not returned to
  // WARM_IDLE). Without remembering the poison it would have been reused.
  await b.lease.release("healthy");
  snap = pool.snapshot();
  assert.equal(snap.total, 0);

  await pool.drain({ deadlineMs: 1_000 });
});

test("a failed driver.destroy keeps the paid worker tracked, then drain reclaims it once it recovers", async () => {
  const { clock } = controllableClock(0);
  const events: Record<string, unknown>[] = [];
  const pool = createWorkerPool(poolSettings({ max: 1, warm: 0, min: 0 }), {
    clock,
    drivers,
    logEvent: (event) => {
      events.push(event);
    },
  });

  const a = await pool.acquire(acquireReq());
  assert.equal(a.status, "leased");
  if (a.status !== "leased") return;
  const workerId = a.lease.workerId;

  assert.ok(lastDriver);
  const driver = lastDriver as FakeWorkerDriver;

  // The backend destroy fails when the poisoned lease tries to recycle the worker.
  driver.injectDestroyFailure(workerId, "driver 500");
  await a.lease.fail("ssh_down");

  // The worker must stay tracked (a machine that may still be running and billing):
  // not dropped from inventory, flagged for destroy, and a destroy-failed event
  // logged. The backend instance is still alive because destroy never succeeded.
  const snap = pool.snapshot();
  assert.equal(snap.total, 1);
  const retained = snap.workers.find((worker) => worker.workerId === workerId);
  assert.equal(retained?.markedForDestroy, true);
  assert.equal(retained?.inFlight, 0);
  assert.equal(
    events.some(
      (event) => event.event === "worker_pool_destroy_failed" && event.workerId === workerId,
    ),
    true,
  );
  assert.equal(
    (await driver.list()).some((descriptor) => descriptor.workerId === workerId),
    true,
  );

  // Once the backend recovers, teardown actually reclaims it - proving the retained
  // worker was recoverable, never silently leaked.
  driver.clearDestroyFailure(workerId);
  await pool.drain({ deadlineMs: 1_000 });
  assert.equal(
    (await driver.list()).some((descriptor) => descriptor.workerId === workerId),
    false,
  );
});

test("maxWorkersPerIssue is not bypassed when a same-issue sibling settles on a shared worker", async () => {
  const { clock } = controllableClock(0);
  const pool = createWorkerPool(
    poolSettings({ max: 2, warm: 0, min: 0, slotsPerMachine: 2, maxWorkersPerIssue: 1 }),
    { clock, drivers, logEvent: () => undefined },
  );

  // Two leases for issue-a co-reside on worker B1 (both its slots).
  const a1 = await pool.acquire(acquireReq({ issueId: "issue-a", slotIndex: 0 }));
  const a2 = await pool.acquire(acquireReq({ issueId: "issue-a", slotIndex: 1 }));
  assert.equal(a1.status, "leased");
  assert.equal(a2.status, "leased");
  if (a1.status !== "leased" || a2.status !== "leased") return;
  assert.equal(a1.lease.workerId, a2.lease.workerId);

  // One issue-a lease settles. The worker must still be attributed to issue-a because
  // its sibling slot is live; a plain set would forget the issue here.
  await a1.lease.release("healthy");

  // A different issue fills the freed slot so issue-a can no longer reuse B1.
  const c = await pool.acquire(acquireReq({ issueId: "issue-c", slotIndex: 0 }));
  assert.equal(c.status, "leased");
  if (c.status !== "leased") return;
  assert.equal(c.lease.workerId, a1.lease.workerId);

  // issue-a wants another slot. B1 is full and issue-a already holds its one allowed
  // worker, so growth is barred by the cap and the acquire times out. If the settle had
  // dropped issue-a's attribution, the pool would grow a SECOND worker for issue-a and
  // blow the cap.
  const a3 = await pool.acquire(acquireReq({ issueId: "issue-a", slotIndex: 0, timeoutMs: 30 }));
  assert.equal(a3.status, "no_capacity");
  assert.equal(pool.snapshot().total, 1);

  await pool.drain({ deadlineMs: 1_000 });
});
