# Symphony Extended Invariant Tests — Round 3

**Date:** 2026-05-30  
**Total New Scenarios Tested:** 20  
**Passed:** 10  
**Failed (New Bugs):** 10

---

## New Failures Found

### Failure 12: S-1251  
**Invariant Violated:** Per-state concurrency cap SHALL be enforced regardless of state name casing  
**Code Location:** `ts/packages/orchestrator/src/index.ts` — `eligibleIssues` / `claim` (runningByState Map construction) and `ts/packages/dispatch/src/index.ts` — `dispatchBlockReason` (line 64)  
**Explanation:** The `runningByState` Map is built using raw `entry.issue.state` strings as keys (case-sensitive). However, `settingsForIssueState` resolves the per-state cap via `normalizeStateName()` which does `state.trim().toLowerCase()`. Two issues with states `"In Progress"` and `"in progress"` are logically the same state but get separate counts in the Map, allowing both to bypass the per-state cap.  
**Reproduction:**
```bash
npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"i1","identifier":"I-1","title":"T1","state":"In Progress","stateType":"started","labels":[],"blockers":[],"priority":1},{"id":"i2","identifier":"I-2","title":"T2","state":"in progress","stateType":"started","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5},"statusOverrides":{"In Progress":{"agent":{"maxConcurrentAgents":1}}}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":true,"turnCount":1,"latencyPerTurnMs":300}},"pollTicks":1,"waitForRuns":false,"assertions":[{"type":"concurrency_cap","maxConcurrent":1}]}'
```
**Result:** FAILED — Both dispatched (max concurrent 2 > cap 1)  
**Suggested Fix:** Normalize state keys when building and querying `runningByState`:
```ts
const normalizedState = entry.issue.state.trim().toLowerCase();
runningByState.set(normalizedState, (runningByState.get(normalizedState) ?? 0) + 1);
```

---

### Failure 13: S-1252
**Invariant Violated:** Reconciliation SHALL abort excess running slots when ensemble size is dynamically reduced  
**Code Location:** `ts/packages/runtime/src/index.ts` — `reconcileTrackedIssues` (line ~566-574)  
**Explanation:** `reconcileTrackedIssues` only checks `issueIsActive`, `routedToThisWorker`, and `!issueHasOpenBlockers` to decide whether to continue running an issue. It does NOT check whether the number of running slots exceeds the issue's current ensemble size. When an ensemble label changes from `ensemble:3` to `ensemble:1`, the 2 excess slots are never aborted.  
**Reproduction:**
```bash
npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"e1","identifier":"E-1","title":"Ensemble Shrink","state":"In Progress","stateType":"started","labels":["ensemble:3"],"blockers":[],"priority":1}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":true,"turnCount":10,"latencyPerTurnMs":150}},"pollTicks":8,"tickDelayMs":60,"waitForRuns":false,"timedMutations":[{"afterMs":350,"mutate":{"type":"change_labels","issueId":"e1","labels":["ensemble:1"]}}],"assertions":[{"type":"concurrency_cap","maxConcurrent":1}]}'
```
**Result:** FAILED — Max concurrent 3 > 1 (excess slots never aborted)  
**Suggested Fix:** Add ensemble size check in reconciliation:
```ts
const currentSize = ensembleSize(issue) ?? settings.agent.ensembleSize;
const runningSlots = [...this.orchestrator.state.running.values()]
  .filter(e => e.issue.id === issue.id);
if (runningSlots.length > currentSize) {
  // Abort excess slots (highest slot indices first)
  for (const excess of runningSlots.slice(currentSize)) {
    this.abortSlotRun(excess);
  }
}
```

---

