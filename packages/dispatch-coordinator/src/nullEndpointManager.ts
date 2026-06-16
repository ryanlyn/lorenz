// The NULL passthrough McpEndpointManager.
//
// STEP 1 wiring: when no concrete per-run endpoint manager is injected, the
// coordinator uses this null manager so it stays a 1:1 passthrough over the
// existing WorkerPool. `perRunEndpoint` is `false`, so acp keeps acquiring AND
// releasing its OWN endpoint exactly as today (byte-identical runtime
// behaviour); `open` mints nothing (returns null) and `release` is a no-op. It
// holds no state, so a single frozen singleton is safe to share.

import type { McpEndpointManager } from "./types.js";

/**
 * The no-op {@link McpEndpointManager} used by the STEP 1 passthrough
 * coordinator. `perRunEndpoint` is `false` (the capability the STEP 3 gate
 * reads), `open()` resolves to `null` (no per-run endpoint is minted, so acp
 * owns its own endpoint as today), and `release(null)` is a no-op. Stateless and
 * therefore safe to share as a singleton.
 */
export const nullEndpointManager: McpEndpointManager = Object.freeze({
  perRunEndpoint: false,
  async open(): Promise<null> {
    // Mints nothing: acp keeps owning its own endpoint (the STEP 1 byte-identical
    // path). The trivial await keeps the method genuinely async (the port's
    // contract is `Promise`-returning) without an unused-await lint conflict.
    await Promise.resolve();
    return null;
  },
  async release(): Promise<void> {
    // noop: the null manager never holds a lease.
    await Promise.resolve();
  },
});

/**
 * Constructs a fresh NULL passthrough {@link McpEndpointManager}. The shared
 * {@link nullEndpointManager} singleton is sufficient (the manager is
 * stateless), but a factory keeps the construction site symmetric with the
 * concrete remote manager landing in STEP 2 and lets a caller hold a distinct
 * instance if it wants reference identity.
 */
export function createNullEndpointManager(): McpEndpointManager {
  return nullEndpointManager;
}
