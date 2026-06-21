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
 * Out-of-tree worker-driver loading: the configured worker-pool driver accepts a MODULE
 * SPECIFIER (an npm package name, `@scope/name`, `./relative` or `/absolute`
 * path, with an optional `#exportName` suffix) in addition to a registered
 * kind. The daemon dynamic-imports the module at startup (and on a reload that
 * changes the specifier) and registers it into the worker-driver registry under
 * the EXACT configured string, so the pool's existing registry resolution
 * (`registry.require(settings.driver)`) needs no changes and third parties
 * ship drivers without forking the repo.
 *
 * This is the first instantiation of the axis-generic {@link createExtensionLoader}
 * core: every behavioral literal (the `worker_pool_driver_*` error prefix, the
 * `worker_pool_driver_loaded` / `worker_pool_driver_module_pinned` events, the
 * `assertWorkerDriverModule` handshake, the `create`-function module shape, the
 * exact-kind-wins resolution, the per-registry pin WeakMap) is supplied through
 * the axis spec below, so worker-driver behavior is unchanged while the same
 * mechanics now serve the tracker/tool/agent-executor axes too.
 *
 * Trust: a dynamic import runs arbitrary code in the daemon process - the same
 * trust boundary as workspace hooks. Loads happen ONLY here (startup/reload),
 * never on the acquire path, and the `worker_pool_driver_loaded` audit event
 * records exactly which code went live from where.
 *
 * Module pinning: Node's ESM cache loads a given specifier's code once per
 * daemon lifetime. Changing driver CODE requires a daemon restart; changing
 * the CONFIG to a different specifier hot-loads the new module. A reload that
 * re-encounters an already-loaded specifier emits
 * `worker_pool_driver_module_pinned` so the pin is observable, and cache-busting
 * query strings are rejected (unbounded module-graph growth, half-initialized
 * module hazards).
 */

/** A parsed configured worker-pool driver value that is not a registered kind. */
export type WorkerDriverRef = ExtensionRef;

/** Options for {@link ensureWorkerDriverLoaded}. */
export type EnsureWorkerDriverLoadedOptions = EnsureExtensionLoadedOptions;

/** The worker-driver instantiation of the axis-generic loader. */
const workerDriverLoader = createExtensionLoader<WorkerDriverFactory, WorkerDriverModule>({
  errorPrefix: "worker_pool_driver",
  eventNames: {
    loaded: "worker_pool_driver_loaded",
    pinned: "worker_pool_driver_module_pinned",
  },
  defineHelperName: "defineWorkerDriver",
  unitNoun: "worker drivers",
  assertModule: assertWorkerDriverModule,
  looksLikeModule: (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { create?: unknown }).create === "function",
  toFactory: (specifier, module) => ({
    kind: specifier,
    create: (driverOptions, deps) => module.create(driverOptions, deps),
  }),
  describeModule: (module) => ({ kind: module.kind, sdkVersion: module.sdkVersion }),
});

/**
 * Parses a configured driver string into its module-specifier form. Resolution
 * rule (the single authority for the one-field-two-grammars overload): an
 * EXACT registered kind always wins - {@link ensureWorkerDriverLoaded} checks
 * `registry.get(driver)` BEFORE calling this, so a published npm package named
 * `docker` can never shadow the built-in. A `#name` suffix selects a named
 * export; everything else is the specifier itself.
 */
export function parseWorkerDriverRef(driver: string): WorkerDriverRef {
  return workerDriverLoader.parseRef(driver);
}

/**
 * Idempotently makes the configured worker-pool driver resolvable in
 * `registry`. A registry hit (a built-in kind, an extension, or a specifier a
 * previous call already loaded) is a no-op - except that a re-encountered
 * loader-registered specifier emits `worker_pool_driver_module_pinned` so the
 * code-is-pinned semantic is observable on reload. A miss parses the driver as
 * a module reference, dynamic-imports it, and registers a factory whose kind
 * IS the configured specifier string, emitting `worker_pool_driver_loaded`.
 *
 * Called by the daemon BEFORE `createWorkerPool` at startup and (via the
 * coordinator's injected `driverLoader`) BEFORE `pool.reconcile` on reload, so
 * the pool's registry resolution stays synchronous and transactional. A module
 * registered for a reconcile that later fails is harmless: the registry is a
 * catalog, and an unused entry is inert.
 */
export async function ensureWorkerDriverLoaded(
  driver: string,
  registry: WorkerDriverRegistry,
  options: EnsureWorkerDriverLoadedOptions = {},
): Promise<void> {
  return workerDriverLoader.ensureLoaded(driver, registry, options);
}
