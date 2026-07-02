import { randomUUID } from "node:crypto";

import {
  defaultWorkerDriverRegistry,
  POOL_OWNED_LABEL,
  type WorkerDescriptor,
  type WorkerDriver,
  type WorkerDriverRegistry,
  type DriverDeps,
  type TeardownReason,
} from "@lorenz/worker-sdk";
import type { WorkerPoolSettings } from "@lorenz/domain";
import type { ClockPort, TimerHandle } from "@lorenz/domain";
import { runSsh } from "@lorenz/ssh";

import { createLedger, type Ledger } from "./ledger.js";
import { createLease } from "./lease.js";
import { createMutex } from "./mutex.js";
import { runReaperTick, type ReaperInternals } from "./reaper.js";
import type {
  AcquireRequest,
  AcquireResult,
  WorkerLease,
  WorkerOutcome,
  WorkerPool,
  WorkerPoolSnapshot,
  WorkerRecord,
  WorkerState,
  LedgerRow,
  Mutex,
} from "./types.js";

/**
 * Dependencies the pool factory receives. Deliberately excludes any workspace or
 * hook deps: the pool owns worker lifecycle only (the runner owns workspaces). The
 * `ledgerPath` is optional and only consulted when the resolved driver's
 * `capabilities.usesLedger` is true (cloud); a purely in-memory driver does zero
 * fs I/O.
 */
export interface CreateWorkerPoolDeps {
  clock: ClockPort;
  logEvent: (event: Record<string, unknown>) => void;
  ledgerPath?: string;
  /**
   * Worker-driver registry the pool resolves `settings.driver` against. The
   * composition root registers driver extensions and passes its registry here;
   * absent, the pool falls back to the process-wide
   * {@link defaultWorkerDriverRegistry}.
   */
  drivers?: WorkerDriverRegistry | undefined;
}

/**
 * Resolves the configured driver kind through the registry and constructs the
 * driver from the operator's `driverOptions`. The pool is the engine boundary
 * that owns the real ssh dependency: drivers only ever see the injected
 * {@link DriverDeps.runSsh}, never `@lorenz/ssh` itself. Throws the registry's
 * `worker_pool_driver_unavailable` error for an unregistered kind (so the daemon
 * fails loud at startup), and surfaces the factory's own validation error for
 * unusable `driverOptions` at the same fail-loud construction point.
 */
function resolveDriver(settings: WorkerPoolSettings, deps: CreateWorkerPoolDeps): WorkerDriver {
  const factory = (deps.drivers ?? defaultWorkerDriverRegistry).require(settings.driver);
  const driverDeps: DriverDeps = {
    clock: deps.clock,
    logEvent: deps.logEvent,
    runSsh,
  };
  return factory.create(settings.driverOptions ?? {}, driverDeps);
}

/**
 * Bounded retry budget for the authoritative `driver.list()` call on
 * {@link WorkerPoolImpl.hydrate}. A transient driver blip must not be mistaken for a
 * successful (empty) startup, so the list is re-attempted this many times with a
 * short clock-driven backoff before the pool gives up.
 */
const HYDRATE_LIST_ATTEMPTS = 3;
/** Base backoff (ms) between hydrate `list()` retries; multiplied by the attempt. */
const HYDRATE_LIST_BACKOFF_MS = 50;

/**
 * A freshly-provisioned worker is probed for SSH-readiness up to this many times
 * before a grow / warm top-up gives up on it (a cold cloud worker's sshd may lag the
 * provision return). An already-up host (static-ssh) or the fake probes ok on the
 * first attempt, so the retry only engages for a genuinely cold worker.
 */
const PROBE_READY_ATTEMPTS = 3;
/** Base backoff (ms) between readiness probes; multiplied by the attempt. */
const PROBE_READY_BACKOFF_MS = 50;

/** UTC calendar-day key (YYYY-MM-DD) used to roll the daily spend accumulator. */
function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Worker states that count as live for capacity/spend accounting. */
function isLive(state: WorkerState): boolean {
  return state !== "DESTROYED" && state !== "DESTROYING" && state !== "DRAINING";
}

/** A worker that can serve a fresh lease (idle, healthy, not slated for teardown). */
function isLeasable(record: WorkerRecord, slotsPerMachine: number): boolean {
  if (record.markedForDestroy) return false;
  if (record.state !== "WARM_IDLE" && record.state !== "LEASED") return false;
  return record.inFlight < slotsPerMachine;
}

/**
 * A blocked acquire parked on the FIFO waiter queue. Resolved either by a freed
 * worker (release/reconcile), by the acquireTimeout firing, or by the request's
 * abort signal. `settled` guards the single resolution.
 */
interface Waiter {
  req: AcquireRequest;
  settled: boolean;
  resolve: (result: AcquireResult) => void;
  timer: TimerHandle;
  cleanupAbort: (() => void) | null;
}

/**
 * The embedded warm worker pool. A long-lived, reload-surviving singleton that
 * produces each run's `workerHost`. It owns the synchronous select-and-stamp
 * path, RESERVATION-based single-flight growth, the FIFO waiter queue, spend
 * accounting, `maxInFlight`, `maxWorkersPerIssue`, sticky affinity, the recurring
 * reaper timer, and the awaitable `reconcile`/`hydrate`/`drain`/`snapshot`
 * surface. `reconcile` diffs prev-vs-next settings (resize toward min/max,
 * deferring shrink to the reaper oldest-idle-first, never reconstructing the
 * object and never destroying a leased worker synchronously); `hydrate` re-adopts
 * survivors from `driver.list()` + the ledger and drops orphan rows; `drain`
 * rejects new acquires then force-destroys every worker so no paid cloud worker leaks.
 */
class WorkerPoolImpl implements WorkerPool {
  // The authoritative in-memory inventory, keyed on the pool's idempotency key.
  private readonly inventory = new Map<string, WorkerRecord>();

  // One async mutex per worker so a release and a reaper tick can never both mutate
  // the same record's `inFlight`/state (the reaper-vs-release race fix).
  private readonly workerMutexes = new Map<string, Mutex>();

  // FIFO queue of blocked acquires. A freed worker wakes the oldest compatible
  // waiter first, providing basic fairness.
  private readonly waiters: Waiter[] = [];

  // Callbacks the pool fires INSIDE the per-worker mutex immediately before it
  // destroys a machine (the single `recycle` chokepoint), so the dispatch
  // coordinator can fail any still-open RunSlot bound to that worker CLEANLY before
  // the host dies (the recycle-vs-endpoint ordering invariant). Each callback is
  // invoked at most once per worker teardown and its errors are swallowed so a
  // misbehaving listener can never block the destroy it precedes.
  private readonly recyclingCallbacks: Array<(workerId: string) => void> = [];

  // Callbacks fired AFTER a waiter wake-up pass whenever capacity is still
  // leasable (see onCapacityAvailable). The runtime registers its poll nudge
  // here; errors are swallowed so a misbehaving listener can never break the
  // settle/reconcile path that freed the capacity.
  private readonly capacityAvailableCallbacks: Array<() => void> = [];

  // Synchronous capacity reservation taken BEFORE any provision await, so two
  // concurrent growth decisions cannot both allocate past `max`. Incremented in
  // the same synchronous tick the growth is decided; released on settle/reject.
  private reservedProvisions = 0;

  // Per-issue grow reservations taken synchronously the instant a grow for an
  // issue is decided (and before its provision await), so two concurrent grows
  // for the SAME issue cannot both slip past `maxWorkersPerIssue` while neither has
  // landed in inventory yet. Counted alongside `leaseIssues` in the issue caps;
  // decremented in `grow`'s finally.
  private readonly reservedProvisionsByIssue = new Map<string, number>();

  // Worker ids whose provision is in flight (added before the provision await,
  // removed in grow/provisionWarm's finally). The worker exists at the backend -
  // labeled pool-owned and visible to `driver.list()` - before it lands in
  // inventory, so the reaper's destroy-unknown reconcile consults this set to
  // avoid reaping a mid-provision worker as a leaked orphan.
  private readonly pendingProvisionIds = new Set<string>();

  // Process-lifetime + daily worker-second accumulators. `dayKey` rolls on UTC day
  // change. The daily total is seeded from the ledger sidecar on hydrate (T10).
  private workerSecondsUsed = 0;
  private dailyWorkerSecondsUsed = 0;
  private dayKey: string;

  // Monotonic sequence for deterministic worker ids (so the fake driver's
  // idempotency key and the test assertions are reproducible).
  private workerSeq = 0;

  // Once true the pool rejects new acquires and force-destroys all workers. Set by
  // `drain`; never cleared (drain is terminal for the process).
  private draining = false;
  private drainPromise: Promise<void> | null = null;
  // Monotonic drain generation. Captured at the start of each `runDrain`; the
  // deadline barrier and the force-destroy loop bail (without destroying live
  // workers) when the epoch they captured no longer matches `drainEpoch` OR
  // `draining` has been cleared. A reconcile RE-ENABLE bumps this epoch so an
  // orphaned drain parked on its deadline cannot force-destroy the workers a
  // re-enabled (now-live) pool just grew.
  private drainEpoch = 0;
  // Resolved by `onLeaseSettle` the moment `inFlight` reaches zero while draining,
  // so `drain` proceeds without busy-polling the clock (which a fake clock never
  // advances). Raced against a deadline timer inside `runDrain`.
  private notifyDrained: (() => void) | null = null;

