# Symphony Execution Flow — Causal Chains

## Key Concepts

- **Poll cycle**: The runtime loops continuously, sleeping `polling.intervalMs` between cycles.
- **Active states**: Issue states that make an issue eligible for work (configured in `settings.tracker.activeStates`).
- **Terminal states**: Issue states that signal work is done — `completed`, `canceled`, etc. (configured in `settings.tracker.terminalStates`).
- **Continuation retry**: After a successful run, the agent re-runs after 1s to check if more turns are needed.
- **Failure retry**: After an error, retry with exponential backoff: `10s × 2^(attempt-1)`, capped at `maxRetryBackoffMs`.
- **Reconciliation**: Every poll cycle checks tracked issues against the tracker; if an issue moved to a terminal state externally, the run is aborted and cleaned up.

---

## Scenario 1: Single Issue — Picked Up → Completed

### Phase 1: Binary Startup

```
ts/apps/cli/src/bin/cli.ts:3  (shebang entry point)
  → calls run() imported from ../main.js

    ts/apps/cli/src/main.ts:98  run = main
      → main():70 parses CLI args via Commander
      → main():75 calls runDaemon(options)

        ts/apps/cli/src/main.ts:100  runDaemon()
          → :104 calls loadWorkflow() — reads workflow markdown, builds Settings
          → :111 calls validateDispatchConfig(workflow.settings)
          → :117 constructs new SymphonyRuntime({workflow, clientFactory, runner, ...})

              ts/packages/runtime/src/index.ts:215  constructor()
                → :217 calls clientFactory(settings)

                    ts/apps/cli/src/daemon.ts:32  createTrackerClient()
                      → :37 "linear" case → returns new LinearClient(settings)

                → :218 constructs new Orchestrator(settings)
                → :219 stores runner = runAgentAttempt

          → :160 calls runtime.start({once, dryRun})
```

### Phase 2: Main Loop

```
ts/packages/runtime/src/index.ts:260  start()
  → :262-266 do/while loop: repeats until stopped

    → :263 calls this.pollOnce({dryRun, waitForRuns: options.once})

        ts/packages/runtime/src/index.ts:278  pollOnce()
          → :279 serialization guard: if pollInProgress, return same Promise
          → :280 calls pollOnceUnlocked(options)
```

### Phase 3: Poll Cycle

```
ts/packages/runtime/src/index.ts:289  pollOnceUnlocked()

  → :298 calls this.reloadWorkflowIfConfigured()
      ts/packages/runtime/src/index.ts:491  reloadWorkflowIfConfigured()
        → re-reads workflow file if callback provided, updates settings

  → :300 calls this.cleanupTerminalWorkspacesOnce()
      ts/packages/runtime/src/index.ts:638  cleanupTerminalWorkspacesOnce()
        → first poll only: fetches terminal issues, removes leftover workspaces
        → no-op on subsequent polls (startupCleanupDone = true)

  → :301 calls this.reconcileStalledRuns()
      ts/packages/runtime/src/index.ts:573  reconcileStalledRuns()
        → no running entries yet → no-op

  → :302 calls this.reconcileTrackedIssues()
      ts/packages/runtime/src/index.ts:506  reconcileTrackedIssues()
        → :516-527 builds tracked set from running + retrying maps
        → :528 tracked.size === 0 → returns early (nothing to reconcile)

  → :303 calls this.client.fetchCandidateIssues()
      ts/packages/linear-tracker/src/index.ts:217  fetchCandidateIssues()
        → :218 calls this.fetchIssuesByStates(this.settings.tracker.activeStates)

            ts/packages/linear-tracker/src/index.ts:221  fetchIssuesByStates()
              → :233 executes GraphQL query `SymphonyTsPoll` with state filter
              → :248 for each result, calls normalizeIssue()

                  ts/packages/issue/src/index.ts:8  normalizeIssue()
                    → builds Issue domain object from raw Linear payload

              → returns [Issue{id:"abc", state:"In Progress"}]

  → :304 calls this.orchestrator.eligibleIssues(issues)
      ts/packages/orchestrator/src/index.ts:58  eligibleIssues()
        → :59 calls this.cleanupRetryAttempts(issues)
        → :61-64 builds runningByState map from current running entries
        → :66 calls sortForDispatch(issues)

            ts/packages/dispatch/src/index.ts:121  sortForDispatch()
              → :123 sorts by priority (line 141 prioritySort)
              → :125 then by createdAt
              → :127 then by identifier

        → :66 .filter() for each issue:
          → :67-68 checks retry backoff: retryAttempts.get(issue.id)?.dueAt > now → skip
            (no retry entry → passes)
          → :76 calls dispatchBlockReason(issue, settings, dispatchState)

              ts/packages/dispatch/src/index.ts:45  dispatchBlockReason()
                → :56 calls issueIsActive(issue, settings)
                    ts/packages/dispatch/src/index.ts:18  issueIsActive()
                      → :20 state ∈ activeStates AND state ∉ terminalStates → true
                → :57 calls routedToThisWorker(issue, settings)
                    ts/packages/dispatch/src/index.ts:33  routedToThisWorker()
                      → :34 checks assignedToWorker flag
                      → :36-38 checks label routing vs onlyRoutes/acceptUnrouted
                → :58 calls issueHasOpenBlockers(issue, settings)
                    ts/packages/dispatch/src/index.ts:25  issueHasOpenBlockers()
                      → :26 only blocks unstarted issues with unresolved blockers
                → :60 checks runningCount >= maxConcurrentAgents → no (0 < cap)
                → :64 checks per-state concurrency cap → no
                → :66 checks workerCapacityAvailable → yes
                → returns null (no block)

          → :87 calls shouldDispatchIssue(issue, settings, dispatchState)
              ts/packages/dispatch/src/index.ts:71  shouldDispatchIssue()
                → :81-84 repeats active/routed/unblocked checks
                → :85 calls dispatchBlockReason → null
                → :87-92 checks for unclaimed ensemble slots
                  → :88 gets claimed set
                  → :90 slot 0 not in claimed → returns true

        → returns [Issue{id:"abc"}]

  → :311-312 for (issue of eligibleIssues) dispatched.push(...maybeDispatch(issue))
```

