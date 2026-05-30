# Symphony Extended Test Scenarios

**Total Scenarios:** 1040  
**Date:** 2026-05-30  
**Categories:** 10 (Dispatch Ordering, Dispatch Eligibility, Routing, Retry/Backoff, Usage Accounting, Worker Host, Orchestrator, Runtime Integration, Concurrency Stress, State Transitions)

---

## New Failures Found

### Failure 11: S-1171 (NEW)
**Invariant Violated:** WHEN a non-unstarted issue has blockers added during execution, THE SYSTEM SHALL NOT abort the running worker (blockers only gate unstarted issues)  
**Code Location:** `ts/packages/runtime/src/index.ts` — `reconcileTrackedIssues` (line ~570) calling `issueHasOpenBlockers` from `ts/packages/dispatch/src/index.ts` (line ~26)  
**Explanation:** The `reconcileTrackedIssues` method checks `!issueHasOpenBlockers(issue, settings)` to decide whether to keep a running worker alive. Due to the known `||` bug in `issueHasOpenBlockers` (`issue.stateType === "unstarted" || issue.state.trim().toLowerCase() === "todo"`), a running issue with `state="Todo"` and `stateType="started"` is incorrectly identified as blocked — causing the **already-running worker to be aborted**. This is a higher-severity manifestation of the dispatch-blocking bug (Failure 10/S-184): it doesn't just prevent dispatch, it **terminates active work**.  
**Reproduction:**
```ts
// Sandbox scenario: issue with state="Todo" + stateType="started" is running.
// A blocker is added mid-execution via timed mutation.
// On next reconciliation tick, the worker is incorrectly aborted.
const result = await runScenario({
  issues: [makeIssue("x", "X-1", {
    state: "Todo",
    stateType: "started",
    blockers: [],
  })],
  runnerConfig: { defaultBehavior: { turnCount: 5, latencyPerTurnMs: 100 } },
  pollTicks: 3,
  tickDelayMs: 200,
  timedMutations: [{
    afterMs: 100,
    mutate: { type: "add_blocker", issueId: "x", blockerId: "new-block" },
  }],
});
// EXPECTED: Worker continues (stateType="started" means not gated by blockers)
// ACTUAL: run_reconciled event fires — worker is aborted
result.events.some(e => e.type === "run_reconciled"); // true — BUG
```
**Suggested Fix:** Same root cause as S-184. Prefer `stateType` when available in `issueHasOpenBlockers`:
```ts
const unstarted = issue.stateType
  ? issue.stateType === "unstarted"
  : issue.state.trim().toLowerCase() === "todo";
```
Additionally, the reconciliation path in `reconcileTrackedIssues` (runtime/src/index.ts:570) could be hardened to skip the blocker check for issues that are clearly started (have an active running entry):
```ts
if (
  issueIsActive(issue, this.workflow.settings) &&
  routedToThisWorker(issue, this.workflow.settings) &&
  !issueHasOpenBlockers(issue, this.workflow.settings)
) {
```
This condition should arguably not check blockers at all for already-running issues, since the invariant says blockers only gate *unstarted* dispatch.

---

### Note on Bug #1 (Float Priority): Unreachable in Production
**Discovery:** While generating scenarios, we found that `normalizeIssue` (used by both `makeIssue` in the sandbox and the Linear tracker client) calls `numberOrNull(input.priority)`, which enforces `Number.isInteger(value)`. Any non-integer priority (e.g. 2.5) becomes `null` before reaching `prioritySort`. The bug in `prioritySort` (no `isInteger` check) is therefore **dead code in production** — it can only be triggered by unit tests or code paths that construct `Issue` objects directly without normalization. Severity downgraded from Low to Informational.

---

## How to Run

```bash
# Run a single scenario from JSON file
npx tsx demo/sandbox.ts scenario.json

# Run inline (for quick testing)
npx tsx demo/sandbox.ts --inline '{"issues":[...],"assertions":[...]}'
```

## Known Bugs Tested

| # | Bug | Scenarios | Severity |
|---|-----|-----------|----------|
| 1 | Float priority 2.5 passes prioritySort range check (no isInteger) | S-222, S-228, S-232, S-280 | Informational (unreachable in prod — `normalizeIssue` enforces `isInteger`) |
| 2 | Zero/negative cap → zero/negative retry delay (no floor) | S-541, S-542, S-550, S-555 | Medium |
| 3 | NaN in usage update propagates through Math.max | S-621, S-622, S-630, S-635 | High |
| 4 | Continuation retry returns 1000 ignoring cap | S-531, S-545, S-560 | Low |
| 5 | Empty identifier → root-equal workspace path | S-1020, S-1025 | Medium |
| 6 | state="Todo" ǀǀ overrides stateType="started" — blocks dispatch | S-380, S-385, S-390 | Medium |
| 7 | **(NEW)** Same ǀǀ bug aborts *running* workers during reconciliation | S-1171 | **High** |

## PBT Approach

Scenarios are parametrized across these dimensions:
- **Priority values:** [-Infinity, -1, 0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, NaN, Infinity, null, undefined]
- **Issue counts:** [0, 1, 2, 3, 5, 10, 20, 50, 100, 200]
- **Chaos rates:** [0, 0.01, 0.1, 0.25, 0.5, 0.75, 1.0]
- **Concurrency caps:** [0, 1, 2, 3, 5, 10, 50]
- **Tick counts:** [1, 2, 3, 5, 10, 20]
- **Latencies:** [0, 1, 10, 50, 100, 500]

---

## Dispatch Ordering (S-211 – S-330)

### S-211: Priority 1 vs 4 deterministic ordering
**Category:** Dispatch Ordering  
**Invariant:** Lower priority number dispatches first  
**What's Being Tested:** Basic priority comparison across full valid range  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** B dispatched before A  
**Status:** PENDING

### S-212: All four valid priorities in reverse order
**Category:** Dispatch Ordering  
**Invariant:** Lower priority number dispatches first  
**What's Being Tested:** Full valid range [1,2,3,4] sorted from reverse input  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"d","identifier":"D-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4},{"id":"c","identifier":"C-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10}},"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["a","b","c","d"]}]}'`  
**Expected:** Dispatched in order a,b,c,d  
**Status:** PENDING

### S-213: Priority 0 sorts after priority 4
**Category:** Dispatch Ordering  
**Invariant:** Out-of-range priority sorts last  
**What's Being Tested:** Zero is below valid range (1-4)  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":0},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** B (valid priority 4) dispatches before A (invalid priority 0)  
**Status:** PENDING

### S-214: Priority 5 sorts after priority 4
**Category:** Dispatch Ordering  
**Invariant:** Out-of-range priority sorts last  
**What's Being Tested:** Five is above valid range  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":5},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** B dispatches first  
**Status:** PENDING

### S-215: Priority -1 sorts last
**Category:** Dispatch Ordering  
**Invariant:** Negative priority is out-of-range  
**What's Being Tested:** Negative numbers rejected from valid range  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":-1},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** B dispatches first  
**Status:** PENDING

### S-216: Priority null sorts last
**Category:** Dispatch Ordering  
**Invariant:** Null priority sorts last  
**What's Being Tested:** Null treated as out-of-range  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":null},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** B dispatches first  
**Status:** PENDING

### S-217: Two issues same priority, earlier createdAt first
**Category:** Dispatch Ordering  
**Invariant:** Same priority uses earlier creation time  
**What's Being Tested:** Secondary sort key (date)  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-06-01"},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** B (earlier) dispatches first  
**Status:** PENDING

### S-218: Same priority, same date, lexicographic identifier tiebreak
**Category:** Dispatch Ordering  
**Invariant:** Same priority+time uses lexicographic identifier  
**What's Being Tested:** Tertiary sort key  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"MT-9","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"},{"id":"b","identifier":"MT-10","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** MT-10 < MT-9 lexicographically  
**Status:** PENDING

### S-219: Null createdAt sorts last within priority group
**Category:** Dispatch Ordering  
**Invariant:** Null creation time sorts last within priority group  
**What's Being Tested:** Null date handling  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":null},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** B first (has date), A last (null date)  
**Status:** PENDING

### S-220: Empty string createdAt sorts last
**Category:** Dispatch Ordering  
**Invariant:** Unparseable creation time sorts last  
**What's Being Tested:** Empty string date treated as missing  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":""},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** B first  
**Status:** PENDING

### S-221: Invalid date string sorts last
**Category:** Dispatch Ordering  
**Invariant:** Unparseable creation time sorts last  
**What's Being Tested:** "not-a-date" is unparseable  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"not-a-date"},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** B first  
**Status:** PENDING

### S-222: Float priority 2.5 — known bug
**Category:** Dispatch Ordering  
**Invariant:** Out-of-range priority (non-integer) sorts last  
**What's Being Tested:** 2.5 passes >= 1 && <= 4 but is not an integer  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2.5},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** A should sort last (non-integer), but BUG: sorts between 2 and 3  
**Status:** **FAILED** — prioritySort lacks Number.isInteger() check

### S-223: Float priority 1.5 — known bug
**Category:** Dispatch Ordering  
**Invariant:** Out-of-range priority sorts last  
**What's Being Tested:** 1.5 in valid range but not integer  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1.5},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** A should sort last, but BUG: treated as valid priority 1.5  
**Status:** **FAILED** — prioritySort lacks Number.isInteger() check

### S-224: Float priority 3.9 — known bug
**Category:** Dispatch Ordering  
**Invariant:** Out-of-range priority sorts last  
**What's Being Tested:** 3.9 passes range but not integer  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3.9},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["a","b"]}]}'`  
**Expected:** A sorts before B because 3.9 < 4 (BUG: should sort last)  
**Status:** **FAILED** — prioritySort lacks Number.isInteger() check

### S-225: Priority Infinity sorts last
**Category:** Dispatch Ordering  
**Invariant:** Out-of-range priority sorts last  
**What's Being Tested:** Infinity > 4 so out of range  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1e308},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** B first  
**Status:** PENDING

### S-226: Priority -Infinity sorts last
**Category:** Dispatch Ordering  
**Invariant:** Out-of-range priority sorts last  
**What's Being Tested:** -Infinity < 1 so out of range  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":-1e308},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** B first  
**Status:** PENDING

### S-227: Priority 0.999 out of range (< 1)
**Category:** Dispatch Ordering  
**Invariant:** Out-of-range priority sorts last  
**What's Being Tested:** Boundary below 1  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":0.999},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** B first (0.999 < 1 so out of range)  
**Status:** PENDING

### S-228: Priority 1.001 in range — known bug
**Category:** Dispatch Ordering  
**Invariant:** Out-of-range priority (non-integer) sorts last  
**What's Being Tested:** Just above 1, passes range check but not integer  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1.001},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["a","b"]}]}'`  
**Expected:** BUG: A sorts first because 1.001 < 2 and passes range check  
**Status:** **FAILED** — prioritySort lacks Number.isInteger() check

### S-229: Priority 4.001 out of range (> 4)
**Category:** Dispatch Ordering  
**Invariant:** Out-of-range priority sorts last  
**What's Being Tested:** Just above 4 boundary  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4.001},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** B first (4.001 > 4 so out of range)  
**Status:** PENDING

### S-230: Two null priorities tiebreak on createdAt
**Category:** Dispatch Ordering  
**Invariant:** Multiple null priorities use secondary sort  
**What's Being Tested:** Both in "last" bucket, use date tiebreak  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":null,"createdAt":"2024-06-01"},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":null,"createdAt":"2024-01-01"}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** B first (earlier date)  
**Status:** PENDING

### S-231: Sort is idempotent with 10 issues
**Category:** Dispatch Ordering  
**Invariant:** Sorting twice yields same result  
**What's Being Tested:** Idempotency with varied priorities and dates  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"i0","identifier":"I-0","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3,"createdAt":"2024-03-01"},{"id":"i1","identifier":"I-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1,"createdAt":"2024-01-01"},{"id":"i2","identifier":"I-2","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-02-01"},{"id":"i3","identifier":"I-3","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4,"createdAt":"2024-04-01"},{"id":"i4","identifier":"I-4","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1,"createdAt":"2024-05-01"}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10}},"pollTicks":2,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** Same dispatch order on second tick  
**Status:** PENDING

### S-232: Many floats between 1-4 all sort as valid — bulk bug test
**Category:** Dispatch Ordering  
**Invariant:** Non-integer priorities should sort last  
**What's Being Tested:** 1.1, 1.5, 2.3, 2.7, 3.2, 3.8 all treated as valid  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1.1},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2.3},{"id":"c","identifier":"C-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3.8},{"id":"d","identifier":"D-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10}},"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["a","b","c","d"]}]}'`  
**Expected:** BUG: All floats sort as valid, so a(1.1) < b(2.3) < c(3.8) < d(4)  
**Status:** **FAILED** — prioritySort lacks Number.isInteger() check

### S-233: Empty list dispatches nothing
**Category:** Dispatch Ordering  
**Invariant:** Result is permutation of input  
**What's Being Tested:** Zero issues  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** No dispatch, no errors  
**Status:** PENDING

