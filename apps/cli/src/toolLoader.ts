import {
  assertToolProviderModule,
  type ToolProvider,
  type ToolProviderModule,
  type ToolRegistry,
} from "@lorenz/tool-sdk";

import {
  createExtensionLoader,
  type EnsureExtensionLoadedOptions,
  type ExtensionRef,
  type ExtensionRegistry,
} from "./extensionLoader.js";

/**
 * Out-of-tree tool-pack loading: a configured tool-pack name accepts a MODULE
 * SPECIFIER (an npm package name, `@scope/name`, `./relative` or `/absolute`
 * path, with an optional `#exportName` suffix) in addition to a registered pack
 * name. The daemon dynamic-imports the module at startup (and on a reload that
 * changes the specifier) and registers it into the tool registry under the EXACT
 * configured string, so the MCP mount's existing registry resolution
 * (`registry.require(name)`) needs no changes and third parties ship tool packs
 * without forking the repo.
 *
 * This is the third instantiation of the axis-generic {@link createExtensionLoader}
 * core (worker-driver is the first, tracker the second): every behavioral literal
 * (the `tool_provider_*` error prefix, the `tool_provider_loaded` /
 * `tool_provider_module_pinned` events, the `assertToolProviderModule` handshake,
 * the `executeTool`/`toolSpecs`-function module shape, the exact-name-wins
 * resolution, the per-registry pin WeakMap) is supplied through the axis spec
 * below, so the same audited mechanics serve the tool axis. It is purely
 * additive: the built-in tool packs register through `registerBuiltinBackends()`
 * and never flow through here.
 *
 * Trust: a dynamic import runs arbitrary code in the daemon process - the same
 * trust boundary as workspace hooks. Loads happen ONLY here (startup/reload),
 * never on a per-tool-call/hot path, and the `tool_provider_loaded` audit event
 * records exactly which code went live from where.
 *
 * Module pinning: Node's ESM cache loads a given specifier's code once per daemon
 * lifetime. Changing tool-pack CODE requires a daemon restart; changing the
 * CONFIG to a different specifier hot-loads the new module. A reload that
 * re-encounters an already-loaded specifier emits `tool_provider_module_pinned`
 * so the pin is observable, and cache-busting query strings are rejected
 * (unbounded module-graph growth, half-initialized module hazards).
 *
 * Wiring note: this is a READY-TO-WIRE entrypoint. The tool-pack config surface
 * is the deliberate extension point left clean by Feature D's scope - a caller
 * (a `loadWorkflow` prepareRegistries hook or a startup MCP-mount step) calls
 * {@link ensureToolProviderLoaded} for any configured pack name BEFORE the
 * registry resolves it, exactly as `prepareTrackerExtensions` does for trackers.
 */

/** A parsed configured tool-pack value that is not a registered pack name. */
export type ToolRef = ExtensionRef;

/** Options for {@link ensureToolProviderLoaded}. */
export type EnsureToolProviderLoadedOptions = EnsureExtensionLoadedOptions;

/** The tool instantiation of the axis-generic loader. */
const toolLoader = createExtensionLoader<ToolProvider, ToolProviderModule>({
  errorPrefix: "tool_provider",
  eventNames: {
    loaded: "tool_provider_loaded",
    pinned: "tool_provider_module_pinned",
  },
  defineHelperName: "defineToolProvider",
  unitNoun: "tool packs",
  assertModule: assertToolProviderModule,
  looksLikeModule: (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { executeTool?: unknown }).executeTool === "function",
  // Register under the EXACT configured specifier: the MCP mount resolves the
  // configured pack name verbatim, so the registered provider's `name` must be
  // the specifier, not the module's self-declared name (which is logged for the
  // audit trail). Spread the loaded module so every provider hook (toolSpecs,
  // executeTool, validateOptions, skills, ...) is preserved and only `name` is
  // overridden.
  toFactory: (specifier, module) => ({ ...module, name: specifier }),
  // The tool axis's identity field is `name`; map it onto the generic `kind`
  // audit field so the loaded/pinned events stay uniform across axes.
  describeModule: (module) => ({ kind: module.name, sdkVersion: module.sdkVersion }),
});

/**
 * One stable {@link ExtensionRegistry} adapter per underlying {@link ToolRegistry}.
 * The generic loader keys its pinned-specifier set in a WeakMap by the registry
 * IDENTITY it is handed, so the adapter must be the SAME object across reload
 * calls for the same tool registry - otherwise the module-pinned re-encounter
 * event would never fire. Caching by the real registry preserves that identity.
 */
const adapters = new WeakMap<ToolRegistry, ExtensionRegistry<ToolProvider>>();

/**
 * Adapts a {@link ToolRegistry} to the minimal {@link ExtensionRegistry} surface
 * the generic loader needs. The tool registry exposes `names()` rather than the
 * generic `kinds()`, so the loader sees registered pack names through this thin
 * shim - no behavior change, just the method-name reconciliation noted in the
 * Feature D design.
 */
function asExtensionRegistry(registry: ToolRegistry): ExtensionRegistry<ToolProvider> {
  let adapter = adapters.get(registry);
  if (adapter === undefined) {
    adapter = {
      get: (name) => registry.get(name),
      register: (provider) => registry.register(provider),
      kinds: () => registry.names(),
    };
    adapters.set(registry, adapter);
  }
  return adapter;
}

/**
 * Parses a configured tool-pack string into its module-specifier form. Resolution
 * rule (the single authority for the one-field-two-grammars overload): an EXACT
 * registered pack name always wins - {@link ensureToolProviderLoaded} checks
 * `registry.get(name)` BEFORE calling this, so a published npm package named
 * `tracker` can never shadow the built-in pack. A `#name` suffix selects a named
 * export; everything else is the specifier itself.
 */
export function parseToolRef(name: string): ToolRef {
  return toolLoader.parseRef(name);
}

/**
 * Idempotently makes the configured tool pack resolvable in `registry`. A
 * registry hit (a built-in pack, an extension, or a specifier a previous call
 * already loaded) is a no-op - except that a re-encountered loader-registered
 * specifier emits `tool_provider_module_pinned` so the code-is-pinned semantic is
 * observable on reload. A miss parses the name as a module reference,
 * dynamic-imports it, and registers a provider whose name IS the configured
 * specifier string, emitting `tool_provider_loaded`.
 *
 * Ready-to-wire: a caller invokes this BEFORE the MCP mount resolves the pack at
 * startup and on every reload, so the mount's `registry.require(name)` resolves
 * an out-of-tree pack exactly like a built-in. A module registered for a config
 * that later mounts nothing is harmless: the registry is a catalog, and an unused
 * entry is inert.
 */
export async function ensureToolProviderLoaded(
  name: string,
  registry: ToolRegistry,
  options: EnsureToolProviderLoadedOptions = {},
): Promise<void> {
  return toolLoader.ensureLoaded(name, asExtensionRegistry(registry), options);
}
