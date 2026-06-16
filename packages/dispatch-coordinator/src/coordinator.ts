// The DispatchCoordinator: STEP 1 is a 1:1 passthrough over the proven
// @lorenz/worker-pool WorkerPool.
//
// With the default settings (slotsPerMachine=1) and the NULL McpEndpointManager
// (perRunEndpoint=false, mcpEndpoint=null), every operation here is byte-identical
// at the runtime boundary to calling the underlying WorkerPool directly:
//   - acquireRunSlot calls pool.acquire and, on `leased`, mints a RunSlot whose
//     release/fail/heartbeat delegate straight to the wrapped WorkerLease (so the
//     pool's exactly-once leaseId/generation/DESTROYED guards and poison/healthy
//     classification are unchanged); a `no_capacity` result is returned with the
//     SAME typed reason; a THROWN pool fault PROPAGATES verbatim so the runtime's
//     catch emits worker_pool_acquire_error.
//   - the coordinator itself is the orchestrator's capacity authority: governs()/
//     canAcquire() re-read live pool state each call, and the coordinator is a
//     reload-surviving singleton, so an orchestrator that captured it in its ctor
//     is never stranded by a reconcile.
//   - reconcile/drain/hydrate delegate verbatim; snapshot is the pool snapshot
//     extended with a `slots` view derived from the live registry.
//
// The coordinator owns the authoritative per-slot registry (minted-but-unsettled
// slots) used for collision detection, recycle-driven fail-fast, the tunnel
// ceiling, and the snapshot.slots view.

import type { WorkerPoolSettings, Settings } from "@lorenz/domain";
import type {
  AcquireResult,
  WorkerLease,
  WorkerOutcome,
  WorkerPool,
  WorkerPoolSnapshot,
} from "@lorenz/worker-pool";
import type { AgentMcpEndpointLease } from "@lorenz/mcp";

import type { AcquireRunSlotRequest, McpEndpointManager, RunSlot } from "./types.js";

/**
 * The typed `no_capacity` reasons the coordinator surfaces. In STEP 1 these are
 * exactly the pool's reasons (passed through verbatim); the `tunnel_exhausted`
 * reason is reserved for the STEP 3 per-run tunnel ceiling and never produced by
 * this passthrough. The runtime maps EVERY one of these onto the single
 * `worker_host_capacity` dispatch_skipped event (no per-reason differentiation),
 * matching today's behaviour.
 */
export type NoCapacityReason =
  | "acquire_timeout"
  | "spend_cap"
  | "pool_disabled"
  | "driver_error"
  | "tunnel_exhausted";

/** Discriminated result of {@link DispatchCoordinator.acquireRunSlot}. */
export type AcquireRunSlotResult =
  | { status: "bound"; slot: RunSlot }
  | { status: "no_capacity"; reason: NoCapacityReason };

/**
 * Thrown by {@link DispatchCoordinator.acquireRunSlot} when the per-run MCP
 * endpoint fails to OPEN after the WorkerLease was already bound. The just-bound
 * lease has been settled HEALTHY before this is thrown (the worker itself is fine -
 * only the endpoint failed - so it must NOT be poisoned), and NO half-open ssh
 * child / RunSlot is left behind. The runtime catches this exactly like any other
 * thrown acquire fault and emits `worker_pool_acquire_error` (never a partial run).
 * `cause` carries the underlying manager error; `workerHost`/`runKey` identify the
 * run the endpoint was being opened for.
 */
export class EndpointOpenError extends Error {
  override readonly cause: unknown;
  readonly workerHost: string;
  readonly runKey: string;

  constructor(args: { cause: unknown; workerHost: string; runKey: string }) {
    super(
      `mcp_endpoint_open_failed: ${args.workerHost}#${args.runKey}: ${errorMessage(args.cause)}`,
    );
    this.name = "EndpointOpenError";
    this.cause = args.cause;
    this.workerHost = args.workerHost;
    this.runKey = args.runKey;
  }
}

