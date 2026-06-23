// The worker SDK: the contract a worker backend implements to join the warm
// worker pool, the registry the composition root wires it into, and the
// in-memory reference driver. The conformance kit lives behind the
// `@lorenz/worker-sdk/conformance` subpath so the runtime barrel never pulls
// vitest.

export {
  POOL_OWNED_LABEL,
  type WorkerDescriptor,
  type WorkerDriver,
  type WorkerDriverFactory,
  type WorkerHealth,
  type DriverCapabilities,
  type DriverDeps,
  type ProvisionRequest,
  type SshRunOptions,
  type SshRunResult,
  type SshRunner,
  type TeardownReason,
} from "./types.js";

export { WorkerDriverRegistry, defaultWorkerDriverRegistry } from "./registry.js";

export {
  WORKER_DRIVER_SDK_VERSION,
  assertWorkerDriverModule,
  defineWorkerDriver,
  type WorkerDriverModule,
} from "./module.js";

export { FakeWorkerDriver, fakeWorkerDriverFactory, registerFakeWorkerDriver } from "./fake.js";

export {
  LocalWorkerDriver,
  localWorkerDriverFactory,
  registerLocalWorkerDriver,
} from "./local.js";
