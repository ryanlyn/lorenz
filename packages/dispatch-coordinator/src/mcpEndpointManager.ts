// The CONCRETE per-run McpEndpointManager (STEP 2 / T2c).
//
// Where the NULL passthrough mints nothing (acp keeps owning its own endpoint),
// this manager OWNS the WHOLE per-run MCP endpoint lease (auth token + refcounted
// local mcp server + reverse tunnel, bundled behind one `AgentMcpEndpointLease`)
// so two co-resident runs on one machine never share a single host-keyed endpoint.
//
// Dependency direction (invariant #8): this package must stay free of any
// `@lorenz/mcp` / tunnel RUNTIME dependency, so the concrete acquire function
// (`acquireAgentMcpEndpointForRun`) is INJECTED, not imported. The daemon wiring
// (apps/cli/daemon.ts), which already depends on `@lorenz/mcp`, threads the real
// function in. The `AgentMcpEndpointLease` type is pulled in TYPE-ONLY (fully
// erased by tsc), so no runtime edge to `@lorenz/mcp` is formed here.

import type { Settings } from "@lorenz/domain";
import type { AgentMcpEndpointLease } from "@lorenz/mcp";

import type { McpEndpointManager } from "./types.js";

/**
 * The injected per-run endpoint acquirer. Structurally matches
 * `acquireAgentMcpEndpointForRun(settings, workerHost, runKey)` from
 * `@lorenz/mcp`, which issues the token, refcounts the local server, and opens
 * the per-run tunnel via `workerHostPool.openForRun(...)`, returning ONE lease
 * whose `release()` revokes the token, drops the local-server ref, and calls
 * `closeForRun(...)` (all three sub-resources owned together).
 */
export type AcquireAgentMcpEndpointForRun = (
  settings: Settings,
  workerHost: string,
  runKey: string,
) => Promise<AgentMcpEndpointLease>;

/** Constructor deps for {@link createPerRunEndpointManager}. */
export interface CreatePerRunEndpointManagerDeps {
  /** The injected `acquireAgentMcpEndpointForRun`-shaped function (from `@lorenz/mcp`). */
  acquireForRun: AcquireAgentMcpEndpointForRun;
}

/**
 * A `workerHost` is LOCAL (no per-run endpoint needed; acp keeps acquiring AND
 * releasing its own endpoint exactly as today) when it is empty. Every other
 * value is a real ssh-addressable host the per-run endpoint is opened against.
 * This mirrors acp's truthy-host => remote rule, so the single-slot / local path
 * stays byte-identical.
 */
function isLocalWorkerHost(workerHost: string): boolean {
  return workerHost.length === 0;
}

/**
 * Constructs the CONCRETE per-run {@link McpEndpointManager}
 * (`perRunClaimEnforcement = true`, the capability the startup gate consumes:
 * each run gets a scoped Token B claim the shared gateway re-checks server-side).
 * For an ssh-addressable
 * `workerHost` it opens the WHOLE per-run endpoint lease via the injected
 * `acquireForRun`; for a local (empty) host it returns `null` (acp keeps its
 * own endpoint, the byte-identical local path). `release(lease)` closes the lease
 * (revoking the token, dropping the local-server ref, and closing the per-run
 * tunnel together) and is a safe no-op for the `null` local lease.
 */
export function createPerRunEndpointManager(
  deps: CreatePerRunEndpointManagerDeps,
): McpEndpointManager {
  const { acquireForRun } = deps;
  return {
    perRunClaimEnforcement: true,
    async open(req: {
      settings: Settings;
      workerHost: string;
      runKey: string;
    }): Promise<AgentMcpEndpointLease | null> {
      if (isLocalWorkerHost(req.workerHost)) {
        // Local host: mint nothing so acp keeps acquiring AND releasing its own
        // endpoint (the single-slot / local path is untouched).
        return null;
      }
      return acquireForRun(req.settings, req.workerHost, req.runKey);
    },
    async release(lease: AgentMcpEndpointLease | null): Promise<void> {
      // The local path minted no lease; releasing null is a safe no-op so the
      // RunSlot settle path is uniform whether or not an endpoint was opened.
      if (lease === null) return;
      await lease.release();
    },
  };
}
