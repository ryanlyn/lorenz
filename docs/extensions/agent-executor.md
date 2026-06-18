# Agent executor extension point

An agent executor decides *how* an agent record runs: it owns the runtime driver behind one value of `agents.<kind>.executor`. This page is for extension authors who want to run agents through something other than the built-in Agent Client Protocol bridge. It covers the `AgentExecutorProvider` contract, the `AgentExecutor`/`AgentSession`/`AgentUpdate` runtime contracts, how a selector is resolved at startup, and the built-in `acp` executor as the reference implementation.

This is a less-trodden extension point than [tracker providers](./tracker-provider.md) or [worker drivers](./worker-driver.md). Lorenz ships exactly one executor, `acp`, which covers both Codex and Claude by spawning a bridge subprocess. Write a new executor only when your agent runtime does not speak ACP at all: an in-process SDK, a hosted HTTP agent, or a protocol the ACP bridges cannot wrap. If your runtime can be reached over the Agent Client Protocol, write a bridge instead and keep the `acp` executor - see [ACP bridges](../agents/acp-bridges.md).

## Where the executor sits

Two packages split the contract. The build-time selector contract lives in `@lorenz/agent-sdk`, the runtime driver contract in `@lorenz/domain`.

- `@lorenz/agent-sdk` (`packages/agent-sdk/src/provider.ts`) defines `AgentExecutorProvider` and `AgentExecutorRegistry`. A provider owns one selector string and the validation of the records that select it.
- `@lorenz/domain` (`packages/domain/src/index.ts`) defines `AgentExecutor`, `AgentSession`, and the `AgentUpdate` event union. These are the runtime objects the orchestrator drives. They live in domain so the dependency-free vocabulary package owns them, not the SDK.

The orchestrator never imports your executor package. It resolves executors through the registry, so adding a runtime is one package plus one registration line at the composition root.

<p align="center"><img src="../assets/diagrams/acp-executor-model.svg" alt="acp executor model diagram" width="720" style="width:100%;max-width:720px;height:auto" /></p>
*The provider registers under a selector; `agents.<kind>.executor` picks it; `createExecutor` builds the `AgentExecutor` that the agent-runner loop drives.*

## The `AgentExecutorProvider` contract

A provider is the build-time half. It names a selector, normalizes config, validates records at startup, and constructs the runtime driver. Defined in `packages/agent-sdk/src/provider.ts`.

| Member | Required | Purpose |
| --- | --- | --- |
| `executor` | yes | Readonly selector string matched against `agents.<kind>.executor`. The registry key. |
| `configAliases` | no | snake_case to camelCase map for this executor's keys in an `agents.<kind>` record. Applied before `parseOptions`. |
| `parseOptions` | no | Validate and normalize the executor's slice of the record. Runs at config-parse time. The return value becomes `AgentConfig.options`. |
| `validateAgent` | no | Throw when a record selecting this executor is not runnable. Runs once at startup. |
| `createExecutor` | yes | Build the `AgentExecutor` for an agent kind. May return `AgentExecutor` or `Promise<AgentExecutor>`. |

The exact signatures:

```ts
export interface AgentExecutorProvider {
  readonly executor: string;
  readonly configAliases?: Readonly<Record<string, string>> | undefined;
  parseOptions?(
    options: Record<string, unknown>,
    context: {
      env: NodeJS.ProcessEnv;
      resolveSecret?: (value: string | undefined, fallbackEnvVar?: string) => string | undefined;
    },
  ): Record<string, unknown>;
  validateAgent?(kind: AgentKind, config: AgentConfig, settings: Settings): void;
  createExecutor(kind: AgentKind, settings: Settings): AgentExecutor | Promise<AgentExecutor>;
}
```

`parseOptions` receives the option record with `configAliases` already applied, and a `context` carrying the process `env` plus an optional `resolveSecret` for `$VAR` and `op://` references. Throw with a message naming the offending key on bad input. `validateAgent` is the startup gate: it sees the fully parsed `AgentConfig` and the whole `Settings`, and throws to reject the run before any agent spawns.

### The registry and selector resolution

`AgentExecutorRegistry` is a map keyed by the selector. Its methods:

- `register(provider)` - idempotent for the same instance; throws `agent executor provider already registered: <selector>` when a different provider claims a selector already taken. A blank selector throws `agent executor selector must not be blank`.
- `get(executor)` - returns the provider or `undefined`.
- `require(executor)` - returns the provider or throws `unsupported agent executor: <e> (known executors: ...)`, listing the sorted known selectors.
- `executors()` - sorted list of registered selectors.

`defaultAgentExecutorRegistry` is the process-wide singleton. The composition root populates it; library code only reads. A call site that needs isolation constructs its own `AgentExecutorRegistry` and passes it explicitly.

