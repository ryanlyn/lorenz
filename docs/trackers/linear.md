# Linear tracker

Lorenz polls Linear.app for issues to work, drives them through their workflow states, and lets
agents read and write back over the Linear API. This page is for the operator setting up the Linear
backend: the prerequisites, every config key, and how each setting maps to runtime behavior. For the
full config grammar see [configuration](../reference/configuration.md); to build your own tracker see
[tracker-provider](../extensions/tracker-provider.md).

The Linear backend ships as the `@lorenz/linear-tracker` extension. It registers a `TrackerProvider`
(`kind: "linear"`) that polls issues into the dispatch loop, plus a `linear` tool pack that gives
agents a raw GraphQL escape hatch.

## Prerequisites

- A Linear **personal API key**. Generate one under Settings, Security & access, Personal API keys.
  The key authenticates every poll, status change, and comment Lorenz makes, so the agent acts as the
  key's owner.
- At least one Linear **project** to watch, identified by its slug, an explicit list of slugs, or
  project labels. The slug is the `slugId` in a project URL: `https://linear.app/<workspace>/project/<slug>/...`.

## Minimal config

Select the bundle with `tracker.kind`, then configure the implementation under
`trackers.linear`: the API key and exactly one project selector. The key reads from the
`LINEAR_API_KEY` environment variable when you omit `api_key`.

```yaml
tracker:
  kind: linear
trackers:
  linear:
    provider: linear
    api_key: ${LINEAR_API_KEY}
    project_slugs:
      - my-project-slug
```

This watches `Todo` and `In Progress` issues in one project, dispatches each to an agent, and treats
`Closed`, `Cancelled`, `Canceled`, `Duplicate`, and `Done` as finished. The sections below expand
every key.

## Config keys

These keys live under `trackers.linear:` (the `tracker.kind: linear` selector points at this bundle).
Snake_case is the config form; the provider aliases each to its internal camelCase name.

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | (required) | Set to `linear` to name the implementation. |
| `api_key` | env `LINEAR_API_KEY` | Personal API key. Required for dispatch. |
| `endpoint` | `https://api.linear.app/graphql` | Linear GraphQL endpoint. Override only for a proxy or test server. |
| `assignee` | env `LINEAR_ASSIGNEE` | Filter polled issues by assignee. Blank means no filter. The literal `me` resolves to the API key's own user. |
| `project_slug` | unset | Single project slug. Deprecated in favor of `project_slugs`. |
| `project_slugs` | unset | Explicit list of project slugs to watch. |
| `project_labels` | unset | Project labels; Lorenz discovers matching projects dynamically. |
| `active_states` | `["Todo", "In Progress"]` | Workflow state names polled as dispatch candidates. |
| `terminal_states` | `["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]` | Finished states; reaching one triggers workspace cleanup. |
| `dispatch` | (see below) | Route-label gating for multi-instance setups. |

### Project selection: exactly one of three

Lorenz resolves which projects to poll from three mutually exclusive keys. Configure exactly one.
Setting zero, or more than one, fails validation at startup with a distinct message for each case.

| Key | Use it when | Powers `projectUrl`? |
| --- | --- | --- |
| `project_slugs` | You know the slugs and want a fixed list. | No |
| `project_labels` | Projects change and you tag them with a label instead of listing slugs. | No |
| `project_slug` | You watch one project. Prefer `project_slugs` for new configs. | Yes |

Precedence inside the client runs `project_slugs` first, then `project_labels` (resolved by querying
Linear for projects carrying those labels), then `project_slug` (wrapped as a single-element list).
Resolved slugs are cached after the first lookup. A transient resolution error clears the cache, so
the next poll retries.

Only the deprecated `project_slug` produces an operator project URL
(`https://linear.app/project/<slug>/issues`). Multi-project and label-based configs span many
projects, so they surface no single project link.

Configure `project_labels` and the provider kicks off label discovery in the background as the client
is built, so the first poll skips the discovery round trip.

### Assignee filter

`assignee` narrows the poll to one person's issues. Three behaviors:

- Blank or unset: no assignee filter, every candidate issue is eligible.
- The literal `me` (case-insensitive, trimmed): resolves to the API key owner's user id by querying
  the Linear viewer. The resolved id is cached for the client's life and re-resolved on a failed
  lookup.
- Any other value: sent verbatim as the assignee id.

### States: active vs terminal

`active_states` and `terminal_states` are core tracker settings, not Linear-specific, so the same
names and defaults apply across backends. Linear matches them against the issue's workflow state
**name**.

- `active_states` are the states Lorenz polls. An issue in an active state that also matches the
  assignee filter becomes a dispatch candidate.
- `terminal_states` are the finished states. Reaching one tells the runtime to clean up the issue's
  workspace.

The defaults match Linear's stock workflow (see the active/terminal default lists in
[configuration](../reference/configuration.md)). Teams that add intermediate states must list them
explicitly. A team using `Agent Review`, `Rework`, and `Merging` between in-flight and done would set:

```yaml
tracker:
  kind: linear
trackers:
  linear:
    provider: linear
    api_key: ${LINEAR_API_KEY}
    project_slugs:
      - team-alpha
    active_states:
      - Todo
      - In Progress
      - Rework
    terminal_states:
      - Agent Review
      - Merging
      - Done
      - Cancelled
```

