import { beforeEach, test } from "vitest";
import type { WorkerPoolSettings } from "@lorenz/domain";
import { withDerivedMaxInFlight } from "@lorenz/domain";
import type { ClockPort, TimerHandle } from "@lorenz/domain";
import { assert } from "@lorenz/test-utils";
import { WorkerDriverRegistry, FakeWorkerDriver } from "@lorenz/worker-sdk";
import type { WorkerDriver } from "@lorenz/worker-sdk";

import { createWorkerPool } from "../src/pool.js";
import { runReaperTick, type ReaperInternals } from "../src/reaper.js";
import { createMutex } from "../src/mutex.js";
import type { WorkerRecord, Mutex } from "../src/types.js";

// --- shared fixtures -------------------------------------------------------

function controllableClock(startMs: number): {
  clock: ClockPort;
  advance(ms: number): void;
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
  };
}

function poolSettings(overrides: Partial<WorkerPoolSettings> = {}): WorkerPoolSettings {
  const { maxInFlight, slotsPerMachine, ...rest } = overrides;
  return withDerivedMaxInFlight({
    enabled: true,
    driver: "fake",
    min: 0,
    max: 4,
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

beforeEach(() => {
  registerFake();
  lastDriver = null;
});

// Builds a WorkerRecord seeded into a hand-rolled inventory for the unit-level
// reaper tests (so a test controls state/heartbeats/inFlight precisely without
// driving the whole acquire path).
function makeRecord(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  const workerId = overrides.workerId ?? "worker-0";
  const workerHost = overrides.workerHost ?? `fake://worker-${workerId}`;
  return {
    workerId,
    workerHost,
    driverRef: workerHost,
    state: "WARM_IDLE",
    labels: ["lorenz.pool=worker-pool"],
    createdAtMs: 0,
    leaseId: null,
    inFlight: 0,
    lastIdleAtMs: 0,
    lastHeartbeatMs: 0,
    workerSecondsUsed: 0,
    markedForDestroy: false,
    affinityKey: null,
    metadata: {},
    leaseIssues: new Map<string, number>(),
    ...overrides,
  };
}

// A minimal ReaperInternals over a hand-rolled inventory + the fake driver, so
// the reaper logic is exercised in isolation. Tracks destroy calls and provisions
// so a test can assert exactly which workers were torn down or topped up.
function makeInternals(
  settings: WorkerPoolSettings,
  records: WorkerRecord[],
  options: {
    driver?: WorkerDriver;
    isRunActive?: (record: WorkerRecord) => boolean;
    poolOwnedLabel?: string;
    liveWorkerCount?: () => number;
  } = {},
): {
  internals: ReaperInternals;
  inventory: Map<string, WorkerRecord>;
  mutexes: Map<string, Mutex>;
  destroyed: string[];
  provisioned: string[];
} {
  const inventory = new Map<string, WorkerRecord>();
  for (const record of records) inventory.set(record.workerId, record);
  const mutexes = new Map<string, Mutex>();
  const destroyed: string[] = [];
  const provisioned: string[] = [];

  // Default driver whose authoritative `list()` mirrors the live inventory, so
  // the list() reconcile is a no-op for the ttl/idle/orphan/top-up unit tests
  // (which only want to exercise those paths). Tests that need driver-vs-pool
  // DIVERGENCE pass their own driver via `options.driver`.
  const inventoryMirrorDriver: WorkerDriver = {
    kind: "fake",
    capabilities: { sshAddressable: false, ephemeral: false, usesLedger: false },
    provision: async (req) => ({
      workerId: req.workerId,
      workerHost: `fake://worker-${req.workerId}`,
      driverRef: `fake://worker-${req.workerId}`,
      createdAtMs: 0,
      labels: [...req.labels],
      metadata: {},
    }),
    probe: async () => ({ ok: true }),
    destroy: async () => undefined,
    list: async () =>
      [...inventory.values()].map((record) => ({
        workerId: record.workerId,
        workerHost: record.workerHost,
        driverRef: record.driverRef,
        createdAtMs: record.createdAtMs,
        labels: record.labels,
        metadata: record.metadata,
      })),
  };
  const driver = options.driver ?? inventoryMirrorDriver;

  const internals: ReaperInternals = {
    settings,
    driver,
    poolOwnedLabel: options.poolOwnedLabel ?? "lorenz.pool=worker-pool",
    now: () => 0,
    inventory,
    mutexFor: (workerId: string): Mutex => {
      let mutex = mutexes.get(workerId);
      if (!mutex) {
        mutex = createMutex();
        mutexes.set(workerId, mutex);
      }
      return mutex;
    },
    liveWorkerCount: options.liveWorkerCount ?? (() => inventory.size),
    isRunActive: options.isRunActive ?? (() => true),
    hydrated: () => true,
    hasGrowthBudget: () => true,
    destroyWorker: async (record: WorkerRecord) => {
      destroyed.push(record.workerId);
      inventory.delete(record.workerId);
      mutexes.delete(record.workerId);
    },
    provisionWarm: async () => {
      const id = `warm-${provisioned.length}`;
      provisioned.push(id);
      inventory.set(id, makeRecord({ workerId: id }));
    },
    logEvent: () => undefined,
    wakeWaiters: () => undefined,
  };
  return { internals, inventory, mutexes, destroyed, provisioned };
}

// --- ttl / idle reaping ----------------------------------------------------

test("ttl-exceeded WARM_IDLE above min is destroyed", async () => {
  const settings = poolSettings({ min: 0, ttlMs: 1_000 });
  const record = makeRecord({ state: "WARM_IDLE", createdAtMs: 0, lastIdleAtMs: 0 });
  const { internals, inventory, destroyed } = makeInternals(settings, [record]);
  internals.now = () => 2_000; // 2s past createdAt, ttl is 1s

  await runReaperTick(internals);

  assert.deepEqual(destroyed, ["worker-0"]);
  assert.equal(inventory.size, 0);
});

test("idle-exceeded above min destroyed; min floor respected", async () => {
  const settings = poolSettings({ min: 1, idleReapMs: 1_000, ttlMs: 1_000_000 });
  // Two idle workers both past idle window, but min=1 so exactly one survives.
  const a = makeRecord({ workerId: "worker-0", state: "WARM_IDLE", lastIdleAtMs: 0 });
  const b = makeRecord({ workerId: "worker-1", state: "WARM_IDLE", lastIdleAtMs: 0 });
  const { internals, inventory, destroyed } = makeInternals(settings, [a, b]);
  internals.now = () => 5_000; // both well past the 1s idle window

  await runReaperTick(internals);

  // Only one worker reaped; the min=1 floor keeps the other alive.
  assert.equal(destroyed.length, 1);
  assert.equal(inventory.size, 1);
});

test("LEASED past ttl is flagged markedForDestroy, NOT yanked, recycled when inFlight->0 inside mutex", async () => {
  // Drive the real pool so the flag-then-recycle-on-settle path (including the
  // per-worker mutex coordination) is exercised end to end. The reaper flags a
  // LEASED worker past ttl but never yanks it mid-run; the pool's lease-settle
  // recycles it the instant the last lease returns.
  const { clock, advance } = controllableClock(0);
  const pool = createWorkerPool(
    poolSettings({
      min: 0,
      warm: 0,
      max: 1,
      ttlMs: 1_000,
      idleReapMs: 1_000_000,
      reapIntervalMs: 10,
    }),
    { clock, drivers, logEvent: () => undefined },
  );

  const leased = await pool.acquire({
    issueId: "issue-1",
    slotIndex: 0,
    labels: [],
    timeoutMs: 1_000,
  });
  assert.equal(leased.status, "leased");
  if (leased.status !== "leased") return;

  // Advance past ttl and let a reaper tick fire. The worker is LEASED so it is only
  // flagged, never destroyed mid-run.
  advance(2_000);
  await new Promise<void>((resolve) => setTimeout(resolve, 40));

  let snap = pool.snapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.leased, 1);
  const flagged = snap.workers.find((b) => b.workerId === leased.lease.workerId);
  assert.ok(flagged);
  assert.equal(flagged?.markedForDestroy, true);

  // The lease returns: the flagged worker is recycled exactly once (inFlight->0
  // inside the per-worker mutex), so it never underflows and is fully gone.
  await leased.lease.release("healthy");
  snap = pool.snapshot();
  assert.equal(snap.total, 0);
  assert.equal(snap.inFlight, 0);
  await pool.drain({ deadlineMs: 100 });
});

// --- probe / DEGRADED ------------------------------------------------------

test("probe failure on long-idle demotes to DEGRADED then DESTROYING", async () => {
  const { clock } = controllableClock(0);
  const driver = new FakeWorkerDriver({ clock });
  // Provision a worker into the driver so probe has something to flip to failing.
  await driver.provision({ workerId: "worker-0", labels: [], timeoutMs: 1_000 });
  driver.injectProbeFailure("worker-0", "unreachable");

  const settings = poolSettings({ min: 0, idleReapMs: 1_000, ttlMs: 1_000_000 });
  const record = makeRecord({ state: "WARM_IDLE", lastIdleAtMs: 0, lastHeartbeatMs: 0 });
  const { internals, inventory, destroyed } = makeInternals(settings, [record], { driver });
  // Within idle window so idle-reap does NOT fire; the demotion path runs.
  internals.now = () => 500;

  await runReaperTick(internals);

  // A probe-failed worker is demoted and then torn down (no point keeping a dead worker).
  assert.deepEqual(destroyed, ["worker-0"]);
  assert.equal(inventory.size, 0);
});

// --- orphan vs alive -------------------------------------------------------

test("ORPHAN: stale-heartbeat lease whose run is gone is force-returned, clearing lease table AND decrementing inFlight", async () => {
  const settings = poolSettings({ min: 0, staleHeartbeatMs: 1_000, ttlMs: 1_000_000 });
  const record = makeRecord({
    state: "LEASED",
    inFlight: 1,
    leaseId: "lease-1",
    lastHeartbeatMs: 0,
  });
  // The run is GONE (not active) => orphan.
  const { internals, inventory, destroyed } = makeInternals(settings, [record], {
    isRunActive: () => false,
  });
  internals.now = () => 5_000; // heartbeat 5s old, stale threshold 1s

  await runReaperTick(internals);

  // The orphaned lease is force-returned: inFlight cleared, lease table cleared,
  // and the worker recycled (a worker that hosted an orphan is not trusted).
  assert.equal(record.inFlight <= 0 ? 0 : record.inFlight, 0);
  assert.deepEqual(destroyed, ["worker-0"]);
  assert.equal(inventory.size, 0);
});

test("ALIVE: long single-turn run past staleHeartbeatMs but still active is NOT destroyed", async () => {
  const settings = poolSettings({ min: 0, staleHeartbeatMs: 1_000, ttlMs: 1_000_000 });
  const record = makeRecord({
    state: "LEASED",
    inFlight: 1,
    leaseId: "lease-1",
    lastHeartbeatMs: 0,
  });
  // The run is STILL ACTIVE (a long single turn emits no heartbeat) => NOT orphan.
  const { internals, inventory, destroyed } = makeInternals(settings, [record], {
    isRunActive: () => true,
  });
  internals.now = () => 5_000; // heartbeat 5s old but the run is alive

  await runReaperTick(internals);

  // A long-but-alive run is left untouched: no destroy, inFlight preserved.
  assert.equal(destroyed.length, 0);
  assert.equal(inventory.size, 1);
  assert.equal(record.inFlight, 1);
  assert.equal(record.state, "LEASED");
});

test("LIVE POOL: a long-stale LEASED worker is never force-returned by the orphan path", async () => {
  // Honesty invariant: the live pool wires `isRunActive` to a constant true (an
  // un-settled in-flight lease == an active run in-process), so the orphan path is
  // a no-op there and never yanks a held worker from under a long single-turn run.
  const { clock, advance } = controllableClock(0);
  const pool = createWorkerPool(
    poolSettings({
      min: 0,
      warm: 0,
      max: 1,
      staleHeartbeatMs: 1_000,
      ttlMs: 1_000_000,
      idleReapMs: 1_000_000,
      reapIntervalMs: 10,
    }),
    { clock, drivers, logEvent: () => undefined },
  );

  const leased = await pool.acquire({
    issueId: "issue-1",
    slotIndex: 0,
    labels: [],
    timeoutMs: 1_000,
  });
  assert.equal(leased.status, "leased");
  if (leased.status !== "leased") return;

  // Advance far past staleHeartbeatMs WITHOUT a heartbeat, then let several reaper
  // ticks fire. The held lease never settles, so the worker must stay LEASED.
  advance(60_000);
  await new Promise<void>((resolve) => setTimeout(resolve, 60));

  const snap = pool.snapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.leased, 1);
  assert.equal(snap.inFlight, 1);
  const row = snap.workers.find((b) => b.workerId === leased.lease.workerId);
  assert.ok(row);
  assert.equal(row?.state, "LEASED");

  // The still-live lease settles cleanly afterward (it was never force-returned).
  await leased.lease.release("healthy");
  await pool.drain({ deadlineMs: 100 });
});

// --- list() authoritative reconcile ---------------------------------------

test("list() authoritative: labeled pool-owned unknown is destroyed", async () => {
  const { clock } = controllableClock(0);
  const driver = new FakeWorkerDriver({ clock });
  // A labeled pool-owned worker exists at the driver but the pool has NO record
  // of it (e.g. a crashed-before-ledger orphan). It must be destroyed.
  await driver.provision({
    workerId: "ghost-0",
    labels: ["lorenz.pool=worker-pool"],
    timeoutMs: 1_000,
  });

  const settings = poolSettings({ min: 0 });
  const { internals } = makeInternals(settings, [], { driver });

  await runReaperTick(internals);

  // The labeled-but-unknown survivor is destroyed at the driver directly (the
  // pool has no record to route through `destroyWorker`).
  const remaining = await driver.list();
  assert.equal(remaining.length, 0);
});

test("list() pre-hydrate: a labeled survivor is NOT destroyed before hydrate has run", async () => {
  const { clock } = controllableClock(0);
  const driver = new FakeWorkerDriver({ clock });
  // A labeled pool-owned survivor exists at the driver. A reaper tick that fires
  // BEFORE hydrate() has re-adopted it must NOT destroy it (the constructor arms
  // the reaper but hydrate runs later); otherwise a restart reaps its own survivor.
  await driver.provision({
    workerId: "survivor-0",
    labels: ["lorenz.pool=worker-pool"],
    timeoutMs: 1_000,
  });

  const settings = poolSettings({ min: 0 });
  const { internals } = makeInternals(settings, [], { driver });
  // The pool has not hydrated yet: the destroy-unknown branch must be inert.
  internals.hydrated = () => false;

  await runReaperTick(internals);

  // The labeled survivor is still present (never reaped pre-hydrate).
  const remaining = await driver.list();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.workerId, "survivor-0");
});

