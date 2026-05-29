# Decouple the tracker abstraction; add Local and Slack trackers

- Date: 2026-05-29
- Status: Approved (brainstorming complete; ready for implementation plan)
- Scope: `ts/` (the TypeScript port)

## Context

Symphony orchestrates agents against an issue tracker. The TypeScript port currently
supports two tracker backends, `linear` and `memory`, selected by `tracker.kind`. The goal
is to make the tracker abstraction pluggable so we can ship trackers that need no external
service:

- A built-in **Local** tracker backed by the filesystem (`.symphony/board/`). This lets users
  run Symphony-style orchestration on personal projects, in airgapped environments, or in CI
  without standing up a Linear workspace.
- A **Slack** tracker where an @-mention of the bot is an issue, emoji reactions are statuses,
  and thread replies are comments.

### How the tracker works today (the coupling points)

The **read path** is already a clean abstraction. The runtime only ever calls three methods on
`RuntimeTrackerClient` (`ts/packages/domain/src/index.ts:427`):

```ts
fetchCandidateIssues(): Promise<Issue[]>;
fetchIssuesByIds(ids: string[]): Promise<Issue[]>;
fetchIssuesByStates?(states: string[]): Promise<Issue[]>;
```

The runtime polls `fetchCandidateIssues()` every `polling.intervalMs` (default 30s), refreshes
in-flight issues with `fetchIssuesByIds()`, and uses the optional `fetchIssuesByStates()` for
startup workspace cleanup. It does not care which backend answers.

The **write path** is where Linear is hard-wired. Agents mutate the tracker through a single MCP
tool, `linear_graphql` (`ts/packages/mcp/src/tools.ts`), which runs raw Linear GraphQL with the
configured credentials. The MCP server that exposes it is named `symphony_linear`
(`ts/packages/mcp/src/agentEndpoint.ts:50`, `:74`).

Coupling lives in exactly three places, each with a hard-coded `if (kind === "linear")`:

1. Read factory — `createTrackerClient()` in `ts/apps/cli/src/daemon.ts:32`.
2. Config validation — `validateDispatchConfig()` in `ts/packages/config/src/index.ts:398`.
3. Agent write tool — `toolSpecs()` / `executeTool()` in `ts/packages/mcp/src/tools.ts`.

Plus the supporting config: `TRACKER_KINDS` (`ts/packages/domain/src/index.ts:15`), the
`TrackerSettings` shape (`:144`), the zod `trackerRawSchema` and `parseTracker()`
(`ts/packages/config/src/index.ts`), and the MCP server name in `agentEndpoint.ts`.

## Decisions (locked during brainstorming)

- **Write path = per-adapter tools.** Keep `linear_graphql` unchanged. Add per-backend tools
  (`local_*`, `slack_*`). `toolSpecs()` / `executeTool()` dispatch on `settings.tracker.kind`.
  There is no shared `tracker_*` alias vocabulary; each backend has its own tool names.
- **Local tracker storage = one Markdown-with-frontmatter file per issue** under `.symphony/board/`.
- **Slack = Web API polling** behind an injectable `SlackTransport` interface (real `fetch`-based
  client + `InMemorySlackTransport` for tests). No Socket Mode.
- **MCP server name is derived per kind** via a helper: `symphony_linear` (unchanged),
  `symphony_local`, `symphony_slack`. `symphony_linear` is NOT renamed.
- **`board` is named `local`** as the kind/package/tools (the kind names the transport). The
  on-disk artifact stays a "board": default dir `.symphony/board/`, identifiers `BOARD-1`, `BOARD-2`, …
- **WORKFLOW.md decoupling = fixtures only, minimal.** Do not modify the main `WORKFLOW.md` and do
  not add adapter-contributed prompt guidance in this effort. Self-describing MCP tool descriptions
  (surfaced via `tools/list`) carry the "how". Add bare-minimum `workflow-local.md` and
  `workflow-slack.md` test fixtures so the new backends are testable end-to-end through config.