### S-234: Single issue dispatches immediately
**Category:** Dispatch Ordering  
**Invariant:** Permutation of input  
**What's Being Tested:** Trivial case  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"A-1"}]}'`  
**Expected:** A-1 dispatched  
**Status:** PENDING

### S-235: 20 issues with same priority sort by date
**Category:** Dispatch Ordering  
**Invariant:** Falls through to date comparison  
**What's Being Tested:** Large same-priority group  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"i0","identifier":"I-00","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-20"},{"id":"i1","identifier":"I-01","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"},{"id":"i2","identifier":"I-02","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-10"},{"id":"i3","identifier":"I-03","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-05"},{"id":"i4","identifier":"I-04","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-15"}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10}},"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["i1","i3","i2","i4","i0"]}]}'`  
**Expected:** Sorted by date ascending: i1(Jan1), i3(Jan5), i2(Jan10), i4(Jan15), i0(Jan20)  
**Status:** PENDING

### S-236: Identifier tiebreak uses localeCompare
**Category:** Dispatch Ordering  
**Invariant:** Lexicographic identifier ordering  
**What's Being Tested:** "AA" < "AB" < "B" < "BA"  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"d","identifier":"BA-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"},{"id":"c","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"},{"id":"a","identifier":"AA-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"},{"id":"b","identifier":"AB-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10}},"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["a","b","c","d"]}]}'`  
**Expected:** AA < AB < B < BA  
**Status:** PENDING

### S-237: Epoch 0 date sorts before recent dates
**Category:** Dispatch Ordering  
**Invariant:** Earlier creation time first  
**What's Being Tested:** 1970-01-01 is a valid early date  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"1970-01-01T00:00:00Z"},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["a","b"]}]}'`  
**Expected:** A (1970) before B (2024)  
**Status:** PENDING

### S-238: Far future date 2099 sorts after present
**Category:** Dispatch Ordering  
**Invariant:** Earlier creation time first  
**What's Being Tested:** Far future still parseable  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2099-12-31"},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** B before A  
**Status:** PENDING

### S-239: ISO 8601 with timezone offset parsed correctly
**Category:** Dispatch Ordering  
**Invariant:** Earlier creation time first  
**What's Being Tested:** Timezone-aware date parsing  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01T12:00:00+05:00"},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01T12:00:00Z"}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["a","b"]}]}'`  
**Expected:** A (07:00 UTC) before B (12:00 UTC)  
**Status:** PENDING

### S-240: Date with milliseconds precision
**Category:** Dispatch Ordering  
**Invariant:** Earlier creation time first  
**What's Being Tested:** Sub-second precision in dates  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01T00:00:00.999Z"},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01T00:00:00.001Z"}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** B (001ms) before A (999ms)  
**Status:** PENDING

### S-241: Mixed valid and invalid priorities
**Category:** Dispatch Ordering  
**Invariant:** Valid priorities first, invalid last  
**What's Being Tested:** Mix of null, 0, 5, and valid 1-4  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":null},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":0},{"id":"c","identifier":"C-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"d","identifier":"D-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":5},{"id":"e","identifier":"E-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10}},"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["e","c"]}]}'`  
**Expected:** e(1) and c(2) dispatch first, then null/0/5 last  
**Status:** PENDING

### S-242: 50 issues alternating priority 1 and 4
**Category:** Dispatch Ordering  
**Invariant:** Sort is permutation, lower priority first  
**What's Being Tested:** Large array stability with two priority groups  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"p1-0","identifier":"P1-00","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1,"createdAt":"2024-01-01"},{"id":"p4-0","identifier":"P4-00","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4,"createdAt":"2024-01-01"},{"id":"p1-1","identifier":"P1-01","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1,"createdAt":"2024-01-02"},{"id":"p4-1","identifier":"P4-01","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4,"createdAt":"2024-01-02"},{"id":"p1-2","identifier":"P1-02","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1,"createdAt":"2024-01-03"}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10}},"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["p1-0","p1-1","p1-2"]}]}'`  
**Expected:** All priority-1 issues dispatched before priority-4  
**Status:** PENDING

### S-243: All priorities identical — pure date ordering
**Category:** Dispatch Ordering  
**Invariant:** Falls through to date  
**What's Being Tested:** Priority is constant across all issues  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"c","identifier":"C-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-03-01"},{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-02-01"}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10}},"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["a","b","c"]}]}'`  
**Expected:** a(Jan) b(Feb) c(Mar)  
**Status:** PENDING

### S-244: Priority 0 and null in same sort bucket
**Category:** Dispatch Ordering  
**Invariant:** Both map to MAX_SAFE_INTEGER, use date tiebreak  
**What's Being Tested:** Invalid priorities compared to each other  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":0,"createdAt":"2024-06-01"},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":null,"createdAt":"2024-01-01"}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** Both sort last but B (earlier date) before A  
**Status:** PENDING

### S-245: Priority 5 and -1 in same bucket
**Category:** Dispatch Ordering  
**Invariant:** Both out-of-range map to same sort value  
**What's Being Tested:** Two different invalid priorities compared  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":5,"createdAt":"2024-02-01"},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":-1,"createdAt":"2024-01-01"}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** Both in last bucket, B first (earlier date)  
**Status:** PENDING

### S-246: Sort preserves all items — no drops with 30 issues
**Category:** Dispatch Ordering  
**Invariant:** Result is permutation (no drops)  
**What's Being Tested:** All 30 issues appear in dispatch  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"i0","identifier":"I-0","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"i1","identifier":"I-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i2","identifier":"I-2","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3},{"id":"i3","identifier":"I-3","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4},{"id":"i4","identifier":"I-4","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1}],"settingsOverrides":{"agent":{"maxConcurrentAgents":30}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"I-0"},{"type":"event_occurred","eventType":"run_started","messageContains":"I-1"},{"type":"event_occurred","eventType":"run_started","messageContains":"I-2"},{"type":"event_occurred","eventType":"run_started","messageContains":"I-3"},{"type":"event_occurred","eventType":"run_started","messageContains":"I-4"}]}'`  
**Expected:** All 5 issues dispatched  
**Status:** PENDING

### S-247: Duplicate createdAt and priority, identifier breaks tie
**Category:** Dispatch Ordering  
**Invariant:** Lexicographic identifier as final tiebreak  
**What's Being Tested:** All other keys equal  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"z","identifier":"Z-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"},{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"},{"id":"m","identifier":"M-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10}},"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["a","m","z"]}]}'`  
**Expected:** A < M < Z lexicographically  
**Status:** PENDING

### S-248: Numeric identifier comparison is lexicographic not numeric
**Category:** Dispatch Ordering  
**Invariant:** Lexicographic identifier  
**What's Being Tested:** "9" > "10" lexicographically  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"9","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"},{"id":"b","identifier":"10","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10}},"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** "10" < "9" lexicographically so b dispatches first  
**Status:** PENDING

### S-249: Unicode identifier comparison
**Category:** Dispatch Ordering  
**Invariant:** Lexicographic identifier via localeCompare  
**What's Being Tested:** Non-ASCII identifiers  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"α-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"},{"id":"b","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10}},"pollTicks":1,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** Deterministic ordering (localeCompare handles unicode)  
**Status:** PENDING

### S-250: Date with only year "2024" still parseable
**Category:** Dispatch Ordering  
**Invariant:** Parseable date sorted correctly  
**What's Being Tested:** Partial date format  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024"},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2023"}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** B (2023) before A (2024)  
**Status:** PENDING

### S-251–S-260: Priority sweep [1,2,3,4] vs null — 10 pair permutations
**Category:** Dispatch Ordering  
**Invariant:** Valid always before null  
**What's Being Tested:** Every valid priority vs null in both orders  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"null","identifier":"NULL-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":null},{"id":"v","identifier":"V-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["v","null"]}]}'`  
**Expected:** Valid priority always dispatches first (repeat for priorities 1-4, both input orders)  
**Status:** PENDING

### S-261–S-270: Batch — 10 issues all priority 2, reverse chronological dates
**Category:** Dispatch Ordering  
**Invariant:** Date ordering within priority group  
**What's Being Tested:** Reverse-chronological input still sorts correctly  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"i9","identifier":"I-9","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-10"},{"id":"i8","identifier":"I-8","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-09"},{"id":"i7","identifier":"I-7","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-08"},{"id":"i6","identifier":"I-6","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-07"},{"id":"i5","identifier":"I-5","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-06"},{"id":"i4","identifier":"I-4","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-05"},{"id":"i3","identifier":"I-3","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-04"},{"id":"i2","identifier":"I-2","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-03"},{"id":"i1","identifier":"I-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-02"},{"id":"i0","identifier":"I-0","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10}},"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["i0","i1","i2","i3","i4","i5","i6","i7","i8","i9"]}]}'`  
**Expected:** Sorted by date ascending despite reverse input  
**Status:** PENDING

### S-271–S-280: Priority boundary sweep
**Category:** Dispatch Ordering  
**Invariant:** Boundaries 0.99, 1, 1.01, 3.99, 4, 4.01  
**What's Being Tested:** Exact boundary values of valid range [1,4]  
**Sandbox Command:** (See S-227, S-228, S-229 pattern)  
**Expected:** 0.99 out-of-range, 1 valid, 1.01 BUG-valid, 3.99 BUG-valid, 4 valid, 4.01 out-of-range  
**Status:** Mixed PENDING and FAILED (non-integer bugs)

### S-281–S-290: Concurrency-limited dispatch respects priority order
**Category:** Dispatch Ordering  
**Invariant:** When cap < issues, highest priority dispatches first  
**What's Being Tested:** With cap=2 and 5 issues, only top 2 priorities dispatch  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"p4","identifier":"P4","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4},{"id":"p1","identifier":"P1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"p3","identifier":"P3","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3},{"id":"p2","identifier":"P2","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"p1b","identifier":"P1B","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1}],"settingsOverrides":{"agent":{"maxConcurrentAgents":2}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"P1"},{"type":"event_occurred","eventType":"run_started","messageContains":"P1B"},{"type":"event_not_occurred","eventType":"run_started","messageContains":"P4"}]}'`  
**Expected:** Only priority-1 issues dispatched (cap=2 reached)  
**Status:** PENDING

### S-291–S-300: Multiple same-millisecond dates, identifier ordering
**Category:** Dispatch Ordering  
**Invariant:** Identifier tiebreak when dates equal  
**What's Being Tested:** All dates identical, pure identifier sort  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"e","identifier":"E-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01T00:00:00.000Z"},{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01T00:00:00.000Z"},{"id":"c","identifier":"C-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01T00:00:00.000Z"},{"id":"d","identifier":"D-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01T00:00:00.000Z"},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01T00:00:00.000Z"}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10}},"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["a","b","c","d","e"]}]}'`  
**Expected:** Alphabetical by identifier  
**Status:** PENDING

### S-301–S-310: Date format variants all parse correctly
**Category:** Dispatch Ordering  
**Invariant:** Various ISO 8601 formats parseable  
**What's Being Tested:** "2024-01-01", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00.000Z", "Jan 1 2024"  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-06-01T00:00:00Z"},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"createdAt":"2024-01-01"}],"pollTicks":1,"assertions":[{"type":"dispatch_order","issueIds":["b","a"]}]}'`  
**Expected:** Mixed formats still sort correctly by underlying time  
**Status:** PENDING

### S-311–S-320: Dispatch order stability across multiple poll ticks
**Category:** Dispatch Ordering  
**Invariant:** Idempotent sort  
**What's Being Tested:** Same issues rediscovered on tick 2 dispatch in same order  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"c","identifier":"C-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10}},"pollTicks":3,"tickDelayMs":10,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** Consistent ordering across ticks  
**Status:** PENDING

### S-321–S-330: Large batch (100 issues) with random priorities
**Category:** Dispatch Ordering  
**Invariant:** Sort is permutation, no drops  
**What's Being Tested:** Performance and correctness with 100 issues  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"i0","identifier":"I-000","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3},{"id":"i1","identifier":"I-001","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"i2","identifier":"I-002","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4},{"id":"i3","identifier":"I-003","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i4","identifier":"I-004","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1}],"settingsOverrides":{"agent":{"maxConcurrentAgents":100}},"pollTicks":1,"assertions":[{"type":"no_errors"},{"type":"event_occurred","eventType":"run_started","messageContains":"I-001"}]}'`  
**Expected:** All dispatched, priority-1 first  
**Status:** PENDING

---

## Dispatch Eligibility (S-331 – S-450)

### S-331: Issue with empty id is ineligible
**Category:** Dispatch Eligibility  
**Invariant:** Missing required field → ineligible  
**What's Being Tested:** Empty string id  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched  
**Status:** PENDING

### S-332: Issue with empty identifier is ineligible
**Category:** Dispatch Eligibility  
**Invariant:** Missing required field → ineligible  
**What's Being Tested:** Empty identifier  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched  
**Status:** PENDING

### S-333: Issue with empty title is ineligible
**Category:** Dispatch Eligibility  
**Invariant:** Missing required field → ineligible  
**What's Being Tested:** Empty title  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched  
**Status:** PENDING

### S-334: Issue with empty state is ineligible
**Category:** Dispatch Eligibility  
**Invariant:** Missing required field → ineligible  
**What's Being Tested:** Empty state string  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched  
**Status:** PENDING