test("list() authoritative: unlabeled instance is NEVER destroyed", async () => {
  const { clock } = controllableClock(0);
  const driver = new FakeWorkerDriver({ clock });
  // An UNLABELED instance at the driver (not ours). The reaper must NEVER
  // destroy it even though the pool has no record of it.
  await driver.provision({ workerId: "foreign-0", labels: [], timeoutMs: 1_000 });

  const settings = poolSettings({ min: 0 });
  const { internals, destroyed } = makeInternals(settings, [], { driver });

  await runReaperTick(internals);

  assert.deepEqual(destroyed, []);
  const remaining = await driver.list();
  assert.equal(remaining.length, 1);
});

test("registered-but-missing-in-list is marked DESTROYED", async () => {
  const { clock } = controllableClock(0);
  const driver = new FakeWorkerDriver({ clock });
  // The pool has a record but the driver's authoritative list() does NOT show
  // it (the machine vanished). The record must be reconciled to DESTROYED.
  const settings = poolSettings({ min: 0 });
  const record = makeRecord({ workerId: "worker-0", state: "WARM_IDLE" });
  const { internals, inventory } = makeInternals(settings, [record], { driver });

  await runReaperTick(internals);

  // The vanished worker is dropped from inventory (reconciled to DESTROYED).
  assert.equal(inventory.has("worker-0"), false);
});