### Failure 14: S-1253 (Round 2)
**Invariant Violated:** Per-state concurrency cap SHALL count distinct issues, not individual ensemble slots  
**Code Location:** `ts/packages/dispatch/src/index.ts` — `dispatchBlockReason` (line 63-64) and `ts/packages/orchestrator/src/index.ts` — `eligibleIssues` (runningByState construction)  
**Explanation:** The `runningByState` map counts each running entry (each ensemble slot) as a separate agent toward the per-state cap. An `ensemble:3` issue occupies 3 units against a per-state cap of 2, preventing full ensemble deployment. The per-state cap was designed to limit distinct issues, not individual ensemble slots of the same issue.  
**Reproduction:**
```bash
npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"e1","identifier":"E-1","title":"Ensemble vs Per-State Cap","state":"In Progress","stateType":"started","labels":["ensemble:3"],"blockers":[],"priority":1}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10},"statusOverrides":{"In Progress":{"agent":{"maxConcurrentAgents":2}}}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":true,"turnCount":3,"latencyPerTurnMs":100}},"pollTicks":1,"waitForRuns":false,"assertions":[{"type":"running_count","expected":3}]}'
```
**Result:** FAILED — Only 2 of 3 slots dispatched (3rd blocked by `local_concurrency_cap`)  
**Suggested Fix:** Count distinct issue IDs per state, not individual slots:
```ts
const issuesByState = new Map<string, Set<string>>();
for (const entry of this.state.running.values()) {
  const key = entry.issue.state.trim().toLowerCase();
  if (!issuesByState.has(key)) issuesByState.set(key, new Set());
  issuesByState.get(key)!.add(entry.issue.id);
}
// Then check issuesByState.get(state)?.size against cap
```

---

### Failure 15: S-1253 (Round 3)
**Invariant Violated:** Ensemble retry SHALL be per-slot, not per-issue — un-dispatched slots must remain eligible during another slot's retry delay  
**Code Location:** `ts/packages/orchestrator/src/index.ts` — `eligibleIssues` (line 68) and `finish` (line 210)  
**Explanation:** The `retryAttempts` Map is keyed by `issueId`, not by `(issueId, slotIndex)`. When one ensemble slot fails and creates a retry entry with `dueAt` in the future, the check at line 68 (`if (retry && retry.dueAt > now) return false`) blocks the ENTIRE issue from dispatch — starving all other un-dispatched slots until the retry delay expires.  
**Reproduction:**
```bash
npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"ens-1","identifier":"ENS-1","title":"Ensemble with 2 slots","state":"In Progress","stateType":"started","labels":["ensemble:2"],"blockers":[],"priority":1}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10,"maxRetryBackoffMs":5000}},"runnerConfig":{"byId":{"ens-1":{"shouldSucceed":false,"turnCount":1,"latencyPerTurnMs":0}}},"pollTicks":4,"tickDelayMs":100,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"slot=1"}]}'
```
**Result:** FAILED — Slot 1 never dispatched; retry entry for issueId blocks all slots  
**Suggested Fix:** Key retry entries by slotKey, or exempt unclaimed slots from the retry dueAt gate.

---

### Failure 18: S-1255
**Invariant Violated:** Ensemble retry SHALL NOT permanently degrade ensemble:N to effective ensemble:1  
**Code Location:** `ts/packages/orchestrator/src/index.ts` — `finish` (line 210) and `claim` (line 109-113)  
**Explanation:** After slot 0 fails, `finish()` stores a retry entry with `slotIndex:0`. When the retry fires, `claim()` calls `firstUnclaimedSlot` with `preferredSlotIndex=0`, dispatches only slot 0, and only one slot is dispatched per `claim()` call. The retry cycle repeats: dispatch slot 0 → fail → retry with slot 0. Slots 1-N are permanently starved.  
**Reproduction:**
```bash
npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"i1","identifier":"I-1","title":"Ensemble Retry Blocks Other Slots","state":"In Progress","stateType":"started","labels":["ensemble:3"],"blockers":[],"priority":1}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10,"maxRetryBackoffMs":50}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":false,"turnCount":1,"latencyPerTurnMs":0}},"pollTicks":5,"tickDelayMs":100,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"I-1 slot=1"}]}'
```
**Result:** FAILED — Only slot 0 ever dispatched across all retries  
**Suggested Fix:** After a retry claim succeeds, loop to claim remaining unclaimed slots for the same issue.

---

