import type { WorkerDescriptor, WorkerDriver } from "@lorenz/worker-sdk";
import type { WorkerPoolSettings } from "@lorenz/domain";

import type { WorkerRecord, Mutex } from "./types.js";

/**
 * The seam between the pool and the single serial reaper pass. The pool supplies
 * its live inventory, the per-worker mutex factory, spend/growth predicates, and the
 * destroy/provision primitives; the reaper reads `settings`/`now` and drives the
 * ttl/idle/orphan/list-reconcile/top-up decisions over them. Keeping the contract
 * narrow lets the reaper logic be unit-tested over a hand-rolled inventory while
 * the pool owns the recurring timer (and its `unref`).
 */
export interface ReaperInternals {
  /** Current effective pool settings (swapped by the pool on config reload). */
  settings: WorkerPoolSettings;
  /** The resolved driver whose `list()` is the authoritative source of truth. */
  driver: WorkerDriver;
  /**
   * The label every pool-owned worker carries. A `list()` reconcile destroys a
   * labeled-but-unknown survivor (ours, leaked) but NEVER an unlabeled instance
   * (not ours), so the reaper can never nuke a machine the pool did not create.
   */
  poolOwnedLabel: string;
  /** Monotonic millisecond wall clock (the pool's lease clock). */
  now: () => number;
  /** The pool's authoritative in-memory inventory, keyed on `workerId`. */
  inventory: Map<string, WorkerRecord>;
  /** Returns (creating if needed) the per-worker mutex serializing its mutations. */
  mutexFor: (workerId: string) => Mutex;
  /** Count of workers that count as live for the `min` floor / growth headroom. */
  liveWorkerCount: () => number;
  /**
   * Whether the run holding a leased worker is still active. Distinguishes a true
   * orphan (stale heartbeat AND run gone -> force-return) from a long-but-alive
   * single turn (stale heartbeat but run still running -> left untouched). The
   * live pool wires this to a constant `true`: in-process a lease is settled
   * exactly once (only in `runClaim`'s finally), so an un-settled in-flight lease
   * always implies an active run, and the reaper must never force-return a LEASED
   * worker (that would kill a legitimate long single turn). Cross-restart orphan
   * recovery is handled by `hydrate` (re-adopt only survivors `driver.list()`
   * still shows), not by this predicate. The reaper unit tests inject `false` to
   * exercise the force-return branch in isolation.
   */
  isRunActive: (record: WorkerRecord) => boolean;
  /**
   * Whether `hydrate()` has completed at least once. The constructor arms the
   * recurring reaper but `hydrate()` (which re-adopts labeled survivors from
   * `driver.list()`) runs later, so a reaper tick that fires in the gap would see
   * a labeled survivor the pool has no record of yet and reap it as a leaked
   * unknown - destroying the pool's own survivor on restart. The destroy-unknown
   * reconcile branch is therefore gated on this: it is inert until the first
   * hydrate completes, after which normal reconcile behavior resumes.
   */
  hydrated: () => boolean;
  /** Whether the spend budget allows provisioning one more worker right now. */
  hasGrowthBudget: () => boolean;
  /** Destroys a worker (driver.destroy + inventory/mutex removal). Idempotent. */
  destroyWorker: (record: WorkerRecord, reason: TeardownReasonInternal) => Promise<void>;
  /** Provisions one warm worker toward the min/warm target (under budget). */
  provisionWarm: () => Promise<void>;
  /** Structured-log sink. */
  logEvent: (event: Record<string, unknown>) => void;
  /** Wakes any FIFO waiters after capacity frees (e.g. a reaped worker). */
  wakeWaiters: () => void;
}

/** Teardown reasons the reaper itself attributes (a subset of `TeardownReason`). */
type TeardownReasonInternal = "ttl" | "idle" | "unhealthy" | "orphan";

// Tracks which internals objects have a tick in progress so a second tick that
// fires while the first is still running (a slow probe/destroy) is skipped. Keyed
// on the internals object so the guard never leaks across pools and never makes
// `ReaperInternals` itself stateful.
const inProgress = new WeakSet<ReaperInternals>();

