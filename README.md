# Symphony

This repository is a TypeScript port of [OpenAI Symphony](https://github.com/openai/symphony).

Symphony is an orchestrator that connects a project tracker (Linear) to coding agents (Codex or
Claude Code). It polls for issues, creates isolated workspaces, and runs agents against each issue
until the work is done.

## Screenshots

The TypeScript port ships two operator views over the same runtime snapshot: an Ink terminal
dashboard (TUI) and a web dashboard served by the observability API.

### Terminal dashboard (TUI)

![Symphony terminal dashboard](docs/images/symphony-tui.png)

### Web dashboard

![Symphony web dashboard](docs/images/symphony-dashboard.png)

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
| Claude Code executor | Adds `agent.kind: "claude"` support, including Claude CLI execution, JSONL event parsing, built-in `/mcp` tool serving instead of the Python MCP sidecar, authenticated remote worker access, and Claude-specific runtime settings. |
| Workflow and runtime hardening | Defaults Codex workflows to sandboxed `workspace-write`, honors Linear `Retry-After` backoff on `429`, tightens remote workspace path validation, and improves long-running orchestrator reliability. |
| Claude parity and MCP handling | Routes Claude and Codex through the same Linear tool backend, removes the Python MCP sidecar, and improves remote cleanup behavior. |
| Dispatch routing | Adds tracker-scoped static routing with Linear labels such as `Symphony:shard-a`, so multiple Symphony instances can split work by configured route labels. |
| Run history CLI | Adds an orchestrator run history command (`symphony-ts runs`) exposing completed attempts, retries, token totals, and per-run forensic context beyond live state. |
| Secret resolution | Resolves `op://` references in workflow secrets (e.g. `LINEAR_API_KEY`) through the 1Password CLI. |

## Running

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