  private driver: WorkerDriver;
  // Monotonic driver generation, bumped by `swapDriver` on every driver
  // hot-reload. A grow / warm-provision CAPTURES this (and `this.driver`) BEFORE
  // its provision await; if the generation has advanced by the time provision
  // returns, a swap happened DURING the await, so the new worker was provisioned on the
  // now-stale driver. The pool then records its origin as the CAPTURED driver
  // (so recycle destroys it on the backend that actually created it) and marks it
  // for destroy (it cannot serve the live driver). Without this, a worker provisioned
  // on driver A but inserted after a swap to B would be recorded under B with no
  // origin, so recycle/destroy routes to B and A's paid machine leaks.
  private driverGeneration = 0;
  private ledger: Ledger;
  private readonly clock: ClockPort;
  private readonly logEvent: (event: Record<string, unknown>) => void;
  private readonly leaseClock: { now(): number };
  // The recurring reaper timer. Re-armed at the end of each tick so the single
  // serial pass runs at the configured cadence. Detached via `unref?.()` so it
  // never keeps the process alive (systemClock.setTimeout never unrefs on its
  // own). Cleared on drain so a stopped pool issues no further ticks.
  private reaperTimer: TimerHandle | null = null;
  private reaperStopped = false;
  // True once `hydrate()` has completed at least once. The constructor arms the
  // reaper before `hydrate()` runs, so until the first hydrate re-adopts the
  // labeled survivors from `driver.list()`, the reaper's destroy-unknown branch
  // must stay inert or it would reap the pool's own survivors on restart.
  private hydrated = false;
  private readonly reaperInternals: ReaperInternals;
  // The deps used to resolve the driver in the ctor. Retained so `swapDriver`
  // can re-run `resolveDriver` (and rebuild the ledger gate) in place on a
  // driver hot-reload WITHOUT reconstructing the pool singleton.
  private readonly deps: CreateWorkerPoolDeps;

  constructor(
    private settings: WorkerPoolSettings,
    deps: CreateWorkerPoolDeps,
  ) {
    this.deps = deps;
    this.clock = deps.clock;
    this.logEvent = deps.logEvent;
    this.driver = resolveDriver(settings, deps);
    this.ledger = createLedger({
      ledgerPath: deps.ledgerPath ?? "",
      clock: deps.clock,
      usesLedger: this.driver.capabilities.usesLedger && deps.ledgerPath !== undefined,
    });
    // The lease/heartbeat clock works in milliseconds while the ClockPort yields
    // a Date; adapt once so leases see a plain numeric clock.
    this.leaseClock = { now: () => this.clock.now().getTime() };
    this.dayKey = utcDayKey(this.clock.now());

    // The narrow seam the reaper drives over. Every primitive routes back through
    // the pool's per-worker mutex so a reaper tick and a lease release can never both
    // touch the same `inFlight`.
    this.reaperInternals = {
      settings: this.settings,
      driver: this.driver,
      poolOwnedLabel: POOL_OWNED_LABEL,
      now: () => this.leaseClock.now(),
      inventory: this.inventory,
      mutexFor: (workerId: string) => this.mutexFor(workerId),
      liveWorkerCount: () => this.liveWorkerCount(),
      // In-process invariant: a lease is settled exactly once, only in `runClaim`'s
      // finally (release/fail), so an UN-settled in-flight lease always implies an
      // active run. The reaper therefore treats every in-flight lease as alive and
      // never force-returns a LEASED worker from the live pool (that would kill a
      // legitimate long single-turn run that emits no heartbeat). Orphan recovery
      // after a process restart is handled separately by `hydrate`, which re-adopts
      // only the survivors `driver.list()` still shows and drops orphan rows.
      isRunActive: () => true,
      hydrated: () => this.hydrated,
      pendingProvisionIds: () => this.pendingProvisionIds,
      hasGrowthBudget: () => this.hasGrowthHeadroom(),
      destroyWorker: async (record: WorkerRecord, reason: TeardownReason) =>
        this.recycle(record, reason),
      provisionWarm: async () => this.provisionWarm(),
      logEvent: this.logEvent,
      wakeWaiters: () => this.wakeWaiters(),
    };

    // Single serial recurring reaper timer, detached so it never keeps the
    // process alive. The tick re-arms itself at the configured cadence.
    this.scheduleReaper();
  }

  // --- public API ---------------------------------------------------------

  async acquire(req: AcquireRequest): Promise<AcquireResult> {
    if (!this.settings.enabled || this.draining) {
      return { status: "no_capacity", reason: "pool_disabled" };
    }

    this.rollDayKeyIfNeeded();

    // Spend gate: once worker-seconds (total or daily) are exhausted the pool runs
    // nothing further, even reusing a warm worker, until the cap resets.
    if (this.workerSecondsExhausted()) {
      return { status: "no_capacity", reason: "spend_cap" };
    }

    // 1) Synchronous select-and-stamp over a free/under-capacity worker. No await
    //    between selecting the record and stamping it, so two concurrent acquires
    //    can never grab the same slot.
    const selected = this.selectAndStamp(req);
    if (selected) {
      return { status: "leased", lease: selected };
    }

    // 2) Grow under the reservation, if capacity and spend allow.
    if (this.canGrow(req)) {
      const grown = await this.grow(req);
      if (grown.status === "leased") return grown;
      // A growth that failed for capacity/spend reasons falls through to the
      // waiter queue; a driver_error with nothing to wait on is returned.
      if (grown.status === "no_capacity" && grown.reason === "driver_error") {
        return grown;
      }
    } else if (this.blockedBySpendCap()) {
      // A worker could not be selected and growth is barred specifically by a spend
      // cap (concurrent workers). Surface spend_cap now rather than holding the
      // poll thread on a waiter the budget can never satisfy.
      return { status: "no_capacity", reason: "spend_cap" };
    }

    // 3) Block on the FIFO waiter queue until a worker frees, the timeout fires, or
    //    the request is aborted.
    return this.waitForCapacity(req);
  }

  canAcquire(): boolean {
    if (!this.settings.enabled || this.draining) return false;
    this.rollDayKeyIfNeeded();
    if (this.workerSecondsExhausted()) return false;
    // A warm/under-capacity worker is immediately leasable.
    for (const record of this.inventory.values()) {
      if (isLeasable(record, this.settings.slotsPerMachine)) return true;
    }
    // Otherwise capacity exists only if the pool can still grow a worker.
    return this.hasGrowthHeadroom();
  }

  /**
   * Whether the pool currently governs worker-host capacity. A config reload can disable the pool
   * (which drains it to zero) without tearing down the orchestrator's lifetime capacity probe; the
   * probe reads this so a disabled pool falls through to static/local execution instead of
   * permanently blocking dispatch. Mirrors `settings.enabled` (swapped in by `reconcile`).
   */
  isEnabled(): boolean {
    return this.settings.enabled;
  }

  /**
   * Diffs prev-vs-next settings on a config hot-reload and reconciles the live
   * pool WITHOUT being reconstructed (the singleton survives every reload):
   *
   *  - `enabled true -> false`: drain to zero (paid workers must not linger).
   *  - `enabled false -> true`: grow from zero toward the warm/min target.
   *  - lowering `max` (or any live overshoot of the new `max`): defer the shrink
   *    to the reaper, marking the OLDEST-IDLE excess workers `markedForDestroy`
   *    (the reaper reaps a flagged idle worker on its next tick, and a flagged
   *    LEASED worker is recycled the instant its last lease returns). Leased workers
   *    are NEVER destroyed synchronously here.
   *  - raising `min`/`warm`: top up toward the new target within the spend budget.
   *
   * Settings are swapped in first so every subsequent acquire / reaper tick reads
   * the latest knobs (the reaper re-syncs `internals.settings` each tick anyway).
   */
  reconcile(next: WorkerPoolSettings): void {
    const prev = this.settings;

    if (!next.enabled) {
      // Disabling the pool drains it to zero, so it needs NO (re)built driver:
      // SKIP the swap entirely. A disable reload that ALSO points at an unavailable
      // driver (or drops the static-ssh hosts so construction would throw) must
      // still disable + drain - never throw inside `swapDriver` and strand the
      // live pool enabled with paid workers still running. The drain tears every worker
      // down on the driver that PROVISIONED it (its origin), not the new one.
      this.settings = next;
      this.reaperInternals.settings = next;
      void this.drain({ deadlineMs: next.drainDeadlineMs });
      return;
    }

    // Finding #1: rebuild the driver in place BEFORE the settings swap when the
    // driver construction actually changed (a new kind or deep-changed
    // driverOptions). A same-driver reconcile skips the swap (no rebuild),
    // keeping the singleton's resolved driver object stable. Once the coordinator
    // exists it will drive `swapDriver`; until then `reconcile` drives it directly.
    if (driverConstructionChanged(prev, next)) {
      this.swapDriver(next);
    }

    this.settings = next;
    this.reaperInternals.settings = next;

    // A re-enabled pool (false -> true) starts from zero; the grow-toward-target
    // path below covers it (a disabled pool was drained to zero, so live==0). The
    // prior disable set `draining`/`reaperStopped` via `drain`; a re-enable must
    // clear them (and re-arm the reaper) or the pool stays permanently dead -
    // every acquire short-circuits on `draining` and no reaper top-up ever runs.
    if (!prev.enabled) {
      this.draining = false;
      this.drainPromise = null;
      this.notifyDrained = null;
      // Invalidate any drain still parked on its deadline barrier. Its captured
      // epoch is now stale, so its force-destroy loop will bail instead of
      // tearing down the workers this re-enable is about to grow.
      this.drainEpoch += 1;
      if (this.reaperStopped) {
        this.reaperStopped = false;
        this.scheduleReaper();
      }
    }

    // Defer any shrink toward a lowered `max` to the reaper, oldest-idle first.
    this.markExcessForShrink();

    // Grow toward the (possibly raised) warm/min target within the spend budget.
    void this.growTowardTarget();
  }