/**
 * Runs ONE serial reaper pass. Re-entrant calls while a pass is in progress are
 * skipped (the single in-progress guard), so a slow probe/destroy can never let
 * two passes interleave and double-decrement `inFlight`. The pass, in order:
 *
 *  1. reconcile against `driver.list()` (authoritative): destroy labeled
 *     pool-owned survivors the pool does not know about, NEVER touch unlabeled
 *     instances, and mark registered-but-missing records DESTROYED.
 *  2. orphan detection (gated on `isRunActive`): a LEASED worker with a stale
 *     heartbeat whose run is gone would be force-returned. In the LIVE pool
 *     `isRunActive` is constant `true` (an un-settled in-flight lease == an active
 *     run in-process), so this branch never fires there; it exists for the unit
 *     tests that inject a `false` predicate. Cross-restart orphans are recovered by
 *     `hydrate`, not here.
 *  3. ttl/idle reaping above `min`: a WARM_IDLE worker past ttl or its idle window is
 *     destroyed; a LEASED worker past ttl is only flagged `markedForDestroy` and is
 *     recycled when its last lease returns (inside the per-worker mutex).
 *  4. probe demotion: every WARM_IDLE worker is probed for readiness each tick; a
 *     failing probe demotes it to DEGRADED and tears it down.
 *  5. top-up toward min/warm within the spend budget.
 *
 * Every per-worker mutation runs inside that worker's mutex so a concurrent lease
 * release observing the same `inFlight->0` is serialized (the reaper-vs-release
 * race fix). `now` is read once per call (passed implicitly via `internals.now`).
 */
export async function runReaperTick(internals: ReaperInternals): Promise<void> {
  if (inProgress.has(internals)) return;
  inProgress.add(internals);
  try {
    await reconcileWithDriverList(internals);
    await reapOrphans(internals);
    await reapTtlAndIdle(internals);
    await reapUnhealthy(internals);
    await topUp(internals);
    internals.wakeWaiters();
  } finally {
    inProgress.delete(internals);
  }
}

/**
 * Reconciles the in-memory inventory against `driver.list()`, the authoritative
 * source of truth. Two independent directions:
 *
 *  - driver-has / pool-lacks: a survivor at the driver the pool has no record
 *    of. Destroy it ONLY when it carries the pool-owned label (ours, leaked by a
 *    crash). An unlabeled instance is left strictly alone (it is not ours).
 *  - pool-has / driver-lacks: a registered record the authoritative list no
 *    longer shows (the machine vanished). Mark it DESTROYED and drop it.
 */
async function reconcileWithDriverList(internals: ReaperInternals): Promise<void> {
  let listed: WorkerDescriptor[];
  try {
    listed = await internals.driver.list();
  } catch (error) {
    // list() is advisory-on-failure: a transient driver error must not cause a
    // mass reconcile (which could destroy or drop workers). Skip reconcile this pass.
    internals.logEvent({ event: "worker_pool_list_failed", error: errorMessage(error) });
    return;
  }

  const listedById = new Map<string, WorkerDescriptor>();
  for (const descriptor of listed) listedById.set(descriptor.workerId, descriptor);

  // driver-has / pool-lacks: destroy labeled-pool-owned unknowns only. Held back
  // until the first hydrate completes: pre-hydrate, every labeled survivor is
  // "unknown" simply because hydrate has not re-adopted it yet, and reaping it here
  // would destroy the pool's own survivors on restart. After hydrate the branch
  // resumes normal behavior (a labeled-unknown is then a genuine leaked orphan).
  const reapUnknowns = internals.hydrated();
  for (const descriptor of listed) {
    if (internals.inventory.has(descriptor.workerId)) continue;
    if (!reapUnknowns) continue;
    const owned = descriptor.labels.includes(internals.poolOwnedLabel);
    if (!owned) {
      // Not ours: NEVER destroy.
      continue;
    }
    internals.logEvent({
      event: "worker_pool_reconcile_destroy_unknown",
      workerId: descriptor.workerId,
    });
    try {
      await internals.driver.destroy(descriptor, {
        timeoutMs: internals.settings.acquireTimeoutMs,
        reason: "orphan",
      });
    } catch (error) {
      internals.logEvent({
        event: "worker_pool_destroy_failed",
        workerId: descriptor.workerId,
        error: errorMessage(error),
      });
    }
  }

  // pool-has / driver-lacks: mark registered-but-missing records DESTROYED.
  for (const record of [...internals.inventory.values()]) {
    if (listedById.has(record.workerId)) continue;
    if (record.state === "DESTROYED" || record.state === "DESTROYING") continue;
    // A worker still mid-provision may legitimately not appear in list() yet; only
    // reconcile away records the pool already considers live/idle.
    if (record.state === "PROVISIONING" || record.state === "WARMING") continue;
    // A worker created on a now-detached driver (it carries the `originDriver` a
    // swapDriver stamped) is NOT expected in the LIVE driver's list() - it lives
    // on the OLD backend and is torn down on its origin when its lease settles. An
    // in-flight lease likewise owns its worker's teardown (and a truly-dead one is
    // handled by the orphan reaper / eventual-consistency retry). Reconciling either
    // away here would drop the record so the later settle no-ops on a DESTROYED worker
    // and `originDriver.destroy()` is never called - leaking the paid machine.
    if (record.originDriver !== undefined || record.inFlight > 0) continue;
    internals.logEvent({ event: "worker_pool_reconcile_missing", workerId: record.workerId });
    await internals.mutexFor(record.workerId).runExclusive(async () => {
      record.state = "DESTROYED";
      record.inFlight = 0;
      record.leaseId = null;
      internals.inventory.delete(record.workerId);
      // The body is synchronous; awaiting a resolved promise satisfies the
      // mutex's Promise-returning contract without a meaningless async hop.
      await Promise.resolve();
    });
  }
}