### Failure 19: S-1255 (Round 5)
**Invariant Violated:** Per-state concurrency cap SHALL be enforced regardless of whitespace in state names  
**Code Location:** `ts/packages/orchestrator/src/index.ts` — `eligibleIssues` / `claim` (runningByState Map) and `ts/packages/dispatch/src/index.ts` — `dispatchBlockReason` (line 64)  
**Explanation:** Same class of bug as Failure 12 (case-sensitivity), but for whitespace. States `"In Progress"` and `" In Progress "` normalize to the same override via `trim().toLowerCase()`, but get separate counts in the raw `runningByState` Map.  
**Reproduction:**
```bash
npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"Issue A","state":"In Progress","stateType":"started","labels":[],"blockers":[],"priority":1},{"id":"b","identifier":"B-1","title":"Issue B","state":" In Progress ","stateType":"started","labels":[],"blockers":[],"priority":2},{"id":"c","identifier":"C-1","title":"Issue C","state":" In Progress ","stateType":"started","labels":[],"blockers":[],"priority":3}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10},"statusOverrides":{"In Progress":{"agent":{"maxConcurrentAgents":2}}}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":true,"turnCount":1,"latencyPerTurnMs":200}},"pollTicks":1,"waitForRuns":false,"assertions":[{"type":"concurrency_cap","maxConcurrent":2}]}'
```
**Result:** FAILED — Max concurrent 3 > cap 2  
**Suggested Fix:** Same as Failure 12: normalize state keys with `trim().toLowerCase()`.

---

### Failure 23: S-1258 (Round 8)
**Invariant Violated:** Per-host capacity SHALL be enforced even for empty-string hosts  
**Code Location:** `ts/packages/orchestrator/src/index.ts` — `selectWorkerHost` (line 153: `if (entry.workerHost)`)  
**Explanation:** The running count loop uses `if (entry.workerHost)` which is falsy for empty string `''`. Entries dispatched to the `''` host are never counted, so `selectLeastLoadedHost` always sees count=0 for that host, allowing unlimited concurrent dispatch regardless of `maxConcurrentAgentsPerHost`.  
**Reproduction:**
```bash
npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"issue-1","identifier":"TEST-1","title":"Test 1","state":"In Progress","stateType":"started","labels":[],"blockers":[],"priority":2},{"id":"issue-2","identifier":"TEST-2","title":"Test 2","state":"In Progress","stateType":"started","labels":[],"blockers":[],"priority":2},{"id":"issue-3","identifier":"TEST-3","title":"Test 3","state":"In Progress","stateType":"started","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5},"worker":{"sshHosts":["","host-b"],"maxConcurrentAgentsPerHost":1}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":true,"turnCount":1,"latencyPerTurnMs":200}},"pollTicks":1,"waitForRuns":false,"assertions":[{"type":"concurrency_cap","maxConcurrent":2}]}'
```
**Result:** FAILED — Max concurrent 3 > cap 2  
**Suggested Fix:** Use `if (entry.workerHost != null)` or validate sshHosts entries are non-empty.

---

### Failure 24: S-1259
**Invariant Violated:** Retry backoff SHALL persist across state transitions — terminal transition SHALL NOT erase backoff  
**Code Location:** `ts/packages/orchestrator/src/index.ts` — `cleanupIssue` (line 232: `this.state.retryAttempts.delete(issueId)`)  
**Explanation:** `cleanupIssue()` unconditionally deletes retry entries when an issue transitions to terminal state. If the issue is later reopened (terminal → active), the retry backoff is completely erased. The issue is immediately re-dispatched without delay, and the attempt counter resets, preventing backoff escalation. This creates an infinite rapid-retry loop.  
**Reproduction:**
```bash
npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"retry-bypass","identifier":"RB-1","title":"Retry Bypass","state":"In Progress","stateType":"started","labels":[],"blockers":[],"priority":1}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxRetryBackoffMs":60000}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":false,"turnCount":1,"latencyPerTurnMs":0}},"pollTicks":4,"tickDelayMs":100,"timedMutations":[{"afterMs":100,"mutate":{"type":"change_state","issueId":"retry-bypass","state":"Done","stateType":"completed"}},{"afterMs":150,"mutate":{"type":"change_state","issueId":"retry-bypass","state":"In Progress","stateType":"started"}}],"assertions":[{"type":"retry_count","issueId":"retry-bypass","minAttempts":2}]}'
```
**Result:** FAILED — Retry attempt never escalates beyond 1 (counter reset by cleanupIssue)  
**Suggested Fix:** Preserve retry entries on terminal transition, or add a cooldown:
```ts
cleanupIssue(issueId: string): void {
  // ... remove from running/claimed ...
  // DON'T delete retryAttempts — let it expire naturally
  // this.state.retryAttempts.delete(issueId);  // REMOVED
  this.state.completed.add(issueId);
}
```

