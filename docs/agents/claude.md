# Claude

This page is for operators who run Claude Code as the coding agent behind a Lorenz dispatch. It
covers the `claude` agent record, the `claude-agent-acp` bridge it drives, the `settings.json`-shaped
provider config overlay, and the MCP wiring that lets a Claude session call Lorenz tracker tools.

For the shared agent model (the kind/executor split, the run loop, run-wide knobs), read
[index.md](index.md) first. This page is the Claude-specific layer on top of it.

## Selecting Claude

Claude is a built-in agent kind. Point `agent.kind` at it and Lorenz runs the `agents.claude`
record:

```yaml
agent:
  kind: claude
agents:
  claude:
    executor: acp
    bridge_command: claude-agent-acp
```

`agent.kind` defaults to `codex`, so set it explicitly to run Claude. Everything else has a built-in
default, shown below.

## The `agents.claude` record

The record has the shared core keys (`executor`, `turn_timeout_ms`, `stall_timeout_ms`) plus an
executor-owned `options` bag. For the `acp` executor the bag holds `bridge_command`,
`usage_accounting`, `provider_config`, and `strict_mcp_config`.

| Key | Default | Meaning |
| --- | --- | --- |
| `executor` | `acp` | The runtime that drives a turn. `acp` is the only built-in executor. |
| `bridge_command` | `claude-agent-acp` | The bridge subprocess the executor spawns. A single shell command string. |
| `turn_timeout_ms` | `3600000` | Hard cap on one turn; the executor cancels the turn when it fires. |
| `stall_timeout_ms` | `300000` | Inactivity cap, reset on every update; `<= 0` disables stall detection. |
| `usage_accounting` | `per-turn` | How per-call token usage is folded into the cumulative total. |
| `provider_config` | model pin + `permissions.defaultMode: dontAsk` | Per-session `settings.json` overlay handed to the bridge. |
| `strict_mcp_config` | `true` | Parsed and validated, but not read at runtime by the executor. |

The `acp` executor rejects unknown keys inside `options`; see [index.md](index.md) for that caveat.

The full built-in record, expanded:

```yaml
agents:
  claude:
    executor: acp
    bridge_command: claude-agent-acp
    turn_timeout_ms: 3600000
    stall_timeout_ms: 300000
    usage_accounting: per-turn
    strict_mcp_config: true
    provider_config:
      model: claude-opus-4-6[1m]
      permissions:
        defaultMode: dontAsk
```

### `bridge_command`

`bridge_command` is one shell command string, not an argument array. The bare name
`claude-agent-acp` resolves to the vendored workspace bridge package for local runs. To pass flags to
the bridge, write them inline in the string, for example `bridge_command: claude-agent-acp --verbose`;
there is no separate `bridge_args` key. How the executor splits the string and resolves the name on a
worker host lives in [acp-bridges.md](acp-bridges.md).

### `provider_config`

For a `claude` kind, `provider_config` is a `settings.json`-shaped record delivered to the bridge
once per session. The bridge merges it over the file-based Claude settings, so it carries any
`settings.json` field: `model`, `permissions`, `env`, and the rest. How Lorenz wraps it in the
`_meta` overlay (here under the `symphony/settings` key) is in [acp-bridges.md](acp-bridges.md).

The built-in record sets two fields:

- `model` pins the session model. The built-in `claude` record pins `DEFAULT_CLAUDE_MODEL`
  (currently `claude-opus-4-6[1m]`; the authoritative value lives in
  `packages/config/src/defaults.ts`).
- `permissions.defaultMode` is `dontAsk`, so the bridge does not prompt for permission. The
  executor also auto-approves any ACP permission request it receives, selecting the first option
  whose kind begins with `allow`.

To pin a different model or open a `settings.json` field, set it under `provider_config`:

```yaml
agents:
  claude:
    bridge_command: claude-agent-acp
    provider_config:
      model: claude-opus-4-6[1m]
      permissions:
        defaultMode: dontAsk
```

### `usage_accounting`

The built-in record sets `usage_accounting: per-turn`. The Claude bridge keeps no running cumulative
counter: its per-turn aggregate arrives as the ACP `PromptResponse.usage` and reconciles at turn end.
The accounting modes and the pipeline that emits session-cumulative totals live in
[acp-bridges.md](acp-bridges.md).

