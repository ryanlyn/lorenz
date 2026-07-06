import type { WorkerDriver } from "@lorenz/worker-sdk";
import type { WorkerDriverKind, WorkerPoolSettings } from "@lorenz/domain";

/**
 * Pool-side types for the embedded warm worker pool. Every implementation file
 * imports from this module so concrete files (pool, lease, reaper, ledger) never
 * form import cycles. The DRIVER contract (WorkerDriver, WorkerDescriptor,
 * ProvisionRequest, WorkerHealth, TeardownReason, POOL_OWNED_LABEL, the registry)
 * lives in `@lorenz/worker-sdk`; this module owns only the engine vocabulary the
 * pool itself adds on top: leases, inventory records, the ledger row shape, and
 * the pool surface.
 */

/**
 * Outcome of a completed lease. `healthy` keeps the worker for reuse; `poison`
 * recycles the worker (a typed worker-transport fault, not a local/agent failure).
 * `release(outcome)` defaults to `healthy`; `fail(reason)` is equivalent to
 * `release('poison')` with a recorded reason.
 */
export type WorkerOutcome = "healthy" | "poison";

/**
 * Lifecycle state of a worker inside the pool inventory. Internal to the pool;
 * surfaced (read-only) via `WorkerPoolSnapshot` for tests/observability.
 *
 * `PROVISIONING`, `WARMING`, and `DRAINING` are never assigned by the current
 * pool (a mid-provision worker is tracked in the pool's `pendingProvisionIds`
 * set rather than as an inventory placeholder, provisioning probes inline, and
 * drain is a pool-level flag); they stay in the vocabulary for a future async
 * warmup strategy / per-worker drain marker, and the leasable/reap guards
 * already treat them correctly.
 */
export type WorkerState =
  | "PROVISIONING"
  | "WARMING"
  | "WARM_IDLE"
  | "LEASED"
  | "DEGRADED"
  | "DESTROYING"
  | "DESTROYED"
  | "DRAINING";

/**
 * In-memory record the pool keeps per worker. Mutated only inside the per-worker
 * mutex so the reaper and a lease release can never both touch `inFlight`.
 */
export interface WorkerRecord {
  workerId: string;
  workerHost: string;
  driverRef: string;
  state: WorkerState;
  labels: ReadonlyArray<string>;
  createdAtMs: number;
  /** Identity of the current lease generation; a release with a stale id is a no-op. */
  leaseId: string | null;
  /** Concurrent leases currently held against this worker (>= 0 invariant). */
  inFlight: number;
  /** When the worker last went idle (used by idle reaping). */
  lastIdleAtMs: number;
  /** Last heartbeat from the active run (used by orphan detection). */
  lastHeartbeatMs: number;
  /** Cumulative wall-clock worker-seconds attributed to this worker (monotonic). */
  workerSecondsUsed: number;
  /** Set when the reaper wants the worker gone but a lease is still in flight. */
  markedForDestroy: boolean;
  /** The affinity key (prior workerHost) this worker is currently sticky to, if any. */
  affinityKey: string | null;
  /** Per-worker metadata mirrored from the descriptor. */
  metadata: Record<string, unknown>;
  /**
   * Per-issue lease refcount against this worker: issue id -> number of leases that
   * issue currently holds on this worker. Used to enforce the optional
   * `maxWorkersPerIssue` fairness cap (so one ensemble cannot monopolize the pool).
   * A plain set of issue ids is wrong under co-residence (`slotsPerMachine>1`):
   * the SAME issue can hold two slots on one worker, so settling one must not forget
   * the worker still belongs to that issue. The key is dropped only when its count
   * reaches zero. Absent on records that predate the pool's per-issue accounting;
   * treated as empty.
   */
  leaseIssues?: Map<string, number>;
  /**
   * Acquire timestamps (ms) of every lease currently in flight against this worker,
   * one entry per outstanding lease (so `maxInFlight>1` overlapping leases each
   * carry their own window). A normal settle removes its own entry as it accrues
   * its window in `onLeaseSettle`; a drain that force-destroys a still-LEASED worker
   * accrues every remaining entry's window so the in-flight worker-seconds are not
   * dropped. Absent on records that predate this accounting; treated as empty.
   */
  liveLeaseAcquiredMs?: number[];
  /**
   * The driver that PROVISIONED this worker, captured by `swapDriver` on a driver
   * hot-reload BEFORE the pool reassigns its live `this.driver`. A teardown
   * (`recycle`/`destroyDescriptor`) routes `destroy` to
   * `record.originDriver ?? this.driver`, so an in-flight lease that settles
   * AFTER a driver swap destroys its worker on the ORIGINAL backend and a paid worker
   * is never orphaned on the now-detached driver. Absent on workers provisioned
   * under the live driver (no swap has happened); treated as `this.driver`.
   */
  originDriver?: WorkerDriver;
}

