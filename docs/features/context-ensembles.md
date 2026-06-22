# Context ensembles

A context ensemble runs several independent agents against one issue at the same time, each in its own workspace. Use it when you want parallel attempts at a single problem - different agents explore different paths, and you pick the result you like. This page is for operators: it covers how to turn ensembles on, where the per-slot workspaces land, what the prompt template sees, and the exact rules that decide how many slots an issue gets.

## What an ensemble is

By default Lorenz dispatches one agent run per issue. An ensemble raises that to `n` runs for the same issue, dispatched and tracked as `n` separate slots. The slots are fully independent: each claims its own slot key, gets its own workspace, runs its own turn loop, retries on its own schedule, and finishes on its own. Lorenz does not merge or rank the slots' output. You read the results across slots and choose.

Slots are indexed `0` to `size - 1`. The orchestrator keys every per-slot piece of state by `slotKey(issueId, slotIndex)`, which is the string `` `${issueId}:${slotIndex}` ``. Retry attempts are keyed by slot key too, so each slot retries independently of the others.

## Turning it on

Set the default ensemble size in `WORKFLOW.md` front matter:

```yaml
agent:
  ensemble_size: 3
```

`agent.ensemble_size` defaults to `1` (no ensemble). With the value above, every dispatched issue runs across three slots.

To set the size per issue instead, add a label `ensemble:<n>` to the issue in your tracker:

```text
ensemble:4
```

The label wins over the workflow default for that issue. An issue labeled `ensemble:4` runs four slots even when `agent.ensemble_size` is `1`, and an issue with no ensemble label falls back to `agent.ensemble_size`.

## How the size resolves

The resolved size for an issue is the first valid `ensemble:<n>` label, otherwise `agent.ensemble_size`. The rules, taken from the ensemble-resolution invariants:

- A valid label is `ensemble:<n>` where `<n>` is an integer in the range `1` to `100` (`ENSEMBLE_SIZE_MAX`). Matching is case-insensitive and whitespace-insensitive: the label is trimmed and lower-cased before the regex `^ensemble:(\d+)$` runs.
- When several valid ensemble labels are present, the first one encountered wins.
- A label specifying zero, a negative integer, a value above `100`, or a non-numeric value (`ensemble:0`, `ensemble:abc`) is ignored, and the issue falls back to the configured `agent.ensemble_size`.
- When no valid ensemble label is present, the configured default applies.

So `ensemble:0` and `ensemble:abc` both behave as if no label were set. The fallback default for a stock workflow is `1`, meaning a single slot.

## Per-slot workspaces

Each slot gets a distinct workspace directory so the agents never collide on files. The layout is:

| Run | Workspace path |
| --- | --- |
| Solo run (resolved size 1) | `<root>/<safe-identifier>` |
| Ensemble (resolved size > 1) | `<root>/<safe-identifier>/<slotIndex>` |

The slot index is appended only when the resolved ensemble size is greater than `1`. A solo run gets the bare `<root>/<safe-identifier>` with no slot suffix. `<root>` is `workspace.root`; `<safe-identifier>` is the issue identifier with every character outside `[A-Za-z0-9_.-]` replaced by `_`. See [workspace.md](../workspace.md) for the full path-resolution and sanitization rules.

Each slot's workspace runs the same lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`) as any other workspace, independently per slot.

