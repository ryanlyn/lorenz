import { makeSdkModuleContract } from "@lorenz/domain";

import type { WorkerDriverFactory } from "./types.js";

/**
 * The worker-driver SDK version this build of the engine speaks. Out-of-tree
 * driver modules declare the version they target via
 * {@link WorkerDriverModule.sdkVersion}; the loader rejects a mismatch before the
 * module ever reaches the registry. Major-only: additive, backwards-compatible
 * SDK changes never bump it.
 */
export const WORKER_DRIVER_SDK_VERSION = 1;

/**
 * The unit an OUT-OF-TREE worker-driver module exports: a {@link WorkerDriverFactory}
 * carrying the SDK version it targets. A dynamically imported module crosses a
 * version boundary the daemon cannot type-check, so the explicit `sdkVersion`
 * handshake stands in for the compiler.
 */
export interface WorkerDriverModule extends WorkerDriverFactory {
  readonly sdkVersion: number;
}

const contract = makeSdkModuleContract<WorkerDriverModule>({
  errorPrefix: "worker_pool_driver",
  moduleNoun: "a worker driver module",
  identityField: "kind",
  defineCall: "defineWorkerDriver({ kind, sdkVersion, create })",
  requiredFns: [{ field: "create", signature: "create(options, deps)", article: "a" }],
  sdkVersion: WORKER_DRIVER_SDK_VERSION,
});

/**
 * Structural check + version handshake for a dynamically loaded worker-driver
 * module. `source` names where the value came from so every error is actionable.
 */
export const assertWorkerDriverModule: (
  value: unknown,
  source: string,
) => asserts value is WorkerDriverModule = contract.assertModule;

/**
 * Authoring sugar for out-of-tree driver modules: shape-asserts the module at
 * definition time (so a typo fails in the author's tests, not the operator's
 * daemon) and returns it unchanged. Usage:
 *
 * ```ts
 * export default defineWorkerDriver({
 *   kind: "acme",
 *   sdkVersion: 1,
 *   create: (options, deps) => new AcmeWorkerDriver(options, deps),
 * });
 * ```
 */
export function defineWorkerDriver(module: WorkerDriverModule): WorkerDriverModule {
  return contract.defineModule(module, "defineWorkerDriver");
}
