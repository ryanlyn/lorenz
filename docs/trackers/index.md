# Trackers

A tracker is the source of issues Lorenz works. It holds the work items, exposes their state, and
accepts comments and status changes back. This is the operator hub: how you pick a tracker, the read
surface every tracker shares, the agent tools that ride on top, and where each backend documents its
exact keys.

Lorenz polls one tracker, turns matching issues into agent runs, and writes results back to that
same tracker. The tracker is an extension point, so Linear, Jira, a local Markdown board, Slack, and an in-process
fixture all plug into the same contract.

## Picking a tracker

Two config keys select the backend. Both resolve to a registered `TrackerProvider.kind`.

- `tracker.kind` is the selector. It names a bundle under `trackers.<name>`.
- `trackers.<name>.provider` is the resolved provider kind for that bundle.

The nested bundle form is the recommended shape. The flat form (provider options written directly
under `tracker:`) is terse shorthand for the same result:

```yaml
tracker:
  kind: work
trackers:
  work:
    provider: linear
    api_key: $LINEAR_API_KEY
    project_slugs: [platform]
```

Here `tracker.kind: work` selects the `trackers.work` bundle, and `provider: linear` resolves to
the `linear` provider. The config parser strips `kind` and `provider`, merges the remaining bundle
keys, and sets the runtime `tracker.kind` to the provider value (`packages/config/src/parse.ts`).
Name a bundle that does not exist under `trackers` and parsing throws
`trackers.<name> is required by tracker.kind`. A bundle missing `provider` throws
`trackers.<name>.provider is required`.

An unknown provider fails fast at startup. `TrackerRegistry.require` throws
`unsupported tracker.kind: <kind> (known kinds: ...)`, and a missing kind throws
`tracker.kind is required`. The supported set is whatever the composition root registered.
`registerBuiltinBackends` in `apps/cli/src/daemon.ts` wires the kinds below.

## The supported kinds

| `provider` | Backend | Use it when |
| --- | --- | --- |
| `linear` | Linear.app over GraphQL | Your team already runs Linear and assigns work by project. |
| `jira` | Jira Cloud REST API v3 | You run Jira Cloud and can give Lorenz a Basic-auth API token. |
| `jira-mcp` | Jira via an external MCP server | A separate MCP server already fronts your Jira; Lorenz proxies through it. |
| `local` | Filesystem Markdown board | You want to try Lorenz with no external tracker, or drive it from files in the repo. |
| `slack` | Slack channels and threads | Work arrives as `@bot` mentions in Slack rather than as tracker issues. |
| `memory` | In-process fixture | Tests and dry runs; issues come from an env var, no network, no agent tools. |

Each provider owns its own config slice and its own page:

- [linear.md](linear.md) - projects, assignee filter, dynamic project discovery by label.
- [jira.md](jira.md) - REST and MCP variants, JQL scope, the hard `agent`-label gate.
- [local.md](local.md) - the Markdown board file format, board directory, id prefix.
- [slack.md](slack.md) - bot-mention issues, thread-derived status, channel allow-list.
- [memory.md](memory.md) - the in-process fixture and its seed env var.

## The shared read surface

Every tracker drives dispatch through one runtime client contract: `TrackerProvider.createClient`
returns a `RuntimeTrackerClient`. The poll loop calls a fixed set of methods on it and never reaches
into the backend directly.

- `fetchCandidateIssues()` returns the issues eligible for dispatch this tick. Each provider scopes
  this to its own notion of "active": Linear polls `tracker.active_states`, the local board calls
  `byStatus(activeStates)`, Jira intersects its JQL with the active-states clause, Slack returns
  mention-tracked roots.
- `fetchIssuesByIds(ids)` refreshes specific issues by id, used to re-read an issue Lorenz is
  already working.
- `fetchIssuesByStates(states)` lists issues in given states, used for workspace cleanup against
  `tracker.terminal_states`.

Two config keys are core, not provider-specific: `tracker.active_states` (default
`['Todo', 'In Progress']`) gates which states poll as candidates, and `tracker.terminal_states`
(default `['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done']`) marks finished states that
trigger workspace cleanup. Comparison is case-insensitive and trims whitespace. See
[dispatch.md](../dispatch.md) for the full eligibility chain that consumes these candidates.

Whatever the backend returns is normalized into the domain `Issue` shape before it reaches the
runtime: `id`, `identifier`, `title`, `state`, a required `stateType`, `labels`, and the raw
payload. A provider that cannot produce a well-formed issue drops it rather than emit a partial one.

