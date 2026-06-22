# Memory tracker

The `memory` tracker is an in-process fixture. Its issues come from one environment variable, it
talks to no network, and it exposes no agent tools. Reach for it when you want to exercise the
dispatch loop in a test or a `--dry-run` without standing up Linear, Jira, or a Markdown board. This
page is for operators and contributors who need a tracker that is fully under their control.

It is not a production tracker. There is no persistence, no comment write-back, and no status the
agents can change from inside a run. Treat it as a seam for testing, not a place to track real work.

## What it does

`memory` registers a `TrackerProvider` whose `kind` is `memory`, defined in
`extensions/memory-tracker/src/index.ts`. At startup `registerMemoryTracker` wires it into the
tracker registry; `registerBuiltinBackends` in `apps/cli/src/daemon.ts` calls that registration
alongside the other builtins. The provider builds a `MemoryTrackerClient`, and that client serves
the same `RuntimeTrackerClient` methods every backend serves: `fetchCandidateIssues`,
`fetchIssuesByIds`, and `fetchIssuesByStates`. The poll loop cannot tell the difference between this
and a real tracker, which is the point.

The issue set is fixed for the lifetime of the process. The client reads it once from the
environment when it is constructed, then answers every poll from that in-memory list. One
write path exists: `updateIssue(id, fields)` mutates `state` and `stateType` in place, which the
runtime uses to advance an issue's state during a test. There is no comment storage and no file on
disk.

`memory` accepts no options. Its `parseOptions` calls `rejectUnknownOptions(options, [], "memory")`,
so any key under the bundle is rejected at parse time with
`unsupported tracker option(s) for kind "memory": <key>`. The only input is the env var.

## Configuration

Select it like any other tracker. The bundle needs nothing beyond `provider: memory`.

```yaml
tracker:
  kind: fixture
trackers:
  fixture:
    provider: memory
```

The two core read keys still apply, since they live on `tracker`, not on the provider.
`tracker.active_states` scopes which states `fetchCandidateIssues` would feed to dispatch, and
`tracker.terminal_states` marks finished states for workspace cleanup. The memory client returns
its full issue list from `fetchCandidateIssues` and filters by state only in `fetchIssuesByStates`,
so the active-state gate is applied by the downstream dispatch chain. See
[../dispatch.md](../dispatch.md) for that chain and [index.md](index.md) for the shared read surface.

## The issue env var

The issue list is JSON read from `LORENZ_MEMORY_TRACKER_ISSUES_JSON`. If that variable is unset or
empty, `memoryIssuesFromEnv` falls back to `LORENZ_MEMORY_TRACKER_ISSUES`. When neither is set the
list is empty and every poll returns no candidates.

The value must be a JSON array. A non-array parses to the error
`LORENZ_MEMORY_TRACKER_ISSUES_JSON must be a JSON array`. A non-object entry at index `n` throws
`memory tracker issue <n> must be an object`. Each entry is run through `normalizeIssue`, so it must
carry the fields a domain `Issue` needs:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Tracker-internal primary key, used everywhere. |
| `identifier` | yes | Human-facing short code (for example `ENG-1`). |
| `title` | yes | Issue title. |
| `state` | yes | Display name of the workflow state (for example `Todo`). Empty or missing throws `issue.state is required`. |
| `stateType` | yes | Category bucket. Resolves from `stateType`, `state_type`, or `state.type`, and the value must already be one of the six category names below. The `state` display name does not map to a `stateType` on this path, so supply it explicitly. Unresolvable throws `issue.stateType is required`. |
| `labels` | no | Array of label names, lower-cased on load. `ensemble:<n>` here sets ensemble size. |
| `description`, `url`, `priority`, `blockers` | no | Carried through if present. |

`stateType` must be one of `backlog`, `unstarted`, `started`, `completed`, `canceled`, or `triage`.

A minimal two-issue fixture:

```sh
export LORENZ_MEMORY_TRACKER_ISSUES_JSON='[
  {"id":"1","identifier":"ENG-1","title":"Fix the flaky test","state":"Todo","stateType":"unstarted","labels":["bug"]},
  {"id":"2","identifier":"ENG-2","title":"Update the README","state":"In Progress","stateType":"started"}
]'
```

## A dry run

`--dry-run` evaluates candidates without dispatching agents. Paired with `memory`, it shows you
exactly which issues the poll would pick up, against a tracker you fully control.

```sh
LORENZ_MEMORY_TRACKER_ISSUES_JSON='[
  {"id":"1","identifier":"ENG-1","title":"Fix the flaky test","state":"Todo","stateType":"unstarted"}
]' \
  lorenz run --dry-run
```

The runtime polls the fixture, runs the eligibility chain, and reports the candidates without
starting a worker or touching a workspace. Add `--once` to poll a single time and exit. See
[../cli.md](../cli.md) for the full flag set.

## Behavior worth knowing

- Every fetch returns deep copies. `fetchCandidateIssues`, `fetchIssuesByIds`, and
  `fetchIssuesByStates` clone each issue (including its `labels` and `blockers`), so a caller cannot
  mutate the fixture's internal state by editing a returned issue.
- `fetchIssuesByIds(ids)` matches an issue by `id` or by `identifier`, mirroring the Linear and Jira
  clients so workspace cleanup can look an issue up by either.
- `fetchIssuesByStates(states)` compares case-insensitively after trimming, so `todo` and `Todo`
  match the same issue.
- No agent tools. `memory` registers no `ToolProvider`, and it declares no `defaultToolPacks`. The
  provider-neutral `tracker` pack advertises zero tools for it, because `memory` has no
  `createToolOps`. An agent in a `memory` run has the issue context but no tracker tool to write
  back.

## See also

- [index.md](index.md) - how trackers are selected and the read surface they share.
- [local.md](local.md) - the filesystem Markdown board, for a no-network tracker that persists.
- [../cli.md](../cli.md) - `lorenz run`, `--dry-run`, and `--once`.
- [../dispatch.md](../dispatch.md) - the eligibility chain that consumes poll candidates.
- [../reference/configuration.md](../reference/configuration.md) - the full `tracker.*` and
  `trackers.*` key reference.
