import type { BoxDriverFactory } from "./types.js";

/**
 * The box-driver SDK version this build of the engine speaks. Out-of-tree
 * driver modules declare the version they target via
 * {@link BoxDriverModule.sdkVersion}; the loader rejects a mismatch before the
 * module ever reaches the registry. Major-only: additive, backwards-compatible
 * SDK changes never bump it.
 */
export const BOX_DRIVER_SDK_VERSION = 1;

/**
 * The unit an OUT-OF-TREE box-driver module exports: a {@link BoxDriverFactory}
 * carrying the SDK version it targets. In-repo extensions register factories
 * directly (the composition root vouches for them); a dynamically imported
 * module instead crosses a version boundary the daemon cannot type-check, so
 * the explicit `sdkVersion` handshake stands in for the compiler.
 */
export interface BoxDriverModule extends BoxDriverFactory {
  readonly sdkVersion: number;
}

/**
 * Authoring sugar for out-of-tree driver modules: shape-asserts the module at
 * definition time (so a typo fails in the author's tests, not the operator's
 * daemon) and returns it unchanged. Usage:
 *
 * ```ts
 * export default defineBoxDriver({
 *   kind: "acme",
 *   sdkVersion: 1,
 *   create: (options, deps) => new AcmeBoxDriver(options, deps),
 * });
 * ```
 */
export function defineBoxDriver(module: BoxDriverModule): BoxDriverModule {
  assertBoxDriverModule(module, "defineBoxDriver");
  return module;
}

/**
 * Structural check + version handshake for a dynamically loaded box-driver
 * module. `source` names where the value came from (a module specifier, or
 * `defineBoxDriver` at authoring time) so every error is actionable. Throws:
 *
 * - `box_pool_driver_module_invalid: <source> ...` when the value is not an
 *   object, `kind` is not a non-empty string, `create` is not a function, or
 *   `sdkVersion` is not a number;
 * - `box_pool_driver_sdk_mismatch: <source> targets SDK v<n>, this build
 *   supports v<BOX_DRIVER_SDK_VERSION>` when the declared version differs.
 */
export function assertBoxDriverModule(
  value: unknown,
  source: string,
): asserts value is BoxDriverModule {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `box_pool_driver_module_invalid: ${source} did not yield a box driver module object ` +
        `(got ${value === null ? "null" : typeof value}); export defineBoxDriver({ kind, sdkVersion, create }) ` +
        `as the default export or a named export`,
    );
  }
  const candidate = value as Partial<BoxDriverModule>;
  if (typeof candidate.kind !== "string" || candidate.kind.trim() === "") {
    throw new Error(
      `box_pool_driver_module_invalid: ${source} is missing a non-empty string \`kind\``,
    );
  }
  if (typeof candidate.create !== "function") {
    throw new Error(
      `box_pool_driver_module_invalid: ${source} (kind: ${candidate.kind}) is missing a \`create(options, deps)\` function`,
    );
  }
  if (typeof candidate.sdkVersion !== "number") {
    throw new Error(
      `box_pool_driver_module_invalid: ${source} (kind: ${candidate.kind}) is missing a numeric \`sdkVersion\` ` +
        `(declare sdkVersion: ${BOX_DRIVER_SDK_VERSION})`,
    );
  }
  if (candidate.sdkVersion !== BOX_DRIVER_SDK_VERSION) {
    throw new Error(
      `box_pool_driver_sdk_mismatch: ${source} targets SDK v${candidate.sdkVersion}, ` +
        `this build supports v${BOX_DRIVER_SDK_VERSION}`,
    );
  }
}
