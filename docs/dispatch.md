# Dispatch

How Lorenz decides what to run and when. This is the operator's mental model and a mini-spec: it walks the eligibility chain, the deterministic ordering rule, route gating, concurrency caps, retry backoff, and the lifecycle of one dispatch slot. Every behavior traces to a policy package or a sandbox invariant. For the surrounding poll/reconcile loop and the in-memory scheduling state, see [agent-orchestrator.md](agent-orchestrator.md).

## The decision in one line

On each poll, the runtime fetches candidate issues, sorts them, and asks three questions of each: is this issue eligible, is there capacity, and is there a free ensemble slot to claim. An issue that passes all three dispatches as one agent run. Everything below is the precise form of those three questions.

The math lives in two pure packages. `@lorenz/dispatch` decides eligibility, route gating, concurrency blocks, slot selection, and sort order. `@lorenz/policies` holds the retry backoff and worker-host selection. Neither package touches the network, the clock, or any mutable runtime state. They take an `Issue`, the workflow `Settings`, and a small plain-object snapshot of running counts, then return a verdict. The stateful wiring lives in `@lorenz/orchestrator` and `@lorenz/runtime`.

## Eligibility: the full chain

`shouldDispatchIssue` in `packages/dispatch/src/index.ts` runs the checks in a fixed order and short-circuits on the first failure. Order matters: earlier checks classify the issue, and later checks assume a well-formed, active, routed issue.

<p align="center"><img src="assets/diagrams/dispatch-eligibility.svg" alt="dispatch eligibility diagram" width="720" style="width:100%;max-width:720px;height:auto" /></p>
*The dispatch eligibility decision tree, evaluated top to bottom; the first failing gate makes the issue ineligible.*

1. **Required fields.** If `issue.id`, `issue.identifier`, `issue.title`, or `issue.state` is missing, the issue is ineligible. A malformed record never dispatches.
2. **Active state.** `issueIsActive` requires the state to be in `tracker.active_states` (default `['Todo', 'In Progress']`) and not in `tracker.terminal_states` (default `['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done']`). Comparison is case-insensitive and trims whitespace. Terminal wins: a state that appears in both lists is treated as inactive.
3. **Routed to this worker.** `routedToThisWorker` gates on the assignee and route labels (detailed below).
4. **Blockers.** `issueHasOpenBlockers` applies only when `issue.stateType === 'unstarted'`. An unstarted issue with any non-terminal blocker is ineligible. Once an issue is started, its blockers are ignored for dispatch gating.
5. **Concurrency caps.** Global, then per-state, then per-host (detailed below).
6. **Free ensemble slot.** The issue needs at least one unclaimed slot. Slot count is `ensemble:<n>` label if present and valid, else `agent.ensemble_size` (default `1`). If every slot key `${issueId}:${slotIndex}` is already claimed, the issue is ineligible.

One load-bearing distinction: `dispatchBlockReason` returns a capacity reason (`global_concurrency_cap`, `local_concurrency_cap`, `worker_host_capacity`) **only** for an issue that is otherwise eligible. An issue that fails required-fields, active-state, routing, or blocker checks gets `null`, not a reason. Callers read `null` as "not eligible at all," not "eligible but capacity-blocked." Only capacity blocks surface in the `dispatch_skipped` event with a reason.

## Routing

Route gating decides whether *this* Lorenz instance owns an issue. It runs after the assignee filter and reads `tracker.dispatch`.

<p align="center"><img src="assets/diagrams/routing-decision.svg" alt="routing decision diagram" width="720" style="width:100%;max-width:720px;height:auto" /></p>
*`routedToThisWorker`: the assignee gate, then route-label parsing, then the `accept_unrouted` and `only_routes` branches.*

The logic in `routedToThisWorker`:

- **Assignee.** If `issue.assignedToWorker === false`, the issue is not this worker's and routing returns `false` immediately. The assignee match comes from `tracker.assignee` (and the tracker's own assignee resolution).
- **Route labels.** A route label is any issue label whose lowercased text starts with `tracker.dispatch.route_label_prefix` (default `Lorenz:`, trailing colon included). The prefix match is case-insensitive. `routeNames` strips the prefix, normalizes the remainder (trim + lowercase), and drops any route that is empty after stripping.
- **No route labels at all.** Fall back to `tracker.dispatch.accept_unrouted` (default `true`). Under the default, an unlabeled issue is accepted.
- **Has a route label but nothing parses.** A prefixed label whose every route is whitespace-only after stripping counts as routed-but-invalid and is rejected.
- **`only_routes === null`** (the default): accept any routed issue.
- **`only_routes === []`**: reject every routed issue.
- **`only_routes` is a non-empty list**: accept only if the issue's normalized routes intersect the normalized allowlist.

So a worker that should pick up everything leaves `only_routes` null and `accept_unrouted` true. A worker dedicated to one shard sets `only_routes: ['shard-a']` and the operators label issues `Lorenz:shard-a`.

```yaml
tracker:
  assignee: lorenz-bot
  dispatch:
    route_label_prefix: "Lorenz:"
    accept_unrouted: false
    only_routes: ["shard-a"]
```

## Concurrency caps

Three caps are checked in order. The first one that is at its limit blocks dispatch and names the `DispatchBlockReason`.

| Reason | Source key | Check |
|---|---|---|
| `global_concurrency_cap` | `agent.max_concurrent_agents` (default `10`) | `runningCount >= cap` |
| `local_concurrency_cap` | `status_overrides[state].agent.max_concurrent_agents` | per-state running count `>= cap` |
| `worker_host_capacity` | `worker.ssh_hosts`, `worker.max_concurrent_agents_per_host` | no host under its cap |

Two details to keep straight:

- **Reserved slots count.** The running count the caps see is `occupiedSlotCount = running.size + reserved.size`. A slot reserved during a pool acquire window consumes capacity against every cap, so dispatch cannot overshoot `max_concurrent_agents` mid-acquire. See [agent-orchestrator.md](agent-orchestrator.md) for the two-phase reserve/bind path.
- **Per-state caps come from `status_overrides`.** There is no dedicated per-state cap field. `settingsForIssueState(settings, issue.state)` looks up the issue's state in the `status_overrides` map and returns a merged `Settings`; the merged `agent.max_concurrent_agents` is the per-state cap. The same override mechanism can change the agent kind and `max_retry_backoff_ms` per state.

```yaml
agent:
  max_concurrent_agents: 10
status_overrides:
  "In Progress":
    agent:
      max_concurrent_agents: 4
```

Per-host capacity uses `worker.max_concurrent_agents_per_host`, which falls back to `agent.max_concurrent_agents` when unset. With an empty `worker.ssh_hosts`, work runs locally and the per-host check passes. When a worker pool governs capacity, the pool's own probe answers the capacity question instead. A disabled-but-present pool reports that it does not govern, so dispatch falls back to the static/local path rather than blocking forever as `worker_host_capacity`.

## Deterministic ordering

Before eligibility filtering, candidates are sorted by `sortForDispatch`. The order is total and deterministic, which the `Dispatch Ordering` invariants in `sandbox/INVARIANTS.md` pin exactly:

1. **Priority ascending.** Lower priority number sorts first. Null, missing, or out-of-range priority sorts last (`Number.MAX_SAFE_INTEGER`).
2. **Created-at ascending.** Within a priority group, the earlier creation time sorts first. Null, empty, or unparseable `createdAt` sorts last within its group.
3. **Identifier.** As the final tie-break, `identifier.localeCompare` breaks remaining ties lexicographically.

The sort is a pure permutation: no issue is added or dropped. The same candidate set always produces the same dispatch order, which is what makes sandbox conformance tests reproducible.

## Retries and backoff

Every run schedules a retry when it finishes. Two kinds exist, with different delays. The math is `retryBackoffMs` in `packages/policies/src/retry.ts`.

