import { isRecord } from "@lorenz/domain";
import {
  assertWorkerDriverModule,
  type WorkerDriverFactory,
  type WorkerDriverModule,
  type WorkerDriverRegistry,
} from "@lorenz/worker-sdk";

import {
  createExtensionLoader,
  type EnsureExtensionLoadedOptions,
  type ExtensionRef,
} from "./extensionLoader.js";

/**
 * Out-of-tree worker-driver loading: `worker.worker_pool.driver` accepts a module
 * specifier in addition to a registered kind. Instantiates the axis-generic
 * {@link createExtensionLoader}; identity field is the driver `kind`. See
 * {@link createExtensionLoader} for the trust boundary, module pinning, and
 * exact-kind-wins resolution shared by every axis.
 */

/** A parsed configured worker-pool driver value that is not a registered kind. */
export type WorkerDriverRef = ExtensionRef;

/** Options for {@link ensureWorkerDriverLoaded}. */
export type EnsureWorkerDriverLoadedOptions = EnsureExtensionLoadedOptions;

const workerDriverLoader = createExtensionLoader<WorkerDriverFactory, WorkerDriverModule>({
  errorPrefix: "worker_pool_driver",
  eventNames: {
    loaded: "worker_pool_driver_loaded",
    pinned: "worker_pool_driver_module_pinned",
  },
  defineHelperName: "defineWorkerDriver",
  unitNoun: "worker drivers",
  assertModule: assertWorkerDriverModule,
  looksLikeModule: (value) => isRecord(value) && typeof value["create"] === "function",
  toFactory: (specifier, module) => ({
    kind: specifier,
    create: (driverOptions, deps) => module.create(driverOptions, deps),
  }),
  describeModule: (module) => ({ kind: module.kind, sdkVersion: module.sdkVersion }),
});

/** Parses a configured driver string into its module-specifier form. */
export function parseWorkerDriverRef(driver: string): WorkerDriverRef {
  return workerDriverLoader.parseRef(driver);
}

/**
 * Idempotently makes the configured worker-pool driver resolvable in `registry`
 * (see {@link createExtensionLoader} for the load/pin semantics). Called by the
 * daemon BEFORE `createWorkerPool` at startup and (via the coordinator's injected
 * `driverLoader`) BEFORE `pool.reconcile` on reload, so the pool's registry
 * resolution stays synchronous and transactional.
 */
export async function ensureWorkerDriverLoaded(
  driver: string,
  registry: WorkerDriverRegistry,
  options: EnsureWorkerDriverLoadedOptions = {},
): Promise<void> {
  return workerDriverLoader.ensureLoaded(driver, registry, options);
}
