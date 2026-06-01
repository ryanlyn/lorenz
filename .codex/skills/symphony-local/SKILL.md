---
name: symphony-local
description: |
  Use Symphony's local board tracker tools (local_query, local_read_issue,
  local_update_status, local_comment, local_create_issue) to read and update
  issues on a filesystem board during Symphony app-server sessions.
---

# Local Board Tracker

Use this skill when Symphony's tracker kind is `local`. The board is a directory of
`BOARD-<n>.md` files (status frontmatter, a title heading, a description, and a
`## Comments` section). The daemon polls the board and hands you one issue; you read
and update it through the tools below. There is no Linear and no `linear_graphql`.

All tools return `{ "success": boolean, "result"?: ..., "error"?: string }`. A failed
operation sets `success: false` and explains why in `error` rather than throwing.

## Tools

### `local_query` (read-only, composable)

Query the whole board with a JSON filter, projection, ordering, and paging. This is the
way to discover issues you were not handed: siblings, blockers named in a description,
duplicates, everything in a given state.

Input (every field optional):

```json
{
  "where": { "field": "state", "op": "eq", "value": "Todo" },
  "select": ["id", "title", "state", "labels"],
  "order_by": [{ "field": "createdAt", "dir": "asc" }],
  "limit": 100,
  "offset": 0
}
```

Row fields available to `select` and `where`: `id`, `identifier`, `title`,
`description`, `state`, `stateType`, `labels`, `createdAt`, `updatedAt`. Add
`"comments"` to `select` to include each issue's comment lines (this costs one extra
read per returned row, so only ask when you need them).

Result:

```json
{
  "rows": [{ "id": "BOARD-7", "title": "Fix flaky test", "state": "Todo", "labels": ["backend"] }],
  "total": 1,
  "skipped": [{ "id": "BOARD-9", "error": "missing required 'status'" }]
}
```

- `total` is the match count BEFORE paging; use it with `limit`/`offset` to page.
- `skipped` lists board files that could not be parsed; the query never fails because
  of one bad file.

### `local_read_issue` (read-only, single issue)

Read one issue's current status, title, description, and comments by id.

```json
{ "issueId": "BOARD-7" }
```

Returns `{ "issue": { "id", "status", "title", "description" }, "comments": [ "..." ] }`.
Prefer `local_query` when you want many issues or a filter; use this for a quick re-read
of one known issue (for example, to recover context after a restart).

### `local_update_status` (write)

Move an issue to a new status. The status is written verbatim into the file's
frontmatter, so use the status names your workflow defines (e.g. `Todo`,
`In Progress`, `Done`, `Cancelled`).

```json
{ "issueId": "BOARD-7", "status": "In Progress" }
```

### `local_comment` (write)

Append a timestamped comment to the issue's `## Comments` section. Comments are
append-only; there is no edit or delete.

```json
{ "issueId": "BOARD-7", "body": "Opened PR #128, CI running." }
```

### `local_create_issue` (write)

Create a new board issue and get back its minted `BOARD-<n>` id.

```json
{ "title": "Investigate retry storm", "body": "Optional description.", "status": "Todo" }
```

## The filter DSL (`where`)

A small, total predicate language - no regex, no code, evaluated in memory. Nesting is
bounded (max depth 12, max 200 nodes), so keep filters reasonable.

Predicates:

```json
{ "field": "state", "op": "eq",       "value": "Todo" }
{ "field": "state", "op": "ne",       "value": "Done" }
{ "field": "n",     "op": "lt",       "value": 5 }          // also lte, gt, gte (numbers/strings)
{ "field": "state", "op": "in",       "value": ["Todo", "In Progress"] }   // also nin
{ "field": "title", "op": "contains", "value": "deploy", "ci": true }       // substring; ci = case-insensitive
{ "field": "labels","op": "contains", "value": "backend" }                  // arrays: matches any element
{ "field": "labels","op": "exists",   "value": true }                       // field present at all
```

Combinators (each takes the same filter shape):

```json
{ "and": [ {...}, {...} ] }
{ "or":  [ {...}, {...} ] }
{ "not": {...} }
```

An unknown or missing field is treated as ABSENT: every comparison against it is false,
and only `{ "op": "exists", "value": false }` matches it. Ask for a field you do not
have and you simply get no match - never an error.

## Common workflows

Find the oldest unstarted backend issues:

```json
{
  "where": {
    "and": [
      { "field": "stateType", "op": "in", "value": ["unstarted", "backlog"] },
      { "field": "labels", "op": "contains", "value": "backend" }
    ]
  },
  "select": ["id", "title", "description"],
  "order_by": [{ "field": "createdAt", "dir": "asc" }],
  "limit": 20
}
```

Pick up an issue and log progress in one short sequence:

1. `local_query` (or `local_read_issue`) to read the current state and comments.
2. `local_update_status` to move it to your workflow's in-progress status.
3. `local_comment` to record what you did.

## Usage rules

- Reads (`local_query`, `local_read_issue`) are side-effect-free; use them freely to
  build context before acting. Writes change the board the daemon polls, so be
  deliberate.
- Use your workflow's exact status names with `local_update_status`. There is no
  enumeration tool; the status strings come from the workflow configuration / your
  prompt. An unknown status is written as-is (and will normalize to `backlog`).
- `select` only the fields you need, and add `comments` only when you will use them.
- Comments are append-only; do not expect to edit or delete them.
- Do not write to the board files directly; always go through these tools so the
  atomic, crash-safe write path is preserved.
