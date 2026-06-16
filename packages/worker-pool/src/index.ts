// Public barrel for @lorenz/worker-pool: the pool ENGINE.
//
// Exports the pool surface (createWorkerPool + the lease/inventory/snapshot types)
// and re-exports the driver contract from `@lorenz/worker-sdk` so the engine
// surface stays one-stop for the runtime/CLI. Importing this barrel has NO side
// effects: no driver is registered here. Concrete drivers live in extensions
// (and the in-memory fake in the SDK); the composition root registers them into
// a `WorkerDriverRegistry` (or the process-wide default) and threads that registry
// to `createWorkerPool` via `CreateWorkerPoolDeps.drivers`.

export type {
  AcquireRequest,
  AcquireResult,
  WorkerLease,
  WorkerOutcome,
  WorkerPool,
  WorkerPoolSnapshot,
  WorkerRecord,
  WorkerState,
  LedgerRow,
  MachineLease,
  Mutex,
} from "./types.js";

export { createMutex } from "./mutex.js";

export { createWorkerPool, type CreateWorkerPoolDeps } from "./pool.js";

// Driver-contract surface re-exported from the SDK so downstream engine
// consumers can keep importing it from this package.
export {
  WorkerDriverRegistry,
  defaultWorkerDriverRegistry,
  FakeWorkerDriver,
  POOL_OWNED_LABEL,
  registerFakeWorkerDriver,
} from "@lorenz/worker-sdk";
export type {
  WorkerDescriptor,
  WorkerDriver,
  WorkerDriverFactory,
  WorkerHealth,
  DriverDeps,
  TeardownReason,
} from "@lorenz/worker-sdk";