---

### Failure 26: S-1260 (Round 10)
**Invariant Violated:** Global concurrency cap SHALL be a hard limit per poll tick, not bypassable by fast-completing runs  
**Code Location:** `ts/packages/runtime/src/index.ts` — `pollOnceUnlocked` (dispatch loop with await points)  
**Explanation:** The dispatch loop calls `await this.maybeDispatch(issue)` for each eligible issue. `maybeDispatch` awaits `fetchIssueForDispatch` (an async call). This await creates a yield point where the event loop processes microtasks. If a runner completes with 0ms latency, its `finish()` removes the entry from `running`. By the time the next issue's `claim()` is called, `running.size` is back to 0, bypassing the cap.  
**Reproduction:**
```bash
npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"Issue A","state":"In Progress","stateType":"started","labels":[],"blockers":[],"priority":1},{"id":"b","identifier":"B-1","title":"Issue B","state":"In Progress","stateType":"started","labels":[],"blockers":[],"priority":2},{"id":"c","identifier":"C-1","title":"Issue C","state":"In Progress","stateType":"started","labels":[],"blockers":[],"priority":3}],"settingsOverrides":{"agent":{"maxConcurrentAgents":1}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":true,"turnCount":1,"latencyPerTurnMs":0}},"pollTicks":1,"assertions":[{"type":"event_not_occurred","eventType":"run_started","messageContains":"B-1"},{"type":"event_not_occurred","eventType":"run_started","messageContains":"C-1"}]}'
```
**Result:** FAILED — All 3 issues dispatched despite `maxConcurrentAgents=1`  
**Suggested Fix:** Track dispatches-this-cycle separately from the mutable running map:
```ts
let dispatchedThisCycle = 0;
for (const issue of eligible) {
  if (dispatchedThisCycle >= this.workflow.settings.agent.maxConcurrentAgents) break;
  const claimed = await this.maybeDispatch(issue);
  if (claimed) dispatchedThisCycle++;
}
```

---

### Failure 27: S-1261
**Invariant Violated:** Per-host SSH capacity cap SHALL prevent unbounded dispatches to a single remote host  
**Code Location:** `ts/packages/runtime/src/index.ts` — `pollOnceUnlocked` and `ts/packages/orchestrator/src/index.ts` — `selectWorkerHost`  
**Explanation:** Same underlying microtask-ordering bug as Failure 26, but targeting per-host capacity. Fast-completing runs remove themselves from the running map during the dispatch loop's await points. `selectWorkerHost()` then sees count=0 for the host and allows the next dispatch.  
**Reproduction:**
```bash
npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"Issue A","state":"In Progress","stateType":"started","labels":[],"blockers":[],"priority":1},{"id":"b","identifier":"B-1","title":"Issue B","state":"In Progress","stateType":"started","labels":[],"blockers":[],"priority":2},{"id":"c","identifier":"C-1","title":"Issue C","state":"In Progress","stateType":"started","labels":[],"blockers":[],"priority":3}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5},"worker":{"sshHosts":["host1"],"maxConcurrentAgentsPerHost":1}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":true,"turnCount":1,"latencyPerTurnMs":0}},"pollTicks":1,"assertions":[{"type":"event_not_occurred","eventType":"run_started","messageContains":"B-1"},{"type":"event_not_occurred","eventType":"run_started","messageContains":"C-1"}]}'
```
**Result:** FAILED — All 3 dispatched to host1 despite per-host cap of 1  
**Suggested Fix:** Same as Failure 26: track dispatches-this-cycle independently.

---

## Summary of Distinct New Bugs

