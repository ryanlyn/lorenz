import type { BoxPoolProvider, BoxPoolSettings } from "@symphony/domain";
import type { ClockPort } from "@symphony/ports";

// Type-only imports (erased at runtime, so no import cycle through the provider
// modules) for the optional injected cloud transports the built-in e2b/modal
// factories thread through `ProviderDeps`.
import type { E2BSandboxClient } from "./providers/e2b.js";
import type { ModalTransport } from "./providers/modal.js";

/**
 * Shared types for the embedded warm box pool. Every implementation file imports
 * from this module so concrete files (pool, lease, reaper, providers, ledger,
 * registry) never form import cycles. Keep this file dependency-light: it pulls
 * `BoxPoolProvider`/`BoxPoolSettings` from `@symphony/domain` and `ClockPort`
 * from `@symphony/ports` only.
 */

/**
 * The label every pool-owned box carries so a `list()` reconcile can re-adopt or
 * destroy ONLY boxes the pool created (never an unlabeled foreign instance). The
 * pool stamps this on every provision request, and every provider's `list()` MUST
 * surface it on the descriptors it returns (the pool's ownership gate keys on it).
 * Defined here in the leaf types module so both `pool.ts` and the provider drivers
 * can reference it without forming an import cycle.
 */
export const POOL_OWNED_LABEL = "symphony.pool=worker-box-pool";

/**
 * Outcome of a completed lease. `healthy` keeps the box for reuse; `poison`
 * recycles the box (a typed box-transport fault, not a local/agent failure).
 * `release(outcome)` defaults to `healthy`; `fail(reason)` is equivalent to
 * `release('poison')` with a recorded reason.
 */
export type BoxOutcome = "healthy" | "poison";

/**
 * Why a box is being torn down. Drives provider `destroy` and ledger/spend
 * bookkeeping; never runs workspace hooks (the runner owns workspace lifecycle).
 */
export type TeardownReason =
  | "ttl"
  | "idle"
  | "shrink"
  | "unhealthy"
  | "failed"
  | "drain"
  | "orphan";

/**
 * Provider-reported health of a single box. The probe is a cheap readiness
 * check (e.g. `printf ready` over SSH), not a workspace/hook operation.
 */
export type BoxHealth = { ok: true } | { ok: false; reason: string };

/**
 * Static capabilities of a provider backend. `usesLedger` gates the write-ahead
 * ledger (cloud-only); `sshAddressable` records that the yielded `workerHost` is
 * an SSH destination; `ephemeral` records that boxes are disposable machines.
 */
export interface ProviderCapabilities {
  sshAddressable: boolean;
  ephemeral: boolean;
  usesLedger: boolean;
}

/**
 * A provisioned box. `workerHost` is the SSH-addressable string threaded
 * end-to-end by the orchestrator/runner. `providerRef` is the backend's own
 * handle (e.g. a machine id) used for `destroy`/`list` reconcile. `labels`
 * tag pool-owned survivors so a `list()` reconcile can re-adopt them.
 */
export interface BoxDescriptor {
  boxId: string;
  workerHost: string;
  providerRef: string;
  createdAtMs: number;
  labels: ReadonlyArray<string>;
  metadata: Record<string, unknown>;
}

/**
 * Request to provision one box. `boxId` is the pool's idempotency key (a
 * provider must return the same box for the same `boxId`). `affinityKey` carries
 * a prior `workerHost` so a retry can re-land on the same machine. `labels` are
 * stamped on the box for reconcile.
 */
export interface ProvisionRequest {
  boxId: string;
  affinityKey?: string | null;
  labels: ReadonlyArray<string>;
  timeoutMs: number;
  signal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
}

/**
 * A swappable backend that provisions, probes, destroys, and lists boxes behind
 * one interface (fake / static-ssh / cloud drivers). Every implementation must
 * be idempotent on `boxId` for `provision` and idempotent for `destroy`.
 */