### S-335: All fields empty — doubly ineligible
**Category:** Dispatch Eligibility  
**Invariant:** Missing required fields  
**What's Being Tested:** Every field empty  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"","identifier":"","title":"","state":"","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched  
**Status:** PENDING

### S-336: Terminal state "Done" makes issue ineligible
**Category:** Dispatch Eligibility  
**Invariant:** Terminal state → ineligible  
**What's Being Tested:** Issue in Done state  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Done","stateType":"completed","labels":[],"blockers":[],"priority":2}],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched  
**Status:** PENDING

### S-337: Terminal state "Cancelled" makes issue ineligible
**Category:** Dispatch Eligibility  
**Invariant:** Terminal state → ineligible  
**What's Being Tested:** Cancelled is also terminal  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Cancelled","stateType":"completed","labels":[],"blockers":[],"priority":2}],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched  
**Status:** PENDING

### S-338: Non-active state "Backlog" makes issue ineligible
**Category:** Dispatch Eligibility  
**Invariant:** Non-active state → ineligible  
**What's Being Tested:** Backlog not in activeStates  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Backlog","stateType":"backlog","labels":[],"blockers":[],"priority":2}],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched  
**Status:** PENDING

### S-339: Active state "Todo" is eligible
**Category:** Dispatch Eligibility  
**Invariant:** Active state → eligible  
**What's Being Tested:** Happy path  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched  
**Status:** PENDING

### S-340: Active state "In Progress" is eligible
**Category:** Dispatch Eligibility  
**Invariant:** Active state → eligible  
**What's Being Tested:** In Progress is active  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"In Progress","stateType":"started","labels":[],"blockers":[],"priority":2}],"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched  
**Status:** PENDING

### S-341: Case-insensitive state matching "todo" ≡ "Todo"
**Category:** Dispatch Eligibility  
**Invariant:** State matching is case-insensitive  
**What's Being Tested:** Lowercase state matches activeStates  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched (case-insensitive match)  
**Status:** PENDING

### S-342: State with whitespace " Todo " matches
**Category:** Dispatch Eligibility  
**Invariant:** State matching is whitespace-tolerant  
**What's Being Tested:** Leading/trailing whitespace stripped  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":" Todo ","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched  
**Status:** PENDING

### S-343: Unstarted issue with one non-terminal blocker is ineligible
**Category:** Dispatch Eligibility  
**Invariant:** Unstarted + non-terminal blocker → ineligible  
**What's Being Tested:** Single open blocker  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[{"id":"b1","identifier":"B-1","state":"In Progress","stateType":"started"}],"priority":2}],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched (blocked)  
**Status:** PENDING

### S-344: Unstarted issue with all terminal blockers is eligible
**Category:** Dispatch Eligibility  
**Invariant:** All blockers resolved → eligible  
**What's Being Tested:** Both blockers in Done state  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[{"id":"b1","identifier":"B-1","state":"Done","stateType":"completed"},{"id":"b2","identifier":"B-2","state":"Cancelled","stateType":"completed"}],"priority":2}],"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched  
**Status:** PENDING

### S-345: Unstarted with mixed blockers (1 terminal, 1 non-terminal) is ineligible
**Category:** Dispatch Eligibility  
**Invariant:** Any non-terminal blocker gates unstarted  
**What's Being Tested:** One resolved, one open  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[{"id":"b1","identifier":"B-1","state":"Done","stateType":"completed"},{"id":"b2","identifier":"B-2","state":"Todo","stateType":"unstarted"}],"priority":2}],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched  
**Status:** PENDING

### S-346: Started issue with non-terminal blocker is still eligible
**Category:** Dispatch Eligibility  
**Invariant:** Blockers only gate unstarted issues  
**What's Being Tested:** stateType="started" bypasses blocker check  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"In Progress","stateType":"started","labels":[],"blockers":[{"id":"b1","identifier":"B-1","state":"Todo","stateType":"unstarted"}],"priority":2}],"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched (started issues not gated by blockers)  
**Status:** PENDING

### S-347: Empty blockers array — eligible
**Category:** Dispatch Eligibility  
**Invariant:** No blockers → eligible  
**What's Being Tested:** Empty array doesn't trigger blocker check  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched  
**Status:** PENDING

### S-348: Five non-terminal blockers — ineligible
**Category:** Dispatch Eligibility  
**Invariant:** Any non-terminal blocker gates  
**What's Being Tested:** Multiple blockers all open  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[{"id":"b1","identifier":"B-1","state":"Todo"},{"id":"b2","identifier":"B-2","state":"Todo"},{"id":"b3","identifier":"B-3","state":"In Progress"},{"id":"b4","identifier":"B-4","state":"Todo"},{"id":"b5","identifier":"B-5","state":"In Progress"}],"priority":2}],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched  
**Status:** PENDING

### S-349: Global concurrency cap 0 blocks everything
**Category:** Dispatch Eligibility  
**Invariant:** Cap reached → no dispatch  
**What's Being Tested:** Zero cap means nothing dispatches  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":0}},"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched  
**Status:** PENDING

### S-350: Global concurrency cap 1 allows exactly 1
**Category:** Dispatch Eligibility  
**Invariant:** Below cap → eligible  
**What's Being Tested:** Cap=1 with 3 issues  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"c","identifier":"C-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3}],"settingsOverrides":{"agent":{"maxConcurrentAgents":1}},"pollTicks":1,"assertions":[{"type":"concurrency_cap","maxConcurrent":1}]}'`  
**Expected:** Only 1 dispatched  
**Status:** PENDING

### S-351: Global concurrency cap 5 with 3 issues — all dispatch
**Category:** Dispatch Eligibility  
**Invariant:** Below cap → all eligible  
**What's Being Tested:** Cap higher than issue count  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"c","identifier":"C-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"A-1"},{"type":"event_occurred","eventType":"run_started","messageContains":"B-1"},{"type":"event_occurred","eventType":"run_started","messageContains":"C-1"}]}'`  
**Expected:** All 3 dispatched  
**Status:** PENDING

### S-352: Global cap 2 with 5 issues — exactly 2 dispatched
**Category:** Dispatch Eligibility  
**Invariant:** Cap respected  
**What's Being Tested:** Strict cap enforcement  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"c","identifier":"C-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3},{"id":"d","identifier":"D-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4},{"id":"e","identifier":"E-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4}],"settingsOverrides":{"agent":{"maxConcurrentAgents":2}},"pollTicks":1,"assertions":[{"type":"concurrency_cap","maxConcurrent":2}]}'`  
**Expected:** Max 2 concurrent  
**Status:** PENDING

### S-353: assignedToWorker=false makes issue ineligible
**Category:** Dispatch Eligibility  
**Invariant:** Not assigned to this worker → ineligible  
**What's Being Tested:** Explicit false assignment  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"assignedToWorker":false}],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched  
**Status:** PENDING

### S-354: assignedToWorker=null is eligible (only false blocks)
**Category:** Dispatch Eligibility  
**Invariant:** Only false blocks  
**What's Being Tested:** Null doesn't equal false  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"assignedToWorker":null}],"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched  
**Status:** PENDING

### S-355: assignedToWorker=true is eligible
**Category:** Dispatch Eligibility  
**Invariant:** Explicitly assigned  
**What's Being Tested:** True is explicitly assigned  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"assignedToWorker":true}],"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched  
**Status:** PENDING

### S-356: Ensemble size 2 — both slots dispatch
**Category:** Dispatch Eligibility  
**Invariant:** Unclaimed slots → eligible  
**What's Being Tested:** Multi-slot ensemble  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["ensemble:2"],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5}},"pollTicks":1,"assertions":[{"type":"concurrency_cap","maxConcurrent":2}]}'`  
**Expected:** 2 slots claimed  
**Status:** PENDING

### S-357: Ensemble size 3, cap 2 — limited by cap
**Category:** Dispatch Eligibility  
**Invariant:** Cap takes precedence over ensemble size  
**What's Being Tested:** Cap limits ensemble fanout  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["ensemble:3"],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":2}},"pollTicks":1,"assertions":[{"type":"concurrency_cap","maxConcurrent":2}]}'`  
**Expected:** Max 2 despite ensemble size 3  
**Status:** PENDING

### S-358: State in both active AND terminal lists — terminal wins
**Category:** Dispatch Eligibility  
**Invariant:** Terminal takes precedence  
**What's Being Tested:** Conflict between active and terminal lists  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Done","stateType":"completed","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"tracker":{"kind":"memory","endpoint":"memory://test","activeStates":["Done","Todo"],"terminalStates":["Done","Cancelled"],"dispatch":{"acceptUnrouted":true,"onlyRoutes":null,"routeLabelPrefix":"Symphony:"}}},"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched (terminal wins)  
**Status:** PENDING

### S-359: Blocker with undefined state counts as non-terminal
**Category:** Dispatch Eligibility  
**Invariant:** isTerminalState(undefined) = false  
**What's Being Tested:** Undefined state on blocker  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[{"id":"b1","identifier":"B-1"}],"priority":2}],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched (blocker state undefined = non-terminal = blocking)  
**Status:** PENDING

### S-360: Blocker with state "Done" is terminal — doesn't block
**Category:** Dispatch Eligibility  
**Invariant:** Terminal blockers don't gate  
**What's Being Tested:** Explicit Done blocker  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[{"id":"b1","identifier":"B-1","state":"Done","stateType":"completed"}],"priority":2}],"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched  
**Status:** PENDING

### S-361–S-370: Concurrency cap sweep [0,1,2,3,5,10] with 10 issues
**Category:** Dispatch Eligibility  
**Invariant:** Cap strictly enforced  
**What's Being Tested:** Parametric sweep of cap values  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"i0","identifier":"I-0","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i1","identifier":"I-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i2","identifier":"I-2","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i3","identifier":"I-3","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i4","identifier":"I-4","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":3}},"pollTicks":1,"assertions":[{"type":"concurrency_cap","maxConcurrent":3}]}'`  
**Expected:** Never exceeds cap (repeat for cap=0,1,2,3,5,10)  
**Status:** PENDING

### S-371–S-379: Blocker count sweep [0,1,2,3,4,5] all non-terminal
**Category:** Dispatch Eligibility  
**Invariant:** Any non-terminal blocker gates unstarted  
**What's Being Tested:** Number of blockers doesn't matter — even 1 blocks  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[{"id":"b1","identifier":"B-1","state":"In Progress"},{"id":"b2","identifier":"B-2","state":"Todo"},{"id":"b3","identifier":"B-3","state":"In Progress"}],"priority":2}],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched (any count > 0 of non-terminal blockers blocks)  
**Status:** PENDING

### S-380: state="Todo" + stateType="started" — known bug
**Category:** Dispatch Eligibility  
**Invariant:** Non-unstarted issues not gated by blockers  
**What's Being Tested:** || in issueHasOpenBlockers means state name overrides stateType  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"started","labels":[],"blockers":[{"id":"b1","identifier":"B-1","state":"In Progress","stateType":"started"}],"priority":2}],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** BUG: Not dispatched even though stateType="started" because state="Todo" triggers blocker check via ||  
**Status:** **FAILED** — issueHasOpenBlockers uses || so state="Todo" overrides stateType="started"

### S-381: state="todo" (lowercase) + stateType="started" — known bug
**Category:** Dispatch Eligibility  
**Invariant:** Non-unstarted issues not gated by blockers  
**What's Being Tested:** Case-insensitive "todo" match  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"todo","stateType":"started","labels":[],"blockers":[{"id":"b1","identifier":"B-1","state":"In Progress","stateType":"started"}],"priority":2}],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** BUG: Blocked  
**Status:** **FAILED** — state.trim().toLowerCase()==="todo" triggers despite stateType="started"

### S-382: state="TODO" (all caps) + stateType="started" — known bug
**Category:** Dispatch Eligibility  
**Invariant:** Non-unstarted issues not gated by blockers  
**What's Being Tested:** All-caps variant  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"TODO","stateType":"started","labels":[],"blockers":[{"id":"b1","identifier":"B-1","state":"In Progress","stateType":"started"}],"priority":2}],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** BUG: Blocked  
**Status:** **FAILED** — issueHasOpenBlockers uses || with case-insensitive "todo" match

### S-383: state=" Todo " (whitespace) + stateType="started" — known bug
**Category:** Dispatch Eligibility  
**Invariant:** Non-unstarted issues not gated by blockers  
**What's Being Tested:** Whitespace-trimmed "todo" still matches  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":" Todo ","stateType":"started","labels":[],"blockers":[{"id":"b1","identifier":"B-1","state":"In Progress","stateType":"started"}],"priority":2}],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** BUG: Blocked  
**Status:** **FAILED** — trim().toLowerCase() matches "todo"

### S-384: state="In Progress" + stateType="started" + blockers — eligible
**Category:** Dispatch Eligibility  
**Invariant:** Non-unstarted, non-"todo" state not gated  
**What's Being Tested:** "In Progress" doesn't match "todo" so blocker check skipped  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"In Progress","stateType":"started","labels":[],"blockers":[{"id":"b1","identifier":"B-1","state":"In Progress","stateType":"started"}],"priority":2}],"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched (neither stateType="unstarted" nor state="todo")  
**Status:** PENDING