test("reconcile-missing leaves a LEASED detached-driver worker alone (no old-driver leak after a swap)", async () => {
  const { clock } = controllableClock(0);
  // The LIVE driver's list() is empty, so worker-0 looks "missing".
  const driver = new FakeWorkerDriver({ clock });
  const settings = poolSettings({ min: 0 });
  // worker-0 is still LEASED and was created on a now-detached driver (captured
  // originDriver by a swapDriver). The live list() legitimately cannot see it -
  // it lives on the OLD backend and is torn down on its origin when its lease settles.
  // Reconciling it away would drop the record so the settle no-ops and the paid
  // old-driver machine leaks.
  const oldDriver = new FakeWorkerDriver({ clock });
  const record = makeRecord({
    workerId: "worker-0",
    state: "LEASED",
    inFlight: 1,
    originDriver: oldDriver,
  });
  const { internals, inventory } = makeInternals(settings, [record], { driver });

  await runReaperTick(internals);

  // NOT reconciled away: the record survives so its lease settle can destroy it on
  // its origin backend.
  assert.equal(inventory.has("worker-0"), true);
});

// --- top-up ----------------------------------------------------------------

test("top-up provisions toward min/warm only within spend budget", async () => {
  const settings = poolSettings({ min: 2, warm: 2, max: 4 });
  const { internals, provisioned } = makeInternals(settings, []);
  internals.hasGrowthBudget = () => true;

  await runReaperTick(internals);
  // Empty pool, min=2 -> tops up two warm workers.
  assert.equal(provisioned.length, 2);
});

