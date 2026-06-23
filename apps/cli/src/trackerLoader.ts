import { isRecord } from "@lorenz/domain";
import {
  assertTrackerProviderModule,
  type TrackerProvider,
  type TrackerProviderModule,
  type TrackerRegistry,
} from "@lorenz/tracker-sdk";

import {
  createExtensionLoader,
  type EnsureExtensionLoadedOptions,
  type ExtensionRef,
} from "./extensionLoader.js";

/**
 * Out-of-tree tracker loading: `tracker.kind` accepts a module specifier in
 * addition to a registered kind. Instantiates the axis-generic
 * {@link createExtensionLoader}; identity field is the provider `kind`. See
 * {@link createExtensionLoader} for the trust boundary, module pinning, and
 * exact-kind-wins resolution shared by every axis.
 */

/** A parsed configured tracker value that is not a registered kind. */
export type TrackerRef = ExtensionRef;

/** Options for {@link ensureTrackerProviderLoaded}. */
export type EnsureTrackerProviderLoadedOptions = EnsureExtensionLoadedOptions;

const trackerLoader = createExtensionLoader<TrackerProvider, TrackerProviderModule>({
  errorPrefix: "tracker_provider",
  eventNames: {
    loaded: "tracker_provider_loaded",
    pinned: "tracker_provider_module_pinned",
  },
  defineHelperName: "defineTrackerProvider",
  unitNoun: "tracker providers",
  assertModule: assertTrackerProviderModule,
  looksLikeModule: (value) => isRecord(value) && typeof value["createClient"] === "function",
  // Spread the loaded module so every provider hook (createClient, parseOptions,
  // validateDispatch, createToolOps, ...) is preserved and only `kind` is
  // overridden to the configured specifier.
  toFactory: (specifier, module) => ({ ...module, kind: specifier }),
  describeModule: (module) => ({ kind: module.kind, sdkVersion: module.sdkVersion }),
});

/** Parses a configured tracker string into its module-specifier form. */
export function parseTrackerRef(kind: string): TrackerRef {
  return trackerLoader.parseRef(kind);
}

/**
 * Idempotently makes the configured tracker resolvable in `registry` (see
 * {@link createExtensionLoader} for the load/pin semantics). Called by the daemon
 * BEFORE `validateDispatchConfig` at startup and on every reload, so the config
 * validation's `trackers.require(settings.tracker.kind)` resolves an out-of-tree
 * tracker exactly like a built-in.
 */
export async function ensureTrackerProviderLoaded(
  kind: string,
  registry: TrackerRegistry,
  options: EnsureTrackerProviderLoadedOptions = {},
): Promise<void> {
  return trackerLoader.ensureLoaded(kind, registry, options);
}