### Phase 4: Dispatch

```
ts/packages/runtime/src/index.ts:336  maybeDispatch(issue)

  → :337 calls this.fetchIssueForDispatch(issue)
      ts/packages/runtime/src/index.ts:374  fetchIssueForDispatch()
        → :376 calls this.client.fetchIssuesByIds([issue.id])
            ts/packages/linear-tracker/src/index.ts:256  fetchIssuesByIds()
              → re-fetches from Linear for freshness (guards against stale data)
        → returns refreshed issue (or null if missing)

  → :343 calls this.orchestrator.claim(refreshed)
      ts/packages/orchestrator/src/index.ts:91  claim()
        → :95-98 builds runningByState from current state
        → :100 calls shouldDispatchIssue(issue, settings, {runningCount, ...})
            ts/packages/dispatch/src/index.ts:71  shouldDispatchIssue()
              → re-checks all dispatch rules (concurrency guard at claim time)
        → :109 calls firstUnclaimedSlot(issue, settings, claimed, retry?.slotIndex)
            ts/packages/dispatch/src/index.ts:95  firstUnclaimedSlot()
              → :111-113 iterates slots 0..ensembleSize, returns first unclaimed
              → returns 0
        → :116 calls this.selectWorkerHost()
            ts/packages/orchestrator/src/index.ts:150  selectWorkerHost()
              → :155 calls selectLeastLoadedHost({hosts, runningCounts, cap})
              → returns null (local mode) or a host string
        → :122-142 creates RunningEntry{issue, slotIndex:0, agentKind:"claude",
                                         startedAt:now, retryAttempt:null, ...}
        → :144 state.claimed.add("abc:0")
        → :145 state.running.set("abc:0", entry)
        → :146 state.retryAttempts.delete(issue.id)
        → returns RunningEntry

  → :348 key = slotKey(issue.id, 0) → "abc:0"
  → :349 runId = "run-1" (nextRunNumber++)
  → :351 activeRunIds.set("abc:0", "run-1")
  → :352 addEvent("run_started", "abc slot=0")

  → :354 controller = new AbortController()
  → :355 activeAbortControllers.set("abc:0", controller)

  → :356 calls this.runClaim(issue, slotIndex=0, agentKind, runId, workerHost, signal)
      (async — does not await here)
  → :364 inFlight.add(run)
  → :365-368 run.finally(() => inFlight.delete(run); update appStatus)
  → :371 returns [run]
```

### Phase 5: Agent Execution