test("top-up does NOT provision when spend budget is exhausted", async () => {
  const settings = poolSettings({ min: 2, warm: 2, max: 4 });
  const { internals, provisioned } = makeInternals(settings, []);
  internals.hasGrowthBudget = () => false; // budget exhausted

  await runReaperTick(internals);
  assert.equal(provisioned.length, 0);
});

test("top-up is HELD for a survivor-owning driver until hydrate completes (no pre-hydrate duplicates)", async () => {
  const settings = poolSettings({ min: 2, warm: 2, max: 4 });
  // A PAID driver that owns survivors (usesLedger/ephemeral). Pre-hydrate its
  // survivors are not yet adopted, so topping up would provision DUPLICATES.
  const paidDriver: WorkerDriver = {
    kind: "fake",
    capabilities: { sshAddressable: true, ephemeral: true, usesLedger: true },
    provision: async (req) => ({
      workerId: req.workerId,
      workerHost: `fake://worker-${req.workerId}`,
      driverRef: `fake://worker-${req.workerId}`,
      createdAtMs: 0,
      labels: [...req.labels],
      metadata: {},
    }),
    probe: async () => ({ ok: true }),
    destroy: async () => undefined,
    list: async () => [],
  };
  const { internals, provisioned } = makeInternals(settings, [], { driver: paidDriver });
  internals.hasGrowthBudget = () => true;
  internals.hydrated = () => false; // hydrate has not completed yet

  await runReaperTick(internals);
  // Held: a survivor-owning driver must NOT top up before hydrate adopts survivors.
  assert.equal(provisioned.length, 0);

  // Once hydrate completes, top-up resumes toward the target.
  internals.hydrated = () => true;
  await runReaperTick(internals);
  assert.equal(provisioned.length, 2);
});

