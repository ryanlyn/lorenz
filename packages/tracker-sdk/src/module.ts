import type { TrackerProvider } from "./provider.js";

/**
 * The tracker SDK version this build of the engine speaks. Out-of-tree tracker
 * modules declare the version they target via {@link TrackerProviderModule.sdkVersion};
 * the loader rejects a mismatch before the module ever reaches the registry.
 * Major-only: additive, backwards-compatible SDK changes never bump it.
 */
export const TRACKER_SDK_VERSION = 1;

/**
 * The unit an OUT-OF-TREE tracker module exports: a {@link TrackerProvider}
 * carrying the SDK version it targets. In-repo extensions register providers
 * directly (the composition root vouches for them); a dynamically imported
 * module instead crosses a version boundary the daemon cannot type-check, so
 * the explicit `sdkVersion` handshake stands in for the compiler.
 */
export interface TrackerProviderModule extends TrackerProvider {
  readonly sdkVersion: number;
}

/**
 * Authoring sugar for out-of-tree tracker modules: shape-asserts the module at
 * definition time (so a typo fails in the author's tests, not the operator's
 * daemon) and returns it unchanged. Usage:
 *
 * ```ts
 * export default defineTrackerProvider({
 *   kind: "acme",
 *   sdkVersion: 1,
 *   createClient: (settings, context) => new AcmeTrackerClient(settings, context),
 * });
 * ```
 */
export function defineTrackerProvider(module: TrackerProviderModule): TrackerProviderModule {
  assertTrackerProviderModule(module, "defineTrackerProvider");
  return module;
}

/**
 * Structural check + version handshake for a dynamically loaded tracker module.
 * `source` names where the value came from (a module specifier, or
 * `defineTrackerProvider` at authoring time) so every error is actionable. Throws:
 *
 * - `tracker_provider_module_invalid: <source> ...` when the value is not an
 *   object, `kind` is not a non-empty string, `createClient` is not a function,
 *   or `sdkVersion` is not a number;
 * - `tracker_provider_sdk_mismatch: <source> targets SDK v<n>, this build
 *   supports v<TRACKER_SDK_VERSION>` when the declared version differs.
 */
export function assertTrackerProviderModule(
  value: unknown,
  source: string,
): asserts value is TrackerProviderModule {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `tracker_provider_module_invalid: ${source} did not yield a tracker provider module object ` +
        `(got ${value === null ? "null" : typeof value}); export defineTrackerProvider({ kind, sdkVersion, createClient }) ` +
        `as the default export or a named export`,
    );
  }
  const candidate = value as Partial<TrackerProviderModule>;
  if (typeof candidate.kind !== "string" || candidate.kind.trim() === "") {
    throw new Error(
      `tracker_provider_module_invalid: ${source} is missing a non-empty string \`kind\``,
    );
  }
  if (typeof candidate.createClient !== "function") {
    throw new Error(
      `tracker_provider_module_invalid: ${source} (kind: ${candidate.kind}) is missing a \`createClient(settings, context)\` function`,
    );
  }
  if (typeof candidate.sdkVersion !== "number") {
    throw new Error(
      `tracker_provider_module_invalid: ${source} (kind: ${candidate.kind}) is missing a numeric \`sdkVersion\` ` +
        `(declare sdkVersion: ${TRACKER_SDK_VERSION})`,
    );
  }
  if (candidate.sdkVersion !== TRACKER_SDK_VERSION) {
    throw new Error(
      `tracker_provider_sdk_mismatch: ${source} targets SDK v${candidate.sdkVersion}, ` +
        `this build supports v${TRACKER_SDK_VERSION}`,
    );
  }
}