/**
 * Force-returns orphaned leases. A LEASED worker whose last heartbeat is older than
 * `staleHeartbeatMs` AND whose run is gone is an orphan: its lease is cleared,
 * `inFlight` zeroed, and the worker recycled (a worker that hosted an orphan is not
 * trusted). The "run is gone" check is `!isRunActive(record)`, which in the LIVE
 * pool is always false (an un-settled in-flight lease == an active run in-process),
 * so this NEVER force-returns a LEASED worker from the live pool - that would kill a
 * legitimate long single turn that emits no heartbeat. The branch is exercised only
 * by the unit tests that inject `isRunActive: () => false`; real cross-restart
 * orphans are recovered by `hydrate`. Runs inside the per-worker mutex so a racing
 * late release cannot underflow.
 */
async function reapOrphans(internals: ReaperInternals): Promise<void> {
  const now = internals.now();
  const stale = internals.settings.staleHeartbeatMs;
  for (const record of [...internals.inventory.values()]) {
    if (record.state !== "LEASED") continue;
    if (record.inFlight <= 0) continue;
    if (now - record.lastHeartbeatMs < stale) continue;
    // Stale heartbeat: in the live pool the run is always still active, so this is
    // a no-op there; a unit-injected `false` predicate exercises the force-return.
    if (internals.isRunActive(record)) continue;
    await internals.mutexFor(record.workerId).runExclusive(async () => {
      // Re-check inside the mutex: a release may have settled while we queued.
      if (record.state === "DESTROYED" || record.inFlight <= 0) return;
      internals.logEvent({ event: "worker_pool_orphan_reaped", workerId: record.workerId });
      record.inFlight = 0;
      record.leaseId = null;
      record.leaseIssues?.clear();
      await internals.destroyWorker(record, "orphan");
    });
  }
}

/**
 * ttl/idle reaping above the `min` floor. WARM_IDLE workers past their ttl or idle
 * window are destroyed oldest-first while staying at or above `min`. A LEASED worker
 * past its ttl is only FLAGGED `markedForDestroy` (never yanked mid-run); the
 * pool's lease-settle recycles it the instant its last lease returns. A worker that
 * is ALREADY flagged and idle is recycled here too.
 */
