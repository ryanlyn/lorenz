# ACP bridges

This page covers the Agent Client Protocol (ACP) bridge layer: the subprocess that runs a coding-agent turn, how Lorenz drives it, and the two vendored bridges in the repo. It is for operators who configure agents and contributors who extend the executor layer. For the per-agent config knobs, see [Codex](codex.md) and [Claude](claude.md).

## What a bridge is

A bridge is an external subprocess that speaks the Agent Client Protocol over stdio. Lorenz launches it, then talks JSON-RPC to it through `@agentclientprotocol/sdk`. The bridge wraps a real coding agent (the Codex CLI or the Claude Agent SDK), translating ACP requests into agent actions and agent output back into ACP notifications.

Lorenz never embeds an agent in-process. The built-in executor (`@lorenz/acp`) owns the protocol conversation: it spawns the bridge, runs ACP `initialize` and `session/new`, sends one `session/prompt` per turn, and reads the stream of session notifications the bridge emits. The executor turns those notifications into the `AgentUpdate` event stream that the rest of Lorenz consumes.

Two bridges ship in `vendor/`:

| Directory | Upstream package | Wraps |
| --- | --- | --- |
| `vendor/codex-acp/` | `@agentclientprotocol/codex-acp` | Codex CLI |
| `vendor/claude-agent-acp/` | `@agentclientprotocol/claude-agent-acp` | Claude Agent SDK |

Both are pnpm workspace packages. The workspace root depends on both, so their bins resolve from `node_modules/.bin/`, and the default agent records point at the bare names `codex-acp` and `claude-agent-acp`.

## Vendored, not stock

The copies in `vendor/` are Lorenz-patched. Each directory holds the published `dist/` output plus a trimmed `package.json` carrying runtime dependencies only. `symphony-patch` comments mark every local modification to `dist/`. To find every divergence from upstream:

```sh
grep -rn "symphony-patch" vendor/*/dist
```

The patches add two capabilities upstream ACP lacks, both carried on `_meta` keys namespaced `symphony/...` so they ride the protocol's sanctioned extension point:

- **Usage accounting.** Each bridge emits a `usage_update` notification with `_meta["symphony/callUsage"]`, a per-call token bucket emitted as each model call completes. Codex additionally emits `_meta["symphony/totalUsage"]`, a thread-cumulative counter used as a floor so missed buckets cannot under-count a session. Claude has no running counter; its turn aggregate arrives as `PromptResponse.usage` and reconciles at turn end.
- **Per-session provider config.** On `session/new`, `session/resume`, and `session/load`, codex consumes `_meta["symphony/config"]` (the same shape as `config.toml`), merged into the thread config. On `session/new`, claude consumes `_meta["symphony/settings"]` (the same shape as `settings.json`), merged over the resolved file settings so `model`, `permissions.defaultMode`, `effortLevel`, and `availableModels` work without writing settings files into the workspace.

The claude bridge carries two further patches: it rewrites `/mcp:server:command args` slash commands to `/server:command (MCP) args`, and it hardcodes `settingSources` to `['user','project','local']` and `disallowedTools` to `['AskUserQuestion']`.

Which `_meta` key carries `provider_config` is decided per bridge family by `isClaudeCompatibleBridgeCommand(bridgeCommand)` (regex `/(^|\s|/)claude-agent-acp(\s|$)/`) or `agentKind === 'claude'`: claude gets `symphony/settings`, everything else gets `symphony/config`. When `provider_config` is absent, the session request omits `_meta` entirely.

## One turn end to end

`@lorenz/agent-runner` owns the run lifecycle. It calls `createWorkspaceForIssue`, runs the `before_run` hook, calls `executor.startSession` (which spawns the bridge and runs ACP `initialize` then `session/new`, each with a hardcoded 30000ms timeout), then loops `runTurn` up to `agent.max_turns` (default `20`). After the loop it calls `session.stop()` and then the `after_run` hook (best-effort).

Each `runTurn` is a single ACP `session/prompt`. The executor sends the prompt, reads every session notification the bridge streams back, and resolves the turn with all the `AgentUpdate` events it produced. The turn ends when the bridge returns a `PromptResponse` with a `stopReason`, which `actionForStopReason` maps:

| Stop reason class | Outcome | Event / error |
| --- | --- | --- |
| `continue` | resolve | `turn_completed` |
| `cancel` | reject | `turn_cancelled` (`acp_turn_cancelled`) |
| anything else | reject | `turn_failed` (`acp_turn_failed: <stopReason>`) |

Only one turn runs per session at a time. A second `runTurn` while a turn is pending throws `ACP turn already running`.

<p align="center"><img src="../assets/diagrams/agent-turn.svg" alt="agent turn diagram" width="920" style="width:100%;max-width:920px;height:auto" /></p>
*One turn: `runTurn` sends `session/prompt`, the bridge streams session notifications that reset the stall timer, and the `PromptResponse.stopReason` resolves or rejects the turn.*

### Turn timeout vs stall timeout

