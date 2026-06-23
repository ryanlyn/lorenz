import { makeSdkModuleContract } from "@lorenz/domain";

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
 * carrying the SDK version it targets. A dynamically imported module crosses a
 * version boundary the daemon cannot type-check, so the explicit `sdkVersion`
 * handshake stands in for the compiler.
 */
export interface TrackerProviderModule extends TrackerProvider {
  readonly sdkVersion: number;
}

const contract = makeSdkModuleContract<TrackerProviderModule>({
  errorPrefix: "tracker_provider",
  moduleNoun: "a tracker provider module",
  identityField: "kind",
  defineCall: "defineTrackerProvider({ kind, sdkVersion, createClient })",
  requiredFns: [{ field: "createClient", signature: "createClient(settings, context)", article: "a" }],
  sdkVersion: TRACKER_SDK_VERSION,
});

/**
 * Structural check + version handshake for a dynamically loaded tracker module.
 * `source` names where the value came from so every error is actionable.
 */
export const assertTrackerProviderModule: (
  value: unknown,
  source: string,
) => asserts value is TrackerProviderModule = contract.assertModule;

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
  return contract.defineModule(module, "defineTrackerProvider");
}
