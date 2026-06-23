import { isRecord } from "@lorenz/domain";
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
 * accepts a module specifier in addition to a registered executor selector.
 * Instantiates the axis-generic {@link createExtensionLoader}; identity field is
 * the provider `executor`. See {@link createExtensionLoader} for the trust
 * boundary, module pinning, and exact-selector-wins resolution shared by every
 * axis.
 *
 * A caller (a `loadWorkflow` prepareRegistries hook or the executor-factory step)
 * invokes {@link ensureAgentExecutorLoaded} for the configured
 * `agents.<kind>.executor` BEFORE the registry resolves it, exactly as
 * `prepareTrackerExtensions` does for trackers.
 */

/** A parsed configured executor value that is not a registered selector. */
export type AgentExecutorRef = ExtensionRef;

/** Options for {@link ensureAgentExecutorLoaded}. */
export type EnsureAgentExecutorLoadedOptions = EnsureExtensionLoadedOptions;

const agentExecutorLoader = createExtensionLoader<AgentExecutorProvider, AgentExecutorModule>({
  errorPrefix: "agent_executor",
  eventNames: {
    loaded: "agent_executor_loaded",
    pinned: "agent_executor_module_pinned",
  },
  defineHelperName: "defineAgentExecutor",
  unitNoun: "agent executors",
  assertModule: assertAgentExecutorModule,
  looksLikeModule: (value) => isRecord(value) && typeof value["createExecutor"] === "function",
  // Spread the loaded module so every provider hook (createExecutor, parseOptions,
  // validateAgent, configAliases, ...) is preserved and only `executor` is
  // overridden to the configured specifier.
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
 * selectors through this thin shim.
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

/** Parses a configured executor string into its module-specifier form. */
export function parseAgentExecutorRef(executor: string): AgentExecutorRef {
  return agentExecutorLoader.parseRef(executor);
}

/**
 * Idempotently makes the configured executor resolvable in `registry` (see
 * {@link createExtensionLoader} for the load/pin semantics). A caller invokes this
 * BEFORE the agent-runner resolves the executor at startup and on every reload, so
 * the runner's `registry.require(agent.executor)` resolves an out-of-tree executor
 * exactly like a built-in.
 */
export async function ensureAgentExecutorLoaded(
  executor: string,
  registry: AgentExecutorRegistry,
  options: EnsureAgentExecutorLoadedOptions = {},
): Promise<void> {
  return agentExecutorLoader.ensureLoaded(executor, asExtensionRegistry(registry), options);
}