There is one other case that appends a slot suffix: `forceSlotSuffix`, which the runtime sets when `worker.worker_pool.max_in_flight` (the pool's slots-per-machine count) is greater than `1`. Multiple run slots per machine mean two solo runs of the same issue could land on one worker, so the runtime appends `/<slotIndex>` even for a resolved size of `1` and the two slots never share the bare path. Running more than one slot per machine requires the explicit `worker.worker_pool.co_residence` opt-in: the dispatch gate rejects `max_in_flight > 1` until co-residence is enabled, because a poisoned worker on a shared machine fails every co-resident run on recycle. Both keys are worker-pool concerns; see [workers/worker-pool.md](../workers/worker-pool.md).

## What the prompt template sees

Every prompt render receives an `ensemble` object alongside `issue` and `attempt`. Its fields are snake_case because template authors reference them directly:

| Field | Type | Meaning |
| --- | --- | --- |
| `ensemble.enabled` | boolean | `true` only when the resolved size is greater than `1` |
| `ensemble.slot_index` | number | Zero-based index of this slot, in `[0, size)` |
| `ensemble.size` | number | Resolved slot count for the issue, at least `1` |

A solo run still gets an `ensemble` object: `enabled` is `false`, `slot_index` is `0`, `size` is `1`.

Use these to give each slot a different instruction so the parallel attempts diverge instead of duplicating each other:

```md
{% if ensemble.enabled %}
You are agent {{ ensemble.slot_index }} of {{ ensemble.size }} working on this issue in parallel.
Other agents are attempting the same task independently. Take an approach that differs from the obvious one,
and commit on a branch named for your slot so your work does not collide with the others.
{% endif %}

Issue {{ issue.identifier }}: {{ issue.title }}
```

The prompt engine runs with `strictVariables` and `strictFilters`, so a reference to an undefined field raises an error instead of rendering empty. The full variable reference is in [reference/workflow-prompt.md](../reference/workflow-prompt.md).

The same fields surface on the dashboards. Each running and history entry carries its `slot_index`, so the TUI, web UI, and HTTP snapshot show every running and finished slot of an issue as its own row. The retrying lane keys its rows by issue and attempt rather than slot, so the HTTP snapshot does not distinguish retrying rows by `slot_index`.

## Slot claiming and dispatch

Ensembles change the eligibility question dispatch asks per issue. An issue is dispatchable only while it has at least one unclaimed slot. On each poll, after an issue passes the active, routed, unblocked, and concurrency checks, dispatch resolves the size and looks for a free slot:

- The free-slot check scans `0` to `size - 1` and returns the first slot whose `slotKey(issueId, slotIndex)` is not already claimed.
- When every slot key is claimed, the issue is ineligible this tick. It becomes eligible again as slots finish and free up.

Slots claim one at a time across polls and as capacity frees, not all at once. With `ensemble:3` and `agent.max_concurrent_agents` set to `2`, at most two slots of the issue run concurrently; the third waits for a free concurrency slot. Reserved (in-acquire) slots count toward concurrency caps too. The full eligibility and capacity model is in [dispatch.md](../dispatch.md).

Retries keep slot affinity. A retried run prefers to reclaim its previous `slotIndex` (`preferredSlotIndex`) when that slot is free, so a slot that fails and retries stays on the same index and workspace across attempts.

A fairness cap is available on the worker pool: `worker.worker_pool.max_workers_per_issue` limits how many pool workers one issue's slots may hold at once, so a large ensemble cannot starve other issues of workers.

## When to use it

Reach for an ensemble when one issue benefits from several independent shots:

- Open-ended or ambiguous tasks where the first approach might be wrong and you want alternatives to compare.
- High-value changes where you would rather review three attempts and merge the best than accept the only one.
- Tasks whose quality varies run to run, where the best of `n` attempts beats a single attempt.

Skip it for routine, well-specified work: the extra slots multiply token spend and worker load for no gain when one attempt reliably solves the issue. Each slot is a full agent run with its own usage, so an `ensemble:4` issue costs roughly four times a solo run.

## See also
- [workspace.md](../workspace.md) - per-issue and per-slot workspace paths, sanitization, and hooks
- [dispatch.md](../dispatch.md) - eligibility, slot claiming, concurrency caps, and retry affinity
- [reference/workflow-prompt.md](../reference/workflow-prompt.md) - the full `issue` / `attempt` / `ensemble` variable reference
- [workers/worker-pool.md](../workers/worker-pool.md) - co-residence and the per-issue worker fairness cap