export interface BoxProvider {
  readonly kind: BoxPoolProvider;
  provision(req: ProvisionRequest): Promise<BoxDescriptor>;
  probe(box: BoxDescriptor, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<BoxHealth>;
  destroy(box: BoxDescriptor, opts: { timeoutMs: number; reason: TeardownReason }): Promise<void>;
  list(): Promise<BoxDescriptor[]>;
  readonly capabilities: ProviderCapabilities;
}

/**
 * Dependencies a provider factory receives. Deliberately excludes any workspace
 * or hook deps: providers manage box lifecycle only.
 *
 * `e2bClient` / `modalTransport` are the injected cloud transports this package
 * does NOT depend on. They are absent for the stock daemon, so the built-in
 * e2b/modal factories fail loud at construction when they are missing; a real
 * deployment supplies them by registering a custom factory (see
 * `registerBoxProvider`) that injects a client/transport.
 */
export interface ProviderDeps {
  clock: ClockPort;
  logEvent: (event: Record<string, unknown>) => void;
  e2bClient?: E2BSandboxClient;
  modalTransport?: ModalTransport;
}

/** Constructs a provider from settings + deps. Registered by `kind`. */
export type BoxProviderFactory = (settings: BoxPoolSettings, deps: ProviderDeps) => BoxProvider;

/**
 * A box-readiness strategy. NEVER runs workspace hooks (the runner owns those);
 * it only gates that a provisioned box is reachable before it is leased.
 */
export interface WarmupStrategy {
  ensureReady(
    box: BoxDescriptor,
    provider: BoxProvider,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<BoxHealth>;
}

/**
 * Lifecycle state of a box inside the pool inventory. Internal to the pool;
 * surfaced (read-only) via `BoxPoolSnapshot` for tests/observability.
 *
 * `WARMING` and `DRAINING` are never assigned by the current pool (provisioning
 * probes inline and drain is a pool-level flag); they stay in the vocabulary for
 * a future async warmup strategy / per-box drain marker, and the leasable/reap
 * guards already treat them correctly.
 */
export type BoxState =
  | "PROVISIONING"
  | "WARMING"
  | "WARM_IDLE"
  | "LEASED"
  | "DEGRADED"
  | "DESTROYING"
  | "DESTROYED"
  | "DRAINING";

/**
 * In-memory record the pool keeps per box. Mutated only inside the per-box
 * mutex so the reaper and a lease release can never both touch `inFlight`.
 */
export interface BoxRecord {
  boxId: string;
  workerHost: string;
  providerRef: string;
  state: BoxState;
  labels: ReadonlyArray<string>;
  createdAtMs: number;
  /** Identity of the current lease generation; a release with a stale id is a no-op. */
  leaseId: string | null;
  /** Concurrent leases currently held against this box (>= 0 invariant). */
  inFlight: number;
  /** When the box last went idle (used by idle reaping). */
  lastIdleAtMs: number;
  /** Last heartbeat from the active run (used by orphan detection). */
  lastHeartbeatMs: number;
  /** Cumulative wall-clock box-seconds attributed to this box (monotonic). */
  boxSecondsUsed: number;
  /** Set when the reaper wants the box gone but a lease is still in flight. */
  markedForDestroy: boolean;
  /** The affinity key (prior workerHost) this box is currently sticky to, if any. */
  affinityKey: string | null;
  /** Per-box metadata mirrored from the descriptor. */
  metadata: Record<string, unknown>;
  /**
   * Per-issue lease refcount against this box: issue id -> number of leases that
   * issue currently holds on this box. Used to enforce the optional
   * `maxBoxesPerIssue` fairness cap (so one ensemble cannot monopolize the pool).
   * A plain set of issue ids is wrong under co-residence (`slotsPerMachine>1`):
   * the SAME issue can hold two slots on one box, so settling one must not forget
   * the box still belongs to that issue. The key is dropped only when its count
   * reaches zero. Absent on records that predate the pool's per-issue accounting;
   * treated as empty.
   */
  leaseIssues?: Map<string, number>;
  /**
   * Acquire timestamps (ms) of every lease currently in flight against this box,
   * one entry per outstanding lease (so `maxInFlight>1` overlapping leases each
   * carry their own window). A normal settle removes its own entry as it accrues
   * its window in `onLeaseSettle`; a drain that force-destroys a still-LEASED box
   * accrues every remaining entry's window so the in-flight box-seconds are not
   * dropped. Absent on records that predate this accounting; treated as empty.
   */
  liveLeaseAcquiredMs?: number[];
  /**
   * The provider that PROVISIONED this box, captured by `swapProvider` on a
   * provider hot-reload BEFORE the pool reassigns its live `this.provider`. A
   * teardown (`recycle`/`destroyDescriptor`) routes `destroy` to
   * `record.originProvider ?? this.provider`, so an in-flight lease that settles
   * AFTER a provider swap destroys its box on the ORIGINAL backend and a paid box
   * is never orphaned on the now-detached provider. Absent on boxes provisioned
   * under the live provider (no swap has happened); treated as `this.provider`.
   */
  originProvider?: BoxProvider;
}

/**
 * Forward-looking alias for {@link BoxRecord}. `BoxRecord` stays the canonical
 * name and shape (every implementation file keeps importing it); `MachineLease`
 * is a pure re-export so downstream dispatch-coordinator code can refer to a
 * leased machine by its domain noun without a second, drift-prone type. The two
 * are structurally identical (an alias, not a subtype), so swapping one for the
 * other is byte-identical.
 */
export type MachineLease = BoxRecord;

/**
 * A single write-ahead ledger row (cloud providers only). Written provisionally
 * BEFORE provision, then upserted with `providerRef`/`workerHost` after the
 * provider returns, so a crash mid-provision is recoverable by labels or boxId.
 */
export interface LedgerRow {
  boxId: string;
  providerRef: string | null;
  workerHost: string | null;
  labels: ReadonlyArray<string>;
  /** `provisional` until the provider returns; then `active`; `destroying` while reaping. */
  status: "provisional" | "active" | "destroying";
  createdAtMs: number;
  updatedAtMs: number;
}

/**
 * A leased box handed to the runtime. `release(outcome)` / `fail(reason)` settle
 * the lease exactly once (guarded by `leaseId` + a `settled` flag + box state);
 * a stale generation or a DESTROYED box is a no-op that never touches `inFlight`.
 */
export interface BoxLease {
  readonly leaseId: string;
  readonly boxId: string;
  readonly workerHost: string;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number | null;
  release(outcome?: BoxOutcome): Promise<void>;
  fail(reason: string): Promise<void>;
  heartbeat(): void;
}

/**
 * Request to lease a box for one run. `affinityKey` is the prior `workerHost`
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
 * Result of an acquire. `leased` carries a settled-once `BoxLease`; `no_capacity`
 * surfaces a typed reason mapped onto the existing `worker_host_capacity` dispatch
 * signal so dispatch can recover (abandon-and-re-evaluate) without backoff churn.
 */
export type AcquireResult =
  | { status: "leased"; lease: BoxLease }
  | {
      status: "no_capacity";
      reason: "acquire_timeout" | "spend_cap" | "pool_disabled" | "provider_error";
    };

/**
 * Read-only view of pool state for tests/observability. Box-seconds are
 * cumulative wall-clock seconds; `dayKey` is the UTC day the daily cap rolls on.
 */
export interface BoxPoolSnapshot {
  enabled: boolean;
  provider: BoxPoolProvider;
  total: number;
  warmIdle: number;
  leased: number;
  provisioning: number;
  degraded: number;
  inFlight: number;
  spend: {
    concurrentBoxes: number;
    boxSecondsUsed: number;
    dailyBoxSecondsUsed: number;
    dayKey: string;
  };
  boxes: ReadonlyArray<{
    boxId: string;
    workerHost: string;
    state: BoxState;
    inFlight: number;
    markedForDestroy: boolean;
  }>;
}

/**
 * The embedded pool: a long-lived, reload-surviving singleton that produces each
 * run's `workerHost`. `reconcile` diffs prev-vs-next settings on config reload;
 * `hydrate` re-adopts survivors on startup; `drain` is awaitable so paid cloud
 * boxes are destroyed before process exit.
 */
export interface BoxPool {
  acquire(req: AcquireRequest): Promise<AcquireResult>;
  canAcquire(): boolean;
  /**
   * Whether the pool currently GOVERNS worker-host capacity (i.e. `settings.enabled`).
   * The pool survives config reloads, so a reload can DISABLE it (it drains to zero) while the
   * orchestrator's lifetime capacity probe stays installed. The probe reads this to decide whether
   * to delegate capacity to {@link BoxPool.canAcquire} (governing) or fall through to static/local
   * execution (not governing); a disabled pool that no longer governs must not block dispatch.
   */
  isEnabled(): boolean;
  reconcile(next: BoxPoolSettings): void;
  /**
   * Rebuilds the resolved provider IN PLACE (re-runs `resolveProvider`, re-threads
   * the reaper provider, and rebuilds the ledger `usesLedger` gate) without
   * reconstructing the singleton, capturing each existing box's origin provider so
   * an in-flight lease that settles AFTER the swap destroys its box on the ORIGINAL
   * backend. Called by `reconcile` when the provider construction changed (and by
   * the dispatch coordinator before `reconcile` once it owns the reload path).
   */
  swapProvider(next: BoxPoolSettings): void;
  /**
   * Registers a callback the pool invokes INSIDE the per-box mutex immediately
   * before it destroys a machine (every teardown path - a poison settle, a reaper
   * reap, a provider-swap drain, and the drain force-destroy loop - routes through
   * the single `recycle` chokepoint, so the callback fires exactly once per box
   * just before `provider.destroy`). The dispatch coordinator registers a callback
   * here so a poisoned/recycled machine fails any still-open RunSlot bound to that
   * box CLEANLY (close its endpoint, settle, deregister) before the host dies,
   * never leaving a hung endpoint to a dead host. The callback must be cheap and
   * non-throwing; the pool swallows a callback error so a misbehaving listener can
   * never block the teardown it precedes. Multiple callbacks may be registered.
   */
  onMachineRecycling(cb: (boxId: string) => void): void;
  hydrate(): Promise<void>;
  drain(opts: { deadlineMs: number; signal?: AbortSignal }): Promise<void>;
  snapshot(): BoxPoolSnapshot;
}

/**
 * Tiny async mutex used to serialize per-box state mutations and the
 * reaper-vs-release interleave. `runExclusive` queues the body behind any
 * in-flight body and resolves with its value (or rejects with its error),
 * releasing the lock even when the body throws.
 */
export interface Mutex {
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
}