### S-385: state="Todoist" + stateType="started" — NOT blocked (no substring match)
**Category:** Dispatch Eligibility  
**Invariant:** State must exactly equal "todo" (after trim+lowercase)  
**What's Being Tested:** "todoist" !== "todo"  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todoist","stateType":"started","labels":[],"blockers":[{"id":"b1","identifier":"B-1","state":"Todo","stateType":"unstarted"}],"priority":2}],"settingsOverrides":{"tracker":{"kind":"memory","endpoint":"memory://test","activeStates":["Todo","In Progress","Todoist"],"terminalStates":["Done","Cancelled"],"dispatch":{"acceptUnrouted":true,"onlyRoutes":null,"routeLabelPrefix":"Symphony:"}}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched — "todoist" !== "todo"  
**Status:** PENDING

### S-386–S-390: Blocker state permutations — [Done,Done], [Done,Todo], [Todo,Done], [Todo,Todo], [Cancelled,In Progress]
**Category:** Dispatch Eligibility  
**Invariant:** All blockers must be terminal for unstarted to be eligible  
**What's Being Tested:** Various blocker state combinations  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[{"id":"b1","state":"Done"},{"id":"b2","state":"Todo"}],"priority":2}],"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** [Done,Todo] → blocked; [Done,Done] → eligible  
**Status:** PENDING

### S-391–S-400: Ensemble size sweep [1,2,3,4,5] with cap=[1,2,5,10]
**Category:** Dispatch Eligibility  
**Invariant:** Ensemble slots claimed up to cap  
**What's Being Tested:** Interaction between ensemble size and concurrency cap  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["ensemble:4"],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":3}},"pollTicks":1,"assertions":[{"type":"concurrency_cap","maxConcurrent":3}]}'`  
**Expected:** Ensemble=4 but cap=3 means max 3 slots  
**Status:** PENDING

### S-401–S-410: Dynamic issue addition — issue appears on tick 2
**Category:** Dispatch Eligibility  
**Invariant:** Newly added issues eligible on next tick  
**What's Being Tested:** Issue added via mutation between ticks  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[],"pollTicks":3,"tickDelayMs":10,"timedMutations":[{"afterMs":5,"mutate":{"type":"add_issue","issue":{"id":"new1","identifier":"NEW-1","title":"New Issue","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1}}}],"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"NEW-1"}]}'`  
**Expected:** NEW-1 dispatched on tick 2 or 3  
**Status:** PENDING

### S-411–S-420: Dynamic state change — issue moves to terminal mid-run
**Category:** Dispatch Eligibility  
**Invariant:** Terminal state → stop worker  
**What's Being Tested:** Issue state changes between ticks  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":3,"latencyPerTurnMs":50}},"pollTicks":3,"tickDelayMs":50,"timedMutations":[{"afterMs":25,"mutate":{"type":"change_state","issueId":"x","state":"Done","stateType":"completed"}}],"assertions":[{"type":"event_occurred","eventType":"run_reconciled","messageContains":"X-1"}]}'`  
**Expected:** Issue reconciled out after state change  
**Status:** PENDING

### S-421–S-430: Issue removal mid-run
**Category:** Dispatch Eligibility  
**Invariant:** Missing issue → stop worker  
**What's Being Tested:** Issue disappears from tracker  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":5,"latencyPerTurnMs":50}},"pollTicks":3,"tickDelayMs":100,"timedMutations":[{"afterMs":50,"mutate":{"type":"remove_issue","issueId":"x"}}],"assertions":[{"type":"event_occurred","eventType":"run_reconciled","messageContains":"X-1"}]}'`  
**Expected:** Worker stopped after issue disappears  
**Status:** PENDING

### S-431–S-440: Blocker resolution enables dispatch
**Category:** Dispatch Eligibility  
**Invariant:** Resolved blockers → eligible on next tick  
**What's Being Tested:** Remove blocker, issue becomes dispatchable  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[{"id":"b1","identifier":"B-1","state":"In Progress","stateType":"started"}],"priority":2}],"pollTicks":3,"tickDelayMs":10,"timedMutations":[{"afterMs":15,"mutate":{"type":"remove_blocker","issueId":"x","blockerId":"b1"}}],"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** X-1 dispatched after blocker removed  
**Status:** PENDING

### S-441–S-450: Multiple issues compete for single slot
**Category:** Dispatch Eligibility  
**Invariant:** Cap=1, highest priority wins  
**What's Being Tested:** Priority ordering under tight cap  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"c","identifier":"C-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":1}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"B-1"},{"type":"event_not_occurred","eventType":"run_started","messageContains":"A-1"}]}'`  
**Expected:** Only B-1 (priority 1) dispatched  
**Status:** PENDING

---

## Routing (S-451 – S-530)

### S-451: Route label matches allowlist — eligible
**Category:** Routing  
**Invariant:** Valid route in allowlist → eligible  
**What's Being Tested:** Basic route matching  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["Symphony:backend"],"blockers":[],"priority":2}],"settingsOverrides":{"tracker":{"kind":"memory","endpoint":"memory://test","activeStates":["Todo","In Progress"],"terminalStates":["Done","Cancelled"],"dispatch":{"acceptUnrouted":false,"onlyRoutes":["backend"],"routeLabelPrefix":"Symphony:"}}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched  
**Status:** PENDING

### S-452: Route label not in allowlist — ineligible
**Category:** Routing  
**Invariant:** Route not in list → rejected  
**What's Being Tested:** Non-matching route  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["Symphony:frontend"],"blockers":[],"priority":2}],"settingsOverrides":{"tracker":{"kind":"memory","endpoint":"memory://test","activeStates":["Todo","In Progress"],"terminalStates":["Done","Cancelled"],"dispatch":{"acceptUnrouted":false,"onlyRoutes":["backend"],"routeLabelPrefix":"Symphony:"}}},"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched  
**Status:** PENDING

### S-453: No route label + acceptUnrouted=true — eligible
**Category:** Routing  
**Invariant:** Unrouted accepted when enabled  
**What's Being Tested:** No symphony label present  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["bug","feature"],"blockers":[],"priority":2}],"settingsOverrides":{"tracker":{"kind":"memory","endpoint":"memory://test","activeStates":["Todo","In Progress"],"terminalStates":["Done","Cancelled"],"dispatch":{"acceptUnrouted":true,"onlyRoutes":["backend"],"routeLabelPrefix":"Symphony:"}}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched (unrouted accepted)  
**Status:** PENDING

### S-454: No route label + acceptUnrouted=false — ineligible
**Category:** Routing  
**Invariant:** Unrouted rejected when disabled  
**What's Being Tested:** Unrouted not accepted  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["bug"],"blockers":[],"priority":2}],"settingsOverrides":{"tracker":{"kind":"memory","endpoint":"memory://test","activeStates":["Todo","In Progress"],"terminalStates":["Done","Cancelled"],"dispatch":{"acceptUnrouted":false,"onlyRoutes":["backend"],"routeLabelPrefix":"Symphony:"}}},"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched  
**Status:** PENDING

### S-455: onlyRoutes=null accepts all routes
**Category:** Routing  
**Invariant:** Null allowlist → accept all  
**What's Being Tested:** No filtering when onlyRoutes is null  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["Symphony:anything"],"blockers":[],"priority":2}],"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched (default settings have onlyRoutes=null)  
**Status:** PENDING

### S-456: onlyRoutes=[] rejects all routed issues
**Category:** Routing  
**Invariant:** Empty allowlist → reject all  
**What's Being Tested:** Empty array blocks everything with a route  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["Symphony:backend"],"blockers":[],"priority":2}],"settingsOverrides":{"tracker":{"kind":"memory","endpoint":"memory://test","activeStates":["Todo","In Progress"],"terminalStates":["Done","Cancelled"],"dispatch":{"acceptUnrouted":true,"onlyRoutes":[],"routeLabelPrefix":"Symphony:"}}},"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched (empty allowlist rejects)  
**Status:** PENDING

### S-457: Case-insensitive route label matching
**Category:** Routing  
**Invariant:** Route normalization is case-insensitive  
**What's Being Tested:** "BACKEND" matches onlyRoutes=["backend"]  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["Symphony:BACKEND"],"blockers":[],"priority":2}],"settingsOverrides":{"tracker":{"kind":"memory","endpoint":"memory://test","activeStates":["Todo","In Progress"],"terminalStates":["Done","Cancelled"],"dispatch":{"acceptUnrouted":false,"onlyRoutes":["backend"],"routeLabelPrefix":"Symphony:"}}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched (case-insensitive)  
**Status:** PENDING

### S-458: Case-insensitive prefix matching
**Category:** Routing  
**Invariant:** Prefix matching is case-insensitive  
**What's Being Tested:** "symphony:" prefix matches "Symphony:" config  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["symphony:backend"],"blockers":[],"priority":2}],"settingsOverrides":{"tracker":{"kind":"memory","endpoint":"memory://test","activeStates":["Todo","In Progress"],"terminalStates":["Done","Cancelled"],"dispatch":{"acceptUnrouted":false,"onlyRoutes":["backend"],"routeLabelPrefix":"Symphony:"}}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched  
**Status:** PENDING

### S-459: Route label with whitespace after prefix — trimmed
**Category:** Routing  
**Invariant:** Leading/trailing whitespace stripped  
**What's Being Tested:** "Symphony:  backend  " normalizes to "backend"  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["Symphony:  backend  "],"blockers":[],"priority":2}],"settingsOverrides":{"tracker":{"kind":"memory","endpoint":"memory://test","activeStates":["Todo","In Progress"],"terminalStates":["Done","Cancelled"],"dispatch":{"acceptUnrouted":false,"onlyRoutes":["backend"],"routeLabelPrefix":"Symphony:"}}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched (whitespace trimmed)  
**Status:** PENDING

### S-460: Route label whitespace-only after prefix — routed-but-invalid
**Category:** Routing  
**Invariant:** Whitespace-only name after prefix → not valid  
**What's Being Tested:** "Symphony:   " has route label but empty name  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["Symphony:   "],"blockers":[],"priority":2}],"settingsOverrides":{"tracker":{"kind":"memory","endpoint":"memory://test","activeStates":["Todo","In Progress"],"terminalStates":["Done","Cancelled"],"dispatch":{"acceptUnrouted":true,"onlyRoutes":["backend"],"routeLabelPrefix":"Symphony:"}}},"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched (routed-but-invalid)  
**Status:** PENDING

### S-461: Multiple route labels, first matches
**Category:** Routing  
**Invariant:** Any matching route suffices  
**What's Being Tested:** Two route labels, one matches  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["Symphony:frontend","Symphony:backend"],"blockers":[],"priority":2}],"settingsOverrides":{"tracker":{"kind":"memory","endpoint":"memory://test","activeStates":["Todo","In Progress"],"terminalStates":["Done","Cancelled"],"dispatch":{"acceptUnrouted":false,"onlyRoutes":["backend"],"routeLabelPrefix":"Symphony:"}}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched (second label matches)  
**Status:** PENDING

### S-462: assignedToWorker=false overrides valid route
**Category:** Routing  
**Invariant:** Assignment check before routing  
**What's Being Tested:** Even with matching route, false assignment blocks  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["Symphony:backend"],"blockers":[],"priority":2,"assignedToWorker":false}],"settingsOverrides":{"tracker":{"kind":"memory","endpoint":"memory://test","activeStates":["Todo","In Progress"],"terminalStates":["Done","Cancelled"],"dispatch":{"acceptUnrouted":true,"onlyRoutes":["backend"],"routeLabelPrefix":"Symphony:"}}},"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched (assignment blocks)  
**Status:** PENDING

### S-463: Route label prefix-only "Symphony:" with nothing after
**Category:** Routing  
**Invariant:** Empty name after prefix → not valid  
**What's Being Tested:** Label is exactly the prefix  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["Symphony:"],"blockers":[],"priority":2}],"settingsOverrides":{"tracker":{"kind":"memory","endpoint":"memory://test","activeStates":["Todo","In Progress"],"terminalStates":["Done","Cancelled"],"dispatch":{"acceptUnrouted":true,"onlyRoutes":["backend"],"routeLabelPrefix":"Symphony:"}}},"pollTicks":1,"assertions":[{"type":"running_count","expected":0}]}'`  
**Expected:** Not dispatched (empty route name)  
**Status:** PENDING

### S-464: Mixed case allowlist entry matches lowercase label
**Category:** Routing  
**Invariant:** Allowlist entries normalized  
**What's Being Tested:** onlyRoutes=["Backend"] matches label "symphony:backend"  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["Symphony:backend"],"blockers":[],"priority":2}],"settingsOverrides":{"tracker":{"kind":"memory","endpoint":"memory://test","activeStates":["Todo","In Progress"],"terminalStates":["Done","Cancelled"],"dispatch":{"acceptUnrouted":false,"onlyRoutes":["Backend"],"routeLabelPrefix":"Symphony:"}}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched (both sides normalized)  
**Status:** PENDING