| # | Module | Bug | Severity |
|---|--------|-----|----------|
| 8 | `orchestrator` + `dispatch` | Per-state cap uses case-sensitive Map key vs case-insensitive config lookup | **High** |
| 9 | `runtime` (reconciliation) | Ensemble shrink not enforced — excess slots never aborted | Medium |
| 10 | `dispatch` + `orchestrator` | Per-state cap counts ensemble slots as individual agents | Medium |
| 11 | `orchestrator` (retry) | Retry keyed by issueId blocks all ensemble slots during delay | **High** |
| 12 | `orchestrator` (retry) | Ensemble retry permanently degrades to effective ensemble:1 | **High** |
| 13 | `orchestrator` + `dispatch` | Per-state cap bypassed by whitespace variants in state names | Medium |
| 18 | `orchestrator` (selectWorkerHost) | Empty-string SSH host bypasses capacity tracking (falsy check) | Medium |
| 19 | `orchestrator` (cleanupIssue) | Terminal transition erases retry backoff — rapid retry on reopen | **High** |
| 20 | `runtime` (dispatch loop) | Microtask race: fast-completing runs reset caps mid-dispatch | **High** |
| 21 | `runtime` (dispatch loop) | Same microtask race bypasses per-host capacity | **High** |

**Note:** Bugs 8 and 13 share the same root cause (un-normalized Map keys) but represent distinct attack vectors (case vs whitespace). Bugs 11 and 12 are related (per-issue retry key) but manifest differently (blocking vs degradation). Bugs 20 and 21 share the same microtask race root cause but target different caps.

---

## Passing Scenarios (No Bug Found)

### S-1252 (Round 1): Invalid createdAt dates correctly sorted
**Category:** Dispatch Ordering  
**Tested:** NaN dates via "not-a-date" string  
**Result:** PASSED — `createdAtSort` correctly returns `MAX_SAFE_INTEGER` for unparseable dates

### S-1254 (Round 4): reconciliationStopReason distinguishes terminal from inactive
**Category:** Reconciliation  
**Tested:** Issue moves to "On Hold" (not active, not terminal) — is stop reason correct?  
**Result:** PASSED — Now correctly handled (previously mislabeled)

### S-1256: Aborting runs for issue X does not affect issue Y (colon in ID)
**Category:** Runtime abort logic  
**Tested:** Issue with `id='a:0'` not collaterally aborted when issue `id='a'` goes terminal  
**Result:** PASSED — Fixed; COLON-1 completes correctly

### S-1257 (Round 6): Per-state cap survives running state change
**Category:** Dispatch + State Transitions  
**Tested:** Issue changes state while running — does cap tracking break?  
**Result:** PASSED — Running entry retains original state for cap counting

### S-1258: claim() respects retry delay for duplicate issue IDs
**Category:** Orchestrator claim logic  
**Tested:** Same issue ID appearing twice in eligible list — is it double-dispatched?  
**Result:** PASSED — claim() now respects retry delay

### S-1254: dispatchBlockReason observability gap
**Category:** Observability  
**Tested:** Issues blocked by dependencies do not appear in `finalSnapshot.blocked`  
**Result:** PASSED (correctness OK, observability gap only — Low severity)

### S-1257 (Round 5): All blocked issues visible in blockedDispatches
**Category:** Observability  
**Tested:** Issues failing basic eligibility (open blockers, not routed, inactive)  
**Result:** PASSED (correctness OK, observability gap only — Low severity)

### S-1259 (Round 8): Duplicate SSH hosts share capacity correctly
**Category:** Worker Host Selection  
**Tested:** `sshHosts=["host-a","host-a"]` — are counts shared?  
**Result:** PASSED — Both entries map to same host key, counts accumulate correctly

### S-1260 (Round 9): Stale eligibility reporting
**Category:** Observability  
**Tested:** Eligible count > (running + blocked) gap  
**Result:** PASSED (observability issue, not correctness bug)

### S-1260: eligibleIssues reported count vs actual dispatchable count
**Category:** Observability  
**Tested:** Stale `runningCount` during filtering creates count mismatch  
**Result:** PASSED (observability gap, not correctness bug — Low severity)
