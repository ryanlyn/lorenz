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
 * carrying the SDK version it targets. In-repo extensions register factories
 * directly (the composition root vouches for them); a dynamically imported
 * module instead crosses a version boundary the daemon cannot type-check, so
 * the explicit `sdkVersion` handshake stands in for the compiler.
 */
export interface WorkerDriverModule extends WorkerDriverFactory {
  readonly sdkVersion: number;
}

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
  assertWorkerDriverModule(module, "defineWorkerDriver");
  return module;
}

/**
 * Structural check + version handshake for a dynamically loaded worker-driver
 * module. `source` names where the value came from (a module specifier, or
 * `defineWorkerDriver` at authoring time) so every error is actionable. Throws:
 *
 * - `worker_pool_driver_module_invalid: <source> ...` when the value is not an
 *   object, `kind` is not a non-empty string, `create` is not a function, or
 *   `sdkVersion` is not a number;
 * - `worker_pool_driver_sdk_mismatch: <source> targets SDK v<n>, this build
 *   supports v<WORKER_DRIVER_SDK_VERSION>` when the declared version differs.
 */
export function assertWorkerDriverModule(
  value: unknown,
  source: string,
): asserts value is WorkerDriverModule {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `worker_pool_driver_module_invalid: ${source} did not yield a worker driver module object ` +
        `(got ${value === null ? "null" : typeof value}); export defineWorkerDriver({ kind, sdkVersion, create }) ` +
        `as the default export or a named export`,
    );
  }
  const candidate = value as Partial<WorkerDriverModule>;
  if (typeof candidate.kind !== "string" || candidate.kind.trim() === "") {
    throw new Error(
      `worker_pool_driver_module_invalid: ${source} is missing a non-empty string \`kind\``,
    );
  }
  if (typeof candidate.create !== "function") {
    throw new Error(
      `worker_pool_driver_module_invalid: ${source} (kind: ${candidate.kind}) is missing a \`create(options, deps)\` function`,
    );
  }
  if (typeof candidate.sdkVersion !== "number") {
    throw new Error(
      `worker_pool_driver_module_invalid: ${source} (kind: ${candidate.kind}) is missing a numeric \`sdkVersion\` ` +
        `(declare sdkVersion: ${WORKER_DRIVER_SDK_VERSION})`,
    );
  }
  if (candidate.sdkVersion !== WORKER_DRIVER_SDK_VERSION) {
    throw new Error(
      `worker_pool_driver_sdk_mismatch: ${source} targets SDK v${candidate.sdkVersion}, ` +
        `this build supports v${WORKER_DRIVER_SDK_VERSION}`,
    );
  }
}