- **Delivery = all three, phased**, each phase green (`mise run check`) before the next,
  orchestrated with dynamic Workflows.

## Architecture: extending the tracker abstraction

There is no single runtime registry object. The three coupling sites live in different layers with
different allowed dependencies, so forcing them through one shared registry would invert the
dependency graph (the low-level `config` package would have to import concrete tracker packages).
Instead, the single source of truth is the `TRACKER_KINDS` union in `domain`, and each of the three
sites does its own per-kind dispatch in the layer that owns it. Each dispatch is written as an
exhaustive `switch` over `TrackerKind` so adding a kind to the union surfaces a compile error at
every site that has not handled it yet.

The three extension points:

1. **Read-client construction** — `createTrackerClient()` in `apps/cli/src/daemon.ts`
   (the composition root, the only place allowed to import every tracker package). A small
   `kind → constructor` map here replaces the current `if`s. Read clients keep living in their own
   packages: existing `@symphony/linear-tracker`, `@symphony/memory-tracker`; new
   `@symphony/local-tracker`, `@symphony/slack-tracker`. Each implements `RuntimeTrackerClient`.
2. **Config validation** — `validateDispatchConfig()` in `packages/config`. Stays inline and
   per-kind (extending the existing linear branch with `local` and `slack`); `config` imports no
   tracker packages.
3. **Agent write tools** — `packages/mcp`. Tools stay here (consistent with where `linear_graphql`
   already lives), split per backend into `mcp/src/tools/{linear,local,slack}.ts`, with `tools.ts`
   reduced to a thin dispatcher on `settings.tracker.kind`. Backend *logic* the tools need (the
   local file store, the Slack transport) lives in the tracker packages and is imported by the tool
   modules, so there is no duplication. `packages/mcp` therefore gains dependencies on
   `@symphony/local-tracker` and `@symphony/slack-tracker` (acyclic: those packages do not import
   `mcp`).

This keeps the dependency direction clean: low-level packages (`config`, `mcp`) never import the
composition root; tracker packages never import `mcp`; only `apps/cli` imports every tracker.

## Domain & config changes

`ts/packages/domain/src/index.ts`:
- `TRACKER_KINDS = ["linear", "memory", "local", "slack"]`.
- `TrackerSettings` gains optional fields, all unused by existing kinds:
  - `path?: string` — local board directory (default `.symphony/board`).
  - `channels?: string[]` — Slack channel IDs to watch.
  - `emojiStates?: Record<string, string>` — Slack emoji → state-name overrides.

`ts/packages/config/src/index.ts`:
- Extend `trackerRawSchema` (zod) with `path`, `channels`, `emojiStates` (all optional).
- `parseTracker()` resolves them; `endpoint` default stays `https://api.linear.app/graphql` but is
  overridden per kind at use (Slack default `https://slack.com/api`). Resolve a new env var
  `SLACK_BOT_TOKEN` into `apiKey` when `kind === "slack"`.
- `validateDispatchConfig()` extends its existing per-kind `switch` (no tracker-package imports):
  - `linear`: `apiKey` + `projectSlug` (unchanged).
  - `local`: a resolvable `path` (defaulted, so effectively always valid).
  - `slack`: `apiKey` (bot token) + non-empty `channels`.

## Write-tool dispatch (`packages/mcp`)

`tools.ts` signature changes so specs are per-kind:

```ts
export function toolSpecs(settings: Settings): ToolSpec[];
export async function executeTool(
  name: string, input: unknown, settings: Settings, deps?: ToolDeps,
): Promise<ToolResult>;
```

`deps` carries injectables for tests (e.g. `fetchImpl` for Slack/Linear, an optional
`SlackTransport`, an optional clock). Dispatch:

| `tracker.kind` | `toolSpecs()` | tools |
|---|---|---|
| `linear` | `linearToolSpecs()` | `linear_graphql` (unchanged behavior) |
| `local`  | `localToolSpecs()`  | `local_update_status(issueId, status)`, `local_comment(issueId, body)`, `local_create_issue(title, body?, status?)` |
| `slack`  | `slackToolSpecs()`  | `slack_update_status(issueId, status)`, `slack_comment(issueId, body)` |
| `memory` | `[]` | none (read-only fixture) |

Call sites updated to pass `settings` (all have it in scope):
- `ts/packages/codex/src/executor.ts:135` → `toolSpecs(input.settings)`.
- `ts/packages/server/src/index.ts:466` and `:470` → `toolSpecs(settings)` / `executeTool(..., settings)`.
- `ts/packages/mcp/src/server.ts:137` / `:141` → same.
- `ts/apps/cli/src/index.ts` re-exports unchanged (signatures only).

Tool descriptions must be self-sufficient (they are surfaced via `tools/list`), e.g.
`local_update_status`: "Move a local board issue to a new status. Args: issueId, status."

## MCP server naming (`packages/mcp/src/agentEndpoint.ts`)

Add `trackerMcpServerName(kind: TrackerKind): string` → `symphony_${kind}` (so `symphony_linear`,
`symphony_local`, `symphony_slack`). Replace the two hard-coded `symphony_linear` literals
(`agentEndpoint.ts:50` in `acpServer()`, `:74` in `mcpConfigContents()`) with the helper.
`symphony_linear` output for `kind === "linear"` is byte-identical to today, so existing setups are
untouched.

## Local tracker (`@symphony/local-tracker`, kind `local`)

### File format

`.symphony/board/<IDENT>.md`, default dir from `tracker.path`. One file per issue:

```
---
status: In Progress      # required - the only mutable field
labels: [backend]        # optional
---
# Fix the flaky polling loop

The retry scheduler double-fires when the worker restarts mid-poll.

## Comments
- 2026-05-29T10:00:00Z agent: opened PR #42
```

Derivation (almost nothing is stored):
- `id` / `identifier` ← filename stem (e.g. `BOARD-1`).
- `title` ← first `# ` heading; fallback to the identifier.
- `description` ← body between the heading and a `## Comments` section (trimmed).
- `state` ← frontmatter `status`. `stateType` ← default name→type map
  (Todo→unstarted, In Progress→started, Done→completed, Cancelled/Canceled→canceled,
  Backlog→backlog, Triage→triage; unknown→null).
- `labels` ← frontmatter `labels` (default `[]`, lower-cased to match Linear normalization).
- `createdAt` / `updatedAt` ← filesystem `birthtime` / `mtime` as ISO strings.
- `assigneeId` ← null; `assignedToWorker` ← always `true` (no assignee filtering for a local board).
- `blockers` ← `[]` (not modeled in the minimal format).

### `BoardStore` (the package's core)

Owns all filesystem and parse/serialize logic; the read client and the `local_*` tools both use it.

```ts
class BoardStore {
  constructor(dir: string);
  list(): Promise<Issue[]>;                       // all issue files
  getByIds(ids: string[]): Promise<Issue[]>;      // preserve requested order
  byStatus(states: string[]): Promise<Issue[]>;   // case-insensitive state-name match
  updateStatus(id: string, status: string): Promise<Issue>;
  appendComment(id: string, body: string, now: () => Date): Promise<void>;
  create(input: { title: string; body?: string; status?: string }): Promise<Issue>; // BOARD-<n++>
}
```

- Identifier allocation: `BOARD-<n>` where `n = max(existing) + 1` (scan filenames; start at 1).
- `appendComment` inserts/extends a `## Comments` section, one `- <ISO> agent: <body>` line.
- Round-trips must preserve description body and unknown content faithfully.
- Frontmatter parsed/serialized with `yaml` (already a workspace dependency).

### Read client

