# TypeScript Race Condition Review

Review scope: static review of the `ts/` implementation, focused on async coordination,
runtime cancellation, retry timers, shared helper processes, and cross-run state.

## Findings

### High: Reconciled runs can later record success or failure after cleanup

In `ts/packages/runtime/src/index.ts`, `reconcileTrackedIssues()` aborts and removes a run from
the orchestrator when an issue becomes terminal, missing, unrouted, or blocked. Unlike stall
reconciliation, it does not mark the run key in `externallyFinishedRunKeys`.

Relevant code:

- `ts/packages/runtime/src/index.ts:546`
- `ts/packages/runtime/src/index.ts:564`
- `ts/packages/runtime/src/index.ts:409`
- `ts/packages/runtime/src/index.ts:443`

Impact: an in-flight `runClaim()` can still complete after reconciliation and record
`run_completed` or `run_failed` after the runtime has already cleaned up the run/workspace. This can
produce misleading history/events and can schedule retry work for a run that should have been
externally reconciled.

Suggested fix: when `reconcileTrackedIssues()` aborts a run, add each active slot key to
`externallyFinishedRunKeys` before cleanup, mirroring the stall reconciliation path.

### High: `stop()` can turn shutdown aborts into failed retryable runs

`stop()` aborts all active controllers and clears retry timers, but active `runClaim()` promises can
still catch the abort and call `orchestrator.finish(..., true, ..., "failure")`, then
`syncRetryTimer()`.

Relevant code:

- `ts/packages/runtime/src/index.ts:269`
- `ts/packages/runtime/src/index.ts:443`
- `ts/packages/runtime/src/index.ts:450`
- `ts/packages/runtime/src/index.ts:451`

Impact: intentional shutdown can be recorded as failed work and can recreate retry timers after
shutdown. `run.finally()` can also set `appStatus` back to `idle` after `stop()` set it to
`stopping`.

Suggested fix: treat shutdown aborts as cancellation, not failure. Either mark active run keys as
externally finished during `stop()`, or have `runClaim()` branch on `this.stopped`/abort state and
record `canceled` without scheduling retries.

### Medium: Retry timer due events can be swallowed during an in-progress poll

`RetryScheduler` deletes the timer before invoking `onDue`. The runtime callback returns
immediately when `pollInProgress` is set and does not reschedule.

Relevant code:

- `ts/packages/retry-scheduler/src/index.ts:12`
- `ts/packages/runtime/src/index.ts:711`
- `ts/packages/runtime/src/index.ts:722`

Impact: if the active poll already computed eligibility before the retry became due, the retry
waits for the next normal poll despite the independent retry timer.

Suggested fix: if a retry timer fires during an active poll, chain a refresh after the current poll
settles or reschedule the same due retry with a short delay.

### Medium: Duplicate `session.stop()` calls can return before the child process exits

Abort handling fire-and-forgets `session.stop()`, then the `finally` block awaits
`session.stop()` again. The Codex/child-process stop helpers return immediately if the child is
already marked killed, even if another stop call is still waiting for the process to close.

Relevant code:

- `ts/packages/agent-runner/src/index.ts:220`
- `ts/packages/agent-runner/src/index.ts:179`
- `ts/packages/codex/src/process.ts:51`
- `ts/packages/child-process/src/index.ts:21`

Impact: lifecycle hooks and workspace cleanup can run while the agent process is still exiting and
may still hold files or emit events.

Suggested fix: make stop idempotent by storing and returning an in-flight stop promise per session
or process, so every caller awaits the same close/kill sequence.

### Medium: Local MCP server acquisition has no in-flight guard

`ensureLocalMcpServer()` checks `localMcpServers`, awaits reachability/startup, then stores the
handle. Concurrent ACP sessions for the same configured port can both miss the map and try to bind
the same port.

Relevant code:

- `ts/packages/mcp/src/agentEndpoint.ts:113`
- `ts/packages/mcp/src/agentEndpoint.ts:117`
- `ts/packages/mcp/src/agentEndpoint.ts:123`
- `ts/packages/mcp/src/agentEndpoint.ts:127`

Impact: concurrent local ACP startup can fail with port binding errors or create inconsistent
reference counts.

Suggested fix: store a pending server-start promise in the map before awaiting startup, and share
that promise across concurrent acquisitions.

## Notes

Existing tests already cover several nearby races, including overlapping `pollOnce()` calls, stale
stall snapshots, and late runner success after stall reconciliation. The gaps above are the remaining
edges that looked actionable from static review.
