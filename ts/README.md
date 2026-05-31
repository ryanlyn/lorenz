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

## Trackers

A tracker is the source of issues Symphony works on. It is selected by `tracker.kind` in the
workflow front matter. Every tracker exposes the same read surface to the runtime (poll for
candidate issues, refresh in-flight issues by id) and one or more agent write tools. The write
tools differ per kind; their descriptions are self-documenting and surface to the agent via the
MCP `tools/list` call.

Supported kinds:

- `linear` - issues live in a Linear project. Read access uses `tracker.api_key` (resolved from
  `LINEAR_API_KEY`) and `tracker.project_slug`; the agent writes through the `linear_graphql`
  tool. This is the original backend and is unchanged.
- `local` - issues live as Markdown files on disk. No external service required.
- `slack` - an @-mention of the bot is an issue, an emoji reaction is the status, and a thread
  reply is a comment.
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

Configure it with `kind: local` and a board `path` (default `.symphony/board`):

```yaml
tracker:
  kind: local
  path: .symphony/board
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
```

`path` is the only local-specific setting and is always defaulted, so a local workflow is valid
with just `kind: local`.

Each issue is one file named `BOARD-<n>.md` (for example `.symphony/board/BOARD-7.md`). The
identifier is the file stem (`BOARD-7`). The format is YAML front matter followed by a `# Title`
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

Agent write tools for `kind: local`:

- `local_update_status` - move an issue to a new status (args: `issueId`, `status`).
- `local_comment` - append a progress note to the issue's `## Comments` section (args: `issueId`,
  `body`).
- `local_create_issue` - create a new board issue for out-of-scope follow-up work (args: `title`,
  optional `body`, optional `status`).

Concurrent writes (multiple agents or ensemble slots) to the same board file are serialized
in-process so a status change and comments are never lost. This assumes a single Symphony daemon
owns the board; editing the `BOARD-<n>.md` files from another process at the same time is out of
scope.

To seed a board so you can try `kind: local` immediately, use the demo seeder, which writes
sample `BOARD-<n>.md` files through the same `BoardStore` the running tracker uses:

```sh
npx tsx demo/seed-local.ts                  # seeds ./.symphony/board
npx tsx demo/seed-local.ts /tmp/demo-board  # seeds an explicit directory
npx tsx demo/seed-local.ts .symphony/board 2 # seeds only the first 2 issues
```

Point `tracker.path` at the directory you seeded and run Symphony as usual.

### Slack tracker (mention + reaction)

The Slack tracker treats an @-mention of a bot as an issue. The mentioned message's text is the
issue title/description, threaded replies are comments, and a status emoji reaction on the source
message is the status. See `WORKFLOW.slack.md` for a complete example workflow.

Set up a Slack app:

1. Create a Slack app at <https://api.slack.com/apps> (from scratch) in your workspace.
2. Under "OAuth & Permissions", add these **bot token scopes**:
   - `channels:history` - read messages in public channels.
   - `groups:history` - read messages in private channels (only if you watch private channels).
   - `reactions:read` - read the status emoji reactions on a message.
   - `reactions:write` - set status by adding/removing the managed reaction.
   - `chat:write` - post threaded replies as comments.

   Symphony discovers issues by paging `conversations.history` and matching the bot's @-mention
   in message text, so it does not need `app_mentions:read`. Only add that scope if you separately
   wire up the Events API / `app_mention` subscription, which Symphony does not use today.

   `conversations.history` is rate-limited (newer non-Marketplace apps can be throttled to roughly
   one request per minute), and each poll re-scans recent channel history. The shipped Slack
   workflow therefore sets a conservative `polling.interval_ms` of `60000` (one minute), and you
   should point it at dedicated, low-traffic channels so a busy channel does not trigger sustained
   `429`s. The transport's `429`/`Retry-After` backoff and per-channel `poll_error` handling cover
   transient limits on top of that.

3. Install the app to the workspace and copy the **Bot User OAuth Token** (starts with `xoxb-`).
   Export it as `SLACK_BOT_TOKEN`; Symphony resolves it into `tracker.api_key`.
4. Find the app's **bot user id** (the `U...` id, shown on the app's "App Home" / via
   `auth.test`). Export it as `SLACK_BOT_USER_ID` and reference it as `tracker.bot_user_id`.
5. Invite the bot to each channel you want it to watch (`/invite @your-bot`). A bot only sees
   `*:history` for channels it has joined.
6. Collect the **channel IDs** (`C...`, from the channel's "About" panel) for those channels and
   list them under `tracker.channels`.

Configure it with `kind: slack`:

```yaml
tracker:
  kind: slack
  channels:
    - C0123456789
  bot_user_id: $SLACK_BOT_USER_ID
  emoji_states:
    eyes: In Progress
    white_check_mark: Done
    x: Cancelled
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
```

`SLACK_BOT_TOKEN` (the bot token), a non-empty `channels` list, and `tracker.bot_user_id`
(`SLACK_BOT_USER_ID`) are all **required**. The bot user id scopes issue creation to the bot's own
mentions: only messages that mention that exact user become issues, and only that leading mention
is stripped from the title. It is required so that ordinary human-to-human `<@U...>` mentions in a
watched channel never spawn agents or expose their text to workers. If it is unset or resolves
empty, config validation fails and the production transport fails closed (it scans nothing).

The issue identifier is the message reference in `<channel>:<ts>` form (for example
`C0123456789:1717000000.000100`); that is the `issueId` passed to the write tools.

Status is shown as an emoji reaction on the source message, controlled by `emoji_states` (emoji
name to state name). The default map is:

- `:eyes:` -> `In Progress`
- `:white_check_mark:` -> `Done`
- `:x:` -> `Cancelled`

A message with no managed reaction is effectively new (`Todo`). Setting status swaps the
reaction: it removes any other status emoji it manages and adds the one for the target state.

Agent write tools for `kind: slack`:

- `slack_update_status` - set the issue's status by swapping its managed emoji reaction (args:
  `issueId`, `status`).
- `slack_comment` - post a threaded reply on the source message as a comment (args: `issueId`,
  `body`).

There is no `slack_create_issue`: issues are created by humans @-mentioning the bot, not by the
agent.

Routing note: Slack issues carry only hashtag-derived labels (a `#tag` in the message text
becomes the label `tag`); they are not otherwise routed or assigned. Dispatch treats a label as a
route only when it starts with `route_label_prefix`, so the Slack workflow sets
`route_label_prefix: route-`. Tag a message `#route-<name>` to route it: `#route-backend` becomes
the label `route-backend`, which dispatch resolves to the route `backend` (set `only_routes`
accordingly). Plain hashtags such as `#backend` stay non-route labels; with the default
`accept_unrouted: true` all Slack mentions are still picked up.

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
