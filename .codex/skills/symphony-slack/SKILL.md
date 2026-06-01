---
name: symphony-slack
description: |
  Use Symphony's Slack tracker tools (slack_query, slack_read_thread,
  slack_update_status, slack_comment) to read and update issues backed by Slack
  messages during Symphony app-server sessions.
---

# Slack Tracker

Use this skill when Symphony's tracker kind is `slack`. The mapping is:

- An @-mention of the bot in a configured channel IS an issue. Its id is
  `<channel>:<ts>` (e.g. `C0123456789:1700000000.000100`).
- An emoji reaction on that message IS the status (default: `eyes` = In Progress,
  `white_check_mark` = Done, `x` = Cancelled; a workflow may configure others).
- A thread reply IS a comment.

The daemon polls bot-mentions in the configured channels and hands you one issue; you
read and update it through the tools below. There is no Linear and no `linear_graphql`.

All tools return `{ "success": boolean, "result"?: ..., "error"?: string }`. A failed
operation sets `success: false` and explains why in `error`.

Trust boundary (enforced for you): every tool only ever touches configured channels and
messages that are real bot-mentions. You cannot read or act on arbitrary messages, and a
requested channel that is not in the allow-list is ignored.

## Tools

### `slack_query` (read-only, composable)

Query the issues (bot-mention messages) in the configured channels with a JSON filter,
projection, ordering, and paging. This is the way to discover issues you were not handed.

Input (every field optional):

```json
{
  "channels": ["C0123456789"],
  "where": { "field": "state", "op": "eq", "value": "Todo" },
  "select": ["issueId", "title", "state", "labels"],
  "expand": ["thread", "reactions"],
  "order_by": [{ "field": "ts", "dir": "asc" }],
  "limit": 100,
  "offset": 0
}
```

- `channels` is intersected with the configured allow-list; omit it to scan all
  configured channels. A channel not in the allow-list is silently dropped.
- Base row fields for `select` and `where`: `issueId`, `channel`, `ts`, `title`,
  `state`, `stateType`, `labels`, `text` (full message body).
- `expand` adds heavier fields: `"reactions"` -> the raw reaction names; `"thread"` ->
  the thread replies (one fetch per returned row).

Result:

```json
{
  "rows": [{ "issueId": "C0123456789:1700.01", "title": "deploy v2", "state": "Todo", "labels": ["backend"] }],
  "total": 1
}
```

`total` is the match count before paging.

### `slack_read_thread` (read-only, single issue)

Read one issue's source message, derived status, reactions, and thread replies by id.

```json
{ "issueId": "C0123456789:1700000000.000100" }
```

Returns:

```json
{
  "issueId": "C0123456789:1700000000.000100",
  "status": "In Progress",
  "text": "<@U0BOT> fix the flaky test",
  "reactions": ["eyes"],
  "replies": [{ "ts": "1700000000.000200", "text": "on it", "user": "U123" }]
}
```

Use this for a quick re-read of one known issue (for example, to recover context after a
restart); use `slack_query` when you want many issues, a filter, or projection.

### `slack_update_status` (write)

Set an issue's status by swapping its status emoji reaction (adds the target, removes the
stale managed ones, verifies the effective state).

```json
{ "issueId": "C0123456789:1700000000.000100", "status": "Done" }
```

The status MUST be one your workflow's `emoji_states` maps to an emoji (e.g.
`In Progress`, `Done`, `Cancelled`). An unmapped status fails with
`No emoji configured for status '<status>'` - it does not silently no-op. If you are
unsure of the valid statuses, they come from the workflow's `emoji_states` config.

### `slack_comment` (write)

Reply in the issue's thread (this is how a comment is recorded).

```json
{ "issueId": "C0123456789:1700000000.000100", "body": "Opened PR #128, CI running." }
```

There is no `slack_create_issue`: an issue is a human's @-mention, so the bot never
fabricates one.

## The filter DSL (`where`)

A small, total predicate language - no regex, no code, evaluated in memory over the
fetched rows. Nesting is bounded (max depth 12, max 200 nodes).

Predicates:

```json
{ "field": "state", "op": "eq",       "value": "Todo" }
{ "field": "state", "op": "ne",       "value": "Done" }
{ "field": "ts",    "op": "gt",       "value": "1700000000.0" }   // also lt/lte/gte (numbers/strings)
{ "field": "state", "op": "in",       "value": ["Todo", "In Progress"] }   // also nin
{ "field": "text",  "op": "contains", "value": "deploy", "ci": true }       // substring; ci = case-insensitive
{ "field": "labels","op": "contains", "value": "backend" }                  // arrays: matches any element
{ "field": "labels","op": "exists",   "value": true }
```

Combinators:

```json
{ "and": [ {...}, {...} ] }
{ "or":  [ {...}, {...} ] }
{ "not": {...} }
```

An unknown or missing field is ABSENT: every comparison against it is false, and only
`{ "op": "exists", "value": false }` matches it.

Labels come from `#hashtags` in the message text (lower-cased, deduped); a
`#route-<x>` hashtag is routing, not a plain label.

## Common workflows

Find open issues about deploys in one channel, with their threads:

```json
{
  "channels": ["C0123456789"],
  "where": {
    "and": [
      { "field": "state", "op": "eq", "value": "Todo" },
      { "field": "text", "op": "contains", "value": "deploy", "ci": true }
    ]
  },
  "select": ["issueId", "title", "state"],
  "expand": ["thread"]
}
```

Pick up an issue and report progress:

1. `slack_query` (or `slack_read_thread`) to read the message, status, and replies.
2. `slack_update_status` to move it to your in-progress status.
3. `slack_comment` to post a thread update.

## Usage rules

- Reads (`slack_query`, `slack_read_thread`) are side-effect-free; use them to build
  context before acting. Writes touch the live Slack workspace, so be deliberate.
- Use only statuses your workflow's `emoji_states` defines with
  `slack_update_status`; an unmapped status is a hard failure, not a no-op.
- `select` only the fields you need; use `expand` for `thread`/`reactions` only when
  you will use them (each `thread` expand is an extra fetch per row).
- You can only act on tracked bot-mention issues in configured channels; do not expect
  to read or post to arbitrary messages or channels.
- There is no way to edit a human's source message or create an issue; comment in the
  thread instead.
