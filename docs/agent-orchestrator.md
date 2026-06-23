# Agent orchestrator and runtime

Contributor reference for the control-plane core: how Lorenz schedules work. It covers the single authoritative scheduling state, the poll loop that drives it, the slot lifecycle, two-phase pool-governed dispatch, the reconciliation passes, and how the live `RuntimeSnapshot` is assembled. The default claim store is in-memory; explicit durable stores add restart recovery for retry state and claim ownership. For the eligibility, sort, and backoff math, see [dispatch.md](dispatch.md); for what an agent run does once dispatched, see [agents/acp-bridges.md](agents/acp-bridges.md).

## The two halves and one source of truth

The control plane splits across four packages with one rule between them.

- `@lorenz/orchestrator` owns the single authoritative `OrchestratorState` and is the only component that mutates scheduling state. It decides eligibility, claims slots, reserves pool-governed slots, applies agent updates, finishes runs, schedules retries, and reconciles in-memory state against fresh issues.
- `@lorenz/runtime` (`LorenzRuntime`) drives the recurring poll loop, dispatches each eligible issue as a detached per-run promise, runs the reconciliation passes, reloads workflow config transactionally, and assembles the snapshot.
- `@lorenz/projections` (`ProjectionActor`) is an in-memory ring buffer: the last 20 events and the last 50 run-history entries, merged with the live orchestrator and runtime fields into the final `RuntimeSnapshot`.
- `@lorenz/runtime-events` is a pure type and constant package: the snapshot shape, the `RUNTIME_EVENT_TYPES` vocabulary, and `RUNTIME_RUN_OUTCOMES`.

The orchestrator is a state machine with no I/O; the runtime is the I/O shell that calls into it. Every scheduling decision belongs to the orchestrator. Every fetch, spawn, timer, and broadcast belongs to the runtime.

## OrchestratorState: the authoritative view

`createState()` in `packages/orchestrator/src/index.ts` builds one object that holds everything in flight. The `Orchestrator` is the sole writer.

| Field | Type | Holds |
|---|---|---|
| `running` | `Map<string, RunningEntry>` | Bound, executing runs, keyed by `slotKey` (`${issueId}:${slotIndex}`). |
| `reserved` | `Map<string, ReservationRecord>` | Pool-governed slots mid-acquire, host-less, keyed by `slotKey`. |
| `claimed` | `Set<string>` | Every `slotKey` that is running or reserved. The claim guard for slot selection. |
| `retryAttempts` | `Map<string, RetryEntry>` | Pending retries keyed by `slotKey`, carrying attempt count, kind, and the monotonic deadline. |
| `completed` | `Set<string>` | Issue ids that have finished at least one run cleanly this process. |
| `usageTotals` | usage record | Session-cumulative token and cost accounting. |
| `rateLimits` | `unknown` | Last-seen rate-limit payload, surfaced for display only. It does not influence retry timing. |
| `blockedDispatches` | array | The capacity-blocked issues from the last eligibility sweep, surfaced as the snapshot `blocked` lane. |

Two details trip up readers matching the code against the spec. `claimed` contains running **and** reserved keys, not retrying ones. `retryAttempts` is keyed by `slotKey`, not by bare issue id, so each ensemble slot retries independently.

## The poll loop

`LorenzRuntime.start(options)` runs one of two modes. In once mode (a single tick or a `--dry-run`) it calls `pollOnce({ dryRun, waitForRuns: true })` and returns when every dispatched run settles. In recurring mode it loops `pollOnce({ dryRun })`, swallows any thrown poll error (already recorded as a `poll_error` event), then `delay(polling.interval_ms)` until stopped. The default interval is `30000` ms, and `nextPollAt` is computed as the current time plus that interval.

Each tick runs `pollOnceUnlocked` in a fixed order:

<p align="center"><img src="assets/diagrams/poll-tick.svg" alt="poll tick diagram" width="720" style="width:100%;max-width:720px;height:auto" /></p>
*One poll tick: reload and validate config, run startup and reconciliation passes, fetch candidates, compute eligibility, then dispatch each eligible issue.*

1. `reloadWorkflowIfConfigured` - transactional workflow reload (below).
2. `validateDispatch(settings)` - dispatch-config preflight. If this throws, the whole poll aborts in the catch as a `poll_error` and nothing else runs that tick.
3. `cleanupTerminalWorkspacesOnce` - startup workspace cleanup, guarded to run once.
4. `reconcileStalledRuns` - stall detection (Part A).
5. `reconcileTrackedIssues` - tracker state refresh (Part B).
6. `client.fetchCandidateIssues` - pull the candidate set from the tracker.
7. `orchestrator.eligibleIssues(issues)` - sort and filter.
8. `syncRetryTimersForIssues` - arm retry timers (skipped on dry-run).
9. dispatch each eligible issue, or emit `dry_run` for it.
10. if `waitForRuns`, await every dispatched run.

Validation runs **before** reconciliation. A failed `validateDispatch` aborts the tick, so reconciliation does not run that poll.

Polls serialize. `pollOnce` guards on `pollInProgress`; a concurrent call queues via `queuePendingPoll` and its intent is merged with `mergePollOptions` (`dryRun` AND-ed, `waitForRuns` OR-ed). `pollUntilQueueDrained` re-runs until nothing is pending. When the coordinator signals freed capacity through `onCapacityAvailable`, `nudgePollForFreedCapacity` queues a forced follow-up poll on a microtask so a just-released slot is filled without waiting a full interval.

## Each run is a detached promise

A dispatched run does not block the poll. `maybeDispatch` wraps every run in an `ActiveRunHandle` keyed by `slotKey`, carrying an `AbortController` and an optional `reason` (such as `'stalled'`). The handle is registered for the whole lifecycle, including the reserved acquire window, so `stop()` and reconciliation can abort a run that is still acquiring a worker. The promise is tracked in `inFlight` and runs on its own; `handle.isActive` guards against recording a result for a run that was superseded or finished externally.

`stop()` is synchronous. It flips `stopped`, sets `appStatus` to `stopping`, clears pending polls, and calls `finishExternally()` on every active handle so an `agent_run_aborted` is treated as a clean shutdown rather than a failed run. It then stops the retry scheduler and emits. `drainWorkerPool()` is the separate async teardown for paid workers, called by the daemon's `finally` after `start()` resolves, bounded by `worker.worker_pool.drain_deadline_ms` (default `30000`).

## The slot lifecycle

A dispatch slot moves through a small state machine. The orchestrator owns every transition.

<p align="center"><img src="assets/diagrams/slot-state-machine.svg" alt="slot state machine diagram" width="720" style="width:100%;max-width:720px;height:auto" /></p>
*A slot's lifecycle: unclaimed to claimed/reserved to running to finished, then a continuation or failure retry that makes the issue eligible again. Reservation expiry and the ABA token guard branch off the reserved state.*

- **Unclaimed.** No entry in `claimed` for this `slotKey`. `firstUnclaimedSlot` will select it, honoring `preferredSlotIndex` so a retry reuses its original slot.
- **Claimed / reserved.** On the pool-governed path, `claim()` returns `{ kind: 'reserved', reservation }`. The slot is in `claimed` and `reserved` but has no host yet. On the static/local path, `claim()` mints a `RunningEntry` immediately and the slot goes straight to running.
- **Running.** A bound `RunningEntry` in `running`. Agent updates flow through `applyUpdate(issueId, slotIndex, update)`, refreshing `lastAgentTimestamp` and usage.
- **Finished.** `finish(issueId, slotIndex, normal, error?, retryKind)` removes the running and claimed entries, adds `secondsRunning`, marks the issue `completed`, and **always** schedules a retry.
- **Retry pending.** A `RetryEntry` in `retryAttempts`. The slot is eligible again only once its monotonic deadline passes.

