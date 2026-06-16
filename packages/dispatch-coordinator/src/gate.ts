// Pure predicate behind the `worker.worker_pool.slots_per_machine > 1` co-residence
// safety gate. Extracted here (a leaf, dependency-light module) so the SAME check
// drives BOTH enforcement points without duplication or drift:
//
//   1. the daemon STARTUP gate (`assertSlotsPerMachineGate` in the CLI), which
//      throws the returned message, and
//   2. the runtime RELOAD guard (`reloadWorkflowIfConfigured`), which keeps the
//      last-good settings and emits `workflow_reload_failed` with the message
//      instead of reconciling the live pool onto unsafe co-resident settings.
//
// Keeping it pure (settings + capability flag in, message-or-null out) means the
// reload path can run the exact gate the daemon ran at startup, closing the hole
// where a live daemon could reload `max_in_flight > 1` past a gate that only ran
// once at boot.

import type { WorkerPoolSettings } from "@lorenz/domain";

/** The subset of a coordinator's capabilities the gate consumes. */
export interface SlotsPerMachineGateCapabilities {
  readonly perRunEndpoint: boolean;
}

/**
 * Returns an operator-facing error message when `workerPool` would be unsafe to run,
 * or `null` when it passes. Co-residence packs multiple run slots onto one machine,
 * so `slotsPerMachine > 1` requires BOTH:
 *
 *  1. a coordinator that advertises `capabilities.perRunEndpoint === true` (each
 *     RunSlot owns its own MCP endpoint - token + local-server + tunnel - so two
 *     co-resident runs never share or tear out each other's endpoint), and
 *  2. an explicit `worker.worker_pool.co_residence` operator opt-in, because a single
 *     poisoned worker fails every co-resident run on recycle: widening that blast
 *     radius is a deliberate tradeoff, not just a capability.
 *
 * `slotsPerMachine === 1` (the default), an absent pool, a DISABLED pool (a dormant
 * `max_in_flight > 1` is unused while the pool is off - runs go static/local), or
 * absent capabilities all return `null` - the gate never triggers, so the
 * single-tenant path stays byte-identical.
 */
export function checkSlotsPerMachineGate(
  workerPool: WorkerPoolSettings | undefined,
  capabilities: SlotsPerMachineGateCapabilities | undefined,
): string | null {
  if (!workerPool || workerPool.enabled === false || workerPool.slotsPerMachine <= 1) return null;

  if (capabilities?.perRunEndpoint !== true) {
    return (
      "worker.worker_pool.max_in_flight > 1 requires a dispatch coordinator with per-run MCP " +
      "endpoints (capabilities.perRunEndpoint), which the current build does not provide"
    );
  }
  if (workerPool.coResidence !== true) {
    return (
      "worker.worker_pool.max_in_flight > 1 requires the explicit worker.worker_pool.co_residence " +
      "opt-in: co-residence shares one machine across runs, so a poisoned worker fails every " +
      "co-resident run on recycle. Set worker.worker_pool.co_residence: true to accept this " +
      "blast radius"
    );
  }
  return null;
}
