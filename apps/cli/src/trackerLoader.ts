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
 * Out-of-tree tracker loading: `tracker.kind` accepts a MODULE SPECIFIER (an npm
 * package name, `@scope/name`, `./relative` or `/absolute` path, with an optional
 * `#exportName` suffix) in addition to a registered kind. The daemon
 * dynamic-imports the module at startup (and on a reload that changes the
 * specifier) and registers it into the tracker registry under the EXACT
 * configured string, so the config parser's and `validateDispatchConfig`'s
 * existing registry resolution (`registry.require(settings.tracker.kind)`) needs
 * no changes and third parties ship trackers without forking the repo.
 *
 * This is the second instantiation of the axis-generic {@link createExtensionLoader}
 * core (the worker-driver loader is the first): every behavioral literal (the
 * `tracker_provider_*` error prefix, the `tracker_provider_loaded` /
 * `tracker_provider_module_pinned` events, the `assertTrackerProviderModule`
 * handshake, the `createClient`-function module shape, the exact-kind-wins
 * resolution, the per-registry pin WeakMap) is supplied through the axis spec
 * below, so the same audited mechanics serve the tracker axis. It is purely
 * additive: the built-in trackers register through `registerBuiltinBackends()`
 * and never flow through here.
 *
 * Trust: a dynamic import runs arbitrary code in the daemon process - the same
 * trust boundary as workspace hooks. Loads happen ONLY here (startup/reload),
 * never on a per-poll/per-issue path, and the `tracker_provider_loaded` audit
 * event records exactly which code went live from where.
 *
 * Module pinning: Node's ESM cache loads a given specifier's code once per
 * daemon lifetime. Changing tracker CODE requires a daemon restart; changing the
 * CONFIG to a different specifier hot-loads the new module. A reload that
 * re-encounters an already-loaded specifier emits
 * `tracker_provider_module_pinned` so the pin is observable, and cache-busting
 * query strings are rejected (unbounded module-graph growth, half-initialized
 * module hazards).
 */

/** A parsed configured tracker value that is not a registered kind. */
export type TrackerRef = ExtensionRef;

/** Options for {@link ensureTrackerProviderLoaded}. */
export type EnsureTrackerProviderLoadedOptions = EnsureExtensionLoadedOptions;

/** The tracker instantiation of the axis-generic loader. */
const trackerLoader = createExtensionLoader<TrackerProvider, TrackerProviderModule>({
  errorPrefix: "tracker_provider",
  eventNames: {
    loaded: "tracker_provider_loaded",
    pinned: "tracker_provider_module_pinned",
  },
  defineHelperName: "defineTrackerProvider",
  unitNoun: "tracker providers",
  assertModule: assertTrackerProviderModule,
  looksLikeModule: (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { createClient?: unknown }).createClient === "function",
  // Register under the EXACT configured specifier: the config parser and
  // validateDispatchConfig resolve `settings.tracker.kind` verbatim, so the
  // registered provider's `kind` must be the specifier, not the module's
  // self-declared kind (which is logged for the audit trail). Spread the loaded
  // module so every provider hook (createClient, parseOptions, validateDispatch,
  // createToolOps, ...) is preserved and only `kind` is overridden.
  toFactory: (specifier, module) => ({ ...module, kind: specifier }),
  describeModule: (module) => ({ kind: module.kind, sdkVersion: module.sdkVersion }),
});

/**
 * Parses a configured tracker string into its module-specifier form. Resolution
 * rule (the single authority for the one-field-two-grammars overload): an EXACT
 * registered kind always wins - {@link ensureTrackerProviderLoaded} checks
 * `registry.get(kind)` BEFORE calling this, so a published npm package named
 * `linear` can never shadow the built-in. A `#name` suffix selects a named
 * export; everything else is the specifier itself.
 */
export function parseTrackerRef(kind: string): TrackerRef {
  return trackerLoader.parseRef(kind);
}

/**
 * Idempotently makes the configured tracker resolvable in `registry`. A registry
 * hit (a built-in kind, an extension, or a specifier a previous call already
 * loaded) is a no-op - except that a re-encountered loader-registered specifier
 * emits `tracker_provider_module_pinned` so the code-is-pinned semantic is
 * observable on reload. A miss parses the kind as a module reference,
 * dynamic-imports it, and registers a provider whose kind IS the configured
 * specifier string, emitting `tracker_provider_loaded`.
 *
 * Called by the daemon BEFORE `validateDispatchConfig` at startup and on every
 * reload, so the config validation's `trackers.require(settings.tracker.kind)`
 * resolves an out-of-tree tracker exactly like a built-in. A module registered
 * for a config that later fails validation is harmless: the registry is a
 * catalog, and an unused entry is inert.
 */
export async function ensureTrackerProviderLoaded(
  kind: string,
  registry: TrackerRegistry,
  options: EnsureTrackerProviderLoadedOptions = {},
): Promise<void> {
  return trackerLoader.ensureLoaded(kind, registry, options);
}