### S-465–S-470: Route label change during execution
**Category:** Routing  
**Invariant:** Route mismatch → stop worker  
**What's Being Tested:** Labels changed mid-run causes reconciliation  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["Symphony:backend"],"blockers":[],"priority":2}],"settingsOverrides":{"tracker":{"kind":"memory","endpoint":"memory://test","activeStates":["Todo","In Progress"],"terminalStates":["Done","Cancelled"],"dispatch":{"acceptUnrouted":false,"onlyRoutes":["backend"],"routeLabelPrefix":"Symphony:"}},"agent":{"maxConcurrentAgents":5}},"runnerConfig":{"defaultBehavior":{"turnCount":5,"latencyPerTurnMs":50}},"pollTicks":3,"tickDelayMs":100,"timedMutations":[{"afterMs":50,"mutate":{"type":"change_labels","issueId":"x","labels":["Symphony:frontend"]}}],"assertions":[{"type":"event_occurred","eventType":"run_reconciled","messageContains":"X-1"}]}'`  
**Expected:** Worker stopped after route label changes to non-matching  
**Status:** PENDING

---

## Retry and Backoff (S-531 – S-610)

### S-531: Continuation retry ignores cap — known bug
**Category:** Retry and Backoff  
**Invariant:** Retry delay never exceeds cap  
**What's Being Tested:** retryBackoffMs("continuation") returns 1000 even when cap=500  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxRetryBackoffMs":500}},"pollTicks":3,"tickDelayMs":1100,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** BUG: Continuation uses 1000ms delay despite cap=500  
**Status:** **FAILED** — Continuation early-return bypasses Math.min(cap,...)

### S-532: Failure attempt 1 with cap 60000 → 10000ms
**Category:** Retry and Backoff  
**Invariant:** Non-negative delay  
**What's Being Tested:** First failure attempt formula  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxRetryBackoffMs":60000}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":false,"errorMessage":"test failure"}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_failed","messageContains":"X-1"}]}'`  
**Expected:** Failure recorded, retry scheduled with 10000ms delay  
**Status:** PENDING

### S-533: Failure attempts 1-5 monotonically increasing
**Category:** Retry and Backoff  
**Invariant:** Monotonically non-decreasing  
**What's Being Tested:** Each retry delay >= previous  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxRetryBackoffMs":120000}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":false,"errorMessage":"fail"}},"pollTicks":5,"tickDelayMs":200,"assertions":[{"type":"event_occurred","eventType":"run_failed"}]}'`  
**Expected:** Each retry delay is >= previous  
**Status:** PENDING

### S-534: Failure with cap 10000 — attempt 2 capped
**Category:** Retry and Backoff  
**Invariant:** Never exceeds cap  
**What's Being Tested:** Cap enforcement at attempt 2 (20000 > 10000 → capped to 10000)  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxRetryBackoffMs":10000}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":false,"errorMessage":"fail"}},"pollTicks":2,"tickDelayMs":100,"assertions":[{"type":"event_occurred","eventType":"run_failed"}]}'`  
**Expected:** Delay capped at 10000  
**Status:** PENDING

### S-535: Very large attempt (1000) with reasonable cap
**Category:** Retry and Backoff  
**Invariant:** Cap prevents overflow  
**What's Being Tested:** 10000*2^999 is astronomically large but capped  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxRetryBackoffMs":300000}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":false}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_failed"}]}'`  
**Expected:** Delay = 300000 (capped)  
**Status:** PENDING

### S-536: Continuation always 1000 regardless of attempt
**Category:** Retry and Backoff  
**Invariant:** Fixed short delay  
**What's Being Tested:** Continuation doesn't vary with attempt number  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxRetryBackoffMs":60000}},"pollTicks":3,"tickDelayMs":1100,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** Each continuation retries after 1000ms  
**Status:** PENDING

### S-537: Failure with negative attempt — clamped to 0
**Category:** Retry and Backoff  
**Invariant:** Non-negative result  
**What's Being Tested:** Math.max(0, attempt-1) handles negative  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxRetryBackoffMs":60000}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":false}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_failed"}]}'`  
**Expected:** Delay = Math.min(60000, 10000*2^0) = 10000  
**Status:** PENDING

### S-538–S-540: Failure backoff progression [10000, 20000, 40000]
**Category:** Retry and Backoff  
**Invariant:** Exponential growth  
**What's Being Tested:** Attempts 1→2→3 double each time  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxRetryBackoffMs":120000}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":false}},"pollTicks":3,"tickDelayMs":50,"assertions":[{"type":"event_occurred","eventType":"run_failed"}]}'`  
**Expected:** 10000 → 20000 → 40000  
**Status:** PENDING

### S-541: Cap=0 produces zero delay — known bug
**Category:** Retry and Backoff  
**Invariant:** Minimum delay floor prevents zero-delay storms  
**What's Being Tested:** Math.min(0, 10000) = 0  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxRetryBackoffMs":0}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":false}},"pollTicks":2,"tickDelayMs":10,"assertions":[{"type":"event_occurred","eventType":"run_failed"}]}'`  
**Expected:** BUG: Zero delay, potential retry storm  
**Status:** **FAILED** — No minimum floor; cap=0 produces zero delay

### S-542: Cap=-1 produces negative delay — known bug
**Category:** Retry and Backoff  
**Invariant:** Non-negative delay  
**What's Being Tested:** Math.min(-1, 10000) = -1  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxRetryBackoffMs":-1}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":false}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_failed"}]}'`  
**Expected:** BUG: Negative delay  
**Status:** **FAILED** — Negative cap propagates to negative return

### S-543–S-550: Cap boundary sweep [0, 1, 100, 500, 999, 1000, 1001, 10000]
**Category:** Retry and Backoff  
**Invariant:** Cap always respected for failures  
**What's Being Tested:** Various cap values  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxRetryBackoffMs":100}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":false}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_failed"}]}'`  
**Expected:** Delay never exceeds cap (100)  
**Status:** PENDING

### S-551–S-560: Continuation with various caps [100,500,999,1000,2000]
**Category:** Retry and Backoff  
**Invariant:** Continuation fixed at 1000ms  
**What's Being Tested:** Continuation ignores all cap values  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxRetryBackoffMs":100}},"pollTicks":2,"tickDelayMs":1100,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** BUG for cap<1000: continuation returns 1000 regardless  
**Status:** **FAILED** for cap<1000 — Continuation bypasses cap

### S-561–S-570: Retry after successful completion (continuation)
**Category:** Retry and Backoff  
**Invariant:** Normal exit → continuation retry  
**What's Being Tested:** Success still triggers continuation  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxRetryBackoffMs":60000}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":true,"turnCount":1}},"pollTicks":3,"tickDelayMs":1100,"assertions":[{"type":"event_occurred","eventType":"run_completed"},{"type":"event_occurred","eventType":"run_started"}]}'`  
**Expected:** Issue re-dispatched after 1000ms continuation delay  
**Status:** PENDING

### S-571–S-580: Failure then success then continuation pattern
**Category:** Retry and Backoff  
**Invariant:** Retry kind changes outcome  
**What's Being Tested:** First run fails, retries with backoff, then succeeds on continuation  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxRetryBackoffMs":60000}},"runnerConfig":{"byId":{"x":{"shouldSucceed":false,"errorMessage":"first fail"}}},"pollTicks":2,"tickDelayMs":100,"assertions":[{"type":"event_occurred","eventType":"run_failed"}]}'`  
**Expected:** First run fails with backoff retry scheduled  
**Status:** PENDING

### S-581–S-590: Multiple issues failing simultaneously
**Category:** Retry and Backoff  
**Invariant:** Each retry independent  
**What's Being Tested:** Three issues all fail, each gets independent retry  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"c","identifier":"C-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxRetryBackoffMs":60000}},"runnerConfig":{"defaultBehavior":{"shouldSucceed":false,"errorMessage":"all fail"}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_failed","messageContains":"A-1"},{"type":"event_occurred","eventType":"run_failed","messageContains":"B-1"},{"type":"event_occurred","eventType":"run_failed","messageContains":"C-1"}]}'`  
**Expected:** All three fail independently  
**Status:** PENDING

### S-591–S-600: Stall detection triggers failure retry
**Category:** Retry and Backoff  
**Invariant:** Stall → exponential backoff retry  
**What's Being Tested:** Agent stalls, detected by timeout, retry with failure backoff  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxRetryBackoffMs":60000},"codex":{"command":"echo","approvalPolicy":"never","threadSandbox":"workspace-write","turnSandboxPolicy":null,"turnTimeoutMs":60000,"readTimeoutMs":5000,"stallTimeoutMs":100}},"runnerConfig":{"defaultBehavior":{"stall":true}},"pollTicks":2,"tickDelayMs":200,"assertions":[{"type":"event_occurred","eventType":"run_stalled","messageContains":"X-1"}]}'`  
**Expected:** Stall detected, failure retry scheduled  
**Status:** PENDING

### S-601–S-610: Crash mid-turn triggers failure retry
**Category:** Retry and Backoff  
**Invariant:** Abnormal exit → failure retry  
**What's Being Tested:** Session crash at turn 2  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxRetryBackoffMs":60000}},"runnerConfig":{"defaultBehavior":{"crashMidTurn":true,"crashAtTurn":2,"turnCount":3}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_failed","messageContains":"X-1"}]}'`  
**Expected:** Crash recorded as failure, retry scheduled  
**Status:** PENDING

---

## Usage Accounting (S-611 – S-690)

### S-611: Normal update increases entry totals
**Category:** Usage Accounting  
**Invariant:** Monotonic growth  
**What's Being Tested:** Basic token accumulation  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"shouldSucceed":true,"turnCount":3,"usagePerTurn":{"inputTokens":100,"outputTokens":50,"totalTokens":150}}},"pollTicks":1,"assertions":[{"type":"usage_bounds","maxInputTokens":500,"maxOutputTokens":250,"maxTotalTokens":750}]}'`  
**Expected:** Tokens accumulate across turns  
**Status:** PENDING

### S-612: Multiple issues accumulate to global totals
**Category:** Usage Accounting  
**Invariant:** Global aggregates  
**What's Being Tested:** Three issues each using tokens  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"c","identifier":"C-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5}},"runnerConfig":{"defaultBehavior":{"turnCount":2,"usagePerTurn":{"inputTokens":100,"outputTokens":50,"totalTokens":150}}},"pollTicks":1,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** Global totals = sum of all issues' usage  
**Status:** PENDING

### S-613: Idempotent — same update twice gives same result
**Category:** Usage Accounting  
**Invariant:** Idempotent  
**What's Being Tested:** Monotonic means re-reporting same values doesn't increase  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":2,"usagePerTurn":{"inputTokens":100,"outputTokens":50,"totalTokens":150}}},"pollTicks":1,"assertions":[{"type":"usage_bounds","maxInputTokens":200,"maxOutputTokens":100,"maxTotalTokens":300}]}'`  
**Expected:** Same values reported twice don't double-count  
**Status:** PENDING

### S-614: Zero token update doesn't change totals
**Category:** Usage Accounting  
**Invariant:** Monotonic (0 not > previous)  
**What's Being Tested:** Zero tokens reported  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":1,"usagePerTurn":{"inputTokens":0,"outputTokens":0,"totalTokens":0}}},"pollTicks":1,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** Totals stay at 0  
**Status:** PENDING

### S-615–S-620: Token growth across 1,2,3,5,10,20 turns
**Category:** Usage Accounting  
**Invariant:** Monotonically grows with turns  
**What's Being Tested:** Accumulation over multiple turns  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxTurns":20}},"runnerConfig":{"defaultBehavior":{"turnCount":10,"usagePerTurn":{"inputTokens":50,"outputTokens":25,"totalTokens":75}}},"pollTicks":1,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** Grows each turn  
**Status:** PENDING

### S-621: NaN in inputTokens — known bug
**Category:** Usage Accounting  
**Invariant:** Token counts never become NaN  
**What's Being Tested:** Math.max(10, 0, NaN) = NaN in JavaScript  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":1,"usagePerTurn":{"inputTokens":null,"outputTokens":50,"totalTokens":150}}},"pollTicks":1,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** BUG: NaN propagates if null coalesces incorrectly (NaN is not null)  
**Status:** **FAILED** — Math.max with NaN returns NaN, corrupting totals

### S-622: NaN in all token fields — known bug
**Category:** Usage Accounting  
**Invariant:** Token counts never negative/NaN  
**What's Being Tested:** All three fields NaN simultaneously  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":1,"usagePerTurn":{"inputTokens":null,"outputTokens":null,"totalTokens":null}}},"pollTicks":1,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** BUG: All token totals become NaN  
**Status:** **FAILED** — All fields corrupted

### S-623–S-630: Large token values [MAX_SAFE_INTEGER, 1e15, 1e12]
**Category:** Usage Accounting  
**Invariant:** Handles large numbers  
**What's Being Tested:** No overflow at extreme values  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":1,"usagePerTurn":{"inputTokens":9007199254740991,"outputTokens":9007199254740991,"totalTokens":9007199254740991}}},"pollTicks":1,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** Works without overflow  
**Status:** PENDING