  /**
   * Rebuilds the resolved driver IN PLACE on a driver hot-reload, without
   * reconstructing the pool singleton (Finding #1). The pool's ctor resolved the
   * driver once, but `reconcile` previously only swapped settings, so a reload
   * that changed `driver`/`driverOptions` left every acquire still routed to
   * the stale driver object.
   *
   * TRANSACTIONAL: every step that can THROW (resolving the new driver and
   * constructing its ledger) runs FIRST, into locals, BEFORE any record or
   * `this.driver` is mutated. A failed reload (driver unavailable / invalid
   * driverOptions) therefore throws having mutated NOTHING, matching the
   * runtime's rollback to the last-good settings: marking last-good workers for
   * destroy and THEN throwing would let `onLeaseSettle`/the reaper drain healthy
   * warm/paid capacity after a REJECTED reload (Codex iter-6 HIGH). Once resolve
   * succeeds (the commit point), the remaining steps cannot throw. `swapDriver`:
   *
   *  1. CAPTURES `originDriver` on EVERY existing record BEFORE reassigning, so
   *     each surviving worker remembers the backend that PROVISIONED it. This is the
   *     no-orphaned-paid-worker invariant: an in-flight lease that settles AFTER the
   *     swap routes `recycle`'s `destroy` to its ORIGINAL backend (below), not the
   *     new `this.driver`. A record that already carries an `originDriver` (a
   *     prior swap) keeps it (the true origin), so repeated swaps never lose it.
   *  2. flags every old-driver worker `markedForDestroy` and recycles each IDLE one
   *     immediately (under its per-worker mutex) against its ORIGINAL backend, so no
   *     paid worker is orphaned and the new driver's `list()` reconcile never sees a
   *     stale old worker it does not own. A still-LEASED old worker keeps the flag and is
   *     recycled on its ORIGINAL backend the instant its last lease settles
   *     (`onLeaseSettle` -> `recycle`, which routes to `originDriver`).
   *  3. commits the pre-resolved driver (`this.driver = newDriver`).
   *  4. re-threads `reaperInternals.driver` to the new driver so the recurring
   *     reaper's `list()` reconcile / probe / top-up drive the new backend.
   *  5. rebuilds the ledger `usesLedger` gate against the new driver's
   *     capabilities (e.g. non-ledger -> ledger) WITHOUT reconstructing the spend
   *     accumulators, which live on the pool and are untouched.
   *
   * Called by `reconcile` only when {@link driverConstructionChanged} is true.
   */
  swapDriver(next: WorkerPoolSettings): void {
    // TRANSACTIONAL: do ALL throwing work (resolveDriver, and constructing the
    // new ledger) into LOCALS BEFORE mutating ANY record or `this.driver`. A
    // failed reload (driver unavailable / invalid driverOptions) must throw
    // having mutated NOTHING, so the runtime's transactional rollback to the
    // last-good settings is matched by an UNTOUCHED inventory: marking workers for
    // destroy before this throws would let `onLeaseSettle` recycle healthy
    // in-flight leases and the reaper reap idle workers, draining warm/paid capacity
    // after a REJECTED reload. (Codex iter-6 HIGH.)
    const newDriver = resolveDriver(next, this.deps);
    const newLedger = createLedger({
      ledgerPath: this.deps.ledgerPath ?? "",
      clock: this.deps.clock,
      usesLedger: newDriver.capabilities.usesLedger && this.deps.ledgerPath !== undefined,
    });

    // --- COMMIT POINT: resolve succeeded, so from here NOTHING throws. ---------

    // 1) Capture the origin driver on every existing record BEFORE reassigning
    //    `this.driver`, and flag each for drain so it is recycled on its origin.
    const idleToRecycle: WorkerRecord[] = [];
    for (const record of this.inventory.values()) {
      record.originDriver = record.originDriver ?? this.driver;
      record.markedForDestroy = true;
      // An idle (un-leased) old-driver worker cannot serve the new driver and the
      // new driver's list() will not own it, so recycle it now against its origin
      // rather than deferring to a reaper that would otherwise drop it un-destroyed.
      if (isLive(record.state) && record.inFlight === 0 && record.state !== "DESTROYING") {
        idleToRecycle.push(record);
      }
    }

    // 3) Commit the pre-resolved driver in place, and bump the driver
    //    generation so any in-flight grow / warm-provision that captured the PRIOR
    //    generation before its provision await detects the swap when it returns
    //    (and records its worker's origin as the captured driver).
    this.driver = newDriver;
    this.driverGeneration += 1;

    // 4) Re-thread the reaper's driver so its list()/probe/top-up drive the new
    //    backend (the reaper reads `reaperInternals.driver`, not `this.driver`).
    this.reaperInternals.driver = this.driver;

    // 5) Commit the pre-built ledger gate (rebuilt against the new driver's
    //    `usesLedger` capability). The pool's spend accumulators are unaffected
    //    (they live on the pool, not the ledger object).
    this.ledger = newLedger;

    // 2 (deferred async, fire-and-forget like reconcile's grow/drain): recycle each
    //    idle old-driver worker on its ORIGINAL backend under its per-worker mutex, then
    //    wake any waiters so the freed capacity refills from the NEW driver.
    if (idleToRecycle.length > 0) {
      void (async () => {
        for (const record of idleToRecycle) {
          await this.mutexFor(record.workerId).runExclusive(async () => {
            if (record.inFlight !== 0) return; // a lease landed first; settle recycles it
            await this.recycle(record, "shrink");
          });
        }
        this.wakeWaiters();
      })();
    }
  }

  /**
   * Registers a callback the pool fires INSIDE the per-worker mutex immediately
   * before it destroys a machine. Every teardown path routes through the single
   * {@link recycle} chokepoint, so the callback fires exactly once per worker just
   * before `driver.destroy`. The dispatch coordinator registers a callback here
   * to fail any still-open RunSlot on the recycled worker CLEANLY before the host
   * dies (the recycle-vs-endpoint ordering invariant). A callback error is
   * swallowed so a misbehaving listener can never block the teardown it precedes.
   */
  onMachineRecycling(cb: (workerId: string) => void): void {
    this.recyclingCallbacks.push(cb);
  }

  /**
   * Registers a callback fired whenever a capacity-freeing event leaves the pool
   * leasable (see {@link WorkerPool.onCapacityAvailable}). Fired at the end of every
   * waiter wake-up pass - a lease settle, a reconcile grow, a reaper top-up -
   * AFTER the FIFO waiters had first claim on the freed worker, and only when
   * `canAcquire()` still holds, so a drained/disabled/spend-capped pool never
   * notifies.
   */
  onCapacityAvailable(cb: () => void): void {
    this.capacityAvailableCallbacks.push(cb);
  }

  /** Notifies every {@link onCapacityAvailable} listener; errors are swallowed. */
  private notifyCapacityAvailable(): void {
    if (this.capacityAvailableCallbacks.length === 0) return;
    if (!this.canAcquire()) return;
    for (const cb of this.capacityAvailableCallbacks) {
      try {
        cb();
      } catch (error) {
        this.logEvent({
          event: "worker_pool_capacity_callback_failed",
          error: errorMessage(error),
        });
      }
    }
  }

  /**
   * Notifies every registered {@link onMachineRecycling} callback that `workerId` is
   * about to be destroyed. Called once at the top of {@link recycle} (inside the
   * per-worker mutex, before `driver.destroy`). Each callback's error is caught and
   * logged so one bad listener can never block the teardown or starve the others.
   */
  private notifyMachineRecycling(workerId: string): void {
    for (const cb of this.recyclingCallbacks) {
      try {
        cb(workerId);
      } catch (error) {
        this.logEvent({
          event: "worker_pool_recycling_callback_failed",
          workerId,
          error: errorMessage(error),
        });
      }
    }
  }

  /**
   * Flags the OLDEST excess workers for destruction when the live count exceeds the
   * current `max`. Idle workers are preferred (so a shrink frees capacity without
   * disturbing a run) and ordered oldest-idle-first; only when no idle worker remains
   * does it fall back to flagging a LEASED worker, which is recycled on lease return
   * (never destroyed synchronously). The actual teardown is the reaper's job.
   */
  private markExcessForShrink(): void {
    const max = this.settings.max;
    const live = [...this.inventory.values()].filter(
      (record) => isLive(record.state) && !record.markedForDestroy,
    );
    let excess = live.length - max;
    if (excess <= 0) return;

    // Oldest-idle first: idle workers before leased, each group oldest-idle-first.
    const ordered = [...live].sort((a, b) => {
      const aIdle = a.state === "WARM_IDLE" && a.inFlight === 0 ? 0 : 1;
      const bIdle = b.state === "WARM_IDLE" && b.inFlight === 0 ? 0 : 1;
      if (aIdle !== bIdle) return aIdle - bIdle;
      return a.lastIdleAtMs - b.lastIdleAtMs;
    });

    for (const record of ordered) {
      if (excess <= 0) break;
      record.markedForDestroy = true;
      excess -= 1;
    }
  }

  /**
   * Provisions warm workers one at a time toward the higher of `min`/`warm`, within
   * the `max` ceiling and the spend budget (the reservation inside `provisionWarm`
   * enforces both). Fire-and-forget from `reconcile` so a reload never blocks; a
   * failed provision is logged and swallowed inside `provisionWarm` and retried by
   * the recurring reaper top-up.
   */
  private async growTowardTarget(): Promise<void> {
    const target = Math.max(this.settings.min, this.settings.warm);
    let attempts = Math.max(0, target - (this.liveWorkerCount() + this.reservedProvisions));
    while (attempts > 0 && this.liveWorkerCount() + this.reservedProvisions < target) {
      if (!this.hasGrowthHeadroom()) break;
      await this.provisionWarm();
      attempts -= 1;
    }
    this.wakeWaiters();
  }

