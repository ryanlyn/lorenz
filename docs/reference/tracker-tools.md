# Agent tool catalog

This page is the exhaustive reference for the tools an agent can call while working an issue: the provider-neutral `tracker_*` family, the read-only query DSL they share, and the provider-specific tool packs (`linear`, `local`, `slack`). It is written for integrators who need exact tool names, argument shapes, and the rules for which tracker supports which tool. Operators who want the conceptual picture should start with [how it works](../how-it-works.md); extension authors building a new pack should read [tool-pack extensions](../extensions/tool-pack.md).

Lorenz serves these tools over an HTTP MCP (Model Context Protocol) endpoint at `POST /mcp`. Every tool is self-documenting: a `tools/list` JSON-RPC call returns the live specs (name, description, JSON-Schema `inputSchema`) for exactly the tools mounted under the current workflow settings. The tables below mirror those specs, but the endpoint is the source of truth at runtime.

## How tools mount

The set of tools an agent sees is computed from the workflow settings, not fixed at build time. The MCP server resolves a list of tool *packs* to mount, flattens them into one namespace, and serves that flat set.

<p align="center"><img src="../assets/diagrams/mcp-tool-mounting.svg" alt="mcp tool mounting diagram" width="880" style="width:100%;max-width:880px;height:auto" /></p>
*Pack selection: the neutral `tracker` pack, the dispatch tracker's default packs, and the workflow `tools:` keys are de-duplicated and flattened into one tool namespace.*

Pack selection order (first-seen wins, de-duplicated through a Set):

1. The neutral `tracker` pack, if registered. It is mounted for every backend, including `memory`.
2. The dispatch tracker's `defaultToolPacks(settings)`. Linear returns `["linear"]`, local returns `["local"]`, slack returns `["slack"]`. Jira and `jira-mcp` declare no own pack. When a tracker omits `defaultToolPacks`, the fallback mounts a pack whose name equals `tracker.kind` if one is registered and is not `tracker`.
3. Every key of the workflow `tools:` map (parsed into `settings.toolOptions`). Writing `tools: { linear: { api_key: "$LINEAR_API_KEY" } }` mounts the `linear` pack over any dispatch tracker.

The namespace is flat. If two mounted packs declare the same tool name, the server throws `tool name collision: <name> is declared by both the "<a>" and "<b>" packs` at mount time. A pack re-declaring its own tool name is fine (ownership is by pack name).

The server name an agent sees for the endpoint is `lorenz_<kind>` (for example `lorenz_linear`, `lorenz_local`), sanitized to `[A-Za-z0-9_]`. The JSON-RPC `serverInfo.name` is the literal `mcp`.

## The isError contract

Tool failures are returned as data, never thrown across the MCP seam. A tool returns a `ToolResult` of `{ success, result?, error? }`. The server wraps a `tools/call` response as:

```json
{
  "content": [{ "type": "text", "text": "<JSON payload>" }],
  "isError": <true when success is false>
}
```

A failed tool is still an HTTP 200 JSON-RPC result with `isError: true`, not a transport error. On success the payload is `result.result ?? {}`; on failure it is `result.result ?? { "error": { "message": <error string> } }`. A pack that throws is caught and returned as a failure. Calling a name no pack declares returns `Unsupported tool: "<name>".` with a `supportedTools` list.

A tool can also report itself unavailable. Each `tracker_*` tool checks the specific backend operation it needs; when that operation is missing it returns `success: false` with `tracker tools are unavailable for <kind> tracker`. Missing required string arguments fail the same way, with `'<key>' is required`.

## The `tracker_*` tools

The neutral `tracker` pack serves seven provider-neutral tools that work against whichever tracker drives dispatch. It implements them over the tracker's normalized operations (`TrackerToolOps`), so the same tool names behave identically across Linear, Jira, local boards, and Slack. A backend that does not implement a given operation makes the matching tool report unavailable rather than fail mid-call. The `memory` tracker implements no operations, so the pack advertises zero tools for it.

| Tool | Required args | Optional args | Returns |
| --- | --- | --- | --- |
| `tracker_read_issue` | `issueId` | | `{ issue }` |
| `tracker_query` | | `states`, `issueIds`, `query`, `where`, `select`, `order_by`, `limit`, `offset` | `{ rows, total, skipped? }` |
| `tracker_update_status` | `issueId`, `status` | | `{ issue }` |
| `tracker_list_comments` | `issueId` | | `{ comments }` |
| `tracker_comment` | `issueId`, `body` | | `{ ok: true }` or `{ ok: true, comment }` |
| `tracker_update_comment` | `issueId`, `commentId`, `body` | | `{ comment }` |
| `tracker_create_issue` | `title` | `body`, `status`, `assignee` | `{ issue }` |