```
ts/packages/runtime/src/index.ts:384  runClaim()

  → :394 calls this.runner({issue, workflow, workerHost, slotIndex, onUpdate, fetchIssue, signal})

      ts/apps/cli/src/daemon.ts:58  runAgentAttempt()
        → :59 calls runAgentAttemptCore({...input, adapters})

            ts/packages/agent-runner/src/index.ts:83  runAgentAttempt()
              → :84 calls new RunController(input).run()

                  ts/packages/agent-runner/src/index.ts:90  RunController.run()

                    → :98 calls createWorkspaceForIssue(adapters, runtime, issue, opts)
                        (adapter wired from ts/apps/cli/src/daemon.ts:43)
                        → creates git worktree or directory for agent isolation
                    → :103 onUpdate({type:"workspace_prepared", workspacePath})

                    → :104-106 if runtime.hooks.beforeRun:
                        calls runHook(adapters, hook, workspace, hooks, workerHost)

                    → :108 calls readResumeState(adapters, workspace, workerHost, timeout)
                        → returns {status:"missing"} (no prior session)
                    → :114-134 resume validation logic
                        → :135 resumeId = null (no valid resume, starts fresh)

                    → :137 calls executorFor(adapters, runtime)
                        ts/apps/cli/src/daemon.ts:48  executorFactory()
                          → :51 "appserver" → new CodexAppServerExecutor()
                          → :52 "acp" → new AcpExecutor(agentKind)

                    → :139-149 calls executor.startSession({workspace, workerHost,
                                 issue, settings, resumeId:null, onUpdate})
                        → creates backend session (Claude/Codex)

                    → :153 TURN LOOP: while (turnCount < maxTurns)

                        → :154 calls throwIfAborted(abortSignal)
                            → checks if AbortController was triggered

                        → :156-162 prompt construction:
                            turnCount === 0:
                              → :157 calls buildPrompt(workflow.promptTemplate, issue, opts)
                                  ts/packages/prompt  buildPrompt()
                                    → renders full prompt with issue context
                            turnCount > 0:
                              → :162 calls continuationPrompt(turnCount+1, maxTurns)
                                  ts/packages/prompt  continuationPrompt()

                        → :163 calls runTurnWithAbort(executor, session, prompt, issue, signal)
                            ts/packages/agent-runner/src/index.ts:209  runTurnWithAbort()
                              → executes one agent turn (LLM call, tool use, etc.)
                              → agent works: reads code, writes code, pushes PR
                              → agent moves issue state to "Done" in Linear

                        → :164 turnCount += 1

                        → :165 calls persistResumeState(adapters, session, runtime, issue, ws, host)
                            → saves session checkpoint to disk for crash recovery

                        → :167 if (!input.fetchIssue) break
                        → :168 issue = await input.fetchIssue(issue)
                            ts/packages/runtime/src/index.ts:403  fetchIssue callback
                              → :404 calls this.client.fetchIssuesByIds([current.id])
                                  ts/packages/linear-tracker/src/index.ts:256  fetchIssuesByIds()
                              → returns Issue{state:"Done"}

                        → :169 calls issueIsActive(issue, settings)
                            ts/packages/dispatch/src/index.ts:18  issueIsActive()
                              → "Done" ∈ terminalStates → returns false
                            → BREAK (exits turn loop)

                    → :179-193 finally block:
                        → :180 calls session.stop()
                        → :181-193 if afterRun hook: calls runHook() (best-effort)

                    → :196 calls persistResumeState() — final checkpoint

                    → :198-206 returns RunResult{workspace, turnCount:1, resumeId,
                                                  agentKind:"claude", finalIssue:{state:"Done"}}
```

### Phase 6: Post-Run (Success)

```
ts/packages/runtime/src/index.ts:384  runClaim() — try block continues after runner returns

  → :409 finalIssue = result.finalIssue ?? fetchIssueOrSelf(issue)
  → :410-411 checks externallyFinishedRunKeys (for stall-abort races) → not set, continues

  → :415 calls this.orchestrator.finish(issue.id, slotIndex, true, undefined, "continuation")
      ts/packages/orchestrator/src/index.ts:192  finish()
        → :199 key = slotKey("abc", 0) → "abc:0"
        → :200 entry = state.running.get("abc:0")
        → :202 state.running.delete("abc:0")
        → :203 state.claimed.delete("abc:0")
        → :204-206 state.usageTotals.secondsRunning += elapsed
        → :209 normal=true branch:
          → :210 attempt = 1 (continuation always resets to 1)
          → :211 state.completed.add("abc")
          → :212-223 state.retryAttempts.set("abc", {issueId, identifier, attempt:1, dueAt, slot, ...})
            → :217 dueAt = this.dueAt(retryBackoffMs(1, max, "continuation"))
                ts/packages/policies/src/retry.ts:3  retryBackoffMs()
                  → :8 retryKind === "continuation" → returns 1000
              → dueAt = now + 1000ms (1 second)

  → :416 calls this.syncRetryTimer("abc")
      ts/packages/runtime/src/index.ts:706  syncRetryTimer()
        → :707 gets retry entry from orchestrator snapshot
        → :712 calls this.retryScheduler.sync(retry, onDue)
            ts/packages/retry-scheduler/src/index.ts:6  sync()
              → :8 calls this.clear(issueId) — removes any existing timer
              → :9 dueTime = new Date(retry.dueAt).getTime()
              → :10 delayMs = max(0, dueTime - Date.now()) ≈ 1000ms
              → :11 setTimeout(onDue, delayMs)
              → :16 stores timer in this.timers map

  → :417-441 calls this.recordHistory({id:"run-1", outcome:"success", turnCount:1, ...})
  → :442 calls this.addEvent("run_completed", "abc turns=1")

  → :480-483 finally block:
      → :481 activeRunIds.delete("abc:0")
      → :482 activeAbortControllers.delete("abc:0")
```

### Phase 7: Continuation Timer → Reconcile → Cleanup