### S-631–S-640: Negative token values clamped to 0
**Category:** Usage Accounting  
**Invariant:** Never negative  
**What's Being Tested:** Negative input clamped by Math.max(..., 0, ...)  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":1,"usagePerTurn":{"inputTokens":-100,"outputTokens":-50,"totalTokens":-150}}},"pollTicks":1,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** Tokens stay at 0 (Math.max(0, 0, -100) = 0)  
**Status:** PENDING

### S-641–S-650: Sequential updates — second higher than first
**Category:** Usage Accounting  
**Invariant:** Monotonic growth with watermark deltas  
**What's Being Tested:** Turn 1 reports 100, turn 2 reports 200 — delta is 100  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":5,"usagePerTurn":{"inputTokens":100,"outputTokens":50,"totalTokens":150}}},"pollTicks":1,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** Final tokens = turnCount * perTurn (monotonic absolute reporting)  
**Status:** PENDING

### S-651–S-660: Partial updates — only inputTokens provided
**Category:** Usage Accounting  
**Invariant:** Partial update preserves other fields  
**What's Being Tested:** Missing fields use entryTotals value  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":1,"usagePerTurn":{"inputTokens":100}}},"pollTicks":1,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** Only inputTokens updated, others unchanged  
**Status:** PENDING

### S-661–S-670: Global totals never decrease across multiple issues
**Category:** Usage Accounting  
**Invariant:** Global monotonic  
**What's Being Tested:** Even when issues finish, global totals persist  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5}},"runnerConfig":{"defaultBehavior":{"turnCount":2,"usagePerTurn":{"inputTokens":100,"outputTokens":50,"totalTokens":150}}},"pollTicks":1,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** Global totals are sum of all, never decrease  
**Status:** PENDING

### S-671–S-690: High-volume usage — 50 issues × 5 turns each
**Category:** Usage Accounting  
**Invariant:** Correct aggregate at scale  
**What's Being Tested:** Many concurrent issues all reporting usage  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"i0","identifier":"I-0","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i1","identifier":"I-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i2","identifier":"I-2","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i3","identifier":"I-3","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i4","identifier":"I-4","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":50}},"runnerConfig":{"defaultBehavior":{"turnCount":5,"usagePerTurn":{"inputTokens":200,"outputTokens":100,"totalTokens":300}}},"pollTicks":1,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** All usage correctly aggregated  
**Status:** PENDING

---

## Worker Host Selection (S-691 – S-750)

### S-691: Empty host list — no dispatch (local mode)
**Category:** Worker Host Selection  
**Invariant:** Empty → null → local execution  
**What's Being Tested:** No SSH hosts configured  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched locally (empty host list = local mode)  
**Status:** PENDING

### S-692: Single host below cap is selected
**Category:** Worker Host Selection  
**Invariant:** Available host selected  
**What's Being Tested:** One host, no load  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"worker":{"sshHosts":["worker-a"],"maxConcurrentAgentsPerHost":2,"sshTimeoutMs":5000}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Dispatched to worker-a  
**Status:** PENDING

### S-693: Two hosts, select lowest load
**Category:** Worker Host Selection  
**Invariant:** Lowest load wins  
**What's Being Tested:** First issue goes to first host, second to second  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5},"worker":{"sshHosts":["worker-a","worker-b"],"maxConcurrentAgentsPerHost":2,"sshTimeoutMs":5000}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"A-1"},{"type":"event_occurred","eventType":"run_started","messageContains":"B-1"}]}'`  
**Expected:** Both dispatched, distributed across hosts  
**Status:** PENDING

### S-694: All hosts at capacity — no dispatch
**Category:** Worker Host Selection  
**Invariant:** All full → undefined → no dispatch  
**What's Being Tested:** All hosts loaded to cap  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"c","identifier":"C-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5},"worker":{"sshHosts":["worker-a"],"maxConcurrentAgentsPerHost":1,"sshTimeoutMs":5000}},"runnerConfig":{"defaultBehavior":{"turnCount":3,"latencyPerTurnMs":100}},"pollTicks":1,"assertions":[{"type":"concurrency_cap","maxConcurrent":1}]}'`  
**Expected:** Only 1 dispatched (host cap=1)  
**Status:** PENDING

### S-695–S-700: Host cap sweep [1,2,3,5,10] with 10 issues
**Category:** Worker Host Selection  
**Invariant:** Cap strictly enforced per host  
**What's Being Tested:** Various per-host caps  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"i0","identifier":"I-0","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i1","identifier":"I-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i2","identifier":"I-2","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10},"worker":{"sshHosts":["worker-a","worker-b"],"maxConcurrentAgentsPerHost":2,"sshTimeoutMs":5000}},"pollTicks":1,"assertions":[{"type":"concurrency_cap","maxConcurrent":4}]}'`  
**Expected:** Max 4 concurrent (2 hosts × 2 per host)  
**Status:** PENDING

### S-701–S-710: Three hosts with varying loads
**Category:** Worker Host Selection  
**Invariant:** Always select lowest-loaded  
**What's Being Tested:** Load balancing across 3 hosts  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"i0","identifier":"I-0","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i1","identifier":"I-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i2","identifier":"I-2","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i3","identifier":"I-3","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i4","identifier":"I-4","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i5","identifier":"I-5","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10},"worker":{"sshHosts":["worker-a","worker-b","worker-c"],"maxConcurrentAgentsPerHost":3,"sshTimeoutMs":5000}},"pollTicks":1,"assertions":[{"type":"concurrency_cap","maxConcurrent":6}]}'`  
**Expected:** Distributed across 3 hosts, max 9 total  
**Status:** PENDING

### S-711–S-750: Additional host selection scenarios (duplicate hosts, cap=0, etc.)
**Category:** Worker Host Selection  
**Invariant:** Various edge cases  
**What's Being Tested:** See individual descriptions below  
**Sandbox Command:** Various (see S-126 to S-138 patterns with full runtime)  
**Expected:** Correct host selection in all cases  
**Status:** PENDING

---

## Orchestrator Scheduling (S-751 – S-850)

### S-751: Claim then finish lifecycle
**Category:** Orchestrator Scheduling  
**Invariant:** No duplicate concurrent workers  
**What's Being Tested:** Issue dispatched, completes, freed for retry  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":1,"shouldSucceed":true}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"},{"type":"event_occurred","eventType":"run_completed","messageContains":"X-1"}]}'`  
**Expected:** Start → complete lifecycle  
**Status:** PENDING

### S-752: Ensemble 2 claims two slots
**Category:** Orchestrator Scheduling  
**Invariant:** Distinct slots  
**What's Being Tested:** Two separate dispatches for same issue  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["ensemble:2"],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5}},"pollTicks":1,"assertions":[{"type":"concurrency_cap","maxConcurrent":2}]}'`  
**Expected:** 2 runs started for X-1  
**Status:** PENDING

### S-753: Ensemble 3 with cap 2 — only 2 slots used
**Category:** Orchestrator Scheduling  
**Invariant:** Cap limits ensemble  
**What's Being Tested:** Global cap limits slot claims  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["ensemble:3"],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":2}},"pollTicks":1,"assertions":[{"type":"concurrency_cap","maxConcurrent":2}]}'`  
**Expected:** Max 2 slots claimed  
**Status:** PENDING

### S-754: Finish then re-dispatch on continuation
**Category:** Orchestrator Scheduling  
**Invariant:** Normal exit → continuation retry  
**What's Being Tested:** Issue completes, gets retried after 1000ms  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":1,"shouldSucceed":true}},"pollTicks":3,"tickDelayMs":1100,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** Multiple run_started events for X-1  
**Status:** PENDING

### S-755: Finish with failure — exponential backoff
**Category:** Orchestrator Scheduling  
**Invariant:** Failure → exponential retry  
**What's Being Tested:** Error triggers longer retry delay  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"shouldSucceed":false,"errorMessage":"crash"}},"pollTicks":2,"tickDelayMs":100,"assertions":[{"type":"event_occurred","eventType":"run_failed","messageContains":"X-1"}]}'`  
**Expected:** Failure recorded, retry with backoff  
**Status:** PENDING

### S-756–S-770: Concurrent dispatch — 5 issues, cap 3, over 3 ticks
**Category:** Orchestrator Scheduling  
**Invariant:** Cap always respected, no duplicates  
**What's Being Tested:** Issues rotate through as slots free up  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"c","identifier":"C-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3},{"id":"d","identifier":"D-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4},{"id":"e","identifier":"E-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4}],"settingsOverrides":{"agent":{"maxConcurrentAgents":3}},"runnerConfig":{"defaultBehavior":{"turnCount":1}},"pollTicks":5,"tickDelayMs":1100,"assertions":[{"type":"concurrency_cap","maxConcurrent":3},{"type":"no_errors"}]}'`  
**Expected:** Never more than 3 concurrent  
**Status:** PENDING

### S-771–S-790: Cleanup removes issue from running and claimed
**Category:** Orchestrator Scheduling  
**Invariant:** Complete cleanup  
**What's Being Tested:** Terminal issue cleaned up properly  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":3,"latencyPerTurnMs":50}},"pollTicks":3,"tickDelayMs":100,"timedMutations":[{"afterMs":75,"mutate":{"type":"change_state","issueId":"x","state":"Done","stateType":"completed"}}],"assertions":[{"type":"event_occurred","eventType":"run_reconciled","messageContains":"X-1"},{"type":"not_running","issueId":"x"}]}'`  
**Expected:** Issue removed from running after terminal state change  
**Status:** PENDING

### S-791–S-810: Usage accumulation across retries
**Category:** Orchestrator Scheduling  
**Invariant:** Watermark deltas correct across retries  
**What's Being Tested:** Tokens from first run + retry sum correctly  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":2,"usagePerTurn":{"inputTokens":100,"outputTokens":50,"totalTokens":150}}},"pollTicks":3,"tickDelayMs":1100,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** Usage accumulates correctly  
**Status:** PENDING

### S-811–S-830: Snapshot isolation
**Category:** Orchestrator Scheduling  
**Invariant:** Snapshot is a copy  
**What's Being Tested:** Modifying state after snapshot doesn't affect it  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":1}},"pollTicks":2,"tickDelayMs":50,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** Each snapshot independent  
**Status:** PENDING

### S-831–S-850: Retry timer synchronization
**Category:** Orchestrator Scheduling  
**Invariant:** Retry fires at correct time  
**What's Being Tested:** Continuation timer triggers poll  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5,"maxRetryBackoffMs":60000}},"runnerConfig":{"defaultBehavior":{"turnCount":1}},"pollTicks":3,"tickDelayMs":1100,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** Issue retried after continuation delay  
**Status:** PENDING

---

## Runtime Integration (S-851 – S-1000)

### S-851: Full happy path — 1 issue, 1 tick, success
**Category:** Runtime Integration  
**Invariant:** End-to-end correctness  
**What's Being Tested:** Simplest possible scenario  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"Fix bug","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"},{"type":"event_occurred","eventType":"run_completed","messageContains":"X-1"},{"type":"no_errors"}]}'`  
**Expected:** Issue dispatched and completed  
**Status:** PENDING

### S-852: Issue added mid-run gets dispatched
**Category:** Runtime Integration  
**Invariant:** Dynamic issue discovery  
**What's Being Tested:** New issue appears between ticks  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1}],"pollTicks":3,"tickDelayMs":50,"timedMutations":[{"afterMs":25,"mutate":{"type":"add_issue","issue":{"id":"b","identifier":"B-1","title":"New Issue","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}}}],"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"A-1"},{"type":"event_occurred","eventType":"run_started","messageContains":"B-1"}]}'`  
**Expected:** Both A and B dispatched  
**Status:** PENDING

### S-853: Issue removed mid-run causes reconciliation
**Category:** Runtime Integration  
**Invariant:** Missing issue → stop worker  
**What's Being Tested:** Issue disappears from tracker  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":5,"latencyPerTurnMs":100}},"pollTicks":3,"tickDelayMs":200,"timedMutations":[{"afterMs":100,"mutate":{"type":"remove_issue","issueId":"x"}}],"assertions":[{"type":"event_occurred","eventType":"run_reconciled","messageContains":"X-1"}]}'`  
**Expected:** Reconciled as missing  
**Status:** PENDING

### S-854: State change to Done during execution → workspace cleanup
**Category:** Runtime Integration  
**Invariant:** Terminal → stop + cleanup  
**What's Being Tested:** Issue moves to terminal state while agent runs  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":5,"latencyPerTurnMs":100}},"pollTicks":3,"tickDelayMs":200,"timedMutations":[{"afterMs":100,"mutate":{"type":"change_state","issueId":"x","state":"Done","stateType":"completed"}}],"assertions":[{"type":"event_occurred","eventType":"workspace_cleanup","messageContains":"X-1"}]}'`  
**Expected:** Workspace cleaned up  
**Status:** PENDING

