import { isRecord } from "@lorenz/domain";
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
 * Out-of-tree tool-pack loading: a configured tool-pack name accepts a module
 * specifier in addition to a registered pack name. Instantiates the axis-generic
 * {@link createExtensionLoader}; identity field is the pack `name`. See
 * {@link createExtensionLoader} for the trust boundary, module pinning, and
 * exact-name-wins resolution shared by every axis.
 *
 * A caller (a `loadWorkflow` prepareRegistries hook or a startup MCP-mount step)
 * invokes {@link ensureToolProviderLoaded} for the configured pack name BEFORE the
 * registry resolves it, exactly as `prepareTrackerExtensions` does for trackers.
 */

/** A parsed configured tool-pack value that is not a registered pack name. */
export type ToolRef = ExtensionRef;

/** Options for {@link ensureToolProviderLoaded}. */
export type EnsureToolProviderLoadedOptions = EnsureExtensionLoadedOptions;

const toolLoader = createExtensionLoader<ToolProvider, ToolProviderModule>({
  errorPrefix: "tool_provider",
  eventNames: {
    loaded: "tool_provider_loaded",
    pinned: "tool_provider_module_pinned",
  },
  defineHelperName: "defineToolProvider",
  unitNoun: "tool packs",
  assertModule: assertToolProviderModule,
  looksLikeModule: (value) => isRecord(value) && typeof value["executeTool"] === "function",
  // Spread the loaded module so every provider hook (toolSpecs, executeTool,
  // validateOptions, skills, ...) is preserved and only `name` is overridden to
  // the configured specifier.
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
 * shim.
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

/** Parses a configured tool-pack string into its module-specifier form. */
export function parseToolRef(name: string): ToolRef {
  return toolLoader.parseRef(name);
}

/**
 * Idempotently makes the configured tool pack resolvable in `registry` (see
 * {@link createExtensionLoader} for the load/pin semantics). A caller invokes this
 * BEFORE the MCP mount resolves the pack at startup and on every reload, so the
 * mount's `registry.require(name)` resolves an out-of-tree pack exactly like a
 * built-in.
 */
export async function ensureToolProviderLoaded(
  name: string,
  registry: ToolRegistry,
  options: EnsureToolProviderLoadedOptions = {},
): Promise<void> {
  return toolLoader.ensureLoaded(name, asExtensionRegistry(registry), options);
}