```
~1 second passes...

ts/packages/retry-scheduler/src/index.ts:11  setTimeout callback fires
  → :12 this.timers.delete("abc")
  → :13 calls onDue(retry)

      ts/packages/runtime/src/index.ts:712  onDue callback (inside syncRetryTimer)
        → :714-720 validates retry is still current (attempt + dueAt match)
        → :723 if (this.pollInProgress) return — deduplication guard
        → :724 addEvent("retry_timer_due", "abc attempt=1")
        → :725 calls this.pollOnce()

            ts/packages/runtime/src/index.ts:278  pollOnce()
              → :280 calls pollOnceUnlocked()

                  ts/packages/runtime/src/index.ts:289  pollOnceUnlocked()

                    → :301 calls this.reconcileStalledRuns()
                        → no running entries → no-op

                    → :302 calls this.reconcileTrackedIssues()
                        ts/packages/runtime/src/index.ts:506  reconcileTrackedIssues()
                          → :516-527 builds tracked set:
                              "abc" is in retryAttempts → added to tracked map
                          → :528 tracked.size = 1, does not return early

                          → :532 calls this.client.fetchIssuesByIds(["abc"])
                              ts/packages/linear-tracker/src/index.ts:256  fetchIssuesByIds()
                                → returns [Issue{id:"abc", state:"Done"}]

                          → :538 for issue "abc":
                            → :539-541 checks:
                                issueIsActive("Done", settings) → false (terminal)
                              → condition fails → enters cleanup branch

                            → :547 calls this.abortIssueRuns("abc")
                                ts/packages/runtime/src/index.ts:657  abortIssueRuns()
                                  → no matching AbortControllers → no-op

                            → :548 calls this.orchestrator.cleanupIssue("abc")
                                ts/packages/orchestrator/src/index.ts:227  cleanupIssue()
                                  → :228-233 removes from running (already gone)
                                  → :234 state.retryAttempts.delete("abc")
                                  → :235 state.completed.add("abc")

                            → :549 calls this.clearRetryTimer("abc")
                                ts/packages/runtime/src/index.ts:732  clearRetryTimer()
                                  → calls retryScheduler.clear("abc")
                                      ts/packages/retry-scheduler/src/index.ts:19  clear()
                                        → clearTimeout + timers.delete

                            → :550 reason = reconciliationStopReason(issue, settings)
                                ts/packages/policies/src/reconciliation.ts:12  reconciliationStopReason()
                                  → :16 !issueIsActive(issue, settings) → returns "terminal"

                            → :551 calls isTerminalState("Done", terminalStates)
                                ts/packages/issue/src/index.ts:61  isTerminalState()
                                  → :67 "done" matches a terminal state → returns true

                            → :552-553 calls this.removeIssueWorkspaces(settings, identifier, host)
                                → deletes git worktree/directory from disk

                            → :557 addEvent("workspace_cleanup", "abc terminal")

                    → :303 calls this.client.fetchCandidateIssues()
                        → "abc" state="Done" not in activeStates → not returned
                        → returns []

                    → :304 orchestrator.eligibleIssues([]) → []
                    → :311 for loop: nothing to dispatch

FINAL STATE: Issue completed. Workspace cleaned. System idle.
```

---

## Scenario 2: Single Issue — Picked Up → Retried → Completed

### Phase 1-4: Same as Scenario 1

(Startup → Main Loop → Poll Cycle → Dispatch → runClaim starts async)

### Phase 5: Agent Execution — FAILS

```
ts/packages/agent-runner/src/index.ts:90  RunController.run()

  → :98 calls createWorkspaceForIssue() → succeeds
  → :137 calls executorFor() → succeeds
  → :139 calls executor.startSession() → succeeds
  → :153 TURN LOOP:
      → :163 calls runTurnWithAbort(executor, session, prompt, issue, signal)
          → THROWS (API error / timeout / process crash / rate limit)
      → exception propagates out of while loop
  → :179 finally:
      → :180 session.stop()
  → exception propagates to caller (runClaim)
```

### Phase 6: Post-Run (Failure)

```
ts/packages/runtime/src/index.ts:443  runClaim() — catch block

  → :444-445 checks externallyFinishedRunKeys → not set, continues

  → :448-449 gets entry from orchestrator snapshot
  → :449 calls this.invalidateResumeStateForRunningEntry(entry, "failure")
      ts/packages/runtime/src/index.ts:665  invalidateResumeStateForRunningEntry()
        → :669 if no workspacePath → return (early exit)
        → :670-671 calls this.invalidateResumeStateForPath(meta, "failure")
            ts/packages/runtime/src/index.ts:680  invalidateResumeStateForPath()
              → :692 calls this.deleteResumeState(workspace, workerHost, timeout)
                  (adapter from ts/apps/cli/src/daemon.ts:67)
                  → deletes resume JSON from disk so next attempt starts fresh
              → :697 addEvent("resume_state_invalidated", "abc failure")

  → :450 calls this.orchestrator.finish("abc", 0, true, errorMessage, "failure")
      ts/packages/orchestrator/src/index.ts:192  finish()
        → :202 state.running.delete("abc:0")
        → :203 state.claimed.delete("abc:0")
        → :209 normal=true branch:
          → :210 attempt = (entry.retryAttempt ?? 0) + 1 = 1
          → :211 state.completed.add("abc")
          → :212-223 state.retryAttempts.set("abc", {attempt:1, dueAt, error, ...})
            → :217 dueAt = this.dueAt(retryBackoffMs(1, max, "failure"))
                ts/packages/policies/src/retry.ts:3  retryBackoffMs()
                  → :9 min(maxRetryBackoffMs, 10000 * 2^(1-1)) = 10000ms
              → dueAt = now + 10000ms (10 seconds)

  → :451 calls this.syncRetryTimer("abc")
      ts/packages/runtime/src/index.ts:706  syncRetryTimer()
        → :712 retryScheduler.sync(retry, onDue)
            ts/packages/retry-scheduler/src/index.ts:6  sync()
              → :11 setTimeout(onDue, 10000)

  → :452-477 calls this.recordHistory({outcome:"failed", error:...})
  → :478 calls this.addEvent("run_failed", "abc <error>")
  → :480-483 finally: cleanup activeRunIds, activeAbortControllers
```