<p align="center"><img src="assets/diagrams/retry-backoff.svg" alt="retry backoff diagram" width="720" style="width:100%;max-width:720px;height:auto" /></p>
*Continuation retries use a fixed short delay; failure retries grow exponentially until they hit `max_retry_backoff_ms`.*

- **Continuation** (a clean worker exit, ready to continue the issue): fixed `1000ms` (`MIN_RETRY_DELAY_MS`), regardless of attempt number. Attempt is pinned to 1.
- **Failure** (an abnormal exit): `min(maxRetryBackoffMs, 10000 * 2 ** (attempt - 1))`. Attempt 1 is `10s`, attempt 2 is `20s`, attempt 3 is `40s`, doubling until it caps at `agent.max_retry_backoff_ms` (default `300000`, five minutes). The failure attempt counter is `previous + 1`.

The delay is monotonically non-decreasing with attempt number, never negative, and never above the cap.

This subsystem has no rate-limit-driven backoff. Backoff is purely exponential on the attempt count. Rate-limit data on agent updates is captured for display in the snapshot only and does not change retry timing; Lorenz does not adjust backoff from a `Retry-After` header or a 429 response.

A retry's deadline carries a monotonic `monotonicDeadlineMs` (the authoritative due check) alongside a wall-clock `dueAtIso` for display. `RetryScheduler` arms a per-issue timer that fires `RETRY_SCHEDULER_SYNC_DELAY_MS` (`5ms`) after the deadline, nudging a poll. The 5ms guard fires the timer slightly late on purpose, so the issue is genuinely due by the time `sortForDispatch` reconsiders it (the `setTimeout` clock and the monotonic clock can skew by ~1ms). Timers are `unref`'d, so they never keep the process alive.

## The dispatch-slot lifecycle

A single slot (one `${issueId}:${slotIndex}` pair) moves through a small state machine - unclaimed to claimed/reserved to running to finished, then a continuation or failure retry back to eligible. The dispatch package answers only whether a transition is allowed; the orchestrator owns the transitions, the ABA-token reservation guard, the two-phase reserve/bind pool path, and `preferredSlotIndex` slot affinity across retries. See the slot-lifecycle state machine in [agent-orchestrator.md](agent-orchestrator.md).

One detail that stays here because it is dispatch math: a capacity miss during the reserve window cancels the reservation without applying backoff and restores the consumed retry entry, so the attempt counter and slot affinity survive a transient capacity shortfall.

## Reconciliation

Starting work is half the loop; reconciliation stops work that should no longer run by re-checking `issueIsActive`, `routedToThisWorker`, and `issueHasOpenBlockers` per tracked issue and stopping any run that has gone terminal, unrouted, blocked, or inactive. The full reconciliation pass, the stop-reason classifier, and the poll-tick order live in [agent-orchestrator.md](agent-orchestrator.md).

## Pure versus stateful split

Keep the package boundary in mind when tracing behavior:

- `@lorenz/dispatch` and `@lorenz/policies` are **pure**. Given the same inputs, they return the same verdict. No I/O, no clock reads, no mutation. This is what the deterministic sandbox exercises.
- `@lorenz/orchestrator`, `@lorenz/runtime`, and `@lorenz/retry-scheduler` are **stateful**. They hold the in-memory scheduling state, drive timers, talk to trackers and workers, and call the pure functions to make decisions.

When a dispatch decision looks wrong, ask first whether the pure verdict is wrong (a config or eligibility issue) or whether the wiring fed it the wrong state (a runtime issue).

## See also

- [agent-orchestrator.md](agent-orchestrator.md) - the poll loop, scheduling state, two-phase pool dispatch, and reconciliation pass
- [features/dispatch-routing.md](features/dispatch-routing.md) - route labels and sharding work across instances
- [features/context-ensembles.md](features/context-ensembles.md) - running multiple slots per issue
- [reference/configuration.md](reference/configuration.md) - every dispatch, agent, and worker config key with defaults
- [reference/events.md](reference/events.md) - `dispatch_skipped`, `run_started`, `retry_timer_due`, and the rest of the event vocabulary