`finish` always writes a retry. A clean exit writes a `continuation` retry (attempt fixed to `1`); a fault writes a `failure` retry (attempt = previous + 1). The continuation retry is written even if the issue is now inactive; `eligibleIssues` prunes it later via `cleanupRetryAttempts` if the issue is no longer active. Continuation backoff is a fixed `1000` ms; failure backoff is `10000 * 2^(attempt - 1)` capped at `agent.max_retry_backoff_ms` (default `300000`). The backoff math lives in `@lorenz/policies` and is detailed in [dispatch.md](dispatch.md).

## Two-phase pool-governed dispatch

When a live worker pool governs capacity, dispatch is two-phase so a reservation holds a concurrency slot while the coordinator finds a real host. The orchestrator's capacity authority is a `CapacityProbe`; the coordinator implements it.

<p align="center"><img src="assets/diagrams/two-phase-dispatch.svg" alt="two phase dispatch diagram" width="860" style="width:100%;max-width:860px;height:auto" /></p>
*Pool-governed dispatch: claim a host-less reservation, acquire a run slot from the coordinator, then bind the host or cancel the reservation.*

The phases:

1. **Claim (reserved).** `claim()` sees `capacityProbe.governs()` is true and returns `{ kind: 'reserved', reservation }`. The slot is claimed and reserved, host-less. The runtime emits `run_reserving`.
2. **Acquire.** `runReservedClaim()` awaits `coordinator.acquireRunSlot`. The result is `{ status: 'bound', slot }` or `{ status: 'no_capacity', reason }`.
3. **Bind or cancel.**
   - On `bound`: `bindReservation(reservation, host)` upgrades the `ReservationRecord` to a `RunningEntry` and the runtime emits `run_started`.
   - On `no_capacity`: `cancelReservation(reservation)` releases the slot with **no backoff** and restores the consumed `RetryEntry`, so the issue's slot affinity and attempt counter survive a capacity miss. The runtime emits `dispatch_skipped` with reason `worker_host_capacity`.
   - On an acquire throw: the runtime emits `dispatch_skipped` with reason `worker_pool_acquire_error <message>`.

The static/local path skips all of this. With no governing pool, `claim()` mints the `RunningEntry` synchronously, picks the least-loaded host with `selectWorkerHost` over `worker.ssh_hosts` (honoring `worker.max_concurrent_agents_per_host`), and emits `run_started` at once. Empty `ssh_hosts` means a local run.

Reserved slots count toward capacity. `occupiedSlotCount = running.size + reserved.size`, and that count feeds both the global cap and every per-state cap, so dispatch cannot exceed `agent.max_concurrent_agents` during acquire windows.

A disabled-but-present pool keeps its `CapacityProbe` installed, but `governs()` returns `false`, so `claim()` and `workerCapacityAvailable()` fall through to the static/local path. A disabled pool never permanently blocks dispatch as `worker_host_capacity`.

### ABA and expiry guards

A reservation carries a token, and that token is an ABA guard. `bindReservation` and `cancelReservation` are no-ops on a token mismatch, so a stale acquire that resolves after its reservation was already swept cannot resurrect or corrupt a newer slot. Every reservation also has a defensive expiry of `acquire_timeout_ms * 2 + 60000` ms (`acquire_timeout_ms` default `30000`). `eligibleIssues` sweeps expired reservations at the top of each eligibility pass through `sweepExpiredReservations`, and the sweep cancels them with the same retry-restore as a `no_capacity` cancel, so a hung acquire does not hold a concurrency slot forever.

## Reconciliation

Two passes run every tick before the candidate fetch, plus a one-time startup pass. They reconcile in-memory state against the tracker and clean up the filesystem.

### Stall detection (Part A)

