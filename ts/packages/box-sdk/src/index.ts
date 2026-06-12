// The box-driver SDK: the contract a box backend implements to join the warm
// worker box pool, the registry the composition root wires it into, and the
// in-memory reference driver. The conformance kit lives behind the
// `@symphony/box-sdk/conformance` subpath so the runtime barrel never pulls
// vitest.

export {
  POOL_OWNED_LABEL,
  type BoxDescriptor,
  type BoxDriver,
  type BoxDriverFactory,
  type BoxHealth,
  type DriverCapabilities,
  type DriverDeps,
  type ProvisionRequest,
  type SshRunOptions,
  type SshRunResult,
  type SshRunner,
  type TeardownReason,
} from "./types.js";

export { BoxDriverRegistry, defaultBoxDriverRegistry } from "./registry.js";

export {
  BOX_DRIVER_SDK_VERSION,
  assertBoxDriverModule,
  defineBoxDriver,
  type BoxDriverModule,
} from "./module.js";

export { FakeBoxDriver, fakeBoxDriverFactory, registerFakeBoxDriver } from "./fake.js";
