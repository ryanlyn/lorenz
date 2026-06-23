import { makeSdkModuleContract } from "@lorenz/domain";

import type { AgentExecutorProvider } from "./provider.js";

/**
 * The agent-executor SDK version this build of the engine speaks. Out-of-tree
 * executor modules declare the version they target via
 * {@link AgentExecutorModule.sdkVersion}; the loader rejects a mismatch before the
 * module ever reaches the registry. Major-only: additive, backwards-compatible
 * SDK changes never bump it.
 */
export const AGENT_EXECUTOR_SDK_VERSION = 1;

/**
 * The unit an OUT-OF-TREE agent-executor module exports: an
 * {@link AgentExecutorProvider} carrying the SDK version it targets. A dynamically
 * imported module crosses a version boundary the daemon cannot type-check, so the
 * explicit `sdkVersion` handshake stands in for the compiler.
 */
export interface AgentExecutorModule extends AgentExecutorProvider {
  readonly sdkVersion: number;
}

const contract = makeSdkModuleContract<AgentExecutorModule>({
  errorPrefix: "agent_executor",
  moduleNoun: "an agent executor module",
  identityField: "executor",
  defineCall: "defineAgentExecutor({ executor, sdkVersion, createExecutor })",
  requiredFns: [
    { field: "createExecutor", signature: "createExecutor(kind, settings)", article: "a" },
  ],
  sdkVersion: AGENT_EXECUTOR_SDK_VERSION,
});

/**
 * Structural check + version handshake for a dynamically loaded agent-executor
 * module. `source` names where the value came from so every error is actionable.
 */
export const assertAgentExecutorModule: (
  value: unknown,
  source: string,
) => asserts value is AgentExecutorModule = contract.assertModule;

/**
 * Authoring sugar for out-of-tree executor modules: shape-asserts the module at
 * definition time (so a typo fails in the author's tests, not the operator's
 * daemon) and returns it unchanged. Usage:
 *
 * ```ts
 * export default defineAgentExecutor({
 *   executor: "acme",
 *   sdkVersion: 1,
 *   createExecutor: (kind, settings) => new AcmeExecutor(kind, settings),
 * });
 * ```
 */
export function defineAgentExecutor(module: AgentExecutorModule): AgentExecutorModule {
  return contract.defineModule(module, "defineAgentExecutor");
}