/** Extracts a stable message from an unknown thrown value for the structured error. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The ISSUE-SCOPED per-run key (`${issueId}#${slotIndex}`) feeding the per-run
 * endpoint/tunnel key (`${workerHost}#${runKey}`). It MUST include the issueId so
 * DIFFERENT issues co-residing on ONE workerHost (slotsPerMachine>1; every
 * non-ensemble issue uses slotIndex 0) never collide on the tunnel/port. The
 * ceiling/collision guards remain keyed on (issueId, slotIndex), and the workspace
 * stays issue-isolated by its own identifier path, so only this endpoint key
 * changes. Both `acquireRunSlot` (open) and `createRunSlot` (slot.runKey) derive the
 * key here so the bound slot's `runKey` is byte-identical to the key the endpoint
 * was opened with.
 */
function runKeyFor(issueId: string, slotIndex: number): string {
  return `${issueId}#${slotIndex}`;
}

/**
 * A `workerHost` is LOCAL (no per-run tunnel is minted; acp keeps its own
 * endpoint) when it is empty. A pool lease's `workerHost` is otherwise always a
 * real ssh address. Mirrors {@link createPerRunEndpointManager}'s host routing so
 * the tunnel-exhaustion ceiling counts ONLY real remote tunnels: a local slot
 * consumes no `ssh -N` child, so it must never be gated by (nor count against) the
 * ceiling.
 */
function isLocalWorkerHost(workerHost: string): boolean {
  return workerHost.length === 0;
}

/**
 * Thrown by {@link DispatchCoordinator.acquireRunSlot} when a freshly-bound lease
 * would place a SECOND live RunSlot with the SAME `(issueId, slotIndex)` on the
 * SAME machine. `(issueId, slotIndex)` is the key that feeds both the per-run
 * `runKey` (`${slotIndex}`) AND the workspace slot suffix, so two co-resident slots
 * sharing it would collide on BOTH the per-run endpoint/tunnel key and the
 * workspace dir. Rather than silently disambiguate (openQuestion #1), the
 * coordinator ASSERTS-AND-REJECTS: the just-bound lease is settled HEALTHY (the worker
 * itself is fine) and NO slot is registered, so this invariant violation surfaces
 * loudly. The runtime maps the throw to `worker_pool_acquire_error` exactly like any
 * other acquire fault, leaving the first slot untouched.
 */
export class RunSlotCollisionError extends Error {
  readonly issueId: string;
  readonly slotIndex: number;
  readonly machineLeaseId: string;

  constructor(args: { issueId: string; slotIndex: number; machineLeaseId: string }) {
    super(
      `run_slot_collision: (issueId=${args.issueId}, slotIndex=${args.slotIndex}) already live on machine ${args.machineLeaseId}`,
    );
    this.name = "RunSlotCollisionError";
    this.issueId = args.issueId;
    this.slotIndex = args.slotIndex;
    this.machineLeaseId = args.machineLeaseId;
  }
}

/**
 * One entry in the coordinator snapshot's `slots` view. STEP 1 always reports an
 * empty list (no live per-run accounting yet); the shape is fixed now so the
 * runtime/observability surface is stable across the later steps that populate it.
 */
export interface RunSlotSnapshotEntry {
  slotId: string;
  machineLeaseId: string;
  issueId: string;
  slotIndex: number;
  workerHost: string;
  remotePort: number | null;
}

/** The coordinator snapshot: the pool snapshot extended with a `slots` view. */
export type DispatchCoordinatorSnapshot = WorkerPoolSnapshot & {
  slots: ReadonlyArray<RunSlotSnapshotEntry>;
};

/**
 * The lifetime-installed capacity gate the orchestrator delegates worker-host
 * decisions to. Identical shape to the orchestrator's `CapacityProbe`; the
 * coordinator itself satisfies it (a reload-surviving singleton, so the
 * orchestrator's captured reference is stable across reconcile).
 */
export interface CapacityProbe {
  /** Whether the live pool currently governs worker-host capacity (`pool.isEnabled()`). */
  governs(): boolean;
  /** Whether a run slot could be acquired right now (`pool.canAcquire()`). */
  canAcquire(): boolean;
}