  /**
   * Re-adopts survivors on daemon startup so a restart does not leak the workers a
   * prior process created. The reconcile is authoritative on `driver.list()`:
   *
   *  1. Seed the daily spend accumulator from the `spend.json` sidecar so a
   *     restart within the same UTC day carries the daily total (a day boundary
   *     resets it). The sidecar is the source of truth for spend, not inventory.
   *  2. Re-adopt every worker `driver.list()` still shows that carries the
   *     pool-owned label into inventory as WARM_IDLE (a fresh process has no
   *     active runs, so a survivor is idle: `inFlight=0`, `leaseId=null`). An
   *     unlabeled instance is never adopted (it is not ours).
   *  3. Force-return orphan ledger rows: a row whose worker the authoritative list
   *     no longer shows is a worker that vanished while the run owning it is gone,
   *     so the row is dropped from the ledger (no phantom inventory survives).
   *
   * Idempotent: a worker already in inventory (e.g. a second hydrate) is left alone.
   */
  async hydrate(): Promise<void> {
    const spend = await this.ledger.loadDailySpend();
    this.dayKey = spend.dayKey;
    this.dailyWorkerSecondsUsed = spend.workerSecondsToday;

    // The ledger replay is advisory; driver.list() is authoritative. A transient
    // list() failure must not wipe inventory, so the re-adopt below only runs once a
    // BOUNDED retry of list() (short clock-driven backoff) finally succeeds.
    const rows = await this.ledger.load();
    const listed = await this.listForHydrate();
    if (listed === null) {
      // list() never recovered. For a driver that owns no paid survivors
      // (non-ledger, non-ephemeral fake / static-ssh) the logged skip is tolerable:
      // there is nothing to leak, so startup proceeds and the reaper reconciles a
      // later tick. `hydrated` deliberately stays false so the reaper's
      // destroy-unknown gate remains closed until a list() actually succeeds.
      return;
    }

    const listedById = new Map<string, WorkerDescriptor>();
    for (const descriptor of listed) listedById.set(descriptor.workerId, descriptor);

    // Re-adopt every labeled-ours survivor the list still shows. A fresh process
    // holds no active runs, so each survivor is re-adopted idle (no lease).
    const now = this.leaseClock.now();
    for (const descriptor of listed) {
      if (this.inventory.has(descriptor.workerId)) continue;
      if (!descriptor.labels.includes(POOL_OWNED_LABEL)) continue;
      this.inventory.set(descriptor.workerId, {
        workerId: descriptor.workerId,
        workerHost: descriptor.workerHost,
        driverRef: descriptor.driverRef,
        state: "WARM_IDLE",
        labels: [...descriptor.labels],
        createdAtMs: descriptor.createdAtMs,
        leaseId: null,
        inFlight: 0,
        lastIdleAtMs: now,
        lastHeartbeatMs: now,
        workerSecondsUsed: 0,
        markedForDestroy: false,
        affinityKey: null,
        metadata: { ...descriptor.metadata },
        leaseIssues: new Map(),
      });
    }

    // Reconcile every ledger row against the authoritative list:
    //  - row whose worker list() still shows: kept (its survivor was re-adopted above).
    //  - PROVISIONAL row with no matching instance YOUNGER than ttlMs: kept. The
    //    prior process crashed mid-provision (the worker may exist at the driver but
    //    not yet be list-visible under eventual consistency), so the recoverable
    //    write-ahead row is retained for a later tick / re-hydrate to correlate.
    //  - any other row with no matching instance (active row whose worker vanished, or
    //    a provisional row older than ttlMs that never materialized): dropped so no
    //    phantom inventory / dead write-ahead row survives the restart.
    const ttlMs = this.settings.ttlMs;
    for (const row of rows) {
      if (listedById.has(row.workerId)) continue;
      if (row.status === "provisional" && now - row.createdAtMs < ttlMs) {
        // A still-recent provisional row: the worker may be in flight / not yet listed.
        continue;
      }
      this.logEvent({ event: "worker_pool_hydrate_orphan_dropped", workerId: row.workerId });
      await this.ledger.delete(row.workerId);
    }

    // Advance the id sequence past any adopted `worker-<n>` survivor so the next
    // grow / warm-provision cannot RE-MINT an id a survivor already owns. Without
    // this, `workerSeq` (which inits at 0) would mint `worker-0` again after adopting a
    // higher-numbered survivor and, once it cycled back through that suffix, stamp
    // a SECOND lease onto a live survivor. Non-numeric ids (e.g. a custom label)
    // carry no numeric suffix and are ignored when computing the high-water mark.
    this.advanceWorkerSeqPastAdopted();

    // The first successful hydrate has now re-adopted every labeled survivor, so
    // the reaper's destroy-unknown reconcile may resume: any labeled-but-unknown
    // survivor a later tick sees is now a genuine leaked orphan, not one this
    // hydrate had simply not adopted yet.
    this.hydrated = true;
  }

