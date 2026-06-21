// @lorenz/dispatch-coordinator
//
// Runtime-facing coordinator that wraps the proven @lorenz/worker-pool
// machine pool and an injected McpEndpointManager to mint per-run RunSlots.
// Distinct from the pure-policy @lorenz/dispatch package.
//
// STEP 1 surface: the DispatchCoordinator is a 1:1 passthrough over WorkerPool
// (default slotsPerMachine=1 + the null McpEndpointManager make every RunSlot
// carry mcpEndpoint=null), so the runtime boundary is byte-identical to calling
// the WorkerPool directly. Later steps add per-run MCP endpoints, co-residence, and
// a provider hot-swap behind this same surface.

export {
  createDispatchCoordinator,
  EndpointOpenError,
  LocalCoResidenceError,
  RunSlotCollisionError,
  type DispatchCoordinator,
  type CreateDispatchCoordinatorDeps,
  type AcquireRunSlotResult,
  type NoCapacityReason,
  type CapacityProbe,
  type DispatchCoordinatorSnapshot,
  type RunSlotSnapshotEntry,
} from "./coordinator.js";

export { type RunSlot, type AcquireRunSlotRequest, type McpEndpointManager } from "./types.js";

export { nullEndpointManager, createNullEndpointManager } from "./nullEndpointManager.js";

export {
  createPerRunEndpointManager,
  type CreatePerRunEndpointManagerDeps,
  type AcquireAgentMcpEndpointForRun,
} from "./mcpEndpointManager.js";

export { checkSlotsPerMachineGate, type SlotsPerMachineGateCapabilities } from "./gate.js";
