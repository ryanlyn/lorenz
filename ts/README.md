# Symphony TypeScript Port

This directory is an independent TypeScript port of the evergreen Symphony SPEC. The workflow files
are copied from the Elixir implementation for parity, but this package does not import or symlink
Elixir code.

## Prerequisites

```sh
pnpm install
```

The live Linear paths require `LINEAR_API_KEY`. The live Codex and Claude paths require working
`codex` and `claude` commands on `PATH`.

## Run

```sh
pnpm build
pnpm start -- WORKFLOW.md
pnpm start:once -- --dry-run --no-tui WORKFLOW.md
pnpm runs -- --port 4000 --failed
```

Useful development commands:

```sh
pnpm typecheck
pnpm test
pnpm test:live
pnpm test:live:codex
pnpm test:live:codex-resume
pnpm test:live:linear-codex
pnpm test:live:claude
pnpm test:live:ssh
pnpm proof:parity
```

## Workspace

The TypeScript port is a pnpm workspace rooted at `ts/`:

- `packages/*` contains the protocol, domain, policies, runtime, adapters, presentation, and
  infrastructure libraries.
- `apps/cli` is the composition root and the only binary app.
- `test/` contains cross-package parity and live tests. Package-owned unit tests live next to their
  package under `packages/<name>/test/` or `apps/cli/test/`.

The CLI app builds a `symphony-ts` binary at `apps/cli/dist/bin/cli.js` and exposes it through
`apps/cli/package.json`. The CLI mirrors the Elixir entrypoint shape:

```sh
symphony-ts [--once] [--dry-run] [--no-tui] [--port <port>] [--logs-root <path>] [path-to-WORKFLOW.md]
symphony-ts runs [--issue ID] [--failed] [--cost] [--retries] [--id RUN_ID] [--limit N] [--url URL | --port PORT] [--json]
```

- With no path, it uses `SYMPHONY_WORKFLOW`, then `./WORKFLOW.md`.
- By default it runs as a long-lived polling daemon with an Ink terminal dashboard.
- `--once --dry-run --no-tui` polls Linear and prints JSON snapshots without starting agents.
- `--port` starts the HTTP observability API and dashboard at `/`, `/api/v1/state`,
  `/api/v1/runs`, `/api/v1/refresh`, and `/api/v1/:issue_identifier`.
- `--logs-root` writes the rotating runtime log under `<path>/log/symphony.log`.
- `symphony-ts runs` mirrors `mix symphony.runs` against that observability API.

## Configuration

Configuration lives in the YAML front matter of `WORKFLOW.md`. The Markdown body below the front
matter is the agent session prompt, rendered as a Liquid template with issue context variables.

```yaml
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
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

Supported top-level sections match the copied Elixir workflow files:
`tracker`, `polling`, `workspace`, `worker`, `agent`, `status_overrides`, `codex`, `claude`,
`hooks`, `observability`, and `server`. Extension sections ignored by Elixir, such as `logging`,
are ignored here too; use `--logs-root` for the TS runtime log sink.

The workflow files in this directory are byte-identical copies of the Elixir workflow files:

- `WORKFLOW.md`
- `WORKFLOW_FULL_ACCESS.md`
- `WORKFLOW_ENSEMBLE.md`
- `WORKFLOW_ALPHA_EVOLVE.md`

`pnpm test` includes a drift check that compares those files against `../elixir/`.

## Workflow Prompt

The prompt body supports the same public context surface as Elixir:

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

The shared prompt fixture test renders representative Liquid/Solid constructs in both Elixir and
TypeScript: conditionals, null fallbacks, loops, `forloop` metadata, nested blocker refs, and common
filters.

## Observability

The terminal TUI uses the same Elixir-style sections for agents, throughput, runtime, tokens, rate
limits, running sessions, retry queue, and dispatch blocks. The web dashboard exposes the TS
observability API and a polling HTML dashboard.

The API routes are:

- `/api/v1/state`
- `/api/v1/runs`
- `/api/v1/runs?id=<run-id>`
- `/api/v1/refresh`
- `/api/v1/:issue_identifier`

Claude sessions use `/claude-mcp` for injected dynamic tools when the TS runtime has started an
observability server.

## Live E2E

The live tests are opt-in and launch the real `codex` and `claude` executables in isolated temporary
workspaces.

See `LIVE_E2E_MATRIX.md` for the live proof surface and boundaries. `pnpm proof:parity` runs the
full local parity gate from the repo root, including focused Elixir tests, TS tests, build, package
dry-run, built CLI dry-run, and live canaries unless `SYMPHONY_PARITY_SKIP_LIVE=1` is set.

## Packaging

```sh
pnpm build
pnpm --filter @symphony/cli pack --dry-run
```

The CLI app includes the built CLI. Workspace documentation, workflow examples, and parity evidence
stay at the workspace root.

## Parity Scope

Executable workflow docs are treated as strict parity and are byte-compared with Elixir. README and
changelog docs are TS-specific packaging docs that point to the parity ledger under
`../docs/parity/` rather than mirroring every historical Elixir changelog entry.