  /**
   * Bounded-retry wrapper around `driver.list()` for {@link hydrate}. The
   * authoritative startup reconcile MUST NOT treat a transient `list()` outage as a
   * successful (empty) startup, because a paid (usesLedger / ephemeral) driver may
   * have real survivors a prior process provisioned: swallowing the failure would
   * leave those workers neither adopted (so they never serve a lease) nor reaped (the
   * destroy-unknown gate stays closed because {@link hydrated} never flips) nor
   * visible to drain - unmanaged paid workers leaking past restart.
   *
   *  - Retries `list()` up to {@link HYDRATE_LIST_ATTEMPTS} times with a short
   *    clock-driven backoff between attempts, returning the descriptors on the first
   *    success (the common case: a brief driver blip recovers within a retry).
   *  - If every attempt fails AND the driver owns real survivors
   *    (`capabilities.usesLedger` or `capabilities.ephemeral`), THROWS
   *    `worker_pool_hydrate_failed` so the daemon's `await workerPool.hydrate()` fails
   *    startup LOUDLY instead of running blind over unmanaged paid machines.
   *  - If every attempt fails for a NON-paid driver (fake / static-ssh: no paid
   *    survivors to leak), returns `null` so the caller logs the skip and proceeds
   *    with startup, leaving `hydrated` false (reaper destroy-unknown gate closed)
   *    until a later `list()` succeeds.
   */
  private async listForHydrate(): Promise<WorkerDescriptor[] | null> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= HYDRATE_LIST_ATTEMPTS; attempt += 1) {
      try {
        return await this.driver.list();
      } catch (error) {
        lastError = error;
        this.logEvent({
          event: "worker_pool_hydrate_list_failed",
          attempt,
          maxAttempts: HYDRATE_LIST_ATTEMPTS,
          error: errorMessage(error),
        });
        if (attempt < HYDRATE_LIST_ATTEMPTS) {
          await this.sleep(HYDRATE_LIST_BACKOFF_MS * attempt);
        }
      }
    }

    const caps = this.driver.capabilities;
    if (caps.usesLedger || caps.ephemeral) {
      // A paid driver with potential real survivors: fail startup loud rather than
      // run with unmanaged paid workers that are invisible to adopt / reap / drain.
      this.logEvent({
        event: "worker_pool_hydrate_failed",
        attempts: HYDRATE_LIST_ATTEMPTS,
        error: errorMessage(lastError),
      });
      throw new Error(
        `worker_pool_hydrate_failed: driver.list() failed after ${HYDRATE_LIST_ATTEMPTS} attempts: ${errorMessage(lastError)}`,
      );
    }
    // A non-paid driver owns no survivors to leak: tolerate the skip.
    return null;
  }

  /** Resolves after `delayMs` via the injected clock (used for hydrate backoff). */
  private async sleep(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const handle = this.clock.setTimeout(resolve, delayMs);
      handle.unref?.();
    });
  }

  /**
   * Probes a freshly-provisioned worker until it reports SSH-ready or the bounded
   * attempt budget is spent, enforcing the warm-up contract that a worker is
   * "reachable before it is leased". `provision` returning does NOT guarantee sshd is
   * up on a cold cloud worker (a container driver may only have resolved the published
   * port; a cloud driver may boot asynchronously), so leasing it immediately would hand
   * an unready host to the runner - failing the first run, poisoning the lease, and
   * destroying an otherwise-healthy worker. An already-up host (static-ssh) and the fake
   * probe ok on the first attempt, so this is a single round-trip on the cold path.
   * Probe faults are treated as not-ready (never thrown). Returns false when the worker
   * never becomes ready; the caller destroys it.
   */
  private async probeUntilReady(
    descriptor: WorkerDescriptor,
    driver: WorkerDriver,
  ): Promise<boolean> {
    let lastReason = "not_ready";
    for (let attempt = 1; attempt <= PROBE_READY_ATTEMPTS; attempt += 1) {
      try {
        const health = await driver.probe(descriptor, {
          timeoutMs: this.settings.acquireTimeoutMs,
        });
        if (health.ok) return true;
        lastReason = health.reason;
      } catch (error) {
        lastReason = errorMessage(error);
      }
      if (attempt < PROBE_READY_ATTEMPTS) await this.sleep(PROBE_READY_BACKOFF_MS * attempt);
    }
    this.logEvent({
      event: "worker_pool_worker_unready",
      workerId: descriptor.workerId,
      reason: lastReason,
    });
    return false;
  }

  /**
   * Bumps `workerSeq` to one past the highest numeric suffix among the `worker-<n>` ids
   * currently in inventory. Ids that do not match `worker-<n>` (non-numeric suffix)
   * are skipped. Never lowers the sequence.
   */
  private advanceWorkerSeqPastAdopted(): void {
    let maxSuffix = -1;
    for (const workerId of this.inventory.keys()) {
      const match = /^worker-(\d+)$/.exec(workerId);
      if (!match) continue;
      const suffix = Number.parseInt(match[1]!, 10);
      if (Number.isFinite(suffix) && suffix > maxSuffix) maxSuffix = suffix;
    }
    if (maxSuffix + 1 > this.workerSeq) this.workerSeq = maxSuffix + 1;
  }

  async drain(opts: { deadlineMs: number; signal?: AbortSignal }): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.draining = true;
    this.drainEpoch += 1;
    this.drainPromise = this.runDrain(opts, this.drainEpoch);
    return this.drainPromise;
  }

  snapshot(): WorkerPoolSnapshot {
    let warmIdle = 0;
    let leased = 0;
    let provisioning = 0;
    let degraded = 0;
    let inFlight = 0;
    let concurrentWorkers = 0;
    const workers: Array<{
      workerId: string;
      workerHost: string;
      state: WorkerState;
      inFlight: number;
      markedForDestroy: boolean;
    }> = [];

    for (const record of this.inventory.values()) {
      inFlight += record.inFlight;
      if (isLive(record.state)) concurrentWorkers += 1;
      switch (record.state) {
        case "WARM_IDLE":
          warmIdle += 1;
          break;
        case "LEASED":
          leased += 1;
          break;
        case "PROVISIONING":
        case "WARMING":
          provisioning += 1;
          break;
        case "DEGRADED":
          degraded += 1;
          break;
        default:
          break;
      }
      workers.push({
        workerId: record.workerId,
        workerHost: record.workerHost,
        state: record.state,
        inFlight: record.inFlight,
        markedForDestroy: record.markedForDestroy,
      });
    }

    return {
      enabled: this.settings.enabled,
      driver: this.settings.driver,
      total: this.inventory.size,
      warmIdle,
      leased,
      provisioning,
      degraded,
      inFlight,
      spend: {
        concurrentWorkers,
        workerSecondsUsed: this.workerSecondsUsed,
        dailyWorkerSecondsUsed: this.dailyWorkerSecondsUsed,
        dayKey: this.dayKey,
      },
      workers,
    };
  }

  // --- selection / stamping ----------------------------------------------

  /**
   * Synchronously picks a leasable worker and stamps a lease on it WITHOUT any
   * await in between. Honors sticky affinity (prefer the same worker a retry ran
   * on) and the per-issue fairness cap. Returns null when no in-inventory worker is
   * leasable for this request.
   */
  private selectAndStamp(req: AcquireRequest): WorkerLease | null {
    const record = this.pickRecord(req);
    if (!record) return null;
    return this.stamp(record, req);
  }

  /** Chooses the best leasable record for a request (affinity first). */
  private pickRecord(req: AcquireRequest): WorkerRecord | null {
    const slotsPerMachine = this.settings.slotsPerMachine;

    // Affinity: if a prior workerHost is named and that worker is still leasable,
    // re-land on it so resume continuity holds across a retry.
    if (req.affinityKey) {
      for (const record of this.inventory.values()) {
        if (record.workerHost === req.affinityKey && isLeasable(record, slotsPerMachine)) {
          if (this.issueWouldExceedCap(req, record)) return null;
          return record;
        }
      }
    }

    // Otherwise prefer an idle worker, then any under-capacity worker (slotsPerMachine>1).
    let underCapacity: WorkerRecord | null = null;
    for (const record of this.inventory.values()) {
      if (!isLeasable(record, slotsPerMachine)) continue;
      if (this.issueWouldExceedCap(req, record)) continue;
      if (record.state === "WARM_IDLE" && record.inFlight === 0) {
        return record;
      }
      if (underCapacity === null) underCapacity = record;
    }
    return underCapacity;
  }

  /** Stamps a lease on a record (sets leaseId, ++inFlight, LEASED). Synchronous. */
  private stamp(record: WorkerRecord, req: AcquireRequest): WorkerLease {
    const leaseId = record.leaseId ?? randomUUID();
    record.leaseId = leaseId;
    record.inFlight += 1;
    record.state = "LEASED";
    record.affinityKey = record.workerHost;
    if (!record.leaseIssues) record.leaseIssues = new Map();
    record.leaseIssues.set(req.issueId, (record.leaseIssues.get(req.issueId) ?? 0) + 1);

    const acquiredAtMs = this.leaseClock.now();
    // Track this lease's acquire time so a drain that force-destroys the worker while
    // it is still LEASED can accrue the in-flight window (the normal settle path
    // removes this entry in `onLeaseSettle`).
    if (!record.liveLeaseAcquiredMs) record.liveLeaseAcquiredMs = [];
    record.liveLeaseAcquiredMs.push(acquiredAtMs);
    record.lastHeartbeatMs = acquiredAtMs;
    const expiresAtMs = record.createdAtMs + this.settings.ttlMs;

    return createLease({
      leaseId,
      record,
      mutex: this.mutexFor(record.workerId),
      clock: this.leaseClock,
      acquiredAtMs,
      expiresAtMs,
      // Bill this lease from ITS OWN acquire time so a long heartbeating run is
      // charged the full window (heartbeats only stamp staleness, never reset the
      // bill) and two overlapping leases on one worker each accrue their own window.
      onSettle: async (rec, outcome, reason) =>
        this.onLeaseSettle(rec, req.issueId, acquiredAtMs, outcome, reason),
    });
  }

  /** True when leasing one more worker for this issue would exceed maxWorkersPerIssue. */
  private issueWouldExceedCap(req: AcquireRequest, candidate: WorkerRecord): boolean {
    const cap = this.settings.maxWorkersPerIssue;
    if (cap === undefined) return false;
    // Reusing a worker the issue already holds does not consume a new slot.
    if ((candidate.leaseIssues?.get(req.issueId) ?? 0) > 0) return false;
    let held = this.reservedProvisionsByIssue.get(req.issueId) ?? 0;
    for (const record of this.inventory.values()) {
      if (record.workerId === candidate.workerId) continue;
      if ((record.leaseIssues?.get(req.issueId) ?? 0) > 0) held += 1;
    }
    return held >= cap;
  }

  // --- growth (reservation-based single flight) --------------------------

  /** Whether a request may attempt to grow a new worker right now. */
  private canGrow(req: AcquireRequest): boolean {
    if (!this.hasGrowthHeadroom()) return false;
    return !this.issueAtGrowthCap(req);
  }

  /** Capacity headroom under `max` and the concurrent-worker spend cap. */
  private hasGrowthHeadroom(): boolean {
    const live = this.liveWorkerCount() + this.reservedProvisions;
    if (live >= this.settings.max) return false;
    const concurrentCap = this.settings.spend?.maxConcurrentWorkers;
    if (concurrentCap !== undefined && live >= concurrentCap) return false;
    return true;
  }

  /**
   * Whether growth is barred specifically by the concurrent-worker spend cap (live
   * workers at the cap while still under `max`). Lets `acquire` distinguish a
   * budget refusal (`spend_cap`, returned now) from a transient `max` saturation
   * (which waits on the FIFO queue).
   */
  private blockedBySpendCap(): boolean {
    const concurrentCap = this.settings.spend?.maxConcurrentWorkers;
    if (concurrentCap === undefined) return false;
    const live = this.liveWorkerCount() + this.reservedProvisions;
    return live >= concurrentCap && live < this.settings.max;
  }

  /** Whether the issue already holds its maxWorkersPerIssue, so it cannot grow. */
  private issueAtGrowthCap(req: AcquireRequest): boolean {
    const cap = this.settings.maxWorkersPerIssue;
    if (cap === undefined) return false;
    return this.issueLeaseCount(req.issueId) >= cap;
  }

  /**
   * Count of workers attributed to an issue for cap purposes: workers whose inventory
   * row already carries the issue PLUS any in-flight grows reserved for it (a grow
   * decided but whose provision has not yet landed in inventory). Counting the
   * reservation is what makes two concurrent same-issue grows respect the cap.
   */
  private issueLeaseCount(issueId: string): number {
    let held = this.reservedProvisionsByIssue.get(issueId) ?? 0;
    for (const record of this.inventory.values()) {
      if ((record.leaseIssues?.get(issueId) ?? 0) > 0) held += 1;
    }
    return held;
  }

  /**
   * Grows one worker under the synchronous reservation. The reservation is taken
   * BEFORE the provision await so a concurrent growth decision sees it and cannot
   * exceed `max`; it is released on settle/reject. A successful provision is
   * stamped and leased immediately.
   */
  private async grow(req: AcquireRequest): Promise<AcquireResult> {
    // Reserve synchronously, then re-validate (a racing reservation may have
    // just consumed the last slot in this same tick).
    this.reservedProvisions += 1;
    if (this.liveWorkerCount() + this.reservedProvisions > this.settings.max) {
      this.reservedProvisions -= 1;
      return { status: "no_capacity", reason: "spend_cap" };
    }

    // Also reserve the per-issue slot synchronously so a concurrent grow for the
    // SAME issue sees this in-flight grow and cannot itself slip past the cap
    // before this provision has landed in inventory. The reservation is included
    // in the issue cap counts and released in the finally below.
    this.reserveIssueProvision(req.issueId);

    const workerId = `worker-${this.workerSeq++}`;
    const labels = [POOL_OWNED_LABEL, ...req.labels];
    // Shield the not-yet-inventoried worker from the reaper's destroy-unknown
    // reconcile for the whole provision->probe window; released in the finally.
    this.pendingProvisionIds.add(workerId);
    // Capture the driver that will actually run this provision (and its
    // generation) BEFORE the await, so a swapDriver racing the provision cannot
    // misattribute the resulting worker: the record's origin is stamped to THIS
    // driver so recycle destroys it on the backend that created it.
    const originDriver = this.driver;
    const originGeneration = this.driverGeneration;
    try {
      // Write-ahead: flush a provisional ledger row BEFORE the provision await so a
      // crash mid-provision leaves a recoverable record (reconciled by hydrate
      // against driver.list()). Inert for non-cloud drivers.
      await this.writeProvisionalRow(workerId, labels);

      const descriptor = await originDriver.provision({
        workerId,
        affinityKey: req.affinityKey ?? null,
        // Stamp the pool-owned label alongside the request labels so a leaked
        // worker (crash between provision and inventory write) is recognized as ours
        // by the reaper's `list()` reconcile and can be destroyed.
        labels,
        timeoutMs: req.timeoutMs,
        ...(req.signal ? { signal: req.signal } : {}),
        ...(this.settings.driverOptions ? { driverOptions: this.settings.driverOptions } : {}),
      });

      // Correlate: upsert the provisional row with the real driverRef/workerHost
      // now the driver has returned, completing the write-ahead correlate.
      await this.correlateRow(descriptor);

      // A swapDriver may have run WHILE this provision was in flight, so the worker
      // was created on the now-stale `originDriver`, not the live `this.driver`.
      const swappedDuringProvision = this.driverGeneration !== originGeneration;

      // Readiness gate: never lease a worker that is not yet SSH-reachable (the
      // "reachable before leased" contract). Probe it on the driver that created it
      // BEFORE it enters inventory, so a concurrent acquire cannot grab a not-yet-ready
      // worker and an unready cold worker is destroyed + reported as no-capacity rather than
      // handed to the runner (which would fail, poison the lease, and churn a healthy
      // worker). Inert for an already-up host / the fake (probes ok on the first try).
      if (!(await this.probeUntilReady(descriptor, originDriver))) {
        await this.destroyDescriptor(descriptor, "unhealthy", originDriver);
        return { status: "no_capacity", reason: "driver_error" };
      }

      // The pool may have started draining (or been disabled) WHILE this provision OR
      // the readiness probe was in flight. runDrain snapshotted inventory before the
      // worker existed, so adding it now would leak a paid worker past a completed drain.
      // Destroy it instead of stamping it in - on the ORIGIN driver that created it.
      if (this.draining || !this.settings.enabled) {
        await this.destroyDescriptor(descriptor, "drain", originDriver);
        return { status: "no_capacity", reason: "pool_disabled" };
      }

      const record: WorkerRecord = {
        workerId: descriptor.workerId,
        workerHost: descriptor.workerHost,
        driverRef: descriptor.driverRef,
        state: "WARM_IDLE",
        labels: [...descriptor.labels],
        createdAtMs: descriptor.createdAtMs,
        leaseId: null,
        inFlight: 0,
        lastIdleAtMs: this.leaseClock.now(),
        lastHeartbeatMs: this.leaseClock.now(),
        workerSecondsUsed: 0,
        // A swap during the provision means this worker was created on a now-stale
        // driver; flag it for destroy so the reaper / settle recycles it (it
        // cannot serve the live driver and the new driver's list() will not own
        // it). A no-swap grow leaves this false (byte-identical default).
        markedForDestroy: swappedDuringProvision,
        affinityKey: null,
        metadata: { ...descriptor.metadata },
        leaseIssues: new Map(),
        // Record the backend that actually provisioned this worker so recycle destroys
        // it there. Only set when a swap happened during the await; an un-swapped
        // grow leaves it undefined so recycle falls back to `this.driver`
        // (byte-identical to the prior default path).
        ...(swappedDuringProvision ? { originDriver } : {}),
      };
      this.inventory.set(record.workerId, record);
      const lease = this.stamp(record, req);
      return { status: "leased", lease };
    } catch (error) {
      this.logEvent({
        event: "worker_pool_provision_failed",
        workerId,
        error: errorMessage(error),
      });
      // The provision rejected: drop the write-ahead provisional row so a failed
      // grow leaves no dangling row a later hydrate would have to reap.
      await this.ledger.delete(workerId);
      return { status: "no_capacity", reason: "driver_error" };
    } finally {
      // Release the reservations on settle OR reject so a failed provision never
      // permanently blocks future growth.
      this.reservedProvisions -= 1;
      this.releaseIssueProvision(req.issueId);
      this.pendingProvisionIds.delete(workerId);
    }
  }

  // --- waiter queue -------------------------------------------------------

  /**
   * Parks a blocked acquire on the FIFO queue. Resolves to a lease when a worker
   * frees, or to `no_capacity:acquire_timeout` when the timeout fires or the
   * request is aborted. The abort path resolves promptly so the poll thread is
   * never held to the full timeout.
   */
  private async waitForCapacity(req: AcquireRequest): Promise<AcquireResult> {
    return new Promise<AcquireResult>((resolve) => {
      const waiter: Waiter = {
        req,
        settled: false,
        resolve,
        timer: this.clock.setTimeout(() => {
          this.settleWaiter(waiter, { status: "no_capacity", reason: "acquire_timeout" });
        }, req.timeoutMs),
        cleanupAbort: null,
      };
      waiter.timer.unref?.();

      if (req.signal) {
        if (req.signal.aborted) {
          this.settleWaiter(waiter, { status: "no_capacity", reason: "acquire_timeout" });
          return;
        }
        const onAbort = (): void => {
          this.settleWaiter(waiter, { status: "no_capacity", reason: "acquire_timeout" });
        };
        req.signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanupAbort = () => req.signal?.removeEventListener("abort", onAbort);
      }

      this.waiters.push(waiter);
    });
  }

  /** Resolves a waiter exactly once and tears down its timer/abort listener. */
  private settleWaiter(waiter: Waiter, result: AcquireResult): void {
    if (waiter.settled) return;
    waiter.settled = true;
    this.clock.clearTimeout(waiter.timer);
    waiter.cleanupAbort?.();
    const index = this.waiters.indexOf(waiter);
    if (index !== -1) this.waiters.splice(index, 1);
    waiter.resolve(result);
  }

  /**
   * Wakes the oldest waiter that can now be satisfied by a freed/grown worker. Runs
   * after any event that frees capacity (release/reconcile). Each woken waiter
   * synchronously re-runs select-and-stamp so it cannot be starved by a fresh
   * acquire racing in.
   */
  private wakeWaiters(): void {
    // Iterate a snapshot; settleWaiter mutates the live array.
    for (const waiter of [...this.waiters]) {
      if (waiter.settled) continue;
      if (this.draining || !this.settings.enabled) {
        this.settleWaiter(waiter, { status: "no_capacity", reason: "pool_disabled" });
        continue;
      }
      const lease = this.selectAndStamp(waiter.req);
      if (lease) {
        this.settleWaiter(waiter, { status: "leased", lease });
      }
    }
    // The FIFO waiters had first claim on the freed capacity; whatever remains
    // leasable is announced so the runtime can nudge its poll (a waiter that
    // consumed the only worker leaves canAcquire() false and suppresses this).
    this.notifyCapacityAvailable();
  }

  // --- lease settlement / spend accounting -------------------------------

  /**
   * Pool-side accounting run INSIDE the per-worker mutex when a lease settles.
   * Decrements `inFlight`, accrues worker-seconds, and either returns the worker to
   * WARM_IDLE (healthy) or recycles it (poison / markedForDestroy). The single
   * destroy here is serialized by the per-worker mutex so a reaper tick observing
   * the same `inFlight->0` cannot double-destroy.
   */
  private async onLeaseSettle(
    record: WorkerRecord,
    issueId: string,
    leaseAcquiredMs: number,
    outcome: WorkerOutcome,
    _reason: string | null,
  ): Promise<void> {
    // Roll the day key BEFORE accruing into `dailyWorkerSecondsUsed`. A lease
    // acquired late on day N but released into day N+1 must bill day N+1 (the day
    // it settled), not day N's already-counted window. Without this roll the
    // accumulator stays keyed on the stale day, the daily cap is bypassed across
    // the midnight boundary, and the persisted `spend.json` (whose `recordDaily`
    // and `flushDaily` writes key on the live UTC day) diverges from memory.
    this.rollDayKeyIfNeeded();

    record.inFlight -= 1;
    // Decrement THIS issue's lease refcount on the worker; only forget the issue once
    // its LAST lease here settles. A plain delete-per-settle would drop the issue
    // while a co-resident sibling slot (`slotsPerMachine>1`) still occupies the worker,
    // letting `maxWorkersPerIssue` be bypassed.
    if (record.leaseIssues) {
      const remaining = (record.leaseIssues.get(issueId) ?? 0) - 1;
      if (remaining > 0) record.leaseIssues.set(issueId, remaining);
      else record.leaseIssues.delete(issueId);
    }
    // Drop THIS lease's tracked acquire time so a later drain does not re-bill its
    // (now settled) window. Remove a single matching entry (overlapping leases may
    // share an acquire timestamp).
    if (record.liveLeaseAcquiredMs) {
      const index = record.liveLeaseAcquiredMs.indexOf(leaseAcquiredMs);
      if (index !== -1) record.liveLeaseAcquiredMs.splice(index, 1);
    }

    // Accrue wall-clock worker-seconds for THIS lease window: acquire time to now.
    // Billing from the lease's own acquire timestamp (not `lastHeartbeatMs`) means
    // a long heartbeating run is charged its full window and two overlapping leases
    // on one worker (maxInFlight>1) each accrue their own window. `lastHeartbeatMs`
    // stays purely a staleness stamp for the reaper's orphan detection.
    const now = this.leaseClock.now();
    const elapsedSeconds = Math.max(0, (now - leaseAcquiredMs) / 1000);
    record.workerSecondsUsed += elapsedSeconds;
    this.workerSecondsUsed += elapsedSeconds;
    this.dailyWorkerSecondsUsed += elapsedSeconds;
    void this.ledger
      .recordDailyWorkerSeconds(elapsedSeconds)
      .catch((error: unknown) =>
        this.logEvent({ event: "worker_pool_ledger_write_failed", error: errorMessage(error) }),
      );

    // Remember a poison outcome even when a co-resident sibling lease is still in
    // flight (`slotsPerMachine>1`). Flag the worker for destroy NOW so it cannot serve a
    // fresh lease (isLeasable rejects markedForDestroy) and so the LAST sibling to
    // settle recycles it instead of returning a known-bad worker to WARM_IDLE. With the
    // default `slotsPerMachine=1` inFlight is already 0 here, so this is inert.
    if (outcome === "poison") record.markedForDestroy = true;

    if (record.inFlight > 0) {
      // Other leases still hold this worker (slotsPerMachine>1); leave it LEASED until
      // the last one settles, which then recycles it if poisoned or reaper-flagged.
      return;
    }

    record.leaseId = null;
    if (outcome === "poison" || record.markedForDestroy) {
      // A poisoned or reaper-flagged worker is recycled the instant its last lease
      // returns; the per-worker mutex (this callback runs inside it) serializes the
      // single destroy so a reaper tick cannot double-destroy / underflow.
      await this.recycle(record, "failed");
    } else if (this.draining) {
      // During drain the worker is left in inventory for runDrain to force-destroy;
      // here we only mark it idle so the drain barrier can observe inFlight->0.
      record.state = "WARM_IDLE";
      record.lastIdleAtMs = now;
    } else {
      record.state = "WARM_IDLE";
      record.lastIdleAtMs = now;
      record.affinityKey = record.workerHost;
    }

    // Wake the drain barrier once nothing is in flight anymore.
    if (this.draining && this.totalInFlight() === 0) this.notifyDrained?.();
    this.wakeWaiters();
  }

  /**
   * Accrues the in-flight worker-seconds window of every outstanding lease on a worker
   * that is about to be force-destroyed mid-lease (the drain path). Each tracked
   * acquire timestamp is billed from acquire-to-now into the process / daily / worker
   * accumulators and the persisted sidecar, then cleared so the late no-op release
   * never double-bills. The day key is rolled first so a window that straddled UTC
   * midnight bills the day it settled. Must be called inside the per-worker mutex.
   */
  private accrueInFlightWindows(record: WorkerRecord): void {
    const live = record.liveLeaseAcquiredMs;
    if (!live || live.length === 0) return;
    this.rollDayKeyIfNeeded();
    const now = this.leaseClock.now();
    for (const acquiredMs of live) {
      const elapsedSeconds = Math.max(0, (now - acquiredMs) / 1000);
      record.workerSecondsUsed += elapsedSeconds;
      this.workerSecondsUsed += elapsedSeconds;
      this.dailyWorkerSecondsUsed += elapsedSeconds;
      void this.ledger
        .recordDailyWorkerSeconds(elapsedSeconds)
        .catch((error: unknown) =>
          this.logEvent({ event: "worker_pool_ledger_write_failed", error: errorMessage(error) }),
        );
    }
    record.liveLeaseAcquiredMs = [];
    record.inFlight = 0;
  }

  /**
   * Destroys a worker and removes it from inventory. Idempotent: a worker already
   * DESTROYED/removed is left alone. Must be called inside the per-worker mutex (or
   * during a single-threaded drain) so it runs exactly once per worker.
   */
  private async recycle(record: WorkerRecord, reason: TeardownReason): Promise<void> {
    if (record.state === "DESTROYED" || record.state === "DESTROYING") return;
    record.state = "DESTROYING";
    // Recycle-vs-endpoint ordering invariant: fire the recycling callbacks INSIDE
    // the per-worker mutex (we are inside it here) BEFORE `driver.destroy`, so the
    // coordinator can fail any still-open RunSlot bound to this worker cleanly (close
    // its endpoint, settle, deregister) before the host is torn out from under it.
    // The state is already flipped to DESTROYING above so this fires exactly once.
    this.notifyMachineRecycling(record.workerId);
    try {
      // Destroy against the worker's ORIGINAL driver when a swap captured one, so an
      // in-flight lease settling AFTER a driver hot-reload tears its worker down on
      // the backend that PROVISIONED it (never the new `this.driver`) and a paid
      // worker is never orphaned. Workers provisioned under the live driver carry no
      // `originDriver` and fall back to `this.driver` (byte-identical default).
      const driver = record.originDriver ?? this.driver;
      await driver.destroy(
        {
          workerId: record.workerId,
          workerHost: record.workerHost,
          driverRef: record.driverRef,
          createdAtMs: record.createdAtMs,
          labels: record.labels,
          metadata: record.metadata,
        },
        { timeoutMs: this.settings.acquireTimeoutMs, reason },
      );
    } catch (error) {
      this.logEvent({
        event: "worker_pool_destroy_failed",
        workerId: record.workerId,
        error: errorMessage(error),
      });
      // The backend worker may still be running and billing. Dropping it from inventory
      // + ledger here would forget a PAID machine with no retry (a silent leak).
      // Instead keep it tracked but non-leasable (markedForDestroy) and put it back
      // in a reaper-retryable idle state: the serial reaper re-attempts the teardown
      // each tick (a flagged worker is reaped even below `min`), and across a restart
      // `hydrate` re-adopts it from the surviving ledger row and retries the destroy.
      record.markedForDestroy = true;
      record.leaseId = null;
      record.state = "WARM_IDLE";
      record.lastIdleAtMs = this.leaseClock.now();
      return;
    }
    record.state = "DESTROYED";
    void this.ledger
      .delete(record.workerId)
      .catch((error: unknown) =>
        this.logEvent({ event: "worker_pool_ledger_write_failed", error: errorMessage(error) }),
      );
    this.inventory.delete(record.workerId);
    this.workerMutexes.delete(record.workerId);
  }

  // --- reaper -------------------------------------------------------------

  /**
   * Arms (or re-arms) the single recurring reaper timer. The handle is detached
   * via `unref?.()` so it never keeps the process alive; the tick re-arms itself
   * at the end so the pass runs serially at the configured cadence. A stopped
   * pool (drained) arms nothing.
   */
  private scheduleReaper(): void {
    if (this.reaperStopped) return;
    const handle = this.clock.setTimeout(() => {
      void this.driveReaper();
    }, this.settings.reapIntervalMs);
    handle.unref?.();
    this.reaperTimer = handle;
  }

  /**
   * Runs one serial reaper pass, then re-arms the timer. The in-progress guard
   * lives in `runReaperTick`, so even an unusually slow tick (a hung probe) can
   * never overlap with the next scheduled fire. The internals are re-synced to
   * the live settings each tick since `reconcile` swaps the whole settings object.
   */
  private async driveReaper(): Promise<void> {
    this.reaperTimer = null;
    if (this.reaperStopped || this.draining) return;
    this.reaperInternals.settings = this.settings;
    try {
      await runReaperTick(this.reaperInternals);
    } catch (error) {
      this.logEvent({ event: "worker_pool_reaper_failed", error: errorMessage(error) });
    } finally {
      this.scheduleReaper();
    }
  }

  /** Stops the recurring reaper timer (terminal; called on drain). */
  private stopReaper(): void {
    this.reaperStopped = true;
    if (this.reaperTimer) {
      this.clock.clearTimeout(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  /**
   * Provisions one warm worker toward the min/warm target (driven by the reaper's
   * top-up). Goes through the same reservation as `grow` so a concurrent acquire
   * cannot push the live count past `max`, but the worker is left WARM_IDLE (no
   * lease stamped) so the next acquire can claim it. Failures are logged and
   * swallowed so a single bad provision never stalls the reaper.
   */
  private async provisionWarm(): Promise<void> {
    this.reservedProvisions += 1;
    if (this.liveWorkerCount() + this.reservedProvisions > this.settings.max) {
      this.reservedProvisions -= 1;
      return;
    }
    const workerId = `worker-${this.workerSeq++}`;
    const labels = [POOL_OWNED_LABEL];
    // Shield the not-yet-inventoried worker from the reaper's destroy-unknown
    // reconcile for the whole provision->probe window; released in the finally.
    this.pendingProvisionIds.add(workerId);
    // Capture the driver that will run this warm provision (and its generation)
    // BEFORE the await so a swapDriver racing the provision cannot misattribute the
    // worker (same no-orphan invariant as `grow`).
    const originDriver = this.driver;
    const originGeneration = this.driverGeneration;
    try {
      // Write-ahead the provisional row BEFORE provision (recoverable mid-provision
      // crash), then correlate after the driver returns. Inert for non-cloud.
      await this.writeProvisionalRow(workerId, labels);

      const descriptor = await originDriver.provision({
        workerId,
        affinityKey: null,
        labels,
        timeoutMs: this.settings.acquireTimeoutMs,
        ...(this.settings.driverOptions ? { driverOptions: this.settings.driverOptions } : {}),
      });

      await this.correlateRow(descriptor);

      // A swapDriver may have run WHILE this warm provision was in flight, so the
      // worker was created on the now-stale `originDriver`, not `this.driver`.
      const swappedDuringProvision = this.driverGeneration !== originGeneration;

      // Readiness gate (same "reachable before leased" contract as `grow`): a warm worker
      // must be SSH-reachable BEFORE it becomes WARM_IDLE and leasable, so an acquire
      // never grabs a not-yet-ready top-up worker. A worker that never becomes ready is
      // destroyed and skipped (the reaper re-tops-up); inert for an already-up host.
      if (!(await this.probeUntilReady(descriptor, originDriver))) {
        await this.destroyDescriptor(descriptor, "unhealthy", originDriver);
        return;
      }

      // A drain (or disable) may have begun WHILE this warm provision OR the readiness
      // probe was in flight; runDrain snapshotted inventory before the worker existed, so
      // adding it now would leak a paid worker past a completed drain. Destroy it instead -
      // on the ORIGIN driver that created it.
      if (this.draining || !this.settings.enabled) {
        await this.destroyDescriptor(descriptor, "drain", originDriver);
        return;
      }
      const now = this.leaseClock.now();
      const record: WorkerRecord = {
        workerId: descriptor.workerId,
        workerHost: descriptor.workerHost,
        driverRef: descriptor.driverRef,
        state: "WARM_IDLE",
        labels: [...descriptor.labels],
        createdAtMs: descriptor.createdAtMs,
        leaseId: null,
        inFlight: 0,
        lastIdleAtMs: now,
        lastHeartbeatMs: now,
        workerSecondsUsed: 0,
        // A swap during the provision means this warm worker was created on a stale
        // driver; flag it for destroy (it cannot serve the live driver).
        markedForDestroy: swappedDuringProvision,
        affinityKey: null,
        metadata: { ...descriptor.metadata },
        leaseIssues: new Map(),
        // Record the backend that actually provisioned this worker (only on a swap; an
        // un-swapped warm provision leaves it undefined -> falls back to
        // `this.driver`, byte-identical to the prior path).
        ...(swappedDuringProvision ? { originDriver } : {}),
      };
      this.inventory.set(record.workerId, record);

      if (swappedDuringProvision) {
        // This idle warm worker was provisioned on a now-stale driver, so it cannot
        // serve the live driver AND the new driver's list() will not own it
        // (the reaper's list-reconcile would otherwise DROP the record without
        // tearing the worker down, orphaning a paid machine on the old backend).
        // Recycle it NOW on its captured origin (under its per-worker mutex, exactly as
        // swapDriver recycles old-driver idle workers) so the destroy is
        // deterministic and routed to the backend that created it.
        await this.mutexFor(record.workerId).runExclusive(async () => {
          if (record.inFlight !== 0) return; // a lease landed first; settle recycles it
          await this.recycle(record, "shrink");
        });
      }
    } catch (error) {
      this.logEvent({
        event: "worker_pool_warm_provision_failed",
        workerId,
        error: errorMessage(error),
      });
      // Drop the write-ahead provisional row for a failed warm provision so no
      // dangling row outlives the attempt.
      await this.ledger.delete(workerId);
    } finally {
      this.reservedProvisions -= 1;
      this.pendingProvisionIds.delete(workerId);
    }
  }

  // --- drain --------------------------------------------------------------

  /**
   * Flips DRAINING, rejects new acquires, waits for in-flight leases up to the
   * deadline, then force-destroys ALL workers (held or not) so no paid cloud worker
   * leaks past process exit.
   */
  private async runDrain(
    opts: { deadlineMs: number; signal?: AbortSignal },
    epoch: number,
  ): Promise<void> {
    // Stop the recurring reaper so a draining pool issues no further ticks.
    this.stopReaper();

    // Reject every parked waiter immediately.
    for (const waiter of [...this.waiters]) {
      this.settleWaiter(waiter, { status: "no_capacity", reason: "pool_disabled" });
    }

    // Wait for in-flight leases to settle, bounded by the deadline. Event-driven:
    // `onLeaseSettle` resolves `notifyDrained` once `inFlight` hits zero, and a
    // deadline timer (real or fake-clock) resolves the race otherwise. Either way
    // we then force-destroy every remaining worker (held or not) so no worker leaks.
    if (this.totalInFlight() > 0 && !opts.signal?.aborted) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          // Only the OWNING drain clears the shared barrier hook; a re-enable
          // may have already nulled/replaced it, so guard the assignment.
          if (this.drainEpoch === epoch) this.notifyDrained = null;
          this.clock.clearTimeout(timer);
          if (onAbort && opts.signal) opts.signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const timer = this.clock.setTimeout(finish, opts.deadlineMs);
        timer.unref?.();
        this.notifyDrained = finish;
        const onAbort = opts.signal ? finish : null;
        if (onAbort && opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
      });
    }

    // Bail if this drain has been superseded. A reconcile re-enable (false->true)
    // clears `draining`, bumps `drainEpoch`, and grows fresh workers; an orphaned
    // drain whose deadline fired AFTER that re-enable must NOT force-destroy the
    // now-LIVE pool's workers. Still flush the daily total below so a superseded
    // drain does not drop the spend it observed.
    if (this.drainEpoch !== epoch || !this.draining) {
      await this.flushDailySpendForDrain();
      return;
    }

    // Force-destroy every remaining worker, held lease or not (the leak fix). Each
    // destroy runs inside that worker's mutex (consistent with every other teardown)
    // so a late `onLeaseSettle` — which while draining would flip the worker back to
    // WARM_IDLE — cannot interleave with the in-progress recycle and resurrect a
    // worker mid-destroy. The settle either runs fully before the destroy (and is
    // then overwritten to DESTROYED) or fully after (and no-ops on the DESTROYED worker).
    for (const record of [...this.inventory.values()]) {
      // Re-check the epoch each iteration: a re-enable racing the loop must stop
      // it from destroying any further workers the now-live pool depends on.
      if (this.drainEpoch !== epoch || !this.draining) break;
      await this.mutexFor(record.workerId).runExclusive(async () => {
        // A worker still LEASED at the deadline never ran `onLeaseSettle` for its
        // outstanding leases, and the late `release()` will no-op on the DESTROYED
        // guard, so accrue each outstanding lease's in-flight window HERE (inside
        // the per-worker mutex) before the force-destroy. Without this the spend is
        // under-counted and the persisted sidecar drops the window across restart.
        this.accrueInFlightWindows(record);
        await this.recycle(record, "drain");
      });
    }

    await this.flushDailySpendForDrain();
  }

  /**
   * Durably flushes the authoritative in-memory daily total at the end of a
   * drain. The hot path records each delta fire-and-forget
   * (`void recordDailyWorkerSeconds`), so a crash could lose the last unpersisted
   * deltas; a clean drain SETS the absolute total here (serialized after any
   * pending additive write) so the persisted sidecar matches the in-memory total
   * a restart will seed from. The day key is rolled first so a flush that lands
   * after a UTC-midnight crossing writes the new day's accumulator.
   */
  private async flushDailySpendForDrain(): Promise<void> {
    this.rollDayKeyIfNeeded();
    await this.ledger.flushDailyWorkerSeconds(this.dailyWorkerSecondsUsed);
  }

  // --- helpers ------------------------------------------------------------

  private mutexFor(workerId: string): Mutex {
    let mutex = this.workerMutexes.get(workerId);
    if (!mutex) {
      mutex = createMutex();
      this.workerMutexes.set(workerId, mutex);
    }
    return mutex;
  }

  /** Reserves one per-issue grow slot (counted in the issue caps until released). */
  private reserveIssueProvision(issueId: string): void {
    this.reservedProvisionsByIssue.set(
      issueId,
      (this.reservedProvisionsByIssue.get(issueId) ?? 0) + 1,
    );
  }

  /** Releases a previously reserved per-issue grow slot. */
  private releaseIssueProvision(issueId: string): void {
    const next = (this.reservedProvisionsByIssue.get(issueId) ?? 0) - 1;
    if (next <= 0) this.reservedProvisionsByIssue.delete(issueId);
    else this.reservedProvisionsByIssue.set(issueId, next);
  }

  /**
   * Writes the write-ahead provisional ledger row for a worker BEFORE its provision is
   * awaited. The row carries the workerId + the pool-owned label but no driverRef /
   * workerHost yet (the driver has not returned), so a crash between provision
   * and the inventory write leaves a recoverable record on disk. Inert (zero fs
   * I/O) for non-cloud drivers (the ledger is a no-op when `usesLedger` is false).
   */
  private async writeProvisionalRow(
    workerId: string,
    labels: ReadonlyArray<string>,
  ): Promise<void> {
    const now = this.leaseClock.now();
    const row: LedgerRow = {
      workerId,
      driverRef: null,
      workerHost: null,
      labels: [...labels],
      status: "provisional",
      createdAtMs: now,
      updatedAtMs: now,
    };
    await this.ledger.upsert(row);
  }

  /**
   * Upserts the CORRELATED active ledger row for a worker AFTER its provision returns,
   * stamping the real driverRef / workerHost over the earlier provisional row
   * (same workerId, so it is replaced, not appended). Completes the write-ahead
   * correlate. Inert for non-cloud drivers.
   */
  private async correlateRow(descriptor: WorkerDescriptor): Promise<void> {
    const now = this.leaseClock.now();
    const row: LedgerRow = {
      workerId: descriptor.workerId,
      driverRef: descriptor.driverRef,
      workerHost: descriptor.workerHost,
      labels: [...descriptor.labels],
      status: "active",
      createdAtMs: descriptor.createdAtMs,
      updatedAtMs: now,
    };
    await this.ledger.upsert(row);
  }

  /**
   * Destroys a driver descriptor that was created but never entered inventory
   * (e.g. a worker provisioned while the pool started draining). Best-effort: a
   * failure is logged and swallowed so the caller can still bail. The optional
   * `driver` override destroys the worker on the backend that ACTUALLY provisioned it
   * (the captured origin) when a swap raced the provision; it defaults to the live
   * `this.driver` (byte-identical to the prior single-driver path).
   */
  private async destroyDescriptor(
    descriptor: WorkerDescriptor,
    reason: TeardownReason,
    driver: WorkerDriver = this.driver,
  ): Promise<void> {
    try {
      await driver.destroy(
        {
          workerId: descriptor.workerId,
          workerHost: descriptor.workerHost,
          driverRef: descriptor.driverRef,
          createdAtMs: descriptor.createdAtMs,
          labels: descriptor.labels,
          metadata: descriptor.metadata,
        },
        { timeoutMs: this.settings.acquireTimeoutMs, reason },
      );
    } catch (error) {
      // Keep the write-ahead ledger row on failure: the backend worker may still be
      // running, and the surviving row lets `hydrate` re-adopt it after a restart and
      // retry teardown instead of silently leaking a paid worker. (Byte-identical to the
      // prior swallow except the row is no longer dropped when destroy did not run.)
      this.logEvent({
        event: "worker_pool_destroy_failed",
        workerId: descriptor.workerId,
        error: errorMessage(error),
      });
      return;
    }
    void this.ledger
      .delete(descriptor.workerId)
      .catch((error: unknown) =>
        this.logEvent({ event: "worker_pool_ledger_write_failed", error: errorMessage(error) }),
      );
  }

  private liveWorkerCount(): number {
    let count = 0;
    for (const record of this.inventory.values()) {
      if (isLive(record.state)) count += 1;
    }
    return count;
  }

  private totalInFlight(): number {
    let total = 0;
    for (const record of this.inventory.values()) total += record.inFlight;
    return total;
  }

  private rollDayKeyIfNeeded(): void {
    const today = utcDayKey(this.clock.now());
    if (today !== this.dayKey) {
      this.dayKey = today;
      this.dailyWorkerSecondsUsed = 0;
    }
  }

  private workerSecondsExhausted(): boolean {
    const spend = this.settings.spend;
    if (!spend) return false;
    if (spend.maxWorkerSeconds !== undefined && this.workerSecondsUsed >= spend.maxWorkerSeconds) {
      return true;
    }
    if (
      spend.dailyWorkerSeconds !== undefined &&
      this.dailyWorkerSecondsUsed >= spend.dailyWorkerSeconds
    ) {
      return true;
    }
    return false;
  }
}