async function reapTtlAndIdle(internals: ReaperInternals): Promise<void> {
  const now = internals.now();
  const { ttlMs, idleReapMs, min } = internals.settings;

  // Flag LEASED workers past ttl (and recycle any already-flagged idle worker).
  for (const record of internals.inventory.values()) {
    if (record.state === "LEASED" && now - record.createdAtMs >= ttlMs) {
      record.markedForDestroy = true;
    }
  }

  // Candidate idle workers to reap, oldest-idle first so the freshest survivors are
  // the ones kept toward `min`.
  const idle = [...internals.inventory.values()]
    .filter((record) => record.state === "WARM_IDLE" && record.inFlight === 0)
    .sort((a, b) => a.lastIdleAtMs - b.lastIdleAtMs);

  let liveAbove = internals.liveWorkerCount();
  for (const record of idle) {
    const ttlExpired = now - record.createdAtMs >= ttlMs;
    const idleExpired = now - record.lastIdleAtMs >= idleReapMs;
    const flagged = record.markedForDestroy;
    if (!ttlExpired && !idleExpired && !flagged) continue;
    // Respect the min floor: never reap below `min` live workers (a flagged worker is
    // still reaped because the operator/ttl explicitly wants it gone).
    if (!flagged && liveAbove <= min) continue;
    const reason: TeardownReasonInternal = ttlExpired ? "ttl" : "idle";
    await internals.mutexFor(record.workerId).runExclusive(async () => {
      if (record.state !== "WARM_IDLE" || record.inFlight !== 0) return;
      await internals.destroyWorker(record, reason);
    });
    liveAbove -= 1;
  }
}

/**
 * Probe-demotes unhealthy idle workers. EVERY WARM_IDLE worker (inFlight 0) that
 * survived the ttl/idle reaping above is probed for readiness each tick; a failing
 * probe demotes it to DEGRADED and then tears it down (a dead worker serves no leases).
 * Only idle workers are probed, so a live run is never disturbed by a readiness check.
 */
async function reapUnhealthy(internals: ReaperInternals): Promise<void> {
  for (const record of [...internals.inventory.values()]) {
    if (record.state !== "WARM_IDLE" || record.inFlight !== 0) continue;
    let health: { ok: boolean };
    try {
      health = await internals.driver.probe(descriptorOf(record), {
        timeoutMs: internals.settings.acquireTimeoutMs,
      });
    } catch (error) {
      health = { ok: false };
      internals.logEvent({
        event: "worker_pool_probe_failed",
        workerId: record.workerId,
        error: errorMessage(error),
      });
    }
    if (health.ok) continue;
    await internals.mutexFor(record.workerId).runExclusive(async () => {
      if (record.state !== "WARM_IDLE" || record.inFlight !== 0) return;
      record.state = "DEGRADED";
      internals.logEvent({ event: "worker_pool_degraded", workerId: record.workerId });
      await internals.destroyWorker(record, "unhealthy");
    });
  }
}

/**
 * Tops up the warm inventory toward the higher of `min` and `warm`, one worker at a
 * time, ONLY while the spend budget allows. Capped by `max` via `hasGrowthBudget`
 * / the pool's own headroom check inside `provisionWarm`.
 */
async function topUp(internals: ReaperInternals): Promise<void> {
  // Hold top-up until the first hydrate has adopted any driver survivors, but ONLY
  // for a driver that actually OWNS survivors (paid: usesLedger / ephemeral). The
  // ctor arms the reaper before `hydrate()` runs, so a pre-hydrate tick sees an empty
  // in-memory inventory even while paid survivors still exist at the backend - topping
  // up now would provision DUPLICATES and overshoot warm/max (a paid driver that
  // cannot hydrate fails startup loudly, so reaching steady state implies hydrated).
  // A non-paid driver (fake / static-ssh) owns no survivors and need not wait on a
  // one-time list(), so it warms immediately regardless of `hydrated`.
  const caps = internals.driver.capabilities;
  if (!internals.hydrated() && (caps.usesLedger || caps.ephemeral)) return;

  const target = Math.max(internals.settings.min, internals.settings.warm);
  // Bound attempts to the size of the gap so a persistently-failing provision
  // (which never adds a worker) cannot spin the tick forever; the next tick retries.
  let attempts = Math.max(0, target - internals.liveWorkerCount());
  while (attempts > 0 && internals.liveWorkerCount() < target) {
    if (!internals.hasGrowthBudget()) {
      internals.logEvent({ event: "worker_pool_topup_budget_blocked" });
      return;
    }
    await internals.provisionWarm();
    attempts -= 1;
  }
}

/** Reconstructs a WorkerDescriptor from a record for driver probe/destroy calls. */
function descriptorOf(record: WorkerRecord): WorkerDescriptor {
  return {
    workerId: record.workerId,
    workerHost: record.workerHost,
    driverRef: record.driverRef,
    createdAtMs: record.createdAtMs,
    labels: record.labels,
    metadata: record.metadata,
  };
}

/** Extracts a stable message from an unknown thrown value for structured logs. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
