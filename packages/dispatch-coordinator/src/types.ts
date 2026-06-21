// Shared types for @lorenz/dispatch-coordinator.
//
// Leaf types module: every implementation file (runSlot, mcpEndpointManager, the
// coordinator) imports from here so concrete files never form import cycles. The
// only cross-package value dependencies are the canonical worker-pool/domain nouns.
//
// `AgentMcpEndpointLease` (from `@lorenz/mcp`) is the WHOLE per-run endpoint
// lease (auth token + refcounted local mcp server + reverse tunnel) the
// coordinator owns end-to-end in later steps. It is pulled in with a TYPE-ONLY
// import so it is fully erased by tsc and forms NO runtime edge to
// `@lorenz/mcp` (which pulls in the observability server, the tunnel pool,
// hono, etc.) - keeping this package (and `worker-pool`) free of any
// mcp/tunnel RUNTIME dependency (invariant #8 in the dispatch-coordinator plan).
// In STEP 1 every RunSlot carries `mcpEndpoint = null`, so nothing here reads the
// lease at runtime yet; the type lives here only to nail the contract shape.

import type { Settings } from "@lorenz/domain";
import type { AgentMcpEndpointLease } from "@lorenz/mcp";
import type { WorkerOutcome } from "@lorenz/worker-pool";

/**
 * One run's slot over a leased machine. A `RunSlot` fuses the machine-side
 * {@link WorkerLease} sub-handle (settle/heartbeat) with this run's optional
 * per-run MCP endpoint lease, plus the registry identity the coordinator keys
 * fairness/recycle accounting on.
 *
 * `release(outcome)` / `fail(reason)` are idempotent and exactly-once across
 * BOTH the normal settle path and a machine-recycle-initiated fail: they close
 * THIS slot's endpoint (a no-op when `mcpEndpoint` is null, as in STEP 1) THEN
 * delegate to the wrapped `WorkerLease` (itself leaseId+settled+DESTROYED guarded)
 * THEN deregister from the coordinator's registry.
 *
 * In STEP 1 the coordinator is a 1:1 passthrough: `mcpEndpoint` is always null,
 * so `release`/`fail` are byte-identical to the underlying `WorkerLease` settle.
 */
export interface RunSlot {
  /** Stable per-slot identity used as the registry key (issueId/slotIndex/leaseId derived). */
  readonly slotId: string;
  /** Identity of the underlying leased machine (the `WorkerLease.workerId`). */
  readonly machineLeaseId: string;
  /** The issue this slot serves (drives per-issue fairness accounting). */
  readonly issueId: string;
  /** The ensemble slot index this run occupies on its machine. */
  readonly slotIndex: number;
  /** The wrapped `WorkerLease` generation id; rotates on retry, settle-guarded. */
  readonly leaseId: string;
  /** SSH-addressable worker host this slot runs against. */
  readonly workerHost: string;
  /** Issue-scoped per-run key (`${issueId}#${slotIndex}`) feeding the per-run endpoint/tunnel. */
  readonly runKey: string;
  /** The WHOLE per-run endpoint lease, or null in STEP 1 / on the local path. */
  readonly mcpEndpoint: AgentMcpEndpointLease | null;
  /** Mirrors `WorkerLease.acquiredAtMs` (the lease-bind timestamp). */
  readonly acquiredAtMs: number;
  /** Forwards to `WorkerLease.heartbeat()` (orphan-detection keepalive). */
  heartbeat(): void;
  /**
   * Settle this slot exactly once: close the endpoint (noop for null) THEN
   * settle the wrapped lease with `outcome` (`healthy` keeps the worker, `poison`
   * recycles it) THEN deregister. A second call is a no-op.
   */
  release(outcome: WorkerOutcome): Promise<void>;
  /**
   * Settle this slot exactly once as a failure (equivalent to
   * `release('poison')` with a recorded `reason`). A second call is a no-op.
   */
  fail(reason: string): Promise<void>;
}

/**
 * Request to acquire a {@link RunSlot}. Mirrors the worker-pool `AcquireRequest`
 * shape so the STEP 1 coordinator can pass it straight through to `pool.acquire`
 * (1:1 passthrough). `affinityKey` is the prior `workerHost` for sticky retry,
 * NOT the pending sentinel.
 */
export interface AcquireRunSlotRequest {
  issueId: string;
  slotIndex: number;
  labels: ReadonlyArray<string>;
  affinityKey?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * The FULL workflow {@link Settings}, threaded straight to
   * `McpEndpointManager.open`. The concrete per-run manager reads
   * `settings.server.port` (via `acquireAgentMcpEndpointForRun`) to build the
   * remote endpoint, so the coordinator must forward the workflow Settings here -
   * NOT its own `WorkerPoolSettings`, which has no `server.port` and would make an
   * enabled per-run-endpoint pool fail at acquire and never dispatch. The null
   * passthrough ignores it.
   *
   * Optional only so a legacy passthrough caller that pre-dates this field (and
   * already injects a full Settings as the coordinator's constructor `settings`)
   * keeps compiling; the production runtime ALWAYS supplies it.
   */
  settings?: Settings;
  /**
   * Whether THIS run actually consumes a per-run MCP endpoint over the reverse
   * tunnel. Only the ACP/Claude executor reads the threaded `mcpEndpoint` (its
   * `/mcp` server is reached through the reverse tunnel); the Codex/appserver
   * executor runs its dynamic tools IN-PROCESS and IGNORES the endpoint entirely.
   *
   * When `false`, the coordinator SKIPS `mcpEndpointManager.open` AND the
   * tunnel-ceiling reservation/accounting for this acquire (the bound slot's
   * `mcpEndpoint` stays null), so a Codex worker-pool run is never SKIPPED by
   * mcp_endpoint_open_failed, remote port-forward restrictions, or
   * maxConcurrentTunnels for an endpoint it would never use.
   *
   * Defaults to `true` (the existing ACP behaviour) when omitted, so a legacy
   * caller that pre-dates this field keeps opening the per-run endpoint exactly as
   * before. The production runtime computes it from the resolved executor kind
   * (`acp` -> true; `appserver`/codex -> false).
   */
  needsMcpEndpoint?: boolean;
}

/**
 * The injected port the coordinator uses to own each run's WHOLE MCP endpoint
 * (per-run scoped Token B claim + refcounted local server + reverse tunnel) behind
 * ONE lease object. `perRunClaimEnforcement` is the capability the startup gate
 * consumes: a concrete remote manager mints per-run scoped Token B claims the shared
 * gateway re-checks server-side (resolve claim -> owner live -> generation fence ->
 * allowlist, else fail closed), so it reports `true`; the NULL passthrough enforces
 * nothing (acp keeps acquiring/releasing its own settings-wide endpoint, the STEP 1
 * byte-identical behaviour) and reports `false`.
 *
 * `open` returns null when this manager does not mint a per-run endpoint (the
 * NULL passthrough always, or the concrete manager on a local/non-ssh host).
 * `release` accepts that null and is a no-op for it, so the RunSlot settle path
 * is uniform whether or not an endpoint was minted.
 */
export interface McpEndpointManager {
  readonly perRunClaimEnforcement: boolean;
  open(req: {
    settings: Settings;
    workerHost: string;
    runKey: string;
  }): Promise<AgentMcpEndpointLease | null>;
  release(lease: AgentMcpEndpointLease | null): Promise<void>;
}