/**
 * The runtime-facing coordinator over the machine {@link WorkerPool}. It is also
 * the orchestrator's capacity authority ({@link CapacityProbe}): `governs()` /
 * `canAcquire()` re-read live pool state on each call.
 */
export interface DispatchCoordinator extends CapacityProbe {
  acquireRunSlot(req: AcquireRunSlotRequest): Promise<AcquireRunSlotResult>;
  /**
   * Registers a callback fired when the pool frees (or grows) leasable capacity,
   * forwarded to {@link WorkerPool.onCapacityAvailable} when the pool provides the
   * hook (a no-op otherwise). The runtime uses it to nudge its poll so a
   * capacity-skipped issue re-dispatches without waiting out the poll interval.
   */
  onCapacityAvailable(cb: () => void): void;
  readonly capabilities: { readonly perRunEndpoint: boolean };
  /**
   * Reconciles the live pool (and the coordinator-owned settings) onto `next`.
   * Async ONLY for the injected `driverLoader` (out-of-tree driver modules are
   * dynamic-imported BEFORE the pool reconcile); the pool reconcile itself
   * stays synchronous and transactional. A rejection (module load failure or a
   * pool rollback) leaves both the pool and the coordinator on last-good.
   */
  reconcile(next: WorkerPoolSettings): Promise<void>;
  drain(opts: { deadlineMs: number; signal?: AbortSignal }): Promise<void>;
  hydrate(): Promise<void>;
  snapshot(): DispatchCoordinatorSnapshot;
}

/** Constructor dependencies for {@link createDispatchCoordinator}. */
export interface CreateDispatchCoordinatorDeps {
  pool: WorkerPool;
  mcpEndpointManager: McpEndpointManager;
  settings: WorkerPoolSettings;
  /**
   * Optional structured-event sink for BEST-EFFORT cleanup faults the settle path
   * must never throw to the caller (e.g. an endpoint/tunnel close that rejects
   * while the worker lease is still being settled). When absent the fault is swallowed
   * (the lease still settles regardless); the production runtime injects the same
   * `logEvent` it threads into the underlying WorkerPool. Mirrors the pool's
   * `(event) => void` shape so observability is uniform across the two layers.
   */
  logEvent?: (event: Record<string, unknown>) => void;
  /**
   * Optional out-of-tree driver loader awaited by {@link DispatchCoordinator.reconcile}
   * BEFORE `pool.reconcile` when the next settings are enabled. The daemon
   * injects `ensureWorkerDriverLoaded` here so a reload that changes the configured
   * worker-pool driver to a module specifier dynamic-imports and
   * registers it first, keeping the pool's registry resolution synchronous. A
   * rejection aborts the reconcile (the pool is never touched), so the
   * runtime's transactional reload keeps last-good settings.
   */
  driverLoader?: (driver: string) => Promise<void>;
}

/**
 * Mints a {@link RunSlot} wrapping a settled-once {@link WorkerLease}. STEP 1 always
 * passes `mcpEndpoint = null` (the null manager mints nothing) so release/fail are
 * byte-identical to the underlying lease settle. The slot holds a single
 * `settled` flag so release/fail are exactly-once on THIS handle (a second call is
 * a no-op and never reaches the lease); the lease itself stays the authoritative
 * leaseId/generation/DESTROYED guard for the recycle path.
 */
