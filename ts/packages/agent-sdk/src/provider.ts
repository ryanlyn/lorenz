import type { AgentConfig, AgentExecutor, AgentKind, Settings } from "@symphony/domain";

/**
 * Everything Symphony needs to know about one way of running agents, bundled as a single
 * extension point. An executor provider owns the runtime driver behind one value of
 * `agents.<kind>.executor` (e.g. `"acp"` drives a bridge subprocess over the Agent Client
 * Protocol) and the validation of agent records that select it.
 *
 * The core (config validation, agent-runner, CLI) resolves executors exclusively through
 * an {@link AgentExecutorRegistry}; adding a new way to run agents means implementing this
 * interface and registering it at the composition root - no core package changes.
 */
export interface AgentExecutorProvider {
  /** Executor selector matched against `agents.<kind>.executor`. */
  readonly executor: string;
  /**
   * Throw when an agent record selecting this executor is not runnable (missing command,
   * invalid combination, ...). Called once at startup by `validateDispatchConfig`.
   */
  validateAgent?(kind: AgentKind, config: AgentConfig, settings: Settings): void;
  /** Build the executor that drives sessions for the given agent kind. */
  createExecutor(kind: AgentKind, settings: Settings): AgentExecutor | Promise<AgentExecutor>;
}

/** Lookup table of {@link AgentExecutorProvider}s keyed by their `executor` selector. */
export class AgentExecutorRegistry {
  private readonly providers = new Map<string, AgentExecutorProvider>();

  /** Register a provider. Throws when a different provider already claims the selector. */
  register(provider: AgentExecutorProvider): void {
    const executor = provider.executor.trim();
    if (!executor) throw new Error("agent executor selector must not be blank");
    const existing = this.providers.get(executor);
    if (existing && existing !== provider) {
      throw new Error(`agent executor provider already registered: ${executor}`);
    }
    this.providers.set(executor, provider);
  }

  get(executor: string | undefined): AgentExecutorProvider | undefined {
    return executor === undefined ? undefined : this.providers.get(executor);
  }

  /** Like {@link get} but throws an error listing the known executor selectors. */
  require(executor: string): AgentExecutorProvider {
    const provider = this.providers.get(executor);
    if (!provider) {
      const known = this.executors();
      const hint = known.length > 0 ? ` (known executors: ${known.join(", ")})` : "";
      throw new Error(`unsupported agent executor: ${executor}${hint}`);
    }
    return provider;
  }

  executors(): string[] {
    return [...this.providers.keys()].sort();
  }
}

/**
 * Process-wide registry used as the default by config validation and the CLI. Registration
 * happens at the composition root; library code only reads from it. Call sites that need
 * isolation can construct their own {@link AgentExecutorRegistry} and pass it explicitly.
 */
export const defaultAgentExecutorRegistry = new AgentExecutorRegistry();