The split is a policy choice. List a state under `active_states` to keep handing the issue back to an
agent; list it under `terminal_states` to stop polling it and release its workspace. A state in
neither list the poll ignores. State names must match Linear exactly, including casing and spaces.

### Dispatch block

`dispatch` gates which issues a Lorenz instance accepts, by route label. It is a core dispatch
concept shared across trackers, not owned by the Linear backend. The Linear client only reads each
issue's labels and normalizes them to lowercase; routing decisions happen in the runtime.

| Key | Default | Meaning |
| --- | --- | --- |
| `accept_unrouted` | `true` | Accept issues with no label matching the route prefix. |
| `only_routes` | `null` | Whitelist of route names (the suffix after the prefix) this instance handles. `null` means all. |
| `route_label_prefix` | `Lorenz:` | Label prefix that marks a route. |

A Linear label `Lorenz:Backend` routes its issue to instances handling the `Backend` route. With the
default prefix and `accept_unrouted: true`, an issue with no `Lorenz:` label still gets picked up. See
[dispatch-routing](../features/dispatch-routing.md) for multi-instance setups.

## Polling and rate limits

The dispatch loop calls the Linear client on each cycle. The client runs a paginated GraphQL query
filtered by the resolved project slugs and the `active_states` names, fetching 50 issues per page and
following the cursor until the project is exhausted.

The client talks to Linear over GraphQL with two transports. With `api_key` set and no custom fetch
injected, it uses the `@linear/sdk` GraphQL client; otherwise it uses raw `fetch`. Both share the
same resilience behavior:

- **Timeout.** Each request is bounded at 30 seconds.
- **429 backoff.** On a `429`, the client honors `Retry-After` when present (integer seconds or an
  HTTP-date), falling back to exponential backoff (1 second base, doubling, capped at 30 seconds). It
  retries up to 4 times, then raises a `429` error.
- **Pagination integrity.** A page that reports more issues but omits its cursor fails the poll
  loudly rather than truncating silently. Oversized nested issue and project metadata is read across
  follow-up pages when possible; if Linear cannot provide the continuation page, the poll keeps
  usable issues and logs the degraded issue, project, team, and connection.

A missing `api_key` fails before any network call with a `missing Linear API key` error.

## Agent tools

Mounting the Linear backend gives agents the `linear` tool pack over the configured Linear
credentials. The provider's `defaultToolPacks` declares only this pack, so Linear dispatch mounts
`linear_graphql` and nothing else.

**The `linear_graphql` escape hatch.** The `linear` tool pack serves one tool, `linear_graphql`, for
raw GraphQL over the full Linear API: issue reads and queries, status transitions, comment reads and
edits, attachment and upload flows, schema introspection. It accepts a bare query string or a
`{ query, variables }` object and reuses Lorenz's configured Linear auth. A top-level GraphQL
`errors` array on an HTTP 200 returns a failed result instead of throwing, and the tool applies the
same 429 backoff as the poller. The pack mounts automatically for Linear dispatch.

The `linear` pack also bundles a `lorenz-linear` skill that teaches the agent how to call
`linear_graphql`: progressive issue lookup (key, then identifier, then internal id), fetching team
states before a transition, comment edits, and the three-step file-upload flow. Mounting the pack
overlays the skill. See [skills](../agents/skills.md).

### Tool pack credentials

`linear_graphql` resolves its credential separately from dispatch, so you can mount it over a
non-Linear tracker. Precedence:

1. `tools.linear.api_key` (resolved at config-parse time) wins when set.
2. Only when `tracker.kind` is `linear` does it fall back to the dispatch tracker's `api_key` and
   `endpoint`.

A non-Linear dispatch tracker's token never reaches Linear. The `tools.linear` slice accepts only
`api_key` (or `apiKey`) and `endpoint`; any other key fails at startup with
`tools.linear.<key> is not supported`. To give agents `linear_graphql` while dispatching from another
backend:

```yaml
tools:
  linear:
    api_key: ${LINEAR_API_KEY}
```

## How config maps to behavior

| You set | Lorenz does |
| --- | --- |
| `api_key` / `LINEAR_API_KEY` | Authenticates every poll, status change, comment, and `linear_graphql` call. |
| one project selector | Resolves to the slug set the poll filters by. |
| `assignee: me` | Resolves the API key's own user id and filters the poll to it. |
| `active_states` | The state names the poll treats as dispatch candidates. |
| `terminal_states` | The state names that release an issue's workspace. |
| `dispatch.route_label_prefix` + labels | Gates which routed issues this instance accepts. |
| `tools.linear.api_key` | Credential `linear_graphql` uses, independent of dispatch. |

## See also

- [Trackers overview](index.md) - all tracker backends and how dispatch consumes them.
- [Configuration reference](../reference/configuration.md) - the full key, default, and alias table.
- [Dispatch routing](../features/dispatch-routing.md) - route labels and multi-instance gating.
- [Skills](../agents/skills.md) - the bundled `lorenz-linear` skill and how packs overlay docs.
- [Tracker provider extension](../extensions/tracker-provider.md) - build your own tracker backend.