`LocalTrackerClient implements RuntimeTrackerClient` wraps a `BoardStore`:
- `fetchCandidateIssues()` → `byStatus(settings.tracker.activeStates)`.
- `fetchIssuesByIds(ids)` → `getByIds(ids)`.
- `fetchIssuesByStates(states)` → `byStatus(states)`.

### Agent tools (`mcp/src/tools/local.ts`)

`local_update_status` → `BoardStore.updateStatus`; `local_comment` → `appendComment`;
`local_create_issue` → `create`. Construct the `BoardStore` from `settings.tracker.path`.

## Slack tracker (`@symphony/slack-tracker`, kind `slack`)

### Transport interface (injectable)

```ts
interface SlackMessage { channel: string; ts: string; text: string; reactions: string[]; }

interface SlackTransport {
  listMentions(channels: string[], opts?: { sinceTs?: string }): Promise<SlackMessage[]>;
  getMessage(channel: string, ts: string): Promise<SlackMessage | null>; // for fetchIssuesByIds
  addReaction(channel: string, ts: string, name: string): Promise<void>;
  removeReaction(channel: string, ts: string, name: string): Promise<void>;
  postReply(channel: string, threadTs: string, body: string): Promise<void>;
}
```

- Real impl `SlackWebTransport`: `fetch` to `${endpoint}/<method>` with `Authorization: Bearer <botToken>`.
  Methods used: `conversations.history` (per channel; filter messages that mention the bot, read
  their `reactions`), a single-message fetch for `getMessage` (`conversations.history` with
  `latest=ts&inclusive=true&limit=1`), `reactions.add`, `reactions.remove`, `chat.postMessage`
  (with `thread_ts`).
- Test impl `InMemorySlackTransport`: in-memory channels/messages/reactions; deterministic.

### Mapping

- An @-mention of the bot in a watched channel = an issue.
  - `id` = `<channel>:<ts>` (stable). `identifier` = `SLK-<short>` derived from `ts`.
  - `title` = first line of the message text. `description` = full message text.
  - `state` = derived from the message's reaction set via the emoji→state map.
- Default emoji→state map (overridable via `tracker.emojiStates`):
  - no status reaction → `Todo`
  - `eyes` (👀) → `In Progress`
  - `white_check_mark` (✅) → `Done`
  - `x` (❌) → `Cancelled`
- `stateType` from the same default name→type map as Local.
- Thread replies = comments (read side may surface them on `raw`; write side appends them).

### Read client

`SlackTrackerClient implements RuntimeTrackerClient`:
- `fetchCandidateIssues()` → list mentions across `channels`, derive state, keep those in `activeStates`.
- `fetchIssuesByIds(ids)` → re-fetch each `<channel>:<ts>`, preserve order.
- `fetchIssuesByStates(states)` → list mentions, filter by derived state.

### Agent tools (`mcp/src/tools/slack.ts`)

- `slack_update_status(issueId, status)`: resolve target emoji from the map; remove the currently
  present status emoji(s); add the target emoji. Self-correcting and matches the polling read model.
- `slack_comment(issueId, body)`: `postReply` to the thread.

## WORKFLOW.md handling (fixtures only)

Do not modify the main `ts/WORKFLOW.md`. Add minimal fixtures used only by tests:

- `ts/test/fixtures/workflow-local.md` — frontmatter selecting `kind: local` with `path`,
  `active_states`, `terminal_states`; one-line body.
- `ts/test/fixtures/workflow-slack.md` — frontmatter selecting `kind: slack` with `channels`,
  `active_states`, `terminal_states`; one-line body.

These drive parse → validate → adapter wiring → tool dispatch tests for the new backends.
(Final fixture path may live under the package whose test consumes it; chosen during planning.)

## Testing strategy (TDD, vitest; each phase ends with `mise run check` green)

