// @lorenz/dispatch-coordinator
//
// Runtime-facing coordinator that wraps the proven @lorenz/worker-pool
// machine pool and an injected McpEndpointManager to mint per-run RunSlots.
// Distinct from the pure-policy @lorenz/dispatch package.
//
// With default slotsPerMachine=1 and the null McpEndpointManager every RunSlot
// carries mcpEndpoint=null, so the runtime boundary is byte-identical to calling
// the WorkerPool directly. A concrete McpEndpointManager adds per-run MCP
// endpoints and co-residence behind this same surface.

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
