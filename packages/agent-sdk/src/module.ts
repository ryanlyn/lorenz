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
 * {@link AgentExecutorProvider} carrying the SDK version it targets. In-repo
 * extensions register providers directly (the composition root vouches for them);
 * a dynamically imported module instead crosses a version boundary the daemon
 * cannot type-check, so the explicit `sdkVersion` handshake stands in for the
 * compiler.
 */
export interface AgentExecutorModule extends AgentExecutorProvider {
  readonly sdkVersion: number;
}

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
  assertAgentExecutorModule(module, "defineAgentExecutor");
  return module;
}

/**
 * Structural check + version handshake for a dynamically loaded agent-executor
 * module. `source` names where the value came from (a module specifier, or
 * `defineAgentExecutor` at authoring time) so every error is actionable. Throws:
 *
 * - `agent_executor_module_invalid: <source> ...` when the value is not an
 *   object, `executor` is not a non-empty string, `createExecutor` is not a
 *   function, or `sdkVersion` is not a number;
 * - `agent_executor_sdk_mismatch: <source> targets SDK v<n>, this build supports
 *   v<AGENT_EXECUTOR_SDK_VERSION>` when the declared version differs.
 */
export function assertAgentExecutorModule(
  value: unknown,
  source: string,
): asserts value is AgentExecutorModule {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `agent_executor_module_invalid: ${source} did not yield an agent executor module object ` +
        `(got ${value === null ? "null" : typeof value}); export defineAgentExecutor({ executor, sdkVersion, createExecutor }) ` +
        `as the default export or a named export`,
    );
  }
  const candidate = value as Partial<AgentExecutorModule>;
  if (typeof candidate.executor !== "string" || candidate.executor.trim() === "") {
    throw new Error(
      `agent_executor_module_invalid: ${source} is missing a non-empty string \`executor\``,
    );
  }
  if (typeof candidate.createExecutor !== "function") {
    throw new Error(
      `agent_executor_module_invalid: ${source} (executor: ${candidate.executor}) is missing a \`createExecutor(kind, settings)\` function`,
    );
  }
  if (typeof candidate.sdkVersion !== "number") {
    throw new Error(
      `agent_executor_module_invalid: ${source} (executor: ${candidate.executor}) is missing a numeric \`sdkVersion\` ` +
        `(declare sdkVersion: ${AGENT_EXECUTOR_SDK_VERSION})`,
    );
  }
  if (candidate.sdkVersion !== AGENT_EXECUTOR_SDK_VERSION) {
    throw new Error(
      `agent_executor_sdk_mismatch: ${source} targets SDK v${candidate.sdkVersion}, ` +
        `this build supports v${AGENT_EXECUTOR_SDK_VERSION}`,
    );
  }
}
