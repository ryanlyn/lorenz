// The NULL passthrough McpEndpointManager.

import type { McpEndpointManager } from "./types.js";

/**
 * The no-op {@link McpEndpointManager}: when no concrete per-run endpoint manager
 * is injected, the coordinator uses this so it stays a passthrough over the
 * existing WorkerPool. `perRunClaimEnforcement` is `false` (the capability the
 * startup gate reads), `open()` resolves to `null` (no per-run endpoint is minted,
 * so acp owns its own endpoint), and `release(null)` is a no-op. Stateless, so a
 * single frozen singleton is safe to share.
 */
export const nullEndpointManager: McpEndpointManager = Object.freeze({
  perRunClaimEnforcement: false,
  async open(): Promise<null> {
    // no-op: acp keeps its own endpoint. The trivial await satisfies the port's
    // Promise-returning contract without an unused-await lint conflict.
    await Promise.resolve();
    return null;
  },
  async release(): Promise<void> {
    // no-op: the null manager never holds a lease.
    await Promise.resolve();
  },
});

/**
 * Constructs a NULL passthrough {@link McpEndpointManager}. The shared
 * {@link nullEndpointManager} singleton is sufficient (the manager is stateless),
 * but a factory keeps the construction site symmetric with the concrete remote
 * manager and lets a caller hold a distinct instance if it wants reference
 * identity.
 */
export function createNullEndpointManager(): McpEndpointManager {
  return nullEndpointManager;
}