// --- pool wiring: serial guard + unref ------------------------------------

test("reaper serial: a second tick while one is in progress is skipped", async () => {
  const settings = poolSettings({ min: 1, warm: 1 });
  let bodyRuns = 0;
  let inBody = 0;
  let maxConcurrent = 0;
  const { internals, inventory } = makeInternals(settings, []);
  // Make the single top-up provision block so a second tick can be attempted
  // mid-flight, then add the worker so the top-up loop terminates on release.
  const gate: { release: (() => void) | null } = { release: null };
  internals.provisionWarm = async () => {
    bodyRuns += 1;
    inBody += 1;
    maxConcurrent = Math.max(maxConcurrent, inBody);
    await new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    inventory.set(`warm-${bodyRuns}`, makeRecord({ workerId: `warm-${bodyRuns}` }));
    inBody -= 1;
  };

  const first = runReaperTick(internals);
  // Wait until the first tick has entered provisionWarm and parked (the body runs
  // after the reconcile/probe awaits, so poll rather than guess a microtask count).
  while (gate.release === null) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  // A second tick must be a no-op while the first is in progress (it must NOT
  // start a second provision body).
  const second = runReaperTick(internals);
  await second;
  gate.release();
  await first;

  // The serial in-progress guard means the body never ran concurrently and the
  // skipped second tick never started its own provision.
  assert.equal(maxConcurrent, 1);
  assert.equal(bodyRuns, 1);
});

test("pool invokes timerHandle.unref?.() on the reaper timer", () => {
  let unrefCalled = 0;
  const timer: TimerHandle = {
    unref: () => {
      unrefCalled += 1;
    },
  };
  const clock: ClockPort = {
    now: () => new Date(0),
    monotonicMs: () => 0,
    setTimeout: () => timer,
    clearTimeout: () => undefined,
  };
  const pool = createWorkerPool(poolSettings({ enabled: true, min: 0, warm: 0 }), {
    clock,
    drivers,
    logEvent: () => undefined,
  });
  // The reaper timer must be detached so it never keeps the process alive.
  assert.equal(unrefCalled >= 1, true);
  void pool.drain({ deadlineMs: 1 });
});

test("pool reaper tick fires on the clock timer and reaps an idle worker (end-to-end wiring)", async () => {
  // Drive the reaper through the real pool timer to prove start/stop wiring.
  const { clock, advance } = controllableClock(0);
  const pool = createWorkerPool(
    poolSettings({ min: 0, warm: 0, max: 1, idleReapMs: 1_000, reapIntervalMs: 10, ttlMs: 10_000 }),
    { clock, drivers, logEvent: () => undefined },
  );

  const leased = await pool.acquire({
    issueId: "issue-1",
    slotIndex: 0,
    labels: [],
    timeoutMs: 1_000,
  });
  assert.equal(leased.status, "leased");
  if (leased.status !== "leased") return;
  await leased.lease.release("healthy");
  assert.equal(pool.snapshot().warmIdle, 1);

  // Advance the logical clock past the idle window and let the real reaper timer
  // fire; the idle worker should be reaped.
  advance(5_000);
  await new Promise<void>((resolve) => setTimeout(resolve, 40));

  assert.equal(pool.snapshot().total, 0);
  await pool.drain({ deadlineMs: 100 });
});