### Phase 7: Backoff Period (issue blocked from dispatch)

```
Regular poll cycles continue during the 10s backoff:

ts/packages/runtime/src/index.ts:289  pollOnceUnlocked()
  → :303 fetchCandidateIssues() → returns [Issue{id:"abc", state:"In Progress"}]
  → :304 orchestrator.eligibleIssues([Issue{id:"abc"}])

      ts/packages/orchestrator/src/index.ts:58  eligibleIssues()
        → :66 .filter() for "abc":
          → :67 retry = this.state.retryAttempts.get("abc")
              → {attempt:1, dueAt: <10s from now>}
          → :68 retry.dueAt.getTime() > this.clock.now().getTime() → TRUE
          → returns false → FILTERED OUT

      → returns [] (no eligible issues)

  → nothing dispatched

Issue appears as "retrying" in RuntimeSnapshot (visible in TUI/API)
but is NOT dispatchable until dueAt passes.
```

### Phase 8: Retry Timer Fires → Re-dispatch

```
~10 seconds pass...

ts/packages/retry-scheduler/src/index.ts:11  setTimeout callback fires
  → :13 calls onDue(retry)

      ts/packages/runtime/src/index.ts:712  onDue callback
        → :725 calls this.pollOnce()

            ts/packages/runtime/src/index.ts:289  pollOnceUnlocked()

              → :302 calls this.reconcileTrackedIssues()
                  ts/packages/runtime/src/index.ts:506  reconcileTrackedIssues()
                    → :516-527 "abc" in retryAttempts → tracked
                    → :532 fetchIssuesByIds(["abc"]) → Issue{state:"In Progress"}
                    → :539-541 issueIsActive + routedToThisWorker + !openBlockers → all true
                    → :544 calls this.orchestrator.refreshRunningIssue(issue)
                        ts/packages/orchestrator/src/index.ts:168  refreshRunningIssue()
                          → updates in-memory issue data for any running entries
                          → (abc not in running, only retrying — effectively no-op)
                    → continues (no cleanup needed)

              → :303 fetchCandidateIssues() → [Issue{id:"abc"}]

              → :304 orchestrator.eligibleIssues([Issue{id:"abc"}])
                  ts/packages/orchestrator/src/index.ts:58  eligibleIssues()
                    → :67 retry = retryAttempts.get("abc") → {attempt:1, dueAt: <past>}
                    → :68 retry.dueAt <= now → passes time check
                    → :69 calls this.releaseStaleClaimsForRetry("abc")
                        → clears any leftover claimed slots for this issue
                    → :76-87 dispatch rules pass → eligible
                  → returns [Issue{id:"abc"}]

              → :311 for loop: calls maybeDispatch(issue)

                  ts/packages/runtime/src/index.ts:336  maybeDispatch()
                    → :337 fetchIssueForDispatch() — re-fetch from Linear
                    → :343 calls orchestrator.claim(issue)
                        ts/packages/orchestrator/src/index.ts:91  claim()
                          → :92-94 retry exists + dueAt <= now → releaseStaleClaimsForRetry
                          → :109 calls firstUnclaimedSlot(issue, settings, claimed, retry.slotIndex)
                              ts/packages/dispatch/src/index.ts:95  firstUnclaimedSlot()
                                → :102-108 preferred slot (retry.slotIndex=0) is unclaimed → returns 0
                          → :141 retryAttempt = retry.attempt = 1
                          → :144 claimed.add("abc:0")
                          → :145 running.set("abc:0", entry)
                          → :146 retryAttempts.delete("abc")
                          → returns RunningEntry{retryAttempt:1}
                    → :356 calls runClaim(issue, slot=0, agentKind, runId, host, signal)
```

### Phase 9: Agent Execution — SUCCEEDS on retry

```
ts/packages/runtime/src/index.ts:384  runClaim()
  → :394 calls this.runner(...)

      ts/packages/agent-runner/src/index.ts:90  RunController.run()

        → :98 createWorkspaceForIssue() — reuses existing workspace dir
        → :108 readResumeState()
            → resume was deleted (invalidated in Phase 6) → {status:"missing"}
        → :135 resumeId = null (starts fresh session)
        → :139 executor.startSession({resumeId:null}) — brand new session

        → :153 TURN LOOP:
            → :156-158 buildPrompt(template, issue, {attempt:1, slotIndex:0, ...})
                (attempt=1 passed through — prompt can include retry context)
            → :163 runTurnWithAbort() → SUCCEEDS this time
                Agent works, pushes code, moves issue to "Done"
            → :164 turnCount = 1
            → :165 persistResumeState()
            → :168 fetchIssue() → Issue{state:"Done"}
            → :169 issueIsActive() → false (terminal) → BREAK

        → :180 session.stop()
        → :198-206 returns RunResult{turnCount:1, finalIssue:{state:"Done"}}
```

