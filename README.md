# Lorenz

Originated from [OpenAI Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/), Lorenz lets you declare work on trackers (in-memory, Obsidian markdown files, Linear, Jira, Slack etc.) and manage the dispatch, execution, and convergence of concurrent agent sessions until they reach a specified terminal state. It is harness-agnostic through the [Agent-Client Protocol](https://agentclientprotocol.com/get-started/introduction) with support for local, static SSH boxes, or (experimental) cloud-brokered VMs. 

## Screenshots

Lorenz ships two operator views over the same runtime snapshot: an Ink terminal dashboard (TUI)
and a web dashboard served by the observability API.

### Terminal dashboard (TUI)

![Lorenz terminal dashboard](docs/images/lorenz-tui.png)

### Web dashboard

![Lorenz web dashboard](docs/images/lorenz-dashboard.png)

## Documentation

The full docs live in [`docs/`](./docs). Start here:

- [Getting started](./docs/getting-started.md) - install, write a `WORKFLOW.md`, run your first issue.
- [How it works](./docs/how-it-works.md) - the polling, dispatch, and run lifecycle.
- [Configuration reference](./docs/reference/configuration.md) - every front-matter key, default, and meaning.
- [Trackers](./docs/trackers/index.md) - Linear, Jira, Slack, local, and memory sources of issues.
- [CLI](./docs/cli.md) - commands, flags, and run history.

## Quickstart

Running Lorenz is as easy as:

```sh
npx @lorenz WORKFLOW.md
```

with full CLI options:

```sh
lorenz [--once] [--dry-run] [--no-tui] [--port <port>] [--logs-root <path>] [path-to-WORKFLOW.md]
lorenz runs [--issue ID] [--failed] [--cost] [--retries] [--id RUN_ID] [--limit N] [--json]
```

`--logs-root <path>` writes logs under `<path>/log/lorenz.log`. With no workflow path the CLI reads
`LORENZ_WORKFLOW`, then `./WORKFLOW.md`. See [CLI](./docs/cli.md) for every flag and command.

Runtime needs depend on the workflow: `LINEAR_API_KEY` for Linear, `codex` on `PATH` for Codex
runs, a Claude ACP bridge for Claude runs, and SSH access for remote workers. See
[Getting started](./docs/getting-started.md) for the full list. Run commands from the repository
root unless a command says otherwise.

## Configuration

Configuration lives in the YAML front matter of a workflow file. The Markdown body below the front
matter is the agent session prompt, rendered as Liquid with issue-context variables. See
[Workflows](./docs/workflows.md) for the file format and a quickstart example.

### Full Reference

Every front-matter key, its type, verified default, and meaning are in the
[Configuration reference](./docs/reference/configuration.md). `workspace.root` supports `~` and
whole-value `$VAR` expansion, and `LORENZ_WORKSPACE_ROOT` overrides it at runtime.

## Linear

Linear is the default tracker: issues live in a Linear project, read access uses `LINEAR_API_KEY`,
and project selection uses `project_slug`. Route labels such as `Lorenz:backend` let multiple
instances share one project. Setup and configuration are in
[Linear tracker](./docs/trackers/linear.md). Other sources (Jira, Slack, local, memory) are covered
under [Trackers](./docs/trackers/index.md).

## Workflow Prompt

The prompt body reads public issue and run fields as Liquid variables, such as
`{{ issue.identifier }}`, `{{ issue.title }}`, `{{ issue.description }}`, and `{{ attempt }}`. The
complete variable list is in the [Workflow prompt reference](./docs/reference/workflow-prompt.md).

## Skills

The `skills/` directory holds orchestration skills (`lorenz-commit`, `lorenz-push`, `lorenz-pull`,
`lorenz-land`, `lorenz-debug`) referenced by the example workflows. Lorenz copies skills into
`.lorenz/skills/` in each prepared workspace before the agent starts. See
[Skills](./docs/agents/skills.md) for how `agent.skills` and tool-pack skills are resolved.

## Observability

The terminal dashboard shows agents, throughput, runtime, token usage, rate limits, sessions, the
retry queue, and dispatch blocks. The web dashboard exposes the same runtime snapshot over a local
HTTP server, started with `--port` or `server.port`. Routes, the WebSocket stream, and `/mcp` tool
serving are documented in [Observability](./docs/observability.md).

## Contributing

### Requirements

[mise](https://mise.jdx.dev/) manages Node 24 and pnpm 9 from `mise.toml`:

```sh
mise trust
mise install
pnpm install
```

### Run

Build, then run the CLI against a workflow file:

```sh
pnpm build
pnpm start -- WORKFLOW.md
pnpm start:once -- --dry-run --no-tui WORKFLOW.md
```

### Workspace Layout

`apps/cli` is the composition root; `packages/*` is the provider-agnostic engine;
`extensions/*` are the tracker backends; `test/` holds workspace-level tests. The layering rules
and the recipe for adding a tracker live in [Architecture](./docs/architecture.md) and the
[Source map](./docs/source-map.md).

### Testing

```sh
mise run tidy
mise run check
```

`mise run tidy` formats and applies lint fixes. `mise run check` runs typecheck, build, tests, and
lint. When running Vitest directly, rebuild first so tests exercise the current compiled packages.

### Live Tests

Live tests are opt-in and launch real CLIs or services in isolated workspaces:

```sh
pnpm test:live:codex
pnpm test:live:linear-codex
pnpm test:live:claude
pnpm test:live:ssh
```

`LORENZ_LIVE_SSH_WORKER_HOSTS` is a comma-separated list of real SSH workers. When it is unset, the
SSH live test can use disposable local workers if Docker, `ssh-keygen`, and Codex auth are
available. `LINEAR_API_KEY` is required for Linear live tests, and
`LORENZ_TS_CLAUDE_ACP_BRIDGE_COMMAND` enables the Claude live tests.

### Packaging

```sh
pnpm build
pnpm --filter @lorenz/cli pack --dry-run
```

The CLI package includes the built binary. Workspace documentation, workflow fixtures, and test
evidence stay at the workspace root.

### Compatibility Contracts

The checked-in workflow files (`WORKFLOW.md`, `WORKFLOW_FULL_ACCESS.md`) are executable fixtures.
`pnpm test` guards workflow docs, prompt rendering, dashboard snapshots, runtime behavior, and CLI
documentation. Update the fixture and the matching test together when the public contract changes.

## License

See [CHANGELOG.md](CHANGELOG.md) for notable changes. This project is licensed under the [Apache License 2.0](LICENSE).
