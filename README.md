# Symphony

This repository is a fork of [OpenAI Symphony](https://github.com/openai/symphony)'s Elixir reference implementation, with an additional TypeScript port.

Symphony is an orchestrator that connects a project tracker (Linear) to coding agents (Codex or
Claude Code). It polls for issues, creates isolated workspaces, and runs agents against each issue
until the work is done.

## How it works

1. Polls Linear for issues in active states (e.g. `Todo`, `In Progress`)
2. Creates a workspace per issue and bootstraps it via `hooks.after_create`
3. Launches the configured agent executor (Codex or Claude Code) inside the workspace
4. Renders a Liquid-templated prompt from `WORKFLOW.md` with issue context and sends it to the agent
5. Re-runs the agent on subsequent polling cycles if the issue remains active, up to `max_turns`
6. When an issue moves to a terminal state (`Done`, `Closed`, `Cancelled`, `Duplicate`), stops the
   agent and cleans up the workspace

The workflow file (`WORKFLOW.md`) defines both the orchestrator configuration (YAML front matter) and
the agent session prompt (Markdown body). Editing the workflow while Symphony is running reloads the
configuration automatically - no restart needed.

## Extensions

| Extension | What it adds |
| --- | --- |
| Context Ensembles | Adds configurable multi-agent issue fan-out with per-slot workspaces, prompt/dashboard ensemble context, `ensemble:*` label overrides, and a dedicated `WORKFLOW_ENSEMBLE.md` example for independent workpads. |
| Claude Code executor | Adds `agent.kind: "claude"` support, including Claude CLI execution, JSONL event parsing, built-in `/claude-mcp` tool serving instead of the Python MCP sidecar, authenticated remote worker access, and Claude-specific runtime settings. |
| Session resumption | Persists resume metadata in `.git/symphony/resume.json` so Codex and Claude sessions can continue safely across runs with executor-aware validation. |
| Workflow and runtime hardening | Defaults Codex workflows to sandboxed `workspace-write`, honors Linear `Retry-After` backoff on `429`, tightens remote workspace path validation, and improves long-running orchestrator reliability. |
| Claude parity and MCP handling | Routes Claude and Codex through the same Symphony-owned Linear tool backend, removes the Python MCP sidecar, and improves remote cleanup behavior. |
| Dispatch routing | Adds tracker-scoped static routing with Linear labels such as `Symphony:shard-a`, so multiple Symphony instances can split work by configured route labels. |

## Running

### Elixir

See [elixir/README.md](elixir/README.md) for full setup, configuration, and testing instructions.

```bash
cd elixir
mise trust
mise install
mise exec -- mix setup
mise exec -- mix build
mise exec -- ./bin/symphony ./WORKFLOW.md
```

### TypeScript

See [ts/README.md](ts/README.md) for full setup, configuration, and testing instructions.

```bash
cd ts
mise trust
mise install
pnpm install
pnpm build
pnpm start
```

See [CHANGELOG.md](CHANGELOG.md) for notable fork-specific changes.

## License

This project is licensed under the [Apache License 2.0](LICENSE).