### Phase 10: Post-Run Success → Cleanup (same as Scenario 1 Phase 6-7)

```
ts/packages/runtime/src/index.ts:415
  → orchestrator.finish("abc", 0, true, undefined, "continuation")
    → retryAttempts.set("abc", {dueAt: now+1s})
  → syncRetryTimer("abc") → setTimeout(onDue, 1000)

~1s later: timer fires → pollOnce() → reconcileTrackedIssues()
  → detects "Done" is terminal → cleanupIssue → removeWorkspaces

FINAL STATE: Issue completed after 1 failed attempt + 1 successful retry.
             Workspace cleaned. System idle.
```

### Exponential Backoff Progression

```
ts/packages/policies/src/retry.ts:9
  formula: min(maxRetryBackoffMs, 10000 * 2^(attempt-1))

  Attempt 1:  10,000ms  (10s)
  Attempt 2:  20,000ms  (20s)
  Attempt 3:  40,000ms  (40s)
  Attempt 4:  80,000ms  (80s)
  Attempt N:  min(10000 × 2^(N-1), maxRetryBackoffMs)

No max-retry-count cap — retries continue indefinitely until the
issue reaches a terminal state, is unrouted, or is blocked.
```

---

## Scenario 3: Two Issues Concurrently

### Phase 1-3: Startup through Poll (same as Scenario 1)

### Phase 4: Eligibility — Both pass

```
ts/packages/runtime/src/index.ts:303
  → client.fetchCandidateIssues() returns [IssueA(P1, older), IssueB(P2, newer)]

ts/packages/runtime/src/index.ts:304
  → orchestrator.eligibleIssues([IssueA, IssueB])

      ts/packages/orchestrator/src/index.ts:58  eligibleIssues()

        → :61-64 builds runningByState from state.running (empty → all counts = 0)
            NOTE: this snapshot is taken ONCE at the start. It does NOT
            update mid-filter. Both issues see runningCount=0.
            The real concurrency guard is in claim() (Phase 5).

        → :66 calls sortForDispatch([IssueA, IssueB])
            ts/packages/dispatch/src/index.ts:121  sortForDispatch()
              → :123 prioritySort: P1(1) < P2(2) → IssueA first
              → returns [IssueA, IssueB]

        → :66 .filter() for IssueA:
            → :68 no retry → passes
            → :76 dispatchBlockReason(A, {runningCount:0}) → null (0 < cap)
            → :87 shouldDispatchIssue(A) → true
            → ELIGIBLE

        → :66 .filter() for IssueB:
            → :68 no retry → passes
            → :76 dispatchBlockReason(B, {runningCount:0}) → null (0 < cap)
                (sees stale snapshot: runningCount still 0)
            → :87 shouldDispatchIssue(B) → true
            → ELIGIBLE

        → returns [IssueA, IssueB]
```

### Phase 5: Dispatch — Both claimed (cap ≥ 2)

```
ts/packages/runtime/src/index.ts:311  for (issue of eligibleIssues)

── IssueA ──

  → :312 calls maybeDispatch(IssueA)
      ts/packages/runtime/src/index.ts:336  maybeDispatch()
        → :337 fetchIssueForDispatch(A) → refreshed IssueA
        → :343 calls orchestrator.claim(A)
            ts/packages/orchestrator/src/index.ts:91  claim()
              → :100 shouldDispatchIssue(A, {runningCount:0}) → true (0 < cap)
              → :109 firstUnclaimedSlot → 0
              → :144 claimed.add("A:0")
              → :145 running.set("A:0", entryA) — running.size = 1
              → returns RunningEntry

        → :349 runId = "run-1"
        → :356 calls runClaim(A, ...) — starts async
        → :364 inFlight.add(runA) — inFlight.size = 1

── IssueB ──

  → :312 calls maybeDispatch(IssueB)
      ts/packages/runtime/src/index.ts:336  maybeDispatch()
        → :337 fetchIssueForDispatch(B) → refreshed IssueB
        → :343 calls orchestrator.claim(B)
            ts/packages/orchestrator/src/index.ts:91  claim()
              → :95-98 builds fresh runningByState (now includes A's state)
              → :100 shouldDispatchIssue(B, {runningCount:1})
                  ts/packages/dispatch/src/index.ts:71  shouldDispatchIssue()
                    → :85 dispatchBlockReason(B, {runningCount:1})
                        ts/packages/dispatch/src/index.ts:45  dispatchBlockReason()
                          → :60 1 < maxConcurrentAgents(≥2) → no block
                    → :87-92 slot 0 unclaimed for B → true
              → :109 firstUnclaimedSlot → 0
              → :144 claimed.add("B:0")
              → :145 running.set("B:0", entryB) — running.size = 2
              → returns RunningEntry

        → :349 runId = "run-2"
        → :356 calls runClaim(B, ...) — starts async
        → :364 inFlight.add(runB) — inFlight.size = 2
```

### Phase 6: Parallel Agent Execution