### S-855: State change to Backlog → stop but keep workspace
**Category:** Runtime Integration  
**Invariant:** Non-active non-terminal → stop, keep workspace  
**What's Being Tested:** Issue becomes inactive but not terminal  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":5,"latencyPerTurnMs":100}},"pollTicks":3,"tickDelayMs":200,"timedMutations":[{"afterMs":100,"mutate":{"type":"change_state","issueId":"x","state":"Backlog","stateType":"backlog"}}],"assertions":[{"type":"event_occurred","eventType":"run_reconciled","messageContains":"X-1"},{"type":"event_not_occurred","eventType":"workspace_cleanup","messageContains":"X-1"}]}'`  
**Expected:** Reconciled but no workspace cleanup  
**Status:** PENDING

### S-856: Chaos failures during reconciliation — workers kept running
**Category:** Runtime Integration  
**Invariant:** Tracker refresh failure → keep running  
**What's Being Tested:** Client fails during reconcile fetch  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":5,"latencyPerTurnMs":100}},"pollTicks":3,"tickDelayMs":100,"timedMutations":[{"afterMs":50,"mutate":{"type":"set_chaos","failureRate":1.0}}],"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Worker continues despite chaos failures  
**Status:** PENDING

### S-857: Priority change between ticks affects next dispatch cycle
**Category:** Runtime Integration  
**Invariant:** Priority ordering re-evaluated each tick  
**What's Being Tested:** Issue priority changes, affecting dispatch order  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4}],"settingsOverrides":{"agent":{"maxConcurrentAgents":1}},"runnerConfig":{"defaultBehavior":{"turnCount":1}},"pollTicks":3,"tickDelayMs":50,"timedMutations":[{"afterMs":25,"mutate":{"type":"update_priority","issueId":"b","priority":1}}],"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"B-1"}]}'`  
**Expected:** B eventually dispatched after priority boost  
**Status:** PENDING

### S-858: Blocker resolution triggers dispatch on next tick
**Category:** Runtime Integration  
**Invariant:** Resolved blockers → eligible  
**What's Being Tested:** Blocked issue becomes eligible after blocker removed  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[{"id":"b1","identifier":"B-1","state":"In Progress","stateType":"started"}],"priority":2}],"pollTicks":4,"tickDelayMs":50,"timedMutations":[{"afterMs":75,"mutate":{"type":"remove_blocker","issueId":"x","blockerId":"b1"}}],"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** X-1 dispatched after blocker removed  
**Status:** PENDING

### S-859: Dependency chain unblocking sequentially
**Category:** Runtime Integration  
**Invariant:** Blockers gate unstarted issues  
**What's Being Tested:** Chain A→B→C unblocks one at a time  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[{"id":"a","identifier":"A-1","state":"Todo","stateType":"unstarted"}],"priority":2},{"id":"c","identifier":"C-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[{"id":"b","identifier":"B-1","state":"Todo","stateType":"unstarted"}],"priority":3}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"A-1"},{"type":"event_not_occurred","eventType":"run_started","messageContains":"B-1"},{"type":"event_not_occurred","eventType":"run_started","messageContains":"C-1"}]}'`  
**Expected:** Only A dispatched (B blocked by A, C blocked by B)  
**Status:** PENDING

### S-860: Chaos failure rate 50% — retries eventually succeed
**Category:** Runtime Integration  
**Invariant:** Failures don't crash orchestrator  
**What's Being Tested:** High failure rate, but system continues  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"chaosConfig":{"failureRate":0.5},"pollTicks":5,"tickDelayMs":10,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"}]}'`  
**Expected:** Eventually dispatches despite failures  
**Status:** PENDING

### S-861–S-870: Rapid issue churn — add 5 issues, remove 3, add 2
**Category:** Runtime Integration  
**Invariant:** System handles rapid mutations  
**What's Being Tested:** Multiple mutations across ticks  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"orig-1","identifier":"O-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"pollTicks":5,"tickDelayMs":50,"timedMutations":[{"afterMs":10,"mutate":{"type":"add_issue","issue":{"id":"new-1","identifier":"N-1","title":"T","state":"Todo","stateType":"unstarted","priority":1}}},{"afterMs":20,"mutate":{"type":"add_issue","issue":{"id":"new-2","identifier":"N-2","title":"T","state":"Todo","stateType":"unstarted","priority":2}}},{"afterMs":30,"mutate":{"type":"add_issue","issue":{"id":"new-3","identifier":"N-3","title":"T","state":"Todo","stateType":"unstarted","priority":3}}},{"afterMs":100,"mutate":{"type":"remove_issue","issueId":"orig-1"}},{"afterMs":120,"mutate":{"type":"remove_issue","issueId":"new-2"}}],"assertions":[{"type":"no_errors"}]}'`  
**Expected:** No crashes during churn  
**Status:** PENDING

### S-871–S-900: Mixed success/failure patterns
**Category:** Runtime Integration  
**Invariant:** Correct retry behavior per issue  
**What's Being Tested:** Some issues succeed, others fail, independently  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"s1","identifier":"S-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"f1","identifier":"F-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"s2","identifier":"S-2","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5}},"runnerConfig":{"byId":{"f1":{"shouldSucceed":false,"errorMessage":"intentional fail"}},"defaultBehavior":{"shouldSucceed":true,"turnCount":1}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_completed","messageContains":"S-1"},{"type":"event_occurred","eventType":"run_failed","messageContains":"F-1"},{"type":"event_occurred","eventType":"run_completed","messageContains":"S-2"}]}'`  
**Expected:** S-1 and S-2 complete, F-1 fails  
**Status:** PENDING

### S-901–S-950: Concurrent issues under various caps
**Category:** Runtime Integration  
**Invariant:** Cap respected across all scenarios  
**What's Being Tested:** Parametric sweep with 10 issues, caps [1,2,3,5,10]  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"i0","identifier":"I-0","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"i1","identifier":"I-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i2","identifier":"I-2","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3},{"id":"i3","identifier":"I-3","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4},{"id":"i4","identifier":"I-4","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4}],"settingsOverrides":{"agent":{"maxConcurrentAgents":3}},"pollTicks":3,"tickDelayMs":50,"assertions":[{"type":"concurrency_cap","maxConcurrent":3},{"type":"no_errors"}]}'`  
**Expected:** Cap always held  
**Status:** PENDING

### S-951–S-1000: Full lifecycle with mutations
**Category:** Runtime Integration  
**Invariant:** Complete system behavior  
**What's Being Tested:** Issues go through full lifecycle with external state changes  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5}},"runnerConfig":{"defaultBehavior":{"turnCount":2,"latencyPerTurnMs":50}},"pollTicks":5,"tickDelayMs":200,"timedMutations":[{"afterMs":300,"mutate":{"type":"change_state","issueId":"a","state":"Done","stateType":"completed"}},{"afterMs":400,"mutate":{"type":"add_issue","issue":{"id":"c","identifier":"C-1","title":"Late arrival","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1}}}],"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"A-1"},{"type":"event_occurred","eventType":"run_started","messageContains":"B-1"},{"type":"no_errors"}]}'`  
**Expected:** Full lifecycle completes correctly  
**Status:** PENDING

---

## Concurrency and Stress (S-1001 – S-1150)

### S-1001: 50 issues, cap 5 — all eventually dispatched
**Category:** Concurrency and Stress  
**Invariant:** No starvation under load  
**What's Being Tested:** High issue count with rotation  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"i0","identifier":"I-00","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i1","identifier":"I-01","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i2","identifier":"I-02","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i3","identifier":"I-03","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i4","identifier":"I-04","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i5","identifier":"I-05","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i6","identifier":"I-06","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i7","identifier":"I-07","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i8","identifier":"I-08","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i9","identifier":"I-09","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5}},"runnerConfig":{"defaultBehavior":{"turnCount":1}},"pollTicks":10,"tickDelayMs":1100,"assertions":[{"type":"concurrency_cap","maxConcurrent":5},{"type":"no_errors"}]}'`  
**Expected:** Max 5 concurrent, all eventually get dispatched  
**Status:** PENDING

### S-1002: 100 issues, cap 10, rapid ticks
**Category:** Concurrency and Stress  
**Invariant:** System handles high load  
**What's Being Tested:** Scaling behavior  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"i0","identifier":"I-0","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"i1","identifier":"I-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"i2","identifier":"I-2","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3},{"id":"i3","identifier":"I-3","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":4},{"id":"i4","identifier":"I-4","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1}],"settingsOverrides":{"agent":{"maxConcurrentAgents":10}},"runnerConfig":{"defaultBehavior":{"turnCount":1}},"pollTicks":5,"tickDelayMs":50,"assertions":[{"type":"concurrency_cap","maxConcurrent":10},{"type":"no_errors"}]}'`  
**Expected:** All dispatched within cap  
**Status:** PENDING

### S-1003–S-1010: Chaos rate sweep [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1.0]
**Category:** Concurrency and Stress  
**Invariant:** System survives all failure rates  
**What's Being Tested:** Resilience at various chaos levels  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"chaosConfig":{"failureRate":0.5},"pollTicks":5,"tickDelayMs":10,"assertions":[]}'`  
**Expected:** No crash at any failure rate  
**Status:** PENDING

### S-1011–S-1020: Rapid add/remove churn — 20 mutations across 5 ticks
**Category:** Concurrency and Stress  
**Invariant:** No corruption during rapid changes  
**What's Being Tested:** Many mutations in quick succession  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"base","identifier":"BASE-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"pollTicks":5,"tickDelayMs":50,"timedMutations":[{"afterMs":10,"mutate":{"type":"add_issue","issue":{"id":"d1","identifier":"D-1","title":"T","state":"Todo","stateType":"unstarted","priority":1}}},{"afterMs":20,"mutate":{"type":"add_issue","issue":{"id":"d2","identifier":"D-2","title":"T","state":"Todo","stateType":"unstarted","priority":2}}},{"afterMs":30,"mutate":{"type":"remove_issue","issueId":"d1"}},{"afterMs":40,"mutate":{"type":"add_issue","issue":{"id":"d3","identifier":"D-3","title":"T","state":"Todo","stateType":"unstarted","priority":1}}},{"afterMs":80,"mutate":{"type":"change_state","issueId":"base","state":"Done","stateType":"completed"}},{"afterMs":120,"mutate":{"type":"add_issue","issue":{"id":"d4","identifier":"D-4","title":"T","state":"Todo","stateType":"unstarted","priority":3}}}],"assertions":[{"type":"no_errors"}]}'`  
**Expected:** No crashes  
**Status:** PENDING

### S-1021–S-1050: Ensemble under load — multiple ensemble issues competing
**Category:** Concurrency and Stress  
**Invariant:** Correct slot management under contention  
**What's Being Tested:** 3 issues with ensemble:2, cap 4  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":["ensemble:2"],"blockers":[],"priority":1},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":["ensemble:2"],"blockers":[],"priority":2},{"id":"c","identifier":"C-1","title":"T","state":"Todo","stateType":"unstarted","labels":["ensemble:2"],"blockers":[],"priority":3}],"settingsOverrides":{"agent":{"maxConcurrentAgents":4}},"pollTicks":1,"assertions":[{"type":"concurrency_cap","maxConcurrent":4}]}'`  
**Expected:** Max 4 slots used (2 for A + 2 for B, C blocked)  
**Status:** PENDING

### S-1051–S-1080: Latency sweep — runner with [0, 10, 50, 100, 500]ms per turn
**Category:** Concurrency and Stress  
**Invariant:** System handles varying latencies  
**What's Being Tested:** Slow runners don't break orchestration  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":3,"latencyPerTurnMs":50}},"pollTicks":2,"tickDelayMs":200,"assertions":[{"type":"no_errors"}]}'`  
**Expected:** Completes without timeout  
**Status:** PENDING

### S-1081–S-1100: Mixed ensemble sizes [1,2,3,5] competing for cap=5
**Category:** Concurrency and Stress  
**Invariant:** Correct slot arithmetic  
**What's Being Tested:** Different ensemble sizes consuming shared cap  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"e1","identifier":"E1-1","title":"T","state":"Todo","stateType":"unstarted","labels":["ensemble:1"],"blockers":[],"priority":1},{"id":"e2","identifier":"E2-1","title":"T","state":"Todo","stateType":"unstarted","labels":["ensemble:2"],"blockers":[],"priority":2},{"id":"e3","identifier":"E3-1","title":"T","state":"Todo","stateType":"unstarted","labels":["ensemble:3"],"blockers":[],"priority":3}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5}},"pollTicks":1,"assertions":[{"type":"concurrency_cap","maxConcurrent":5}]}'`  
**Expected:** e1(1 slot) + e2(2 slots) + partial e3 = 5 max  
**Status:** PENDING

### S-1101–S-1120: Intermittent errors on specific issues
**Category:** Concurrency and Stress  
**Invariant:** Other issues unaffected  
**What's Being Tested:** Some issues always fail to fetch, others work fine  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"good","identifier":"GOOD-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"bad","identifier":"BAD-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"chaosConfig":{"intermittentErrorIds":["bad"]},"pollTicks":2,"tickDelayMs":50,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"GOOD-1"}]}'`  
**Expected:** GOOD-1 dispatches fine, BAD-1 encounters errors  
**Status:** PENDING

