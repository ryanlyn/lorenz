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
    executor: acp
    bridge_command: codex-acp
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
  command: codex-acp # legacy alias for agents.codex.bridge_command
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

## Trackers

A tracker is the source of issues Symphony works on. It is selected by `tracker.kind` in the
workflow front matter. Every tracker exposes the same read surface to the runtime (poll for
candidate issues, refresh in-flight issues by id) and a set of agent tools. Those tools are now
read+write symmetric across kinds, mirroring `linear_graphql` (which both reads and writes): each
tracker gives the agent at least one write tool and one read tool. The tools differ per kind; their
descriptions are self-documenting and surface to the agent via the MCP `tools/list` call.

Supported kinds:

- `linear` - issues live in a Linear project. Read access uses `tracker.api_key` (resolved from
  `LINEAR_API_KEY`) and `tracker.project_slug`; the agent both reads and writes through the
  `linear_graphql` tool. This is the original backend and is unchanged.
- `local` - issues live as Markdown files on disk. No external service required.
- `memory` - an in-process tracker used for tests and dry runs.

All kinds share the dispatch routing block under `tracker.dispatch`:

```yaml
tracker:
  dispatch:
    accept_unrouted: true # process issues that carry no matching route label (default)
    only_routes: null # or a list of route names this instance handles
    route_label_prefix: "Symphony:" # the label prefix that names a route
```

### Local tracker (filesystem board)

The local tracker runs Symphony against a directory of Markdown files, with no Linear API key or
workspace. See `WORKFLOW.local.md` for a complete example workflow.

Configure it with `kind: local` and a board `path` (default `.symphony/local`):

```yaml
tracker:
  kind: local
  path: .symphony/local
  id_prefix: "BOARD-" # optional, default "BOARD-"
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
```

Both `path` and `id_prefix` are local-specific and always defaulted, so a local workflow is valid
with just `kind: local`. `id_prefix` sets the issue-id prefix for the board: the tracker only treats
`<prefix><n>.md` files as issues and mints new ids with it, so one board can be `BOARD-1`, `BOARD-2`
and another `XXX-1`, `FEAT-1`, etc. It must be filesystem-safe (start alphanumeric, then only
letters, digits, `_` or `-`); an unsafe prefix is rejected at config load. Changing the prefix of an
existing board orphans files written under the old prefix (they stop matching), so set it up front.

Each issue is one file named `<prefix><n>.md` (for example `.symphony/local/BOARD-7.md`, or
`.symphony/local/XXX-7.md` with `id_prefix: "XXX-"`). The identifier is the file stem (`BOARD-7`).
The format is YAML front matter followed by a `# Title`
heading, the description, and an optional `## Comments` section:

<!-- prettier-ignore -->
```markdown
---
status: In Progress
labels:
  - backend
---

# Fix the retry queue

The retry slot is not released when a worker fails.

<!-- symphony:comments -->
## Comments
- 2026-05-29T12:00:00.000Z agent: Reproduced the leak; fix in progress.
```

- `status` (required) is the issue state. Active states (`Todo`, `In Progress`) mean the issue is
  available to work; terminal states (`Done`, `Cancelled`) mean it is finished and must not be
  reopened. Configure the exact sets with `active_states` / `terminal_states`.
- `labels` (optional) is a YAML list. Labels feed dispatch routing the same way Linear labels do.
- The `# Title` heading is the issue title; the text below it is the description.
- The `## Comments` section is managed by the `local_comment` tool. The hidden
  `<!-- symphony:comments -->` marker delimits it so a description that itself contains a
  `## Comments` heading is never misparsed; treat the most recent comment block as the live
  workpad.

Agent tools for `kind: local` (read and write, symmetric with `linear_graphql`):

- `local_update_status` - move an issue to a new status (args: `issueId`, `status`).
- `local_comment` - append a progress note to the issue's `## Comments` section (args: `issueId`,
  `body`).
- `local_create_issue` - create a new board issue for out-of-scope follow-up work (args: `title`,
  optional `body`, optional `status`).
- `local_read_issue` - read an issue's authoritative state: its current status, title, description,
  and comments (args: `issueId`). Use it to re-read state and recover prior progress notes on a
  continuation turn.

Concurrent writes (multiple agents or ensemble slots) to the same board file are serialized
in-process so a status change and comments are never lost. This assumes a single Symphony daemon
owns the board; editing the `BOARD-<n>.md` files from another process at the same time is out of
scope.

To seed a board so you can try `kind: local` immediately, use the demo seeder, which writes
sample `BOARD-<n>.md` files through the same `BoardStore` the running tracker uses:

```sh
npx tsx sandbox/seed-local.ts                    # seeds ./.symphony/local
npx tsx sandbox/seed-local.ts /tmp/demo-board    # seeds an explicit directory
npx tsx sandbox/seed-local.ts .symphony/local 2  # seeds only the first 2 issues
npx tsx sandbox/seed-local.ts /tmp/demo-board 3 XXX-  # seeds XXX-1..XXX-3 (match tracker.id_prefix)
```

Point `tracker.path` at the directory you seeded and run Symphony as usual. If you set a custom
`id_prefix`, pass the same prefix to the seeder so the seeded ids match what the tracker expects.

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

- `SYMPHONY_TS_CODEX_ACP_COMMAND` overrides the Codex ACP bridge command for live tests.
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