The selector check happens at config validation, not lazily at spawn time. `validateDispatchConfig` in `packages/config/src/parse.ts` walks every agent kind the workflow can dispatch (the default `agent.kind` plus any kind named in a status override), looks up `agents.<kind>.executor` in the registry, and throws when it is unknown:

```text
unsupported agents.<kind>.executor: <value> (known executors: acp)
```

An unknown selector fails startup. There is no fallback executor. When the lookup succeeds, `validateDispatchConfig` then calls the provider's `validateAgent` for that record, so a malformed-but-known executor record also fails here rather than mid-run.

### Registering a built-in

Built-ins are wired in `registerBuiltinBackends` in `apps/cli/src/daemon.ts`, the one place backend identity is hardcoded. The `acp` registration is guard-checked so the call stays idempotent:

```ts
if (executors.get(acpExecutorProvider.executor) === undefined) {
  executors.register(acpExecutorProvider);
}
```

An in-repo executor adds its package import and one `executors.register(...)` line here. An out-of-tree executor registers against `defaultAgentExecutorRegistry` from its own entry point before the daemon validates config - see [out-of-tree extensions](./out-of-tree.md).

## The runtime contracts

Once `createExecutor` returns, the orchestrator drives three plain interfaces from `@lorenz/domain`.

### `AgentExecutor`

The driver. It knows how to spawn the agent process and run turns against it.

```ts
export interface AgentExecutor {
  kind: AgentKind;
  startSession(input: {
    workspace: string;
    workerHost?: string | null | undefined;
    issue?: Issue;
    settings: Settings;
    onUpdate?: (update: AgentUpdate) => void;
  }): Promise<AgentSession>;
  runTurn(session: AgentSession, prompt: string, issue?: Issue): Promise<AgentUpdate[]>;
}
```

`startSession` spawns the process and prepares it for the first turn. `onUpdate` receives every event as it arrives. `workerHost` is non-null when the run is placed on a remote worker, so your executor must decide local versus remote execution from this field. `runTurn` sends one prompt and resolves with all `AgentUpdate` events produced during that turn; the same events also stream through `onUpdate`.

### `AgentSession`

The handle returned by `startSession` and threaded back into every `runTurn`.

```ts
export interface AgentSession {
  agentKind: AgentKind;
  sessionId?: string | null | undefined;
  executorPid?: string | null | undefined;
  stop(): Promise<void>;
}
```

`sessionId` is the backend session id, populated once your executor receives it. `executorPid` is the OS pid of the agent child as a string, or `null` when there is no child process. `stop` closes the session and tears down the process; it must be safe to call from a `finally` block, including before the first turn.

### `AgentUpdate`

Every event your executor emits is a member of the `AgentUpdate` discriminated union, switched on `type`. The full set of types is `AGENT_UPDATE_TYPES` in `packages/domain/src/index.ts`:

```text
workspace_prepared    session_started      turn_started
turn_completed        turn_failed          turn_cancelled
turn_input_required   approval_required    approval_auto_approved
tool_input_auto_answered  rate_limit       stderr
malformed             process_exit         fs_write
hook_execution        session_notification
```

`AgentUpdateType` is derived from the union, not declared separately, and compile-time exhaustiveness checks keep `AGENT_UPDATE_TYPES` in sync. Emit `session_started` once the backend session opens, a `turn_started`/`turn_completed` pair around each turn, and `turn_failed` or `turn_cancelled` on the failure paths. Reuse the existing types; do not invent a new discriminator, since downstream tracing and the dashboard key off this exact set. The runtime event vocabulary the dashboard consumes is a superset, defined in `@lorenz/runtime-events`, not in domain.

## The options bag

`AgentConfig` follows the [options-bag pattern](../architecture.md): a small shared core plus an opaque `options` bag your provider owns.

```ts
export interface AgentConfig {
  executor: string;
  turnTimeoutMs: number;
  stallTimeoutMs: number;
  options: Record<string, unknown>;
}
```

`executor`, `turnTimeoutMs`, and `stallTimeoutMs` are the cross-executor keys every record carries. `options` is yours: its shape is whatever your `parseOptions` returns, and core code reads it only through your executor package's typed accessor (the `acp` package exposes `acpAgentOptions(config)` for this), never by raw key.

`turn_timeout_ms` and `stall_timeout_ms` can be set once under the `agents:` block as shared defaults and overridden per kind. A `stall_timeout_ms` of `0` or less disables stall detection. Honoring both timers is your executor's job: nothing outside the executor enforces them.

## The built-in `acp` executor

The reference implementation is `acpExecutorProvider` in `packages/acp/src/index.ts`. It is the only built-in provider, and it exercises every hook.