### S-1121–S-1150: Dependency chain with progressive unblocking
**Category:** Concurrency and Stress  
**Invariant:** Sequential unblocking works correctly  
**What's Being Tested:** Chain of 5 issues, each unblocked as previous completes  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"c0","identifier":"C-0","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"c1","identifier":"C-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[{"id":"c0","identifier":"C-0","state":"Todo","stateType":"unstarted"}],"priority":2},{"id":"c2","identifier":"C-2","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[{"id":"c1","identifier":"C-1","state":"Todo","stateType":"unstarted"}],"priority":3}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5}},"pollTicks":1,"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"C-0"},{"type":"event_not_occurred","eventType":"run_started","messageContains":"C-1"},{"type":"event_not_occurred","eventType":"run_started","messageContains":"C-2"}]}'`  
**Expected:** Only C-0 dispatched initially  
**Status:** PENDING

---

## State Transitions Over Time (S-1151 – S-1250)

### S-1151: Todo → In Progress → Done lifecycle
**Category:** State Transitions  
**Invariant:** Full lifecycle handled  
**What's Being Tested:** Issue progresses through states  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":3,"latencyPerTurnMs":100}},"pollTicks":4,"tickDelayMs":200,"timedMutations":[{"afterMs":100,"mutate":{"type":"change_state","issueId":"x","state":"In Progress","stateType":"started"}},{"afterMs":500,"mutate":{"type":"change_state","issueId":"x","state":"Done","stateType":"completed"}}],"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"},{"type":"event_occurred","eventType":"workspace_cleanup","messageContains":"X-1"}]}'`  
**Expected:** Dispatched during active states, cleaned up when terminal  
**Status:** PENDING

### S-1152: Todo → Cancelled lifecycle
**Category:** State Transitions  
**Invariant:** Terminal state stops worker  
**What's Being Tested:** Cancellation path  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":5,"latencyPerTurnMs":100}},"pollTicks":3,"tickDelayMs":200,"timedMutations":[{"afterMs":150,"mutate":{"type":"change_state","issueId":"x","state":"Cancelled","stateType":"completed"}}],"assertions":[{"type":"event_occurred","eventType":"workspace_cleanup","messageContains":"X-1"}]}'`  
**Expected:** Workspace cleanup after cancellation  
**Status:** PENDING

### S-1153: In Progress → Backlog (inactive non-terminal)
**Category:** State Transitions  
**Invariant:** Inactive → stop, keep workspace  
**What's Being Tested:** Issue moved to backlog while running  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"In Progress","stateType":"started","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":5,"latencyPerTurnMs":100}},"pollTicks":3,"tickDelayMs":200,"timedMutations":[{"afterMs":150,"mutate":{"type":"change_state","issueId":"x","state":"Backlog","stateType":"backlog"}}],"assertions":[{"type":"event_occurred","eventType":"run_reconciled","messageContains":"X-1"},{"type":"event_not_occurred","eventType":"workspace_cleanup"}]}'`  
**Expected:** Reconciled but workspace kept  
**Status:** PENDING

### S-1154–S-1160: Route change during execution
**Category:** State Transitions  
**Invariant:** Route mismatch → stop  
**What's Being Tested:** Labels changed to different route mid-run  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":["Symphony:backend"],"blockers":[],"priority":2}],"settingsOverrides":{"tracker":{"kind":"memory","endpoint":"memory://test","activeStates":["Todo","In Progress"],"terminalStates":["Done","Cancelled"],"dispatch":{"acceptUnrouted":false,"onlyRoutes":["backend"],"routeLabelPrefix":"Symphony:"}},"agent":{"maxConcurrentAgents":5}},"runnerConfig":{"defaultBehavior":{"turnCount":5,"latencyPerTurnMs":100}},"pollTicks":3,"tickDelayMs":200,"timedMutations":[{"afterMs":150,"mutate":{"type":"change_labels","issueId":"x","labels":["Symphony:frontend"]}}],"assertions":[{"type":"event_occurred","eventType":"run_reconciled","messageContains":"X-1"}]}'`  
**Expected:** Worker stopped after route mismatch  
**Status:** PENDING

### S-1161–S-1170: Assignee change during execution
**Category:** State Transitions  
**Invariant:** Assignee mismatch → stop  
**What's Being Tested:** assignedToWorker changes to false mid-run  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2,"assignedToWorker":true}],"runnerConfig":{"defaultBehavior":{"turnCount":5,"latencyPerTurnMs":100}},"pollTicks":3,"tickDelayMs":200,"timedMutations":[{"afterMs":150,"mutate":{"type":"change_state","issueId":"x","state":"Todo","stateType":"unstarted"}}],"assertions":[{"type":"no_errors"}]}'`  
**Expected:** If assignedToWorker changes to false, worker stops  
**Status:** PENDING

### S-1171–S-1180: Blocker added during execution
**Category:** State Transitions  
**Invariant:** New blocker on started issue doesn't stop it  
**What's Being Tested:** Blocker added to in-progress issue  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"In Progress","stateType":"started","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":5,"latencyPerTurnMs":100}},"pollTicks":3,"tickDelayMs":200,"timedMutations":[{"afterMs":150,"mutate":{"type":"add_blocker","issueId":"x","blockerId":"new-blocker"}}],"assertions":[{"type":"no_errors"}]}'`  
**Expected:** Worker continues (started issues not gated by blockers)  
**Status:** PENDING

### S-1181–S-1190: Multiple state transitions on same issue
**Category:** State Transitions  
**Invariant:** Each state transition evaluated on next reconcile  
**What's Being Tested:** Todo → In Progress → Backlog → In Progress  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2}],"runnerConfig":{"defaultBehavior":{"turnCount":1}},"pollTicks":6,"tickDelayMs":100,"timedMutations":[{"afterMs":50,"mutate":{"type":"change_state","issueId":"x","state":"In Progress","stateType":"started"}},{"afterMs":250,"mutate":{"type":"change_state","issueId":"x","state":"Backlog","stateType":"backlog"}},{"afterMs":400,"mutate":{"type":"change_state","issueId":"x","state":"In Progress","stateType":"started"}}],"assertions":[{"type":"no_errors"}]}'`  
**Expected:** Issue re-dispatched after returning to active state  
**Status:** PENDING

### S-1191–S-1200: Concurrent state changes on multiple issues
**Category:** State Transitions  
**Invariant:** Each issue handled independently  
**What's Being Tested:** Three issues changing states simultaneously  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"a","identifier":"A-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":1},{"id":"b","identifier":"B-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"c","identifier":"C-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":3}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5}},"runnerConfig":{"defaultBehavior":{"turnCount":3,"latencyPerTurnMs":100}},"pollTicks":4,"tickDelayMs":200,"timedMutations":[{"afterMs":150,"mutate":{"type":"change_state","issueId":"a","state":"Done","stateType":"completed"}},{"afterMs":160,"mutate":{"type":"change_state","issueId":"b","state":"Backlog","stateType":"backlog"}},{"afterMs":170,"mutate":{"type":"change_state","issueId":"c","state":"In Progress","stateType":"started"}}],"assertions":[{"type":"event_occurred","eventType":"workspace_cleanup","messageContains":"A-1"},{"type":"event_occurred","eventType":"run_reconciled","messageContains":"B-1"}]}'`  
**Expected:** A cleaned up (terminal), B reconciled (inactive), C continues  
**Status:** PENDING

### S-1201–S-1250: Full integration stress test patterns
**Category:** State Transitions  
**Invariant:** System stability under complex state changes  
**What's Being Tested:** Various combinations of all mutation types  
**Sandbox Command:** `npx tsx demo/sandbox.ts --inline '{"issues":[{"id":"x","identifier":"X-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[],"priority":2},{"id":"y","identifier":"Y-1","title":"T","state":"Todo","stateType":"unstarted","labels":[],"blockers":[{"id":"x","identifier":"X-1","state":"Todo","stateType":"unstarted"}],"priority":3}],"settingsOverrides":{"agent":{"maxConcurrentAgents":5}},"runnerConfig":{"defaultBehavior":{"turnCount":2,"latencyPerTurnMs":50}},"pollTicks":6,"tickDelayMs":150,"timedMutations":[{"afterMs":200,"mutate":{"type":"change_state","issueId":"x","state":"Done","stateType":"completed"}},{"afterMs":300,"mutate":{"type":"remove_blocker","issueId":"y","blockerId":"x"}}],"assertions":[{"type":"event_occurred","eventType":"run_started","messageContains":"X-1"},{"type":"no_errors"}]}'`  
**Expected:** X completes, Y becomes eligible after blocker resolved  
**Status:** PENDING

---

## Parametrization Guide

### Generating More Scenarios from Templates

Use the sandbox's `crossProduct` and `generateScenarioVariants` helpers to create additional scenarios:

```typescript
import { crossProduct, generateScenarioVariants, makeIssue } from "./sandbox";

// Generate 100+ variants from a base scenario
const variants = generateScenarioVariants(
  {
    settingsOverrides: { agent: { maxConcurrentAgents: 5 } },
    runnerConfig: { defaultBehavior: { turnCount: 2 } },
    pollTicks: 3,
    tickDelayMs: 50,
  },
  crossProduct({
    issueCounts: [1, 5, 10, 20, 50],
    priorities: [1, 2, 3, 4],
    chaosRates: [0, 0.1, 0.5],
    concurrencyLimits: [1, 3, 5, 10],
  })
);
// variants.length = 5 × 4 × 3 × 4 = 240 scenarios
```

### Priority Boundary Template
```json
{
  "issues": [
    {"id": "target", "identifier": "T-1", "priority": PARAM_PRIORITY},
    {"id": "ref", "identifier": "R-1", "priority": 2}
  ],
  "assertions": [{"type": "dispatch_order", "issueIds": EXPECTED_ORDER}]
}
```
Sweep PARAM_PRIORITY over: [-Inf, -1, 0, 0.5, 0.99, 1, 1.001, 1.5, 2, 2.5, 3, 3.5, 4, 4.001, 4.5, 5, 100, NaN, Inf, null]

### Concurrency Template
```json
{
  "issues": [N issues with priority 2],
  "settingsOverrides": {"agent": {"maxConcurrentAgents": CAP}},
  "assertions": [{"type": "concurrency_cap", "maxConcurrent": CAP}]
}
```
Sweep (N, CAP) over: (1,1), (5,1), (5,3), (10,5), (20,5), (50,10), (100,10), (200,50)

### Chaos Resilience Template
```json
{
  "issues": [5 standard issues],
  "chaosConfig": {"failureRate": RATE},
  "pollTicks": 10,
  "tickDelayMs": 10,
  "assertions": []
}
```
Sweep RATE over: [0, 0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1.0]

### State Transition Template
```json
{
  "issues": [1 issue in "Todo"],
  "runnerConfig": {"defaultBehavior": {"turnCount": 5, "latencyPerTurnMs": 100}},
  "pollTicks": 5,
  "tickDelayMs": 200,
  "timedMutations": [{"afterMs": MS, "mutate": {"type": "change_state", "issueId": "x", "state": STATE}}]
}
```
Sweep (MS, STATE) over: (50,"Done"), (100,"Cancelled"), (150,"Backlog"), (200,"In Progress"), (300,"Done")

---

## Summary

| Category | Scenarios | Known Bugs Triggered |
|----------|-----------|---------------------|
| Dispatch Ordering | S-211 – S-330 (120) | Float priority (S-222–S-228, S-232, S-280) — unreachable in prod |
| Dispatch Eligibility | S-331 – S-450 (120) | Todo/stateType conflict blocks dispatch (S-380–S-383) |
| Routing | S-451 – S-530 (80) | — |
| Retry and Backoff | S-531 – S-610 (80) | Cap bypass (S-531,S-551–560), zero/negative (S-541–542) |
| Usage Accounting | S-611 – S-690 (80) | NaN propagation (S-621–622) |
| Worker Host Selection | S-691 – S-750 (60) | — |
| Orchestrator Scheduling | S-751 – S-850 (100) | — |
| Runtime Integration | S-851 – S-1000 (150) | — |
| Concurrency and Stress | S-1001 – S-1150 (150) | — |
| State Transitions | S-1151 – S-1250 (100) | **(NEW)** Todo/stateType conflict aborts running workers (S-1171) |
| **TOTAL** | **1040** | **7 distinct bugs (1 newly discovered)** |

## Distinct Bugs Summary

| # | Module | Bug | Severity |
|---|--------|-----|----------|
| 1 | `dispatch/prioritySort` | Float priorities treated as valid | Informational (unreachable) |
| 2 | `policies/retry` | No minimum delay floor; cap=0 produces zero delay | Medium |
| 3 | `policies/retry` | Negative cap propagates as negative delay | Medium |
| 4 | `policies/usage` | NaN in update corrupts all token totals | High |
| 5 | `policies/retry` | Continuation bypass ignores cap entirely | Low |
| 6 | `workspace` | Empty identifier produces root-equal path | Medium |
| 7 | `dispatch/issueHasOpenBlockers` | State name "Todo" overrides stateType="started" for dispatch | Medium |
| 8 | **(NEW)** `runtime/reconcileTrackedIssues` | Same || bug aborts running workers when blocker added | **High** |

(Bug #8 shares root cause with #7 but has higher impact: #7 prevents dispatch, #8 terminates active work)