`tracker_comment` returns `{ ok: true }` when the backend reports no comment body and `{ ok: true, comment }` when it returns the created comment.

### Tracker support matrix

A tool is available only when the dispatch tracker implements the backing operation.

| Tool | linear | jira | jira-mcp | local | slack | memory |
| --- | --- | --- | --- | --- | --- | --- |
| `tracker_read_issue` | yes | yes | yes | yes | yes | no |
| `tracker_query` | yes | yes | yes | yes | yes | no |
| `tracker_update_status` | yes | yes | yes | yes | yes | no |
| `tracker_list_comments` | yes | yes | yes | yes | no | no |
| `tracker_comment` | yes | yes | yes | yes | yes | no |
| `tracker_update_comment` | yes | yes | yes | no | no | no |
| `tracker_create_issue` | yes | yes | yes | yes | no | no |

`tracker_create_issue` is unavailable on Slack: Slack issues are created exclusively by a human @-mentioning the bot, so the backend omits `createIssue` on purpose. The local board exposes create and comment append, so `tracker_create_issue` and `tracker_comment` work, but it has no comment-listing or comment-update operation through the neutral pack, so only `tracker_list_comments` and `tracker_update_comment` report unavailable there. The `memory` tracker exposes nothing; it exists for tests and dry runs.

`tracker_create_issue` assignee handling is provider-specific. Jira REST assigns to the configured owner; `jira-mcp` forwards a concrete assignee; the neutral pack passes `assignee` straight through to the backend.

## The read-only query DSL

`tracker_query` (and the structured pack tools `local_query` and `slack_query`) accept a side-effect-free query envelope: a filter predicate tree, a field projection, an ordering, and paging. The DSL is total. It has no regex, no `eval`, and no JSONPath, and it runs in memory over already-parsed records, so a query can never mutate the backend.

### Filter predicates

A `where` filter is a predicate or a combinator node.

A predicate is `{ field, op, value }`:

| `op` | `value` shape | Meaning |
| --- | --- | --- |
| `eq` / `ne` | scalar | equal / not equal (strict `===`) |
| `lt` / `lte` / `gt` / `gte` | scalar | ordered comparison |
| `in` / `nin` | array of scalars | member / non-member |
| `contains` | string (plus optional `ci: true`) | substring of a string field, or of any element of an array field |
| `exists` | boolean | field is present (and not `undefined`) |

A scalar is a string, number, boolean, or `null`. A combinator node holds exactly one of `and`, `or`, or `not`: `{ and: [Filter, ...] }`, `{ or: [Filter, ...] }` (each a non-empty array), or `{ not: Filter }`.

Evaluation rules:

- An absent field makes every predicate false except `exists: false`.
- `contains` with `ci: true` is case-insensitive; without it, case-sensitive.
- Ordering comparisons only apply to number-vs-number and string-vs-string; mixed types are incomparable and never match `lt`/`lte`/`gt`/`gte`.

### Select, order, page

| Arg | Shape | Effect |
| --- | --- | --- |
| `select` | `string[]` | project to the named fields, dropping any a record lacks |
| `order_by` | `[{ field, dir? }]` | stable sort; `dir` is `asc` (default) or `desc` |
| `limit` | positive integer | page size; clamped to `1000`, default `100` |
| `offset` | non-negative integer | rows to skip; default `0` |

A query returns the page plus `total`, the pre-page count after filtering. `select` is honored only on the whole-issue projection path. When a backend implements native row projection (for example `local_query` and `slack_query`), it does its own projection and the envelope's `select` is applied by that tool's own default rather than by the neutral pack.

DSL bounds: filter nesting is capped at depth `12`, a filter tree at `200` nodes, `limit` default `100` and maximum `1000`. For `tracker_query`, the default projection when `select` is omitted is `id`, `identifier`, `title`, `state`, `stateType`, `labels`, `url`.

## Provider packs

A tracker extension can ship its own tool pack alongside the neutral tools. These give the agent raw or board-native access that the neutral surface deliberately abstracts away. Each pack is mounted by default when its tracker drives dispatch, and can also be mounted standalone through the workflow `tools:` map.

### `linear` pack