function createRunSlot(args: {
  lease: WorkerLease;
  issueId: string;
  slotIndex: number;
  endpoint: Awaited<ReturnType<McpEndpointManager["open"]>>;
  mcpEndpointManager: McpEndpointManager;
  onSettled: (slotId: string) => void;
  logEvent: (event: Record<string, unknown>) => void;
}): RunSlot {
  const { lease, issueId, slotIndex, endpoint, mcpEndpointManager, onSettled, logEvent } = args;
  // runKey is the ISSUE-SCOPED per-run key (`${issueId}#${slotIndex}`). It feeds the
  // per-run endpoint/tunnel key (`${workerHost}#${runKey}`), so it MUST include the
  // issueId: with slotsPerMachine>1, DIFFERENT issues can co-reside on ONE workerHost
  // and a bare `${slotIndex}` (0 for every non-ensemble issue) would collide across
  // issues -> shared tunnel/port, broken per-run isolation. The workspace dir stays
  // issue-isolated by its own identifier path; only this endpoint key needs the issue.
  const runKey = runKeyFor(issueId, slotIndex);
  // slotId is the registry key: unique per (issue, slot, lease generation).
  const slotId = `${issueId}#${slotIndex}#${lease.leaseId}`;
  let settled = false;

  // The single settle path: close THIS slot's endpoint exactly once (a no-op for
  // the null endpoint), delegate to the wrapped lease, then deregister. A second
  // call short-circuits before touching the lease, so settle is exactly-once on
  // this handle while the lease's own guard remains authoritative for the pool.
  //
  // Endpoint cleanup is BEST-EFFORT: we attempt manager.release FIRST (preserving
  // the close-endpoint-BEFORE-settle ordering so no hung tunnel points at a worker
  // about to be returned/recycled), but if it REJECTS - a local mcp server stop /
  // tunnel close that throws - we must NEVER leave the worker lease unsettled or the
  // slot registered. The lease settle + deregister (which also releases any tunnel
  // reservation via onSettled) therefore run in a `finally`, so capacity + tunnel
  // accounting is released regardless. The endpoint error is logged, never thrown
  // to the caller (the runtime would otherwise see a rejected run finalizer instead
  // of a clean settle). The settled-once guard is preserved.
  const settle = async (run: () => Promise<void>): Promise<void> => {
    if (settled) return;
    settled = true;
    try {
      await mcpEndpointManager.release(endpoint);
    } catch (releaseError) {
      logEvent({
        event: "worker_pool_endpoint_release_failed",
        slotId,
        issueId,
        slotIndex,
        workerHost: lease.workerHost,
        error: errorMessage(releaseError),
      });
    } finally {
      await run();
      onSettled(slotId);
    }
  };

  return {
    slotId,
    machineLeaseId: lease.workerId,
    issueId,
    slotIndex,
    leaseId: lease.leaseId,
    workerHost: lease.workerHost,
    runKey,
    mcpEndpoint: endpoint,
    acquiredAtMs: lease.acquiredAtMs,
    heartbeat(): void {
      lease.heartbeat();
    },
    async release(outcome: WorkerOutcome): Promise<void> {
      await settle(async () => lease.release(outcome));
    },
    async fail(reason: string): Promise<void> {
      await settle(async () => lease.fail(reason));
    },
  };
}

/**
 * Constructs the STEP 1 passthrough {@link DispatchCoordinator}. `settings` is
 * retained for the later reconcile/co-residence paths; in STEP 1 it is not read
 * past construction (the pool owns the live settings). The injected
 * `mcpEndpointManager` is the null passthrough in STEP 1, so every minted slot
 * carries `mcpEndpoint = null` and the coordinator advertises
 * `perRunEndpoint = false`.
 */
