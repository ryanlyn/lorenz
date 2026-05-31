# Symphony TypeScript Workspace

Symphony turns tracker issues into agent runs. It polls for eligible work, prepares a workspace,
renders the workflow prompt with issue context, starts Codex or Claude, and records the run so
operators can inspect state, retries, cost, logs, and resume metadata.

This workspace owns the TypeScript CLI, runtime packages, tracker adapters, terminal dashboard,
local observability server, trace viewer packages, and tests.

## Requirements

[mise](https://mise.jdx.dev/) is recommended for managing Node and pnpm:

```sh
mise trust
mise install
pnpm install
```

The workspace uses Node 24 and pnpm 9 from `ts/mise.toml`.

Runtime requirements depend on the workflow:

- `LINEAR_API_KEY` for Linear-backed workflows.
- `codex` on `PATH` for Codex runs and live Codex tests.
- A Claude ACP bridge, usually `claude-agent-acp`, for Claude runs and live Claude tests.
- SSH access for remote workers and live SSH tests.
- Docker and `ssh-keygen` for disposable live SSH workers when no real SSH hosts are configured.

Run commands from `ts/` unless a command says otherwise.

## Run

```sh
pnpm build
pnpm start -- WORKFLOW.md
pnpm start:once -- --dry-run --no-tui WORKFLOW.md
pnpm runs -- --port 4000 --failed
```

The built CLI is `symphony-ts`:

```sh
symphony-ts [--once] [--dry-run] [--no-tui] [--port <port>] [--logs-root <path>] [path-to-WORKFLOW.md]
symphony-ts runs [--issue ID] [--failed] [--cost] [--retries] [--id RUN_ID] [--limit N] [--url URL | --port PORT] [--json]
```

Optional flags:

- `--logs-root <path>` writes logs under `<path>/log/symphony.log`.
- `--port <port>` starts the local observability dashboard and JSON API.
- `--once` polls once and exits.
- `--dry-run` evaluates candidates without dispatching agents.
- `--no-tui` disables the terminal dashboard and prints JSON snapshots.

With no workflow path, the CLI reads `SYMPHONY_WORKFLOW`, then `./WORKFLOW.md`.

The runtime reloads the workflow before each poll. If startup cannot read or parse the workflow,
the CLI exits with an error. If a later reload fails, the runtime keeps the last good workflow and
records a `workflow_reload_failed` event.

## Workspace Layout

- `apps/cli` wires configuration, tracker clients, agent runners, the runtime, the TUI, and the
  observability server into the shipped binary.
- `apps/traceviz` renders trace event streams for local inspection.
- `packages/*` contains the protocol, domain model, configuration loader, prompt renderer, runtime,
  policies, adapters, dashboards, logging, SSH, and support libraries.
- `test/` contains workspace-level integration, contract, sandbox, and live tests.
- Package-owned unit tests live under `packages/<name>/test/` or `apps/<name>/test/`.

Create a package when a boundary has a clear owner. Keep curated exports in `src/index.ts` and
declare internal dependencies as `workspace:*`.

## Configuration

Configuration lives in the YAML front matter of a workflow file. The Markdown body below the front
matter is the agent session prompt, rendered as Liquid with issue context variables.

### Quickstart

```yaml
---
tracker:
  kind: linear
  project_slug: "your-project-slug"
workspace:
  root: ~/code/workspaces
hooks:
  after_create: |
    git clone git@github.com:your-org/your-repo.git .
agent:
  kind: codex
---

You are working on {{ issue.identifier }}: {{ issue.title }}

{{ issue.description }}
```

Set `LINEAR_API_KEY` in your environment before running a Linear workflow.

### Full Reference

```yaml
---
tracker:
  kind: linear # "linear" for Linear, "memory" for fixtures and tests
  api_key: $LINEAR_API_KEY # defaults to $LINEAR_API_KEY when unset
  endpoint: "https://api.linear.app/graphql"
  project_slug: "my-project" # right-click a Linear project and copy the URL slug
  assignee: $LINEAR_ASSIGNEE # optional; filters issues by assignee
  active_states:
    - Todo # default: ["Todo", "In Progress"]
    - In Progress
    - Agent Review
    - Merging
    - Rework
  terminal_states:
    - Closed # default: ["Closed", "Cancelled", "Canceled",
    - Cancelled #           "Duplicate", "Done"]
    - Canceled
    - Duplicate
    - Done
  dispatch:
    accept_unrouted: true # accept issues without a route label; default: true
    only_routes: null # null accepts any route, [] accepts none
    route_label_prefix: "Symphony:" # route labels look like "Symphony:backend"

polling:
  interval_ms: 30000 # default: 30000

workspace:
  root: ~/code/workspaces # default: $TMPDIR/symphony_workspaces

worker:
  ssh_hosts:
    - worker1.example.com # standard OpenSSH targets and Host aliases work
    - worker2.example.com:2222
  ssh_timeout_ms: 60000 # default: 60000
  max_concurrent_agents_per_host: 2 # optional; defaults to the global agent cap per host

agent:
  kind: codex # default: "codex"; "claude" is configured below
  max_concurrent_agents: 10 # default: 10
  max_turns: 20 # default: 20
  max_retry_backoff_ms: 300000 # default: 300000
  ensemble_size: 1 # default: 1

agents:
  codex:
    executor: appserver
    command: codex app-server
  claude:
    executor: acp
    bridge_command: claude-agent-acp
    bridge_args:
      - --permission-mode
      - dontAsk
      - --model
      - claude-opus-4-6[1m]

status_overrides:
  in progress:
    agent:
      max_concurrent_agents: 5
  merging:
    agent:
      max_concurrent_agents: 2

codex:
  command: codex app-server # launched through bash -lc in the workspace
  approval_policy: never # untrusted, on-failure, on-request, never, or a map
  thread_sandbox: workspace-write # read-only, workspace-write, danger-full-access
  turn_sandbox_policy:
    type: workspaceWrite # passed through to Codex unchanged when set
    writableRoots:
      - /path/to/workspace
    networkAccess: true
  turn_timeout_ms: 3600000 # default: 3600000
  read_timeout_ms: 5000 # default: 5000
  stall_timeout_ms: 300000 # default: 300000

claude:
  command: claude-agent-acp # ACP bridge command
  model: claude-opus-4-6[1m]
  permission_mode: dontAsk
  turn_timeout_ms: 3600000 # default: 3600000
  stall_timeout_ms: 300000 # default: 300000
  strict_mcp_config: true # default: true

hooks:
  after_create: | # runs after a workspace directory is created
    git clone --depth 1 git@github.com:org/repo.git .
  before_run: | # runs before each agent turn
    git pull origin main
  after_run: | # best effort; runs after each agent turn
    echo "turn complete"
  before_remove: | # best effort; runs before workspace cleanup
    echo "cleaning up"
  timeout_ms: 60000 # default: 60000

observability:
  dashboard_enabled: true # terminal dashboard; default: true
  refresh_ms: 1000 # default: 1000
  render_interval_ms: 16 # default: 16

server:
  port: 4000 # enables the web dashboard; default: disabled
  host: 127.0.0.1 # default: 127.0.0.1

logging:
  log_file: ./log/symphony.log # default: ./log/symphony.log
---
```

Notes:

- `tracker.kind` is always required. `tracker.project_slug` is required for Linear workflows.
- `tracker.api_key` falls back to `LINEAR_API_KEY`; `tracker.assignee` falls back to
  `LINEAR_ASSIGNEE`.
- `tracker.api_key` and `tracker.assignee` can use `op://` references when the 1Password CLI is
  installed.
- `workspace.root` supports `~` and whole-value `$VAR` expansion. `SYMPHONY_WORKSPACE_ROOT`
  overrides `workspace.root` at runtime.
- `SYMPHONY_SSH_CONFIG` points SSH worker commands at a custom OpenSSH config file.
- Hooks run through `bash -lc` locally or over SSH with the workspace as `cwd`.
- `codex.command` runs through `bash -lc`, so shell expansion happens in the launched process.
- When `codex.turn_sandbox_policy` is omitted, Symphony generates a `workspaceWrite` policy rooted
  at the issue workspace.
- If the Markdown body is blank, Symphony uses a default prompt with the issue identifier, title,
  and body.

## Linear

Prerequisites:

1. Create a personal API token in Linear Settings, Security & access, Personal API keys.
2. Export it as `LINEAR_API_KEY`, or set `tracker.api_key: $LINEAR_API_KEY`.
3. Find the project slug by right-clicking a Linear project and copying its URL. The slug is in the
   path.
4. The example workflows use non-standard states such as `Agent Review`, `Rework`, `Human Review`,
   and `Merging`. Add those states under Team Settings, Workflow, or adjust `active_states` and
   `terminal_states` to match your team.

Route labels let multiple Symphony instances share one Linear project. With the default
`route_label_prefix`, labels such as `Symphony:backend` and `Symphony:frontend` become route names.

## Workflow Prompt

The prompt body can read these public issue and run fields:

- `{{ issue.identifier }}`
- `{{ issue.title }}`
- `{{ issue.description }}`
- `{{ issue.state }}`
- `{{ issue.state_type }}`
- `{{ issue.labels }}`
- `{{ issue.url }}`
- `{{ issue.id }}`
- `{{ issue.priority }}`
- `{{ issue.branch_name }}`
- `{{ issue.assignee_id }}`
- `{{ issue.created_at }}`
- `{{ issue.updated_at }}`
- `{{ issue.assigned_to_worker }}`
- `{{ issue.blocked_by }}`
- `{{ attempt }}`
- `{{ ensemble.enabled }}`
- `{{ ensemble.slot_index }}`
- `{{ ensemble.size }}`

Workspace tests render representative Liquid constructs: conditionals, null fallbacks, loops,
`forloop` metadata, nested blocker refs, and common filters.

## Skills

The `.codex/skills/` directory in this repo contains orchestration skills referenced by the example
workflow files:

- `symphony-linear` interacts with Linear comments, state transitions, and queries.
- `symphony-commit` produces clean, logical commits.
- `symphony-push` pushes branches and creates or updates PRs.
- `symphony-pull` merges the latest `origin/main` into a working branch.
- `symphony-land` monitors and merges approved PRs.
- `symphony-debug` investigates stuck runs and execution failures.

Copy the skills into the target repo's `.codex/skills/` directory when your workflow references
them. The `symphony-linear` skill uses the injected `linear_graphql` tool for Codex or the
`/claude-mcp` endpoint for Claude.

## Observability

The terminal dashboard shows agents, throughput, runtime, token usage, rate limits, running
sessions, retry queue, and dispatch blocks. The web dashboard exposes the same runtime snapshot
through a local HTTP server.

Start the web dashboard with `--port` or `server.port`:

```sh
pnpm start -- WORKFLOW.md --port 4000
```

API routes:

- `/`
- `/api/v1/state`
- `/api/v1/events`
- `/api/v1/runs`
- `/api/v1/runs?id=<run-id>`
- `/api/v1/refresh`
- `/api/v1/:issue_identifier`

Claude sessions use `/claude-mcp` for injected dynamic tools when the runtime has started an
observability server. The server also starts automatically for Claude workflows so the ACP bridge
can reach those tools.

`symphony-ts runs` queries the same API for run history, cost summaries, retry summaries, and raw
JSON output.

## Testing

```sh
mise run tidy
mise run check
```

`mise run tidy` formats and applies lint fixes. `mise run check` runs typecheck, build, tests, and
lint.

Useful direct commands:

```sh
pnpm typecheck
pnpm build
pnpm lint
pnpm test
pnpm test:watch
```

When running Vitest directly, rebuild first so tests exercise the current compiled packages.

## Live Tests

Live tests are opt-in and launch real CLIs or services in isolated workspaces.

```sh
pnpm test:live:codex
pnpm test:live:codex-resume
pnpm test:live:linear-codex
pnpm test:live:claude
pnpm test:live:ssh
pnpm test:live:linear-sandbox
```

`pnpm test:live` runs the Codex, Codex resume, Linear plus Codex, and Claude live tests.

Environment knobs:

- `SYMPHONY_TS_CODEX_COMMAND` overrides the Codex app-server command for live tests.
- `SYMPHONY_TS_CLAUDE_ACP_BRIDGE_COMMAND` enables Claude live tests.
- `SYMPHONY_TS_CLAUDE_ACP_BRIDGE_ARGS` supplies Claude ACP bridge args as a JSON string array.
- `LINEAR_API_KEY` is required for Linear live tests and Claude MCP canaries.
- `LINEAR_PROJECT_SLUG` selects the Linear project for `pnpm test:live:linear-codex`.
- `SYMPHONY_LIVE_SSH_WORKER_HOSTS` is a comma-separated list of real SSH workers.
- When `SYMPHONY_LIVE_SSH_WORKER_HOSTS` is unset, the SSH live test can use disposable local
  workers if Docker, `ssh-keygen`, and Codex auth are available.
- `SYMPHONY_LIVE_DOCKER_CODEX_AUTH_JSON` points disposable workers at a Codex auth file. The
  default is `~/.codex/auth.json`.
- `CLAUDE_CODE_OAUTH_TOKEN` or `SYMPHONY_LIVE_DOCKER_CLAUDE_CODE_OAUTH_TOKEN` lets disposable
  workers run the remote Claude canary.
- `SYMPHONY_TS_REQUIRE_REMOTE_CLAUDE=1` makes the remote Claude canary mandatory in the SSH live
  test.

## Packaging

```sh
pnpm build
pnpm --filter @symphony/cli pack --dry-run
```

The CLI package includes the built binary. Workspace documentation, workflow fixtures, and test
evidence stay at the workspace root.

## Compatibility Contracts

The checked-in workflow files are executable fixtures:

- `WORKFLOW.md`
- `WORKFLOW_FULL_ACCESS.md`

`pnpm test` guards workflow docs, prompt rendering, dashboard snapshots, runtime behavior, and CLI
documentation. Update the fixture and the matching test together when the public contract changes.

## License

This project is licensed under the [Apache License 2.0](../LICENSE).
