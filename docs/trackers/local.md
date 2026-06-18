# Local board tracker

The local tracker turns a directory of Markdown files into a Lorenz issue tracker. It needs no
API key, no network, and no external service, so it is the fastest way to try Lorenz and lets you
drive runs from files committed alongside your code. This page is for operators configuring
`tracker.kind: local`: the board directory, the file format, the id prefix rules, the agent tools,
the durability guarantees, and a complete workflow example.

Set `provider: local` and Lorenz polls a board directory, dispatches issues whose status is in
`active_states`, and writes status changes and comments back into the same files.

```yaml
tracker:
  kind: local
trackers:
  local:
    provider: local
    # path: .lorenz/local      # optional; defaults to .lorenz/local
    id_prefix: BOARD-
    active_states: [Todo, In Progress]
    terminal_states: [Done, Closed, Cancelled]
```

## The board directory

The board is a directory of issue files. Each issue is one Markdown file named `<prefix><n>.md`,
for example `BOARD-1.md`, `BOARD-2.md`. The directory defaults to `.lorenz/local` (the constant
`DEFAULT_BOARD_DIR`) and is set with `tracker.path`.

Path resolution mirrors `workspace.root`. `resolveBoardDir` (`resolveBoardDir.ts`) applies three
rules:

- An unset `path` falls back to `.lorenz/local`.
- A leading `~` expands to `$HOME` (or `$USERPROFILE`), honored only when it stands alone or is
  followed by a separator. Embedded `$VAR` and `${VAR}` expand from the environment; an unknown
  variable expands to the empty string, matching shell substitution.
- A relative path resolves against the daemon's working directory; an absolute path is used as is.

This resolver is the single source of truth for both sides of the board. The read path
(`LocalTrackerClient`, which the daemon polls) and the write path (the `local_*` agent tools) both
call it, so they resolve to the same absolute directory. If they diverged, agent writes would land
in a directory the poll loop never reads, and the run loop would re-dispatch the same issue forever.

Files whose stem does not match `^<prefix>\d+$` are ignored. A `README.md`, a `notes.md`, or a file
written under a different prefix is skipped for both listing and id allocation. The dotted scratch
files Lorenz writes during a publish (`.lorenz-create.<pid>.<rand>.tmp` and
`<target>.<pid>.<rand>.tmp`) are invisible for the same reason.

If the board directory does not exist yet, the poll returns an empty board rather than an error.
Lorenz creates the directory and its parents on the first write, fsyncing each newly created parent
up the chain. Any other `readdir` failure (the path is a file, or permissions deny it) throws with
the directory path in the message, and the runtime records a `poll_error`.

## The file format

A board file has three parts: YAML front matter, the title and description body, and an optional
comments section. The tools read and write this on-disk shape.

```md
---
status: In Progress
labels: [backend, urgent]
---
# Fix the retry backoff

The worker retries immediately on a 503 instead of backing off.
Acceptance: exponential backoff with jitter, capped at 30s.

<!-- lorenz:comments -->
## Comments
- 2026-05-29T10:00:00.000Z agent: opened PR with the backoff change
- 2026-05-29T10:42:00.000Z agent: tests green, moving to In Review
```

<p align="center"><img src="../assets/diagrams/local-board-anatomy.svg" alt="local board anatomy diagram" width="720" style="width:100%;max-width:720px;height:auto" /></p>
*Each region of a board file maps to a status, a body, or a comment line, and to the tool that owns it.*

The front matter carries two keys. `status` is the raw board status string, compared
case-insensitively against `active_states` and `terminal_states` to drive dispatch. `labels` is a
list, lower-cased on read. The `# Title` heading is the issue title; if no heading is present, the
title falls back to the issue id. The text between the heading and the comments marker is the
description.

The `<!-- lorenz:comments -->` marker is load-bearing. It sits immediately before the human-readable
`## Comments` heading and delimits the comments section. The parser splits on the hidden marker, not
on the literal `## Comments` text, so a description that itself contains a `## Comments` heading
round-trips correctly. The marker and the heading are written only when an issue has comments.