/**
 * Forward-looking alias for {@link WorkerRecord}. `WorkerRecord` stays the canonical
 * name and shape (every implementation file keeps importing it); `MachineLease`
 * is a pure re-export so downstream dispatch-coordinator code can refer to a
 * leased machine by its domain noun without a second, drift-prone type. The two
 * are structurally identical (an alias, not a subtype), so swapping one for the
 * other is byte-identical.
 */
export type MachineLease = WorkerRecord;

/**
 * A single write-ahead ledger row (cloud drivers only). Written provisionally
 * BEFORE provision, then upserted with `driverRef`/`workerHost` after the
 * driver returns, so a crash mid-provision is recoverable by labels or workerId.
 */
export interface LedgerRow {
  workerId: string;
  driverRef: string | null;
  workerHost: string | null;
  labels: ReadonlyArray<string>;
  /** `provisional` until the driver returns; then `active`; `destroying` while reaping. */
  status: "provisional" | "active" | "destroying";
  createdAtMs: number;
  updatedAtMs: number;
}

/**
 * A leased worker handed to the runtime. `release(outcome)` / `fail(reason)` settle
 * the lease exactly once (guarded by `leaseId` + a `settled` flag + worker state);
 * a stale generation or a DESTROYED worker is a no-op that never touches `inFlight`.
 */
export interface WorkerLease {
  readonly leaseId: string;
  readonly workerId: string;
  readonly workerHost: string;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number | null;
  release(outcome?: WorkerOutcome): Promise<void>;
  fail(reason: string): Promise<void>;
  heartbeat(): void;
}

/**
 * Request to lease a worker for one run. `affinityKey` is the prior `workerHost`
 * (sticky re-acquire on retry), NOT the pending sentinel. `labels` describe the
 * issue/ensemble slot so the pool can apply per-issue fairness caps.
 */
export type AcquireRequest = {
  issueId: string;
  slotIndex: number;
  labels: ReadonlyArray<string>;
  affinityKey?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
};

/**
 * Result of an acquire. `leased` carries a settled-once `WorkerLease`; `no_capacity`
 * surfaces a typed reason mapped onto the existing `worker_host_capacity` dispatch
 * signal so dispatch can recover (abandon-and-re-evaluate) without backoff churn.
 */
export type AcquireResult =
  | { status: "leased"; lease: WorkerLease }
  | {
      status: "no_capacity";
      reason: "acquire_timeout" | "spend_cap" | "pool_disabled" | "driver_error";
    };

/**
 * Read-only view of pool state for tests/observability. Worker-seconds are
 * cumulative wall-clock seconds; `dayKey` is the UTC day the daily cap rolls on.
 */
export interface WorkerPoolSnapshot {
  enabled: boolean;
  driver: WorkerDriverKind;
  total: number;
  warmIdle: number;
  leased: number;
  provisioning: number;
  degraded: number;
  inFlight: number;
  spend: {
    concurrentWorkers: number;
    workerSecondsUsed: number;
    dailyWorkerSecondsUsed: number;
    dayKey: string;
  };
  workers: ReadonlyArray<{
    workerId: string;
    workerHost: string;
    state: WorkerState;
    inFlight: number;
    markedForDestroy: boolean;
  }>;
}