- **Phase 1 — decouple.** `createTrackerClient` selects the client by kind; `validateDispatchConfig`
  validates per kind; `toolSpecs`/`executeTool` dispatch by kind; existing `linear_graphql` behavior
  preserved through the dispatcher (existing linear/mcp tests stay green, updated only for the new
  `settings` argument); `trackerMcpServerName` returns `symphony_linear` for linear and the new
  names otherwise; missing/unknown kinds rejected with clear errors.
- **Phase 2 — local.** `BoardStore` unit tests in temp dirs: frontmatter round-trip, `list`,
  `getByIds` ordering, `byStatus` case-insensitivity, `updateStatus`, `appendComment` section
  handling, `create` identifier increment, title/description derivation, fs-stat timestamps.
  `LocalTrackerClient` against a temp board. `local_*` tool tests. Config parse from
  `workflow-local.md`; factory wiring.
- **Phase 3 — slack.** `InMemorySlackTransport`. `SlackTrackerClient` read tests (mention→issue,
  reactions→state with default + override map, thread→comment). `slack_*` tool tests
  (`update_status` adds the right emoji and removes the previous; `comment` posts a threaded
  reply). `SlackWebTransport` against a `fetch` mock (request shape + auth header). Config parse
  from `workflow-slack.md`; factory wiring.

## Phasing & dynamic Workflow orchestration

Each phase is its own dynamic `Workflow` run; results are reviewed before launching the next.
A phase workflow runs a TDD pipeline that fans out per package/module — write failing tests →
implement → run the package checks → an adversarial reviewer verifies the contract — followed by a
final `mise run check` gate.

1. Phase 1: per-kind dispatch (factory + config + write tools) + server-name helper + domain/config plumbing.
2. Phase 2: `@symphony/local-tracker` + `mcp/src/tools/local.ts` + factory/config/tool wiring + fixtures.
3. Phase 3: `@symphony/slack-tracker` + `mcp/src/tools/slack.ts` + factory/config/tool wiring + fixtures.

## Non-goals / YAGNI

- No shared `tracker_*` tool alias across backends (per-adapter only).
- No Slack issue *creation* tool (issues originate from human mentions).
- No Slack Socket Mode / Events API.
- No local branch-linking tool and no `branch`, `priority`, `url`, `blockers`, or timestamp fields
  in local frontmatter (derived or omitted).
- No adapter-contributed prompt guidance and no rewrite of the main `WORKFLOW.md`.
- No emoji statuses beyond the four defaults (all overridable via `tracker.emojiStates`).

## New/changed files (summary)

New packages:
- `ts/packages/local-tracker/` (`BoardStore`, `LocalTrackerClient`, name→type map).
- `ts/packages/slack-tracker/` (`SlackTransport`, `SlackWebTransport`, `InMemorySlackTransport`,
  `SlackTrackerClient`, mapping helpers).

New files:
- `ts/packages/mcp/src/tools/{linear,local,slack}.ts` (extracted/added) + dispatcher in `tools.ts`.
- `ts/test/fixtures/workflow-local.md`, `ts/test/fixtures/workflow-slack.md`.

Changed files:
- `ts/packages/domain/src/index.ts` (`TRACKER_KINDS`, `TrackerSettings`).
- `ts/packages/config/src/index.ts` (`trackerRawSchema`, `parseTracker`, `validateDispatchConfig`, env).
- `ts/packages/mcp/src/{tools.ts,agentEndpoint.ts}` (dispatch + server-name helper).
- `ts/packages/mcp/package.json`, `tsconfig.json` (deps on local/slack trackers).
- `ts/packages/codex/src/executor.ts`, `ts/packages/server/src/index.ts`,
  `ts/packages/mcp/src/server.ts` (pass `settings` to `toolSpecs`).
- `ts/apps/cli/src/daemon.ts` (`createTrackerClient` via a `kind → constructor` map).
- Root `ts/tsconfig.json` references + `pnpm-workspace.yaml` already globs `packages/*`.