## The agent tools

Agents change issues through MCP tools, not through provider SDKs directly. Each tracker owns the
tool packs it exposes and mounts them through `defaultToolPacks`.

### The Jira `jira_*` pack

The Jira extension owns the pack named exactly `jira`, defined in
`extensions/jira-tracker/src/tools.ts` as a `ToolProvider`. The `jira` and `jira-mcp` providers
mount it through their `defaultToolPacks(): ["jira"]`, so it rides on top of Jira-driven dispatch.
It serves seven tools:

| Tool | What it does |
| --- | --- |
| `jira_read_issue` | Read one issue by id. |
| `jira_query` | Filter, project, sort, and page issues with the read-only query DSL. |
| `jira_update_status` | Move an issue to a new status. |
| `jira_list_comments` | List an issue's comments. |
| `jira_comment` | Add a comment. |
| `jira_update_comment` | Edit an existing comment. |
| `jira_create_issue` | Create a new issue. |

Each tool maps to a method on the Jira client. The pack selects `JiraClient` for the `jira` kind and
`JiraMcpClient` for `jira-mcp`, keyed off `settings.tracker.kind`, then calls the client method that
backs the invoked tool.

`jira_query` maps issues to records and applies the query DSL with `DEFAULT_SELECT = ['id',
'identifier', 'title', 'state', 'stateType', 'labels', 'url']`. The DSL is total and
side-effect-free, capped by `MAX_FILTER_DEPTH = 12`, `MAX_FILTER_NODES = 200`,
`DEFAULT_LIMIT = 100`, and `MAX_LIMIT = 1000`. Full tool schemas and the DSL grammar live in
[reference/tracker-tools.md](../reference/tracker-tools.md).

### Provider-specific packs

Every tracker that exposes agent tools owns a pack and mounts it through the provider's
`defaultToolPacks`:

| Provider | Pack | Tools |
| --- | --- | --- |
| `jira`, `jira-mcp` | `jira` | `jira_read_issue`, `jira_query`, `jira_update_status`, `jira_list_comments`, `jira_comment`, `jira_update_comment`, `jira_create_issue` |
| `linear` | `linear` | `linear_graphql` |
| `local` | `local` | `local_query`, `local_read_issue`, `local_update_status`, `local_comment`, `local_create_issue` |
| `slack` | `slack` | `slack_update_status`, `slack_comment`, `slack_read_thread`, `slack_query`, `slack_user_info`, `slack_channel_context` |

The `memory` tracker declares no `defaultToolPacks`, so it ships no tools. The pack name (`linear`)
stays distinct from the provider kind (`linear`) even when the strings match. Name a pack in the
workflow `tools:` map to mount it standalone over a different dispatch tracker.

## Mounting and routing

The MCP server (`packages/mcp/src/tools.ts`) decides which packs to mount for the current settings,
in this order, de-duplicated first-seen:

1. The dispatch tracker's `defaultToolPacks(settings)`. If a provider declares none, a fallback
   mounts a pack whose name equals `tracker.kind`, when one is registered.
2. Every key of the workflow `tools:` map (`settings.toolOptions`). Writing `tools: { local: {...} }`
   mounts the `local` pack.

The mounted packs flatten into one tool namespace. A tool name declared by two different packs is a
hard error at mount time: `tool name collision: <name> is declared by both the "<a>" and "<b>"
packs`. A `tools/call` routes to the declaring pack; an unknown name returns an "unsupported tool"
result listing every mounted tool.

Tool failures cross the MCP seam as data, never as thrown errors. A `ToolResult` with
`success: false` becomes a JSON-RPC result with `isError: true` at HTTP 200, not a transport
failure. Claude reaches this surface over the built-in `/mcp` endpoint; Codex and ACP sessions reach
it as a leased MCP server named `lorenz_<kind>` (for example `lorenz_linear`). For the wire format,
see [reference/http-api.md](../reference/http-api.md).

## See also

- [reference/tracker-tools.md](../reference/tracker-tools.md) - exact schemas for all seven
  `jira_*` tools and the query DSL grammar.
- [dispatch.md](../dispatch.md) - the eligibility chain that consumes poll candidates.
- [reference/configuration.md](../reference/configuration.md) - the full `tracker.*` and `trackers.*`
  key reference.
- [extensions/tracker-provider.md](../extensions/tracker-provider.md) - build a new tracker backend.
- [agent-orchestrator.md](../agent-orchestrator.md) - the poll and reconcile loop around these
  clients.