/** Extracts a stable message from an unknown thrown value for structured logs. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a reconcile changes the PROVIDER CONSTRUCTION, gating the in-place
 * `swapDriver` rebuild (Finding #1). True when the driver `kind` differs OR
 * the `driverOptions` deep-differ (the two inputs `resolveDriver` consumes).
 * A same-driver reconcile (e.g. a `max`/`warm` resize) returns false so the
 * resolved driver object stays stable and the rebuild is skipped.
 */
function driverConstructionChanged(prev: WorkerPoolSettings, next: WorkerPoolSettings): boolean {
  if (prev.driver !== next.driver) return true;
  return !deepEqual(prev.driverOptions, next.driverOptions);
}

/**
 * Structural deep-equality over the JSON-shaped `driverOptions` records (plain
 * objects, arrays, and primitives). Sufficient for the swap gate since
 * `driverOptions` is a `Record<string, unknown>` of config-derived JSON values.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aArray = Array.isArray(a);
  const bArray = Array.isArray(b);
  if (aArray !== bArray) return false;
  if (aArray && bArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

/**
 * Constructs a {@link WorkerPool}. Resolves the driver for `settings.driver`
 * through `deps.drivers` (falling back to the process-wide default registry),
 * throwing `worker_pool_driver_unavailable` for an unregistered kind so the daemon
 * fails loud at startup, and wires the write-ahead ledger only when the driver
 * declares `usesLedger` AND a `ledgerPath` is supplied. No workspace/hook deps
 * are taken: the pool owns worker lifecycle only.
 */
export function createWorkerPool(
  settings: WorkerPoolSettings,
  deps: CreateWorkerPoolDeps,
): WorkerPool {
  return new WorkerPoolImpl(settings, deps);
}