Each comment is one line in the exact format `- <ISO8601 timestamp> agent: <body>`, for example
`- 2026-05-29T10:00:00.000Z agent: opened PR`. The `local_comment` tool appends these lines. On
read, CRLF line endings are normalized to LF.

The board status string maps to a normalized `stateType` for the runtime. Unknown statuses fall
back to `backlog`.

## The id prefix

New issue ids are minted as `<prefix><n>`, where `n` is one greater than the highest existing
number on the board. The prefix defaults to `BOARD-` (the constant `DEFAULT_ID_PREFIX`) and is set
with `tracker.id_prefix`.

A prefix must match `^[A-Za-z0-9][A-Za-z0-9_-]*$`: start with a letter or digit, then letters,
digits, `_`, or `-`. The trailing `-` in `BOARD-` is allowed. This keeps every minted filename
inside the board directory and rejects path-traversal through `.`, `/`, `\`, whitespace, or NUL. An
invalid prefix fails at config load with the user-facing key name, for example
`tracker.id_prefix "bad/prefix" is invalid`.

The id prefix also gates which ids agents may touch. Any id an agent passes to a tool must match
`^<prefix>\d+$`; anything else is rejected before it reaches the filesystem, and the resolved file
path is re-checked to confirm it stays inside the board directory.

> Set the prefix once, up front. Changing `id_prefix` on a board that already has files orphans
> every file written under the old prefix. Those stems stop matching `^<prefix>\d+$`, so they vanish
> from listing and from id allocation. They are not deleted, but Lorenz no longer sees them.

### A note on config key casing

The user-facing YAML key is `id_prefix` (snake_case). Internally everything is `idPrefix`. The
provider's `configAliases` maps `id_prefix` to `idPrefix`, and the tool pack accepts both `idPrefix`
and `id_prefix`. The board directory key is `path` on the tracker and `tools.local.path` on the pack.

## The agent tools

Two tool surfaces operate on the same board. The provider-neutral `tracker_*` pack works against any
backend (see [reference/tracker-tools.md](../reference/tracker-tools.md) for the seven neutral tools,
their schemas, and the query DSL grammar); the `local` pack adds five board-native tools
(`local_read_issue`, `local_query`, `local_update_status`, `local_comment`, `local_create_issue`).
Both are mounted automatically for a `local` dispatch tracker (the provider's `defaultToolPacks`
returns `["local"]`), and the neutral ops map onto the five `local_*` tools through `localToolOps`
(`toolOps.ts`) so a workflow written against `tracker_*` runs unchanged on the local board.

A few board-native behaviors worth knowing:

- `local_create_issue` defaults `status` to `Todo` when omitted. It does not read `active_states`;
  those states gate dispatch eligibility, not file creation. An empty or whitespace-only status is
  rejected before any file is written.
- `local_query` returns `{rows, total, skipped}`. `total` is the row count before paging; the default
  projection is `[id, title, state, stateType, labels]`. The `comments` field is off the base record
  because it costs an extra file read, so name it in `select` to include each issue's comment lines. A
  malformed board file does not fail the query; it lands in the `skipped` array.
- `local_read_issue` returns `{issue: {id, status, title, description}, comments}` and reports the raw
  board status string, not the normalized `stateType`.

## Durability and concurrency

Writes are crash-atomic. The directory entry for a file never becomes visible until the file's
contents are durable on disk, so a power loss can never leave a half-written `BOARD-<n>.md`.

- `create` writes the contents to a temp file, fsyncs the file, then publishes the name with a
  no-overwrite hard link and fsyncs the board directory. If the target id already exists (`EEXIST`),
  it recomputes the next id and retries, up to 64 attempts. Because publish uses a no-overwrite link,
  two concurrent creates, even from separate processes, can never collide or overwrite each other.
- `local_update_status` and `local_comment` write the new contents to a temp file, fsync it, rename
  it over the target (an atomic replace), then fsync the directory. A read-modify-write that fails
  validation, such as a blank status, leaves the existing file byte-for-byte intact.

Directory fsync is a best-effort barrier. The contents fsync already protects the data; some
platforms cannot fsync a directory handle, so those specific errors are swallowed and the OS flushes
the entry on its own schedule.

Concurrent writes are serialized per file. A process-wide lock keyed by absolute path queues
read-modify-write cycles on the same file so a status change and a comment can never clobber each
other. Id allocation is serialized per directory by the same mechanism. Each tool call builds a
fresh store, so the lock lives at module scope and every call pointing at one board shares the same
queue.

This serialization is in-process only. It covers the concurrent agents and ensemble slots inside a
single Lorenz daemon and assumes no external process edits the board files at the same time. The
no-overwrite link remains the authoritative guard against external or concurrent create collisions,
but live edits to a `BOARD-<n>.md` from another process while the daemon runs are not protected.

## Seeding a demo board

The `sandbox/seed-local.ts` seeder writes a few sample issues so you can run Lorenz against
`kind: local` with nothing else set up. It writes through the same `BoardStore`, so the ids and
on-disk format match what the running tracker expects.

```sh
npx tsx sandbox/seed-local.ts                       # seeds ./.lorenz/local
npx tsx sandbox/seed-local.ts /tmp/demo-board       # seeds an explicit dir
npx tsx sandbox/seed-local.ts .lorenz/local 2       # seeds only the first 2 issues
npx tsx sandbox/seed-local.ts /tmp/demo-board 3 XXX- # seeds XXX-1..XXX-3
```

The arguments are `[dir] [count] [idPrefix]`, all optional. The seeder writes three sample issues:
two in `Todo` and one in `In Progress`. Existing files are appended to, not overwritten, since
`create` mints the next free id. Match the `idPrefix` argument to your workflow's `tracker.id_prefix`
so the seeded ids land in the namespace the tracker polls.

## A complete example

This board lives in the repo at `.lorenz/local`. The workflow runs against the neutral `tracker_*`
tools so it could later move to any backend.

`lorenz.yaml`:

```yaml
tracker:
  kind: local