Two timers guard a turn, both set per kind and both reset on each `runTurn`:

- **Turn timeout** (`turn_timeout_ms`, internal `turnTimeoutMs`, default `3600000`) is a hard timer. When it fires it calls `connection.cancel({sessionId})` and rejects with `acp turn timed out`.
- **Stall timeout** (`stall_timeout_ms`, internal `stallTimeoutMs`, default `300000`) is an inactivity timer. It is reset on every incoming `AgentUpdate`, which means every session notification or stderr update. If no update arrives within the window, it fires the same `cancelTurn` path as the hard timer. Setting `stall_timeout_ms` to `0` or less disables stall detection entirely.

Both timers route through the same cancel-and-reject path. Late terminal updates that arrive after a timeout has settled the turn are suppressed by a settled guard. You can set both timeouts once under the `agents:` block as shared defaults and override them per kind; the per-kind value wins.

## The executor extension model

`agents.<kind>.executor` selects which executor runs that agent kind. The value is a string resolved through the `AgentExecutorRegistry`. Today the only registered executor is `acp`, provided by `acpExecutorProvider`; any other value throws `unsupported agent executor: <e> (known executors: ...)`.

An `AgentExecutorProvider` (defined in `packages/agent-sdk/src/provider.ts`) contributes an executor:

| Hook | Role |
| --- | --- |
| `executor` | the selector string matched against `agents.<kind>.executor` |
| `configAliases?` | snake_case to camelCase option key aliases |
| `parseOptions?` | validate the executor's slice of `agents.<kind>.options` |
| `validateAgent?` | startup validation of the per-kind config |
| `createExecutor` | required; returns the `AgentExecutor` that drives a session |

`acpExecutorProvider` registers `executor: "acp"`, maps the aliases `bridge_command`, `usage_accounting`, `provider_config`, and `strict_mcp_config`, rejects a blank `bridge_command` in `validateAgent`, and returns a fresh `Executor(kind)` from `createExecutor`. The `Executor` is the `AgentExecutor`: `startSession` spawns the bridge and runs `initialize` + `session/new`, `runTurn` sends the prompt and enforces the two timeouts, and `stopSession` runs `session/close` (5000ms, only if the bridge advertised `sessionCapabilities.close`) then `SIGTERM` followed by `SIGKILL` after a 1000ms grace.

The runtime contracts `AgentExecutor`, `AgentSession`, and `AgentUpdate` live in `@lorenz/domain`, not in `agent-sdk`. The SDK package owns only the build-time provider contract and the registry.

<p align="center"><img src="../assets/diagrams/acp-executor-model.svg" alt="acp executor model diagram" width="720" style="width:100%;max-width:720px;height:auto" /></p>
*The executor extension point: a provider registers under `agents.<kind>.executor`, `createExecutor` yields an `AgentExecutor`, and `agent-runner` drives it through `startSession` and `runTurn`.*

### Local and remote turns

`startSession` spawns the bridge one of two ways depending on whether a worker host is set:

- **Local.** `execa('bash', ['-lc', 'exec <resolvedCommand>'], {cwd, env: hostAgentBinaryEnv()})`. Local runs resolve bare bridge names through `resolveBridgeCommand`, which rewrites `codex-acp` and `claude-agent-acp` to the vendored workspace package bins. The packaged CLI does not bundle agent binaries, so `hostAgentBinaryEnv` resolves `CLAUDE_CODE_EXECUTABLE` and `CODEX_PATH` by running `bash -lc 'command -v <bin>'`; an explicit env value always wins, and results are cached per command.
- **Remote.** `startSshProcess(workerHost, 'cd <ws> && exec <command>')`. `resolveBridgeCommand` short-circuits when a worker host is set, so the remote host runs the configured command verbatim against whatever is on its `PATH`. The vendored packages are local-only.

Client filesystem access (`readTextFile` / `writeTextFile`) is exposed only for local runs and is path-sandboxed to the workspace root; out-of-bounds paths throw `acp_fs_path_must_be_absolute` or `acp_fs_path_outside_workspace`. The executor auto-approves permission requests: it selects the first option whose kind starts with `allow` and emits `approval_auto_approved`, or emits `approval_required` and returns `cancelled` when none match.

## Adding a non-ACP executor

`acp` is the only shipped executor. The extension point exists to add others: implement an `AgentExecutorProvider`, register it at the composition root (`registerBuiltinBackends` in `apps/cli/src/daemon.ts`), and point `agents.<kind>.executor` at your selector. The build recipe is in [Add an agent executor](../extensions/agent-executor.md).

## See also

- [Codex](codex.md) - the codex agent kind and its `provider_config` shape
- [Claude](claude.md) - the claude agent kind, default model, and settings overlay
- [Add an agent executor](../extensions/agent-executor.md) - the build recipe for a new executor
- [Agent orchestrator](../agent-orchestrator.md) - the run loop, hooks, and turn continuation
- [Configuration reference](../reference/configuration.md) - every `agents.<kind>` key and default
