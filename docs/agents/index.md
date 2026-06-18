# Agents

This page is for operators configuring which coding agent Lorenz runs and how. It covers two
independent axes - the agent *kind* (a config record) and the *executor* (the mechanism that runs a
turn) - plus the shared knobs that bound every run. The agent layer is where a dispatched issue turns into
a live coding session.

## Two axes: kind and executor

The agent kind sets *what* you run; the executor sets *how* it runs.

- **Agent kind** is pure configuration. Each kind is a record under `agents.<kind>` in your
  `WORKFLOW.md` front matter. The two built-in kinds are `codex` and `claude`. `agent.kind`
  (default `codex`) selects which record runs.
- **Executor** is the runtime that drives a turn, chosen per kind by `agents.<kind>.executor`. One
  built-in executor ships: `acp`, the default for both built-in kinds.

The axes are orthogonal. Define any number of kinds pointing at the same `acp` executor with
different options, or, as an extension author, register a new executor and select it with
`agents.<kind>.executor`. Adding or renaming a kind never changes the executor contract.

```yaml
agent:
  kind: codex
agents:
  codex:
    executor: acp
  claude:
    executor: acp
```

`AgentKind` is an open-ended string, not a fixed enum. The supported set is whatever the
composition root registered plus whatever you declare under `agents`.

## The ACP bridge model

The `acp` executor runs no coding agent in-process. It spawns an external *bridge* subprocess and
speaks the Agent Client Protocol (ACP) to it over stdio. The bridge wraps the actual agent (the
Codex CLI or the Claude Agent SDK) and translates ACP calls into agent work.

<p align="center"><img src="../assets/diagrams/acp-executor-model.svg" alt="acp executor model diagram" width="720" style="width:100%;max-width:720px;height:auto" /></p>
*The `acp` executor spawns a bridge subprocess and drives it over ACP; the bridge wraps the real coding agent.*

The executor owns the session lifecycle: `initialize` and `newSession` (each with a hardcoded
30000 ms timeout), then one `prompt` call per turn, then `cancel`/`closeSession` on teardown. It
translates the bridge's ACP notifications into the `AgentUpdate` event stream the orchestrator
consumes (`session_started`, `turn_started`, `turn_completed`, `session_notification`, and the
rest). Locally the bridge runs under `bash -lc`; on a worker host it runs over SSH.

`agents.<kind>.bridge_command` names the bridge. The built-in defaults are `codex-acp` (codex) and
`claude-agent-acp` (claude). A bare bridge name resolves to a vendored workspace package for local
runs; on a remote worker host the command runs verbatim against that host's `PATH`. The full bridge
mechanics, vendored patches, and usage accounting live in [acp-bridges.md](acp-bridges.md).

## Codex and Claude

The two built-in kinds differ only in their `agents.<kind>` records. Both use the `acp` executor.

| | `codex` | `claude` |
| --- | --- | --- |
| `bridge_command` default | `codex-acp` | `claude-agent-acp` |
| Underlying agent | Codex CLI | Claude Agent SDK |
| `provider_config` shape | `config.toml` overrides | `settings.json` overlay |
| Model pin | from `config.toml` / `provider_config` | `DEFAULT_CLAUDE_MODEL` (currently `claude-opus-4-6[1m]`; authoritative value in `packages/config/src/defaults.ts`) |

The Claude record ships with a `provider_config` that pins the model and sets
`permissions.defaultMode` to `dontAsk`. See [codex.md](codex.md) and [claude.md](claude.md) for the
per-kind option bags, provider-config formats, and binary resolution.

## The agent record

Each `agents.<kind>` record has a small set of shared core keys plus an executor-owned `options`
bag. The shared keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `executor` | `acp` | Selects the executor that runs this kind. |
| `turn_timeout_ms` | `3600000` | Hard cap on a single turn; the executor cancels the turn when it fires. |
| `stall_timeout_ms` | `300000` | Inactivity cap, reset on every update; `<= 0` disables stall detection. |
| `options` | per-kind | Executor-owned bag (for `acp`: `bridge_command`, `usage_accounting`, `provider_config`, `strict_mcp_config`). |

The executor validates the keys inside `options`, not the config core. The `acp` executor rejects
unknown option keys, so a misspelled key fails at parse time rather than silently doing nothing.

### Shared turn-timeout defaults

`turn_timeout_ms` and `stall_timeout_ms` can be set once under the top-level `agents:` block as
defaults applied to every kind, and also per kind. The per-kind value wins.

```yaml
agents:
  turn_timeout_ms: 1800000
  stall_timeout_ms: 120000
  codex:
    stall_timeout_ms: 60000
```

Every kind gets a 1800000 ms turn cap; `codex` overrides the stall cap to 60000 ms while keeping
the shared turn cap.

## Run-wide knobs

These live under the top-level `agent` block (singular) and bound the orchestration loop, not a
single executor.

| Key | Default | Meaning |
| --- | --- | --- |
| `agent.max_concurrent_agents` | `10` | Global cap on agents running at once. |
| `agent.max_turns` | `20` | Maximum `runTurn` iterations before the run loop stops. |
| `agent.kind` | `codex` | Which `agents.<kind>` record a dispatched issue runs. |

The run loop builds the workspace, runs the `before_run` hook, opens a session, loops `runTurn` up
to `max_turns`, then runs the `after_run` hook on a best-effort basis. It also stops early when the
issue goes inactive or the selected kind changes between turns. See
[agent-orchestrator.md](../agent-orchestrator.md) for the dispatch and concurrency model.

## Legacy `codex:` / `claude:` sugar

Older workflows wrote a top-level `codex:` or `claude:` section instead of `agents.<kind>`. These
sections still parse, mapping onto the matching `agents` record at parse time, where `agents` is the
single source of truth at runtime. A legacy `command` key maps to `bridge_command`; `claude.model`
pins the `model` of the Claude record's `provider_config`. Prefer writing `agents.<kind>` directly.

## See also

- [acp-bridges.md](acp-bridges.md) - the ACP executor, vendored bridges, and usage accounting in full.
- [codex.md](codex.md) - the `codex` kind: options, `config.toml` provider config, binary resolution.
- [claude.md](claude.md) - the `claude` kind: settings overlay, model pin, permission mode.
- [skills.md](skills.md) - skill directories overlaid into the agent workspace.
- [../extensions/agent-executor.md](../extensions/agent-executor.md) - building a new executor for `agents.<kind>.executor`.
- [../reference/configuration.md](../reference/configuration.md) - every config key, default, and alias.