export function createDispatchCoordinator(
  deps: CreateDispatchCoordinatorDeps,
): DispatchCoordinator {
  const { pool, mcpEndpointManager } = deps;
  // Best-effort cleanup-fault sink: when the runtime injects no logEvent (the
  // legacy passthrough callers), endpoint-close faults in the settle path are
  // silently swallowed (the lease still settles regardless).
  const logEvent = deps.logEvent ?? ((): void => {});
  // The authoritative live-slot registry keyed by slotId. A slot is added on a
  // successful lease-bind and removed on settle; the snapshot.slots view is derived
  // from it, and the recycle callback below scans it by machine.
  const slots = new Map<string, RunSlot>();

  // In-flight `slot.fail` promises started by the recycle callback below, which must
  // stay synchronous (it runs inside the pool's per-worker mutex) and so cannot await
  // them. `drain` awaits this set AFTER the pool drain so per-run endpoint /
  // local-MCP-server / reverse-tunnel cleanup for every recycled slot finishes
  // BEFORE drain returns and the daemon stops the local server - otherwise shutdown
  // races live slot teardown and strands those resources.
  const pendingRecycleFails = new Set<Promise<void>>();

  // SYNCHRONOUS tunnel reservations held while an acquire is between the ceiling
  // check and a successful registration. The ceiling check passes and increments
  // this in the SAME JS tick (before any `await mcpEndpointManager.open`), so two
  // concurrent acquires can never both slip past a maxConcurrentTunnels ceiling:
  // the second sees the first's pending reservation. Each reservation is released
  // exactly once - on open FAILURE, on a post-open guard rejection, or on slot
  // settlement (via the slot's onSettled) - mirroring the worker pool's single-flight
  // reservedProvisions counter. A negative count is impossible because every
  // increment is paired with exactly one release.
  let reservedTunnels = 0;

  // The live settings the coordinator reads for the tunnel-exhaustion ceiling.
  // `reconcile` updates this in place so a config reload that raises/lowers the
  // ceiling takes effect WITHOUT reconstructing the singleton (the live-slot
  // registry is preserved across the reload). The pool owns its own live settings;
  // this reference is only read for the coordinator-owned tunnel budget.
  let currentSettings: WorkerPoolSettings = deps.settings;

  // Counts LIVE per-run tunnels: registered slots whose `mcpEndpoint` is non-null
  // (a local / null-endpoint slot consumes no tunnel budget) PLUS the pending
  // reservations held by in-flight acquires that have passed the ceiling check but
  // not yet registered. Including the reservations is what closes the
  // concurrent-acquire race: registration happens only AFTER `await
  // mcpEndpointManager.open`, so without the reservation a second acquire would
  // count zero live tunnels while the first is still mid-open and over-open the
  // ceiling. The registered refcount stays exact via the open-on-bind /
  // close-on-settle lifecycle; the reservation covers the open-in-flight gap.
  const liveTunnelCount = (): number => {
    let count = reservedTunnels;
    for (const slot of slots.values()) {
      if (slot.mcpEndpoint !== null) count += 1;
    }
    return count;
  };

  // Recycle-vs-endpoint ordering invariant: the pool fires this INSIDE the per-worker
  // mutex immediately BEFORE it destroys a machine. We fail every still-open
  // RunSlot bound to that worker CLEANLY - `slot.fail` closes the endpoint (killing
  // the local ssh -N child so no hung tunnel is left pointing at the now-dead
  // host), THEN settles the lease, THEN deregisters - so a poisoned/recycled
  // machine never strands an endpoint and sibling runs see a clean per-run failure.
  // The callback must stay synchronous (it runs inside the mutex), so the matching
  // slots are snapshotted now and their settle is fire-and-forget; `slot.fail` is
  // idempotent so a normal release racing in afterwards is a no-op (exactly-once
  // across BOTH the recycle and the normal path). A settle error is swallowed so a
  // misbehaving endpoint close can never block the pool's teardown.
  //
  // Registration is DEFENSIVE: the runtime keeps accepting a bare `WorkerPool`
  // (wrapped in a null-endpoint passthrough coordinator) for one release to avoid
  // mass test churn, and an older/partial pool injected that way may predate
  // `onMachineRecycling`. The hook is best-effort - a pool without it simply has no
  // recycle-driven fail-fast (the lease settle path still tears the worker down) - so
  // we register only when the pool provides it, never throwing on the passthrough.
  if (typeof pool.onMachineRecycling === "function") {
    pool.onMachineRecycling((workerId: string) => {
      const affected: RunSlot[] = [];
      for (const slot of slots.values()) {
        if (slot.machineLeaseId === workerId) affected.push(slot);
      }
      for (const slot of affected) {
        // Track the fire-and-forget fail so `drain` can await it (the callback itself
        // must not block the pool's in-mutex teardown). Self-removes on settle.
        const failed = slot.fail("machine_recycled").catch(() => {
          // The slot's lease/endpoint guard is authoritative; swallow so a recycle
          // teardown is never blocked by a slot's settle failure.
        });
        pendingRecycleFails.add(failed);
        void failed.finally(() => pendingRecycleFails.delete(failed));
      }
    });
  }

  const capabilities = { perRunEndpoint: mcpEndpointManager.perRunEndpoint } as const;

  return {
    capabilities,

    async acquireRunSlot(req: AcquireRunSlotRequest): Promise<AcquireRunSlotResult> {
      // A throw here (ledger / filesystem / provider fault) PROPAGATES verbatim:
      // the runtime's catch maps it to worker_pool_acquire_error. We do NOT wrap it.
      // `AcquireRunSlotRequest` is structurally the pool's `AcquireRequest`, so the
      // request is forwarded 1:1 (no field copy that would re-introduce undefined
      // under exactOptionalPropertyTypes).
      const acquired: AcquireResult = await pool.acquire(req);

      if (acquired.status !== "leased") {
        // Preserve the SAME typed no_capacity reason the pool returned; the
        // runtime maps every reason onto the single worker_host_capacity event.
        return { status: "no_capacity", reason: acquired.reason };
      }

      // (issueId, slotIndex) uniqueness invariant (STEP 3 / T3b): `(issueId,
      // slotIndex)` feeds BOTH the per-run `runKey` (`${slotIndex}`) and the
      // workspace slot suffix, so the coordinator must NEVER place two live slots
      // sharing it on ONE machine - they would collide on the endpoint/tunnel key
      // AND the workspace dir. We check the registry RIGHT AFTER bind and BEFORE
      // opening the endpoint (so a colliding endpoint is never minted): if a live
      // slot already holds this (issueId, slotIndex) on this worker, settle the
      // just-bound lease HEALTHY (the worker is fine) and assert-and-reject rather than
      // silently disambiguate (openQuestion #1). The runtime maps the throw to
      // worker_pool_acquire_error, leaving the first slot untouched.
      const machineLeaseId = acquired.lease.workerId;
      for (const existing of slots.values()) {
        if (
          existing.issueId === req.issueId &&
          existing.slotIndex === req.slotIndex &&
          existing.machineLeaseId === machineLeaseId
        ) {
          try {
            await acquired.lease.release("healthy");
          } catch {
            // Swallow: the collision is the surfaced fault; the worker is healthy.
          }
          throw new RunSlotCollisionError({
            issueId: req.issueId,
            slotIndex: req.slotIndex,
            machineLeaseId,
          });
        }
      }

      // STEP 3 (T3c #1): tunnel-exhaustion ceiling. When `maxConcurrentTunnels` is
      // set, opening another per-run endpoint that would exceed it surfaces as a
      // TYPED `no_capacity` ('tunnel_exhausted'), NEVER an unhandled throw inside
      // acquireRunSlot. We check this AFTER lease-bind + the collision guard but
      // BEFORE the open so a budget-exhausted slot never mints (then has to tear
      // down) a tunnel. The ceiling counts ONLY live remote tunnels and applies
      // ONLY when this open would actually mint one - a local (empty) host
      // (and the null passthrough, which mints nothing) consumes no `ssh -N` child,
      // so it is neither gated by nor counted against the budget. The just-bound
      // WorkerLease is settled HEALTHY (the worker is fine; only the tunnel budget is
      // exhausted) and NO slot is registered, so a sibling run recovers via the
      // single `worker_host_capacity` dispatch signal instead of seeing a fault.
      //
      // The ceiling check + the reservation are a SINGLE synchronous step (no
      // `await` between `liveTunnelCount()` and `reservedTunnels += 1`): two
      // concurrent acquires therefore cannot both pass it, because the second's
      // count includes the first's pending reservation. The reservation is held
      // across the (awaited) open so the gap between check and registration cannot
      // be over-subscribed; it is released on open FAILURE and otherwise handed off
      // to the slot's settlement (so the budget is freed exactly once when the run
      // finishes). Mirrors the worker pool's reservedProvisions single-flight.
      const runKey = runKeyFor(req.issueId, req.slotIndex);
      const tunnelCeiling = currentSettings.maxConcurrentTunnels;
      // Whether THIS run actually consumes a per-run MCP endpoint. The Codex/appserver
      // executor runs its dynamic tools IN-PROCESS and ignores the endpoint, so a
      // run that needs none must SKIP the open AND the tunnel reservation/ceiling
      // entirely (it would otherwise be SKIPPED by an open failure / port-forward
      // restriction / maxConcurrentTunnels for an endpoint it never uses). Only
      // ACP/Claude reads `/mcp` over the reverse tunnel. Defaults to `true`
      // (the existing ACP behaviour) when a legacy caller omits the field.
      const needsMcpEndpoint = req.needsMcpEndpoint ?? true;
      const wouldOpenTunnel =
        needsMcpEndpoint &&
        mcpEndpointManager.perRunEndpoint &&
        !isLocalWorkerHost(acquired.lease.workerHost);
      let tunnelReserved = false;
      if (wouldOpenTunnel && tunnelCeiling !== undefined) {
        if (liveTunnelCount() >= tunnelCeiling) {
          // Settle the just-bound lease HEALTHY (best-effort; a settle hiccup must
          // not mask the capacity signal) and return the typed no_capacity reason.
          try {
            await acquired.lease.release("healthy");
          } catch {
            // Swallow: the worker is healthy; the capacity signal is what we surface.
          }
          return { status: "no_capacity", reason: "tunnel_exhausted" };
        }
        // Take the reservation in the SAME JS tick the ceiling check passed.
        reservedTunnels += 1;
        tunnelReserved = true;
      }
      // Releases this acquire's pending tunnel reservation exactly once (a no-op if
      // none was taken or it was already released/handed off).
      const releaseReservation = (): void => {
        if (tunnelReserved) {
          tunnelReserved = false;
          reservedTunnels -= 1;
        }
      };

      // STEP 2: open the WHOLE per-run endpoint AFTER the lease-bind (the null
      // manager still mints nothing, keeping the single-slot/local path
      // byte-identical). The runKey is the issue-scoped `${issueId}#${slotIndex}`.
      // SKIP the open entirely for a run that consumes no endpoint (Codex/appserver):
      // the slot binds with a null endpoint (no reservation was taken, since
      // wouldOpenTunnel is false when needsMcpEndpoint is false) so it can never be
      // SKIPPED by an open failure / port-forward restriction for an endpoint it
      // would never use. Falls through to the SHARED register-the-slot path below.
      let endpoint: Awaited<ReturnType<McpEndpointManager["open"]>> = null;
      if (needsMcpEndpoint) {
        try {
          endpoint = await mcpEndpointManager.open({
            // Thread the FULL workflow Settings the REQUEST carries (NOT the
            // coordinator's WorkerPoolSettings). The concrete per-run manager reads
            // `settings.server.port` via acquireAgentMcpEndpointForRun to build the
            // remote endpoint; a WorkerPoolSettings has no server.port, so forwarding it
            // would fail every acquire and never dispatch. The null manager ignores it.
            // The production runtime ALWAYS supplies the full Settings here; the
            // `?? currentSettings` bridge only covers a legacy passthrough caller that
            // pre-dates the request field (which already injects a full Settings as its
            // coordinator `settings`), so the no-server.port WorkerPoolSettings never
            // reaches the concrete manager.
            settings: req.settings ?? (currentSettings as unknown as Settings),
            workerHost: acquired.lease.workerHost,
            runKey,
          });
        } catch (openError) {
          // The endpoint failed to OPEN after the lease was already bound. The worker
          // itself is fine (only the endpoint failed), so settle the just-bound lease
          // HEALTHY - never poison it - and leave NO half-open child / RunSlot. The
          // pending tunnel reservation is released here (the open never minted a
          // tunnel) so a failed open never strands budget. A failure to settle here
          // must not mask the original open error, so the settle is best-effort.
          // Rethrow a structured acquire error the runtime maps to
          // worker_pool_acquire_error.
          releaseReservation();
          try {
            await acquired.lease.release("healthy");
          } catch {
            // Swallow: the original endpoint-open failure is the surfaced cause.
          }
          throw new EndpointOpenError({
            cause: openError,
            workerHost: acquired.lease.workerHost,
            runKey,
          });
        }
      }

      const slot = createRunSlot({
        lease: acquired.lease,
        issueId: req.issueId,
        slotIndex: req.slotIndex,
        endpoint,
        mcpEndpointManager,
        logEvent,
        onSettled: (slotId) => {
          slots.delete(slotId);
        },
      });
      slots.set(slot.slotId, slot);
      // Hand the budget from the pending reservation to the now-registered slot in
      // the SAME synchronous tick as the `slots.set` (no `await` between them, so a
      // concurrent acquire can never observe a moment where neither the reservation
      // nor the registered slot is counted). A registered slot whose `mcpEndpoint`
      // is non-null is itself counted by `liveTunnelCount`, so keeping the
      // reservation too would DOUBLE-count this tunnel; release it here.
      releaseReservation();
      return { status: "bound", slot };
    },

    // The coordinator IS the orchestrator's capacity authority: both methods
    // re-read live pool state on every call (never a cached snapshot), so a
    // reconcile that disables the pool is observed immediately.
    governs(): boolean {
      return pool.isEnabled();
    },

    canAcquire(): boolean {
      return pool.canAcquire();
    },

    onCapacityAvailable(cb: () => void): void {
      // Forward to the pool's additive hook when present. Registration is
      // DEFENSIVE like onMachineRecycling above: an older/partial pool injected
      // via the bare-workerPool passthrough may predate the hook, in which case the
      // runtime simply keeps its interval-only polling.
      pool.onCapacityAvailable?.(cb);
    },

    async reconcile(next: WorkerPoolSettings): Promise<void> {
      // Load any out-of-tree driver module FIRST (only when the next settings are
      // enabled, mirroring the pool's disable path which skips swapDriver
      // entirely): the injected loader dynamic-imports + registers the module so
      // the pool's registry resolution below stays synchronous. A load failure
      // rejects here, BEFORE the pool is touched - the same transactional
      // last-good behavior as a pool rollback. A module registered for a
      // reconcile that later throws is harmless: the registry is a catalog, and
      // an unused entry is inert.
      if (next.enabled) await deps.driverLoader?.(next.driver);
      // Reconcile the pool NEXT: pool.reconcile -> swapDriver -> registry resolve
      // can THROW (e.g. worker_pool_driver_unavailable) when a reload changes the
      // driver to an unavailable kind, and the pool rolls itself back to last-good
      // on that throw. Only AFTER it succeeds do we commit the coordinator-owned
      // settings (the tunnel-exhaustion ceiling) so a rejected reload cannot strand
      // currentSettings on a config the pool refused - keeping the reload
      // transactional end-to-end. The live-slot registry is preserved across the
      // reload (so per-issue accounting and the tunnel refcount cannot desync), and
      // the singleton is NOT reconstructed.
      pool.reconcile(next);
      currentSettings = next;
    },

    async drain(opts: { deadlineMs: number; signal?: AbortSignal }): Promise<void> {
      await pool.drain(opts);
      // The pool's force-destroy fired the recycle callback for every worker, starting
      // each bound slot's fail() (fire-and-forget there). Await those so per-run
      // endpoint / local-server / tunnel cleanup is fully settled before drain
      // returns and the daemon stops the local MCP server and exits.
      if (pendingRecycleFails.size > 0) {
        await Promise.allSettled([...pendingRecycleFails]);
      }
    },

    async hydrate(): Promise<void> {
      await pool.hydrate();
    },

    snapshot(): DispatchCoordinatorSnapshot {
      const base = pool.snapshot();
      const slotEntries: RunSlotSnapshotEntry[] = [];
      for (const slot of slots.values()) {
        slotEntries.push({
          slotId: slot.slotId,
          machineLeaseId: slot.machineLeaseId,
          issueId: slot.issueId,
          slotIndex: slot.slotIndex,
          workerHost: slot.workerHost,
          remotePort: remotePortFromEndpoint(slot.mcpEndpoint),
        });
      }
      return { ...base, slots: slotEntries };
    },
  };
}

/**
 * The remote port a slot's per-run MCP endpoint is bound to, derived from the
 * lease URL (`http://127.0.0.1:<remotePort>/...` on the worker side). `null`
 * when no endpoint is bound (null endpoint manager, local worker host, or a
 * URL without an explicit port).
 */
function remotePortFromEndpoint(endpoint: AgentMcpEndpointLease | null): number | null {
  if (!endpoint) return null;
  try {
    const port = Number(new URL(endpoint.url).port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}