`reconcileStalledRuns` walks each `RunningEntry`. Elapsed time is measured from `lastAgentTimestamp ?? startedAt`. If elapsed exceeds the effective `agents.<kind>.stall_timeout_ms` (default `300000`, and stall detection is disabled when the value is `<= 0`), the run is treated as stalled: `finish()` records it as a failure, run history records the `stalled` outcome, and `handle.finishExternally('stalled')` aborts the run and forces the worker into poison. The runtime emits `run_stalled`.

A stall-finished run poisons its worker even if the underlying runner resolves successfully, because `handle.reason === 'stalled'` forces poison before the slot settles. `classifyWorkerOutcome` alone would otherwise mis-read an `agent_run_aborted` as healthy.

### Tracker state refresh (Part B)

`reconcileTrackedIssues` collects the issue ids that are reserving, running, or retrying and refetches just those from the tracker. Per issue it decides:

- **Active, routed to this worker, no open blockers.** `refreshRunningIssue(issue)` updates the in-memory state and emits `run_reconciled`. The run continues.
- **Otherwise.** `abortIssueRuns` + `cleanupIssue(issueId)` + clear the retry timer. The run stops.
  - If the issue is in a terminal state, `removeIssueWorkspaces` runs and the runtime emits `workspace_cleanup`.
  - Otherwise it emits `run_reconciled`.
- **Missing from the refetch.** Reconciled as `missing`, treated the same as ineligible.

`reconciliationStopReason` in `packages/policies/src/reconciliation.ts` classifies why a tracked run was stopped, returning one of `terminal`, `unrouted`, `blocked`, or `inactive`. A failed refetch emits `reconcile_refresh_failed` and keeps everything running; reconciliation never tears down a live run on a transient tracker error.

The per-issue decision tree:

```text
refetch tracked issue
├─ missing from result        -> abort + cleanup ('missing')
├─ active + routed + unblocked -> refreshRunningIssue (run continues)
└─ else                        -> abort + cleanup
                                   ├─ terminal state -> removeIssueWorkspaces + workspace_cleanup
                                   └─ else           -> run_reconciled
```

### Terminal workspace cleanup (startup)

`cleanupTerminalWorkspacesOnce` runs once per process, guarded by `startupCleanupDone`. It lists the workspaces **on disk** with `listIssueWorkspaces`, fetches just those issue ids, and removes the workspaces whose issues are terminal. It emits `startup_workspace_cleanup` or `startup_workspace_cleanup_failed`. This pass is disk-driven, not history-driven: after a restart there is no in-memory history to consult, so the filesystem is the source of truth for what to clean.

## Retry timers fire off the poll cadence

Retries do not wait for the next poll. `RetryScheduler` (`packages/retry-scheduler/src/index.ts`) keeps one timer per issue id. `syncRetryTimersForIssues` arms a timer at `monotonicDeadlineMs + RETRY_SCHEDULER_SYNC_DELAY_MS`, where the constant is `5` ms. When a timer fires, if a poll is already running it queues a forced poll, otherwise it calls `pollOnce()`. The 5 ms guard fires the timer slightly late on purpose, so `setTimeout` clock skew never fires it before `sortForDispatch` considers the issue due. Timers are `unref()`'d, so a pending retry never keeps the process alive.

## RuntimeSnapshot assembly

`RuntimeSnapshot` (`packages/runtime-events/src/index.ts`) is the object the UIs read; for the consumer view (how the TUI, dashboard, and API project it) see [observability.md](observability.md). `LorenzRuntime.snapshot()` builds it in three layers.

1. **Orchestrator.** `orchestrator.snapshot()` supplies the live scheduling state: `running`, `reserving`, `retrying`, `blocked`, `usageTotals`, and `rateLimits`, mapped into the `runtime-events` shapes.
2. **Runtime live fields.** The runtime layers in `appStatus`, `workflowPath`, the `poll` block (`status`, `candidates`, `eligible`, `lastPollAt`, `nextPollAt`, `lastError`), and `logFile`.
3. **ProjectionActor ring buffers.** `ProjectionActor.snapshot(input)` adds the last `20` `recentEvents` and the last `50` `runHistory` entries. Both caps are hard-coded in `recordEvent` and `recordRunHistory`.