```ts
export const acpExecutorProvider: AgentExecutorProvider = {
  executor: "acp",
  configAliases: {
    bridge_command: "bridgeCommand",
    usage_accounting: "usageAccounting",
    provider_config: "providerConfig",
    strict_mcp_config: "strictMcpConfig",
  },
  parseOptions: (options) => parseAcpAgentOptions(normalizeLegacyCommand(options)),
  validateAgent(kind, config) {
    if (!acpAgentOptions(config).bridgeCommand.trim()) {
      throw new Error(
        kind === "claude" ? "claude.command is required" : `agents.${kind}.bridgeCommand is required`,
      );
    }
  },
  createExecutor: (kind) => new Executor(kind),
};
```

What each hook does here:

- `configAliases` maps the four snake_case config keys (`bridge_command`, `usage_accounting`, `provider_config`, `strict_mcp_config`) to their internal camelCase names.
- `parseOptions` runs `parseAcpAgentOptions` (in `packages/acp/src/options.ts`), which rejects any unknown key with `unsupported agent option(s) for the acp executor: <keys>`. The recognized keys are `bridgeCommand`, `usageAccounting`, `providerConfig`, and `strictMcpConfig`. `usageAccounting` must be one of `per-turn` or `cumulative` (`AGENT_USAGE_ACCOUNTING_VALUES`); when unset it is inferred from the bridge name. `normalizeLegacyCommand` folds the legacy `command` key into `bridgeCommand`, with the canonical key winning when both are present.
- `validateAgent` rejects a blank `bridgeCommand`, since the ACP executor cannot spawn without a command to run.
- `createExecutor` constructs the `Executor` class, the `AgentExecutor` implementation that spawns the bridge subprocess and translates ACP notifications into `AgentUpdate` events.

The `Executor` itself drives the Agent Client Protocol: `startSession` spawns the bridge under `bash -lc` locally or over SSH on a worker host, runs ACP `initialize` and `newSession` (each with a 30000 ms timeout), and `runTurn` sends one ACP prompt while enforcing the turn and stall timers. The bridge mechanics, usage accounting, and Codex-versus-Claude differences are documented in [ACP bridges](../agents/acp-bridges.md); they are details of this one executor, not part of the extension contract.

## When to write a new executor

Write an executor provider when your agent runtime cannot be driven over ACP. Concretely:

- An in-process agent SDK you call directly, with no subprocess and no protocol.
- A hosted HTTP agent where a turn is a request/response against a remote endpoint.
- A protocol the existing ACP bridges do not and will not wrap.

If your runtime *can* speak ACP, do not write an executor. Write a bridge subprocess instead and configure it through `agents.<kind>.bridge_command` on the existing `acp` executor. A bridge reuses Lorenz's turn-timeout, stall-timeout, usage-accounting, and MCP-lease handling for free; a new executor reimplements that surface. The `acp` package is roughly a thousand lines of that machinery, and a fresh executor inherits none of it.

## Build checklist

1. Create a package exporting one `AgentExecutorProvider`. Pick a selector string that is not `acp`.
2. Define your `options` keys. Add `configAliases` for any snake_case spellings, and a `parseOptions` that rejects unknown keys and validates values. Expose a typed accessor so your runtime code reads `options` through one function, never by raw key.
3. Implement `validateAgent` to reject records that cannot run (missing endpoint, missing credential, bad combination). Throw with a message naming the key.
4. Implement `createExecutor` returning an `AgentExecutor`. In it, honor `turnTimeoutMs` and `stallTimeoutMs`, branch on `workerHost` for placement, populate `sessionId`/`executorPid` on the `AgentSession`, make `stop` safe in a `finally`, and emit only `AGENT_UPDATE_TYPES` members.
5. Register the provider: add one `executors.register(...)` line in `registerBuiltinBackends` for an in-repo executor, or register against `defaultAgentExecutorRegistry` from your entry point for an out-of-tree one.
6. Select it from a workflow with `agents.<kind>.executor: <your-selector>` and confirm startup rejects a typo'd selector with `unsupported agents.<kind>.executor`.

## See also

- [ACP bridges](../agents/acp-bridges.md) - the bridge model the `acp` executor drives, and when a bridge beats a new executor.
- [Agents](../agents/index.md) - the operator view of agent kinds and the `agents.<kind>` config.
- [Extensions overview](./index.md) - the four extension points and the registry pattern they share.
- [Out-of-tree extensions](./out-of-tree.md) - loading and registering an executor that lives outside the repo.
- [Configuration reference](../reference/configuration.md) - every `agents.<kind>` key, default, and timeout.
- [Events reference](../reference/events.md) - the full `AgentUpdate` and runtime event catalog.