One tool, for raw GraphQL against the configured Linear workspace. It ships the `lorenz-linear` skill that teaches the agent how to call it.

| Tool | Required args | Optional args | Notes |
| --- | --- | --- | --- |
| `linear_graphql` | `query` | `variables` | Runs a GraphQL query or mutation. `query` is a bare string or `{ query, variables }`. `variables` must be an object or `null`. |

A top-level GraphQL `errors` array on an HTTP 200 returns `success: false` with the response body as the result, not a thrown error. HTTP failures return a failure with the status. Credentials resolve from `tools.linear.api_key` first; only when `tracker.kind` is `linear` does the tool fall back to the dispatch tracker's key. A non-Linear dispatch tracker's token is never sent to Linear.

### `local` pack

Five tools over the filesystem board (`<prefix><n>.md` files in the board directory).

| Tool | Required args | Optional args | Returns |
| --- | --- | --- | --- |
| `local_update_status` | `issueId`, `status` | | `{ issue }` |
| `local_comment` | `issueId`, `body` | | `{ ok: true }` |
| `local_create_issue` | `title` | `body`, `status` | `{ issue }` |
| `local_read_issue` | `issueId` | | `{ issue: { id, status, title, description }, comments }` |
| `local_query` | | `where`, `select`, `order_by`, `limit`, `offset` | `{ rows, total, skipped }` |

`local_create_issue` defaults `status` to `Todo`. `local_query` row fields are `id`, `identifier`, `title`, `description`, `state`, `stateType`, `labels`, `createdAt`, `updatedAt`; add `comments` to `select` to include each issue's comment lines (an extra read). Its default projection is `id`, `title`, `state`, `stateType`, `labels`. Malformed board files are reported in `skipped` rather than failing the query.

### `slack` pack

Six tools over the watched Slack channels. Every tool requires a configured `bot_user_id`, a watched channel, and a tracked message; the production transport fails closed without a bot user id.

| Tool | Required args | Optional args | Returns |
| --- | --- | --- | --- |
| `slack_update_status` | `issueId`, `status` | | `{ ok: true, status }` |
| `slack_comment` | `issueId`, `body` | | `{ ok: true }` |
| `slack_read_thread` | `issueId` | | source message, thread-derived status, reactions, permalink, replies |
| `slack_query` | | `channels`, `where`, `select`, `expand`, `order_by`, `limit`, `offset` | `{ rows, total }` |
| `slack_user_info` | `userId` | | `{ user }` |
| `slack_channel_context` | `issueId` | `before`, `after` | `{ anchor, messages }` |

A Slack `issueId` is `<channel>:<ts>` of the thread root. `slack_update_status` posts the bot's authoritative `status:` reply (reactions are only a visibility mirror) and rejects an unknown state name. `slack_query` rows are `issueId`, `channel`, `ts`, `title`, `state`, `stateType`, `labels`, `text`, `url`; `expand` accepts `thread` and `reactions`; requested `channels` are intersected with the configured allow-list. Its default projection is `issueId`, `title`, `state`, `labels`. `slack_channel_context` reads `before` and `after` messages around the anchor (each defaults to `10`, maximum `50`).

There is no `slack_create_issue`: only a human creating an @-mention starts a Slack issue.

## Jira and the `jira-mcp` external tool map

Jira ships no tool pack of its own. Agents working a Jira issue use the neutral `tracker_*` tools, and the extension also ships a `lorenz-jira` skill documenting raw Jira REST v3 patterns. The `jira-mcp` variant proxies the same neutral operations to an external MCP server. Its tool names default to the `jira_*` family and are overridable per operation under `trackers.jira-mcp.mcp.tools`:

| Operation | Default external tool |
| --- | --- |
| search | `jira_search` |
| read issue | `jira_get_issue` |
| update status | `jira_transition_issue` |
| list comments | `jira_get_comments` |
| comment | `jira_add_comment` |
| update comment | `jira_update_comment` |
| create issue | `jira_create_issue` |

## See also

- [Tool-pack extensions](../extensions/tool-pack.md) - build a new tool pack against the `ToolProvider` contract.
- [Tracker-provider extensions](../extensions/tracker-provider.md) - implement `TrackerToolOps` to back the neutral tools.
- [HTTP API](http-api.md) - the `POST /mcp` JSON-RPC endpoint, auth, and methods.
- [Configuration](configuration.md) - the `tools:` map and per-tracker keys.
- [Trackers](../trackers/index.md) - per-provider setup and behavior for Linear, Jira, local, Slack, and memory.