/**
 * The embedded pool: a long-lived, reload-surviving singleton that produces each
 * run's `workerHost`. `reconcile` diffs prev-vs-next settings on config reload;
 * `hydrate` re-adopts survivors on startup; `drain` is awaitable so paid cloud
 * workers are destroyed before process exit.
 */
export interface WorkerPool {
  acquire(req: AcquireRequest): Promise<AcquireResult>;
  canAcquire(): boolean;
  /**
   * Whether the pool currently GOVERNS worker-host capacity (i.e. `settings.enabled`).
   * The pool survives config reloads, so a reload can DISABLE it (it drains to zero) while the
   * orchestrator's lifetime capacity probe stays installed. The probe reads this to decide whether
   * to delegate capacity to {@link WorkerPool.canAcquire} (governing) or fall through to static/local
   * execution (not governing); a disabled pool that no longer governs must not block dispatch.
   */
  isEnabled(): boolean;
  reconcile(next: WorkerPoolSettings): void;
  /**
   * Rebuilds the resolved driver IN PLACE (re-resolves `settings.driver` through
   * the registry, re-threads the reaper driver, and rebuilds the ledger
   * `usesLedger` gate) without reconstructing the singleton, capturing each
   * existing worker's origin driver so an in-flight lease that settles AFTER the
   * swap destroys its worker on the ORIGINAL backend. Called by `reconcile` when
   * the driver construction changed (and by the dispatch coordinator before
   * `reconcile` once it owns the reload path).
   */
  swapDriver(next: WorkerPoolSettings): void;
  /**
   * Registers a callback the pool invokes INSIDE the per-worker mutex immediately
   * before it destroys a machine (every teardown path - a poison settle, a reaper
   * reap, a driver-swap drain, and the drain force-destroy loop - routes through
   * the single `recycle` chokepoint, so the callback fires exactly once per worker
   * just before `driver.destroy`). The dispatch coordinator registers a callback
   * here so a poisoned/recycled machine fails any still-open RunSlot bound to that
   * worker CLEANLY (close its endpoint, settle, deregister) before the host dies,
   * never leaving a hung endpoint to a dead host. The callback must be cheap and
   * non-throwing; the pool swallows a callback error so a misbehaving listener can
   * never block the teardown it precedes. Multiple callbacks may be registered.
   */
  onMachineRecycling(cb: (workerId: string) => void): void;
  /**
   * OPTIONAL additive hook: registers a callback the pool fires whenever it wakes
   * its FIFO waiters AND capacity is actually leasable (`canAcquire()` is checked
   * AFTER the waiters were woken, so a waiter that consumed the freed worker
   * suppresses the notification). Fires on every capacity-freeing event - a lease
   * settle returning a worker to warm, a reconcile/grow landing a warm worker, a reaper
   * top-up. The runtime registers a poll nudge here so an issue skipped on
   * `worker_host_capacity` re-dispatches within one scheduler turn of a worker
   * landing warm instead of waiting out the poll interval. Callbacks must be
   * cheap; the pool swallows callback errors so a misbehaving listener can never
   * break the settle path that fired it. Optional so structural fakes/legacy
   * pools without the hook stay valid (registration is then skipped).
   */
  onCapacityAvailable?(cb: () => void): void;
  hydrate(): Promise<void>;
  drain(opts: { deadlineMs: number; signal?: AbortSignal }): Promise<void>;
  snapshot(): WorkerPoolSnapshot;
}

/**
 * Tiny async mutex used to serialize per-worker state mutations and the
 * reaper-vs-release interleave. `runExclusive` queues the body behind any
 * in-flight body and resolves with its value (or rejects with its error),
 * releasing the lock even when the body throws.
 */
export interface Mutex {
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
}