```
Both runClaim() Promises execute concurrently. No shared state between them.
Each has its own: workspace, session, AbortController, runId, issue.

── Agent A ──                             ── Agent B ──

ts/packages/runtime/src/index.ts:384      ts/packages/runtime/src/index.ts:384
  runClaim(A, slot=0, ...)                  runClaim(B, slot=0, ...)
  → :394 this.runner(...)                   → :394 this.runner(...)

ts/packages/agent-runner/src/index.ts:90  ts/packages/agent-runner/src/index.ts:90
  RunController.run()                       RunController.run()
  → :98 createWorkspace("A")               → :98 createWorkspace("B")
  → :139 startSession()                    → :139 startSession()
  → :153 turn loop:                        → :153 turn loop:
      turn 1: work on A                        turn 1: work on B
      :168 fetchIssue → active                 :168 fetchIssue → active
      turn 2: push PR, move "Done"             turn 2: push PR, move "Done"
      :168 fetchIssue → "Done"                 :168 fetchIssue → "Done"
      :169 !active → BREAK                     :169 !active → BREAK
  → :180 session.stop()                    → :180 session.stop()
  → return RunResult                       → return RunResult

A finishing does NOT affect B:
  - Each checks only its OWN issue state at line 168-169
  - They share no mutable state during execution
  - The orchestrator only observes them at finish() time
```

### Phase 7: Post-Run (each completes independently)

```
── Agent A finishes first ──

ts/packages/runtime/src/index.ts:415
  → orchestrator.finish("A", 0, true, undefined, "continuation")
      ts/packages/orchestrator/src/index.ts:192  finish()
        → :202 running.delete("A:0") — running.size = 1
        → :212 retryAttempts.set("A", {dueAt: now+1s})
  → :416 syncRetryTimer("A") → setTimeout(1000)
  → :442 addEvent("run_completed", "A turns=2")

ts/packages/runtime/src/index.ts:365  run.finally()
  → inFlight.delete(runA) — inFlight.size = 1
  → appStatus = "running" (B still in flight)

── Agent B finishes (before or after A) ──

ts/packages/runtime/src/index.ts:415
  → orchestrator.finish("B", 0, true, undefined, "continuation")
      ts/packages/orchestrator/src/index.ts:192  finish()
        → :202 running.delete("B:0") — running.size = 0
        → :212 retryAttempts.set("B", {dueAt: now+1s})
  → :416 syncRetryTimer("B") → setTimeout(1000)
  → :442 addEvent("run_completed", "B turns=2")

ts/packages/runtime/src/index.ts:365  run.finally()
  → inFlight.delete(runB) — inFlight.size = 0
  → appStatus = "idle"
```

### Phase 8: Cleanup (continuation timers)

```
── Timer A fires (~1s after A completed) ──

ts/packages/retry-scheduler/src/index.ts:11  setTimeout callback
  → :13 onDue(retryA)

      ts/packages/runtime/src/index.ts:725  pollOnce()

          ts/packages/runtime/src/index.ts:506  reconcileTrackedIssues()
            → :516-527 tracked = {"A" (retry), "B" (retry)}
            → :532 fetchIssuesByIds(["A","B"])
                → returns [Issue{A, state:"Done"}, Issue{B, state:"Done"}]
            → :538 for A: !issueIsActive("Done") → cleanup branch
                → :548 cleanupIssue("A")
                → :552 removeIssueWorkspaces(A)
            → :538 for B: !issueIsActive("Done") → cleanup branch
                → :548 cleanupIssue("B")
                → :552 removeIssueWorkspaces(B)

── Timer B fires (~same time) ──

ts/packages/retry-scheduler/src/index.ts:11  setTimeout callback
  → :13 onDue(retryB)

      ts/packages/runtime/src/index.ts:725  pollOnce()
          ts/packages/runtime/src/index.ts:278  pollOnce()
            → :279 pollInProgress is already set → returns same Promise
            → NO duplicate poll (serialization guard)

FINAL STATE: Both issues completed. Both workspaces cleaned. System idle.
```

### Edge Case: Concurrency Cap = 1

```
maxConcurrentAgents = 1, both issues pass eligibleIssues() filter
(because snapshot taken at start sees runningCount=0 for both)

ts/packages/runtime/src/index.ts:311  for loop

── maybeDispatch(IssueA) ──

  → :343 orchestrator.claim(A)
      ts/packages/orchestrator/src/index.ts:91  claim()
        → :100 shouldDispatchIssue(A, {runningCount:0})
            ts/packages/dispatch/src/index.ts:85  dispatchBlockReason()
              → :60 0 < 1 → no block
            → returns true
        → claim succeeds → running.size = 1

── maybeDispatch(IssueB) ──

  → :343 orchestrator.claim(B)
      ts/packages/orchestrator/src/index.ts:91  claim()
        → :95-98 builds FRESH runningByState (now has A)
        → :100 shouldDispatchIssue(B, {runningCount:1})
            ts/packages/dispatch/src/index.ts:71  shouldDispatchIssue()
              → :85 calls dispatchBlockReason(B, {runningCount:1})
                  ts/packages/dispatch/src/index.ts:45  dispatchBlockReason()
                    → :60 runningCount(1) >= maxConcurrentAgents(1)
                    → returns "global_concurrency_cap"
              → returns false
        → claim() returns null

  → :344-345 addEvent("dispatch_skipped", "B stale_before_dispatch")
  → returns [] (no Promise started for B)

RESULT: Only A runs. B not dispatched this cycle.

NEXT CYCLE (after A completes + cleanup):
  → running.size = 0
  → B passes claim() → dispatched and run
```