### `strict_mcp_config`

`strict_mcp_config` parses and validates (default `true`) and is carried on the parsed options, but
the `acp` executor never reads it and never forwards it to the bridge. It is accepted with no runtime
effect.

## How the Claude bridge differs

The vendored `claude-agent-acp` bridge wraps the Claude Agent SDK and carries Lorenz patches over
the upstream package. Three behaviors are specific to it:

- **`/mcp` slash-command rewriting.** The bridge rewrites a `/mcp:server:command args` slash command
  into `/server:command (MCP) args` so the underlying Claude session resolves it as an MCP command.
- **Fixed setting sources and disallowed tools.** The bridge hardcodes `settingSources` to
  `["user", "project", "local"]` and adds `AskUserQuestion` to `disallowedTools`, so a Claude run
  cannot block on an interactive question.
- **Per-message usage.** The bridge emits a `symphony/callUsage` bucket per assistant message,
  derived from the message's `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and
  `cache_creation_input_tokens`.

## Tools over the built-in `/mcp` endpoint

A Claude session reaches Lorenz tracker tools through the built-in `/mcp` tool endpoint, not a
separate sidecar. The Codex bridge receives the same tools as an ACP `McpServer` config; Claude
calls the HTTP `POST /mcp` JSON-RPC endpoint directly. Either way the tool surface is identical: the
neutral `tracker` pack (`tracker_read_issue`, `tracker_query`, `tracker_update_status`,
`tracker_list_comments`, `tracker_comment`, `tracker_update_comment`, `tracker_create_issue`), plus
the dispatch tracker's own packs and any pack named in the workflow `tools:` map.

The observability server hosts that `/mcp` endpoint, so it starts automatically for Claude workflows
even when you have not configured a web dashboard port. The ACP bridge needs a reachable endpoint to
serve tools. For a remote worker the endpoint is leased over an SSH reverse tunnel. The MCP server,
auth scope, and endpoint leasing live in [observability.md](../observability.md) and
[../reference/tracker-tools.md](../reference/tracker-tools.md).

## Binary resolution

The packaged Lorenz CLI does not bundle the Claude binary. The bridge runs the executable named by
`CLAUDE_CODE_EXECUTABLE`; if that is unset, Lorenz resolves it from a login shell with
`command -v claude` and exports the result. An explicit `CLAUDE_CODE_EXECUTABLE` value always wins.
The general binary/bridge name resolution (per-command caching, worker `PATH`) is in
[acp-bridges.md](acp-bridges.md).

## Prerequisites

- The `claude-agent-acp` ACP bridge, reachable locally as a vendored workspace package or installed
  on each worker host's `PATH`.
- The Claude binary on `PATH` (or `CLAUDE_CODE_EXECUTABLE` set), since the CLI does not bundle it.

## Legacy `claude:` sugar

Older workflows wrote a top-level `claude:` section instead of `agents.claude`. It still parses and
maps onto the `agents.claude` record at parse time, where `agents` is the single source of truth at
runtime. The accepted legacy keys are `command`, `model`, `turn_timeout_ms`, `stall_timeout_ms`,
`strict_mcp_config`, and `provider_config`:

- `command` is the alias for `bridge_command`. When both are set, the canonical `bridge_command`
  wins.
- `model` pins the `model` of the Claude record's `provider_config`.
- `turn_timeout_ms` / `stall_timeout_ms` / `strict_mcp_config` / `provider_config` map to the same
  fields on the record.

This section is `.strict()`: it accepts only those keys. Prefer writing `agents.claude` directly.

## See also

- [index.md](index.md) - the kind/executor model and shared agent record.
- [acp-bridges.md](acp-bridges.md) - the `acp` executor, vendored bridges, and usage accounting.
- [../observability.md](../observability.md) - the server that hosts the `/mcp` tool endpoint.
- [../reference/tracker-tools.md](../reference/tracker-tools.md) - the `tracker_*` tools a Claude session can call.
- [../reference/configuration.md](../reference/configuration.md) - every config key, default, and alias.