trackers:
  local:
    provider: local
    # path: .lorenz/local      # optional; defaults to .lorenz/local
    id_prefix: BOARD-
    active_states: [Todo, In Progress]
    terminal_states: [Done, Closed]
```

`.lorenz/local/BOARD-1.md`:

```md
---
status: Todo
labels: [demo]
---
# Add a health endpoint

Add `GET /healthz` returning `{"status":"ok"}` with HTTP 200.
Acceptance: a passing test that asserts the status code and body.
```

`WORKFLOW.md`:

```md
You implement one board issue per run.

1. Call `tracker_read_issue` with the dispatched issue id to load the
   title, description, and any prior comments. On a continuation turn,
   the comments are your record of what you already did.
2. Make the change in the workspace and run the tests.
3. Call `tracker_comment` to record what you did and any follow-ups.
4. Call `tracker_update_status` to move the issue to `In Review` when
   the work is ready, or back to `Todo` if you are blocked.
5. If you find unrelated work, call `tracker_create_issue` to file a
   new board issue instead of expanding this one.
```

On dispatch, Lorenz polls the board, finds `BOARD-1.md` in `Todo` (an active state), and starts a
run. The agent reads the issue, implements the endpoint, appends a comment, and moves the status to
`In Review`. The status write lands back in `BOARD-1.md`, and the next poll sees the new state.

## See also

- [index.md](index.md) - how trackers plug in, the shared read surface, and the neutral tool pack.
- [memory.md](memory.md) - the in-process fixture tracker for tests and dry runs.
- [reference/tracker-tools.md](../reference/tracker-tools.md) - exact schemas for the `tracker_*`
  tools and the query DSL grammar.
- [reference/configuration.md](../reference/configuration.md) - the full `tracker.*` and
  `trackers.*` key reference.
- [getting-started.md](../getting-started.md) - a first run, including the local board path.
- [extensions/tracker-provider.md](../extensions/tracker-provider.md) - build a new tracker backend.
