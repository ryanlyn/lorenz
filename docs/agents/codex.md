# Codex

This page is for operators running Codex as the coding agent behind a Lorenz workflow. It covers the
`agents.codex` config record, the `codex-acp` bridge, provider config and usage accounting, the
default sandbox, and prerequisites. Codex is the default agent: `agent.kind` is `codex` out of the
box, so an unconfigured workflow runs it.

## Prerequisites

The packaged Lorenz CLI does not bundle the Codex binary. You need the `codex` CLI on `PATH` on the
machine that runs the agent:

- **Local runs**: `codex` must be on `PATH` for the login shell Lorenz spawns. Lorenz resolves the
  binary with `bash -lc 'command -v codex'` and exports it as `CODEX_PATH` for the bridge. An
  explicit `CODEX_PATH` in the environment always wins, so you can pin a specific build.
- **Remote runs** (a worker host): `codex` must be on `PATH` on that host. Lorenz runs the
  configured bridge command verbatim against the worker's `PATH`; it does not ship or resolve the
  binary for you.

The bridge package (`codex-acp`) is vendored inside Lorenz and resolved automatically for local
runs, so you do not install it separately.

## How a Codex turn runs

Codex runs through Lorenz's ACP executor. The executor spawns the `codex-acp` bridge as a
subprocess and drives it over the Agent Client Protocol: `initialize`, `newSession`, then one
`prompt` per turn. The bridge wraps the `codex` CLI. The full lifecycle (workspace creation, hooks,
the turn loop, timeouts) is the same for every ACP agent and lives in
[acp-bridges.md](./acp-bridges.md); this page covers what is specific to Codex.

The one knob that selects this machinery is the executor:

```yaml
agents:
  codex:
    executor: acp
```

`acp` is the only built-in executor and the default for the `codex` record, so you rarely write it.
It resolves the ACP executor provider, which reads the rest of the record.

## Config

Codex config lives under `agents.codex`. The record has shared keys plus an `options` bag the ACP
executor owns. The built-in defaults:

| Key | Default | Meaning |
| --- | --- | --- |
| `agents.codex.executor` | `acp` | Executor selector. Only `acp` ships today. |
| `agents.codex.bridge_command` | `codex-acp` | Shell command launched per session. Bare names resolve to the vendored bridge locally. |
| `agents.codex.usage_accounting` | `per-turn` | Shape of the usage numbers the bridge reports. See [Usage accounting](#usage-accounting). |
| `agents.codex.provider_config` | unset | `config.toml`-shaped overlay merged into the Codex session. See [Provider config](#provider-config). |
| `agents.codex.turn_timeout_ms` | `3600000` | Hard cap on one turn. The executor cancels the ACP turn when it fires. |
| `agents.codex.stall_timeout_ms` | `300000` | Inactivity cap, reset on every update from the bridge. `0` or below disables stall detection. |
| `agents.codex.strict_mcp_config` | `true` | Parsed and validated, but not read at runtime today. Treat it as a no-op for now. |

`bridge_command` must be non-blank; a blank value is rejected at config-parse time. The `acp`
executor rejects unknown option keys (see [index.md](./index.md)), so a misspelled option fails fast
rather than being silently ignored.

A minimal override that bumps the per-turn ceiling and points at a specific bridge invocation:

```yaml
agents:
  codex:
    turn_timeout_ms: 1800000
    bridge_command: codex-acp --some-flag
```

`bridge_command` is a single shell command string. To pass arguments to the bridge, write them
inline in that string; there is no separate `bridge_args` key.

### The legacy `codex:` block

A top-level `codex:` section is sugar that folds into `agents.codex`:

```yaml
codex:
  command: codex-acp
  turn_timeout_ms: 1800000
```

`command` is the legacy alias for `bridge_command`; the executor maps it into the record's `options`
bag. When both `command` and `bridge_command` are set, the canonical `bridge_command` wins. The
top-level `codex.turn_timeout_ms` / `codex.stall_timeout_ms` spellings fold into the record's
timeouts. Prefer the nested `agents.codex` form for new workflows.

### Shared timeout defaults

You can set `turn_timeout_ms` and `stall_timeout_ms` once under the `agents:` block as shared
defaults for every kind, and still override them per kind:

```yaml
agents:
  turn_timeout_ms: 1800000
  codex:
    stall_timeout_ms: 600000
```

The per-kind value wins over the shared default.

## Sandbox

The `codex-acp` bridge starts each session in Codex's default agent mode, `workspace-write`. In this
mode Codex can read and write inside the workspace and run commands, with the sandbox restricting
writes outside the workspace. The bridge exposes three modes:

| Mode | `sandbox_mode` | Behavior |
| --- | --- | --- |
| Read Only | `read-only` | Requires approval to edit files and run commands. |
| Agent (default) | `workspace-write` | Reads, writes, and runs commands inside the workspace. |
| Agent (Full Access) | `danger-full-access` | Drops the workspace sandbox for full-access workflows. |

The bridge picks its starting mode from the `INITIAL_AGENT_MODE` environment variable, falling back
to `workspace-write` when it is unset or unrecognized. Full-access workflows carry an operational
catch: Lorenz auto-approves the bridge's permission requests, so a `danger-full-access` session runs
unsandboxed commands without a human gate. Reserve it for isolated workers, not your laptop. For
sandbox tradeoffs see [security.md](../security.md).

## Provider config

For Codex, `provider_config` is a `config.toml`-shaped overlay: it sets anything the Codex CLI
accepts in `config.toml`, keyed the same way, and the bridge merges it over its own config.

```yaml
agents:
  codex:
    provider_config:
      model: gpt-5-codex
      model_reasoning_effort: high
```

The general `_meta` overlay mechanism (how the overlay reaches the bridge, and what absent
`provider_config` means) lives in [acp-bridges.md](./acp-bridges.md). The `config.toml` shape is the
Codex-specific part; the `claude-agent-acp` bridge consumes a `settings.json`-shaped overlay instead
(see [claude.md](./claude.md)).

## Usage accounting

The session-cumulative usage pipeline (how per-call counts reconcile against `PromptResponse.usage`,
and what `per-turn` vs `cumulative` mean) lives in [acp-bridges.md](./acp-bridges.md). What is
specific to Codex is the pair of signals the `codex-acp` bridge feeds into it:

- `_meta["symphony/callUsage"]`: per-call usage buckets, accumulated additively across a turn and
  deduplicated by sequence number. Input tokens sum the prompt, cached-read, and cached-write
  counts.
- `_meta["symphony/totalUsage"]`: a running cumulative counter Codex emits alongside each call.
  Lorenz uses it as a monotonic floor (baseline-subtracted) so the reported total never undercounts
  what the bridge reports. Codex is the bridge that provides this floor; Claude does not.

If you leave `usage_accounting` unset, Lorenz infers `per-turn` for a bridge command matching
`codex-acp`, and `cumulative` for anything else. The built-in record sets `per-turn` explicitly.

## See also
- [ACP bridges](./acp-bridges.md) - the turn lifecycle, timeouts, and usage pipeline shared by every ACP agent
- [Claude](./claude.md) - the other built-in agent and its `settings.json` overlay
- [Agents overview](./index.md) - choosing and configuring the agent that runs your work
- [Configuration reference](../reference/configuration.md) - every config key, default, and alias
- [Security](../security.md) - sandbox modes and auto-approval tradeoffs