`emit()` broadcasts the snapshot to every subscriber; `subscribe(listener)` immediately pushes the current snapshot so a new client starts from a full picture.

The `reserving` lane is host-less by design and surfaced separately, not folded into `running` with a placeholder host. It is an optional, additive field. The `poll.lastError` and `recentEvents` are the only error surface; there is no persisted error log beyond the optional `appendLogEvent` write to `logging.log_file`.

`RUNTIME_RUN_OUTCOMES` is `['success', 'failed', 'stalled', 'canceled']`, but the runtime never records a `canceled` run-history outcome today: reconciliation calls `cleanupIssue` without writing history. Only `success`, `failed`, and `stalled` reach run history; `canceled` is defined but unused.

## Restart Recovery

With the default in-memory claim store, `createState()` rebuilds `OrchestratorState` empty on boot.
Recovery is tracker-driven and filesystem-driven.

- **Tracker re-fetch.** `fetchCandidateIssues` repopulates the candidate set, and the tracked-issue reconciliation refetches issue ids by id. Any issue that is still eligible re-dispatches on the next tick. An interrupted run simply runs again.
- **Filesystem cleanup.** `cleanupTerminalWorkspacesOnce` reads the workspaces left on disk and removes the ones whose issues are now terminal.

With an explicit durable claim store, retry state and claim ownership hydrate from the store so crash
recovery and retry durability survive process restart. The tracker remains the durable record of what
to work on, and the filesystem remains the durable record of what was left behind.

## Transactional workflow reload

`reloadWorkflowIfConfigured` reloads the workflow only when the file changed and its stamp differs from the loaded one. It runs every throwing side effect first: the slots-per-machine gate via `checkSlotsPerMachineGate`, then `coordinator.reconcile`. Only after all of those succeed does it swap `this.input.workflow`, `orchestrator.settings`, and the client. Any failure keeps the last-known-good config and emits `workflow_reload_failed`; success emits `workflow_reloaded`. The coordinator is never torn down or rebuilt on reload. It is a reload-surviving singleton reconciled in place; reconstructing it would leak paid cloud workers.

## Worker outcome classification

When a run settles, `classifyWorkerOutcome` maps the error to `poison` or `healthy` for worker-pool settlement. It uses `POISON_WORKER_ERROR_PREFIXES`:

```ts
const POISON_WORKER_ERROR_PREFIXES = [
  "ssh_timeout:",
  "remote_home_lookup_failed:",
  "workspace_prepare_failed:",
  "workspace hook failed with status ",
];
```

The match is by prefix, not substring, so `invalid_ssh_timeout` and a local `hook failed with status N` stay healthy. A remote workspace hook that exits non-zero is a worker-side fault and poisons the worker. As noted under stall detection, a stall-finished run is forced to poison regardless of how the runner resolved.

## See also

- [dispatch.md](dispatch.md) - the pure eligibility chain, deterministic sort, route gating, concurrency caps, and retry backoff math.
- [workers/worker-pool.md](workers/worker-pool.md) - the pool and coordinator behind the `CapacityProbe` and `acquireRunSlot`.
- [agents/acp-bridges.md](agents/acp-bridges.md) - what a dispatched run does: the ACP turn loop, timeouts, and usage accounting.
- [observability.md](observability.md) - reading the `RuntimeSnapshot` across the TUI, dashboard, and API.
- [reference/events.md](reference/events.md) - the full `RUNTIME_EVENT_TYPES` vocabulary emitted by the loop.
- [reference/configuration.md](reference/configuration.md) - every config key referenced here, with defaults.