---

## Source File Index

| File | Function | Line | Role |
|------|----------|------|------|
| `ts/apps/cli/src/bin/cli.ts` | `run()` | 3 | Shebang entry point |
| `ts/apps/cli/src/main.ts` | `main()` | 70 | CLI arg parsing |
| `ts/apps/cli/src/main.ts` | `runDaemon()` | 100 | Creates runtime, starts loop |
| `ts/apps/cli/src/daemon.ts` | `createTrackerClient()` | 32 | Linear/Memory client factory |
| `ts/apps/cli/src/daemon.ts` | `runAgentAttempt()` | 58 | Wires adapters to core runner |
| `ts/packages/runtime/src/index.ts` | `SymphonyRuntime` constructor | 215 | Wires client, orchestrator, runner |
| `ts/packages/runtime/src/index.ts` | `start()` | 260 | Main do/while loop |
| `ts/packages/runtime/src/index.ts` | `pollOnce()` | 278 | Serialization guard |
| `ts/packages/runtime/src/index.ts` | `pollOnceUnlocked()` | 289 | Full poll cycle orchestration |
| `ts/packages/runtime/src/index.ts` | `maybeDispatch()` | 336 | Refresh → claim → runClaim |
| `ts/packages/runtime/src/index.ts` | `runClaim()` | 384 | Runs agent, handles success/failure |
| `ts/packages/runtime/src/index.ts` | `reconcileTrackedIssues()` | 506 | Syncs state with tracker |
| `ts/packages/runtime/src/index.ts` | `reconcileStalledRuns()` | 573 | Aborts stalled agents |
| `ts/packages/runtime/src/index.ts` | `syncRetryTimer()` | 706 | Schedules retry timer |
| `ts/packages/runtime/src/index.ts` | `clearRetryTimer()` | 732 | Cancels retry timer |
| `ts/packages/orchestrator/src/index.ts` | `eligibleIssues()` | 58 | Filters + sorts candidates |
| `ts/packages/orchestrator/src/index.ts` | `claim()` | 91 | Reserves slot, creates RunningEntry |
| `ts/packages/orchestrator/src/index.ts` | `finish()` | 192 | Releases slot, schedules retry |
| `ts/packages/orchestrator/src/index.ts` | `cleanupIssue()` | 227 | Removes all tracking for issue |
| `ts/packages/orchestrator/src/index.ts` | `refreshRunningIssue()` | 168 | Updates issue data in-place |
| `ts/packages/dispatch/src/index.ts` | `issueIsActive()` | 18 | state ∈ active ∧ ∉ terminal |
| `ts/packages/dispatch/src/index.ts` | `issueHasOpenBlockers()` | 25 | Unstarted + unresolved blockers |
| `ts/packages/dispatch/src/index.ts` | `routedToThisWorker()` | 33 | Label routing + assignee check |
| `ts/packages/dispatch/src/index.ts` | `dispatchBlockReason()` | 45 | Global/local/worker capacity |
| `ts/packages/dispatch/src/index.ts` | `shouldDispatchIssue()` | 71 | Composite dispatch check |
| `ts/packages/dispatch/src/index.ts` | `firstUnclaimedSlot()` | 95 | Finds available ensemble slot |
| `ts/packages/dispatch/src/index.ts` | `sortForDispatch()` | 121 | Priority → createdAt → identifier |
| `ts/packages/agent-runner/src/index.ts` | `runAgentAttempt()` | 83 | Entry to agent execution |
| `ts/packages/agent-runner/src/index.ts` | `RunController.run()` | 90 | Workspace → session → turn loop |
| `ts/packages/agent-runner/src/index.ts` | `runTurnWithAbort()` | 209 | Single LLM turn execution |
| `ts/packages/policies/src/retry.ts` | `retryBackoffMs()` | 3 | Computes delay: continuation=1s, failure=exponential |
| `ts/packages/policies/src/reconciliation.ts` | `reconciliationStopReason()` | 12 | Why a tracked issue should stop |
| `ts/packages/retry-scheduler/src/index.ts` | `sync()` | 6 | Sets setTimeout for retry |
| `ts/packages/retry-scheduler/src/index.ts` | `clear()` | 19 | Cancels pending timer |
| `ts/packages/linear-tracker/src/index.ts` | `fetchCandidateIssues()` | 217 | Queries active issues from Linear |
| `ts/packages/linear-tracker/src/index.ts` | `fetchIssuesByIds()` | 256 | Batch fetch by ID |
| `ts/packages/issue/src/index.ts` | `normalizeIssue()` | 8 | Raw payload → Issue domain type |
| `ts/packages/issue/src/index.ts` | `isTerminalState()` | 61 | Checks if state is terminal |
| `ts/packages/issue/src/index.ts` | `ensembleSize()` | 51 | Reads `ensemble:N` label |
