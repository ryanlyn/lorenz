import {
  assertAgentExecutorModule,
  type AgentExecutorModule,
  type AgentExecutorProvider,
  type AgentExecutorRegistry,
} from "@lorenz/agent-sdk";

import {
  createExtensionLoader,
  type EnsureExtensionLoadedOptions,
  type ExtensionRef,
  type ExtensionRegistry,
} from "./extensionLoader.js";

/**
 * Out-of-tree agent-executor loading: a configured `agents.<kind>.executor`
 * accepts a MODULE SPECIFIER (an npm package name, `@scope/name`, `./relative` or
 * `/absolute` path, with an optional `#exportName` suffix) in addition to a
 * registered executor selector. The daemon dynamic-imports the module at startup
 * (and on a reload that changes the specifier) and registers it into the executor
 * registry under the EXACT configured string, so the agent-runner's existing
 * registry resolution (`registry.require(agent.executor)`) needs no changes and
 * third parties ship executors without forking the repo.
 *
 * This is the fourth instantiation of the axis-generic {@link createExtensionLoader}
 * core (worker-driver is the first, tracker the second, tool the third): every
 * behavioral literal (the `agent_executor_*` error prefix, the
 * `agent_executor_loaded` / `agent_executor_module_pinned` events, the
 * `assertAgentExecutorModule` handshake, the `createExecutor`-function module
 * shape, the exact-selector-wins resolution, the per-registry pin WeakMap) is
 * supplied through the axis spec below, so the same audited mechanics serve the
 * agent-executor axis. It is purely additive: the built-in executors (e.g. `acp`)
 * register through `registerBuiltinBackends()` and never flow through here.
 *
 * Trust: a dynamic import runs arbitrary code in the daemon process - the same
 * trust boundary as workspace hooks. Loads happen ONLY here (startup/reload),
 * never on a per-session/hot path, and the `agent_executor_loaded` audit event
 * records exactly which code went live from where.
 *
 * Module pinning: Node's ESM cache loads a given specifier's code once per daemon
 * lifetime. Changing executor CODE requires a daemon restart; changing the CONFIG
 * to a different specifier hot-loads the new module. A reload that re-encounters
 * an already-loaded specifier emits `agent_executor_module_pinned` so the pin is
 * observable, and cache-busting query strings are rejected (unbounded
 * module-graph growth, half-initialized module hazards).
 *
 * Wiring note: this is a READY-TO-WIRE entrypoint. The executor config surface is
 * the deliberate extension point left clean by Feature D's scope - a caller (a
 * `loadWorkflow` prepareRegistries hook or the executor-factory step) calls
 * {@link ensureAgentExecutorLoaded} for any configured `agents.<kind>.executor`
 * BEFORE the registry resolves it, exactly as `prepareTrackerExtensions` does for
 * trackers.
 */

/** A parsed configured executor value that is not a registered selector. */
export type AgentExecutorRef = ExtensionRef;

/** Options for {@link ensureAgentExecutorLoaded}. */
export type EnsureAgentExecutorLoadedOptions = EnsureExtensionLoadedOptions;

/** The agent-executor instantiation of the axis-generic loader. */
const agentExecutorLoader = createExtensionLoader<AgentExecutorProvider, AgentExecutorModule>({
  errorPrefix: "agent_executor",
  eventNames: {
    loaded: "agent_executor_loaded",
    pinned: "agent_executor_module_pinned",
  },
  defineHelperName: "defineAgentExecutor",
  unitNoun: "agent executors",
  assertModule: assertAgentExecutorModule,
  looksLikeModule: (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { createExecutor?: unknown }).createExecutor === "function",
  // Register under the EXACT configured specifier: the agent-runner resolves the
  // configured `agents.<kind>.executor` verbatim, so the registered provider's
  // `executor` must be the specifier, not the module's self-declared selector
  // (which is logged for the audit trail). Spread the loaded module so every
  // provider hook (createExecutor, parseOptions, validateAgent, configAliases,
  // ...) is preserved and only `executor` is overridden.
  toFactory: (specifier, module) => ({ ...module, executor: specifier }),
  // The agent axis's identity field is `executor`; map it onto the generic `kind`
  // audit field so the loaded/pinned events stay uniform across axes.
  describeModule: (module) => ({ kind: module.executor, sdkVersion: module.sdkVersion }),
});

/**
 * One stable {@link ExtensionRegistry} adapter per underlying
 * {@link AgentExecutorRegistry}. The generic loader keys its pinned-specifier set
 * in a WeakMap by the registry IDENTITY it is handed, so the adapter must be the
 * SAME object across reload calls for the same executor registry - otherwise the
 * module-pinned re-encounter event would never fire. Caching by the real registry
 * preserves that identity.
 */
const adapters = new WeakMap<AgentExecutorRegistry, ExtensionRegistry<AgentExecutorProvider>>();

/**
 * Adapts an {@link AgentExecutorRegistry} to the minimal {@link ExtensionRegistry}
 * surface the generic loader needs. The executor registry exposes `executors()`
 * rather than the generic `kinds()`, so the loader sees registered executor
 * selectors through this thin shim - no behavior change, just the method-name
 * reconciliation noted in the Feature D design.
 */
function asExtensionRegistry(
  registry: AgentExecutorRegistry,
): ExtensionRegistry<AgentExecutorProvider> {
  let adapter = adapters.get(registry);
  if (adapter === undefined) {
    adapter = {
      get: (executor) => registry.get(executor),
      register: (provider) => registry.register(provider),
      kinds: () => registry.executors(),
    };
    adapters.set(registry, adapter);
  }
  return adapter;
}

/**
 * Parses a configured executor string into its module-specifier form. Resolution
 * rule (the single authority for the one-field-two-grammars overload): an EXACT
 * registered selector always wins - {@link ensureAgentExecutorLoaded} checks
 * `registry.get(executor)` BEFORE calling this, so a published npm package named
 * `acp` can never shadow the built-in. A `#name` suffix selects a named export;
 * everything else is the specifier itself.
 */
export function parseAgentExecutorRef(executor: string): AgentExecutorRef {
  return agentExecutorLoader.parseRef(executor);
}

/**
 * Idempotently makes the configured executor resolvable in `registry`. A registry
 * hit (a built-in selector, an extension, or a specifier a previous call already
 * loaded) is a no-op - except that a re-encountered loader-registered specifier
 * emits `agent_executor_module_pinned` so the code-is-pinned semantic is
 * observable on reload. A miss parses the executor as a module reference,
 * dynamic-imports it, and registers a provider whose executor IS the configured
 * specifier string, emitting `agent_executor_loaded`.
 *
 * Ready-to-wire: a caller invokes this BEFORE the agent-runner resolves the
 * executor at startup and on every reload, so the runner's
 * `registry.require(agent.executor)` resolves an out-of-tree executor exactly
 * like a built-in. A module registered for a config that later selects a
 * different executor is harmless: the registry is a catalog, and an unused entry
 * is inert.
 */
export async function ensureAgentExecutorLoaded(
  executor: string,
  registry: AgentExecutorRegistry,
  options: EnsureAgentExecutorLoadedOptions = {},
): Promise<void> {
  return agentExecutorLoader.ensureLoaded(executor, asExtensionRegistry(registry), options);
}
