# Symphony Invariant Test Results

**Date:** 2026-05-29  
**Total Scenarios Tested:** 210  
**Passed:** 200  
**Failed:** 10

---

## Failures Found

### Failure 1: S-022
**Invariant Violated:** Out-of-range priority SHALL sort last (valid priorities are 1-4 integers)  
**Code Location:** `ts/packages/dispatch/src/index.ts` — `prioritySort` (line ~142)  
**Explanation:** `prioritySort` checks `priority >= 1 && priority <= 4` but does NOT verify `Number.isInteger()`. A float like 2.5 passes the range check and is treated as a valid priority sorting between 2 and 3, instead of being mapped to `MAX_SAFE_INTEGER` (sort last). The invariant specifies "valid priorities (1-4)" which implies integers.  
**Reproduction:**
```ts
import { sortForDispatch } from "@symphony/dispatch";
const a = { ...issue, priority: 2.5, identifier: "A" };
const b = { ...issue, priority: 2, identifier: "B" };
sortForDispatch([a, b]); // Returns [b, a] — treats 2.5 as valid priority
```
**Suggested Fix:** Add `Number.isInteger(priority)` to the guard:
```ts
function prioritySort(priority: number | null | undefined): number {
  return priority && Number.isInteger(priority) && priority >= 1 && priority <= 4
    ? priority : Number.MAX_SAFE_INTEGER;
}
```

---

### Failure 2: S-105
**Invariant Violated:** Minimum delay floor SHALL prevent zero-delay retry storms  
**Code Location:** `ts/packages/policies/src/retry.ts` — `retryBackoffMs` (line 9)  
**Explanation:** `retryBackoffMs(1, 0, "failure")` computes `Math.min(0, 10000) = 0`. With a cap of 0, the retry delay is zero, creating potential retry storms. There is no minimum floor enforced on the result.  
**Reproduction:**
```ts
import { retryBackoffMs } from "@symphony/policies/retry";
retryBackoffMs(1, 0, "failure"); // Returns 0
```
**Suggested Fix:** Enforce a minimum floor (e.g., 1000ms):
```ts
const MIN_RETRY_DELAY_MS = 1_000;
return Math.max(MIN_RETRY_DELAY_MS, Math.min(maxRetryBackoffMs, 10_000 * 2 ** Math.max(0, attempt - 1)));
```

---

### Failure 3: S-106
**Invariant Violated:** Retry delay SHALL be non-negative  
**Code Location:** `ts/packages/policies/src/retry.ts` — `retryBackoffMs` (line 9)  
**Explanation:** `retryBackoffMs(1, -1, "failure")` computes `Math.min(-1, 10000) = -1`. A negative `maxRetryBackoffMs` propagates directly as a negative result. No validation or clamping prevents this.  
**Reproduction:**
```ts
retryBackoffMs(1, -1, "failure"); // Returns -1 — NEGATIVE
```
**Suggested Fix:** Clamp result to non-negative:
```ts
return Math.max(0, Math.min(maxRetryBackoffMs, 10_000 * 2 ** Math.max(0, attempt - 1)));
```

---

### Failure 4: S-120
**Invariant Violated:** Token counts SHALL never become negative / NaN  
**Code Location:** `ts/packages/policies/src/usage.ts` — `mergeMonotonicUsage` (lines 17-21)  
**Explanation:** When `update.inputTokens` is `NaN`, the nullish coalescing (`??`) does NOT catch it (NaN is not null/undefined). This feeds NaN into `Math.max(10, 0, NaN)` which returns NaN in JavaScript. The result propagates through entry totals, reported totals, and global totals, corrupting all downstream state.  
**Reproduction:**
```ts
import { mergeMonotonicUsage } from "@symphony/policies/usage";
mergeMonotonicUsage({
  entryTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, secondsRunning: 0 },
  reportedTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, secondsRunning: 0 },
  globalTotals: { inputTokens: 100, outputTokens: 50, totalTokens: 150, secondsRunning: 0 },
  update: { inputTokens: NaN },
});
// entryTotals.inputTokens = NaN, globalTotals.inputTokens = NaN
```
**Suggested Fix:** Validate update values with `Number.isFinite()`:
```ts
const safeInput = Number.isFinite(input.update.inputTokens)
  ? input.update.inputTokens : input.entryTotals.inputTokens;
```

---

### Failure 5: S-121
**Invariant Violated:** Token counts SHALL never become negative / NaN  
**Code Location:** `ts/packages/policies/src/usage.ts` — `mergeMonotonicUsage` (lines 27-31)  
**Explanation:** Same root cause as S-120 but for the `totalTokens` field. `Math.max(10, 0, NaN)` returns NaN. Each token field is independently vulnerable. A single NaN field corrupts only that field's chain but leaves others intact.  
**Reproduction:**
```ts
mergeMonotonicUsage({ ..., update: { totalTokens: NaN, inputTokens: 20 } });
// entryTotals.totalTokens = NaN, but inputTokens correctly updates to 20
```
**Suggested Fix:** Same NaN guard applied to all three token fields.

---

### Failure 6: S-185
**Invariant Violated:** Retry delay SHALL never exceed the configured maximum cap  
**Code Location:** `ts/packages/policies/src/retry.ts` — `retryBackoffMs` (line 8)  
**Explanation:** The continuation path returns `1_000` unconditionally via early return, bypassing `Math.min(maxRetryBackoffMs, ...)`. When `maxRetryBackoffMs < 1000` (e.g., 500), the returned delay exceeds the configured cap.  
**Reproduction:**
```ts
retryBackoffMs(1, 500, "continuation"); // Returns 1000, which exceeds cap of 500
```
**Suggested Fix:** Apply cap to continuation:
```ts
if (retryKind === "continuation") return Math.min(maxRetryBackoffMs, 1_000);
```

---

### Failure 7: S-186
**Invariant Violated:** Token counts SHALL never become negative / NaN  
**Code Location:** `ts/packages/policies/src/usage.ts` — `mergeMonotonicUsage` (lines 17-35)  
**Explanation:** When ALL token fields in the update are NaN, all three chains (entry, reported, global) become NaN simultaneously. This is the compound version of S-120/S-121 affecting all fields at once.  
**Reproduction:**
```ts
mergeMonotonicUsage({
  ...,
  update: { inputTokens: NaN, outputTokens: NaN, totalTokens: NaN },
});
// All token fields across all totals become NaN
```
**Suggested Fix:** Apply `Number.isFinite()` guard to each field before Math.max.

---

### Failure 8: S-209
**Invariant Violated:** Workspace path SHALL be a strict descendant of the workspace root  
**Code Location:** `ts/packages/workspace/src/index.ts` — `workspacePath` (line ~22)  
**Explanation:** `workspacePath("/tmp/w", "", 0, 1)` calls `safeIdentifier("")` which returns `""`, then `path.join("/tmp/w", "")` returns `"/tmp/w"` — which equals root. While `createWorkspaceForIssue` catches this downstream via `validateWorkspaceCwd`, the pure `workspacePath` function itself produces an invalid path. Any code path that calls `workspacePath` directly (without going through create) would get a root-equal path.  
**Reproduction:**
```ts
import { workspacePath, safeIdentifier } from "@symphony/workspace";
safeIdentifier("");           // ""
workspacePath("/tmp/w", "");  // "/tmp/w" === root!
```
**Suggested Fix:** Guard in `safeIdentifier` or `workspacePath`:
```ts
export function workspacePath(root, identifier, slotIndex = 0, ensembleSize = 1) {
  const safe = safeIdentifier(identifier);
  if (!safe) throw new Error("empty identifier produces invalid workspace path");
  ...
}
```

---

### Failure 9: S-210
**Invariant Violated:** Retry delay SHALL never exceed the configured maximum cap  
**Code Location:** `ts/packages/policies/src/retry.ts` — `retryBackoffMs` (line 8)  
**Explanation:** Same root cause as S-185. Continuation returns 1000 without cap enforcement. With `maxRetryBackoffMs=100`, result is 1000 > 100.  
**Reproduction:** Same as S-185 with cap=100.  
**Suggested Fix:** Same as S-185.

---

### Failure 10: S-184
**Invariant Violated:** WHEN a non-unstarted issue has non-terminal blockers, THE SYSTEM SHALL still consider it eligible (blockers only gate unstarted issues)  
**Code Location:** `ts/packages/dispatch/src/index.ts` — `issueHasOpenBlockers` (line ~43)  
**Explanation:** The function determines "unstarted" via `issue.stateType === "unstarted" || issue.state.trim().toLowerCase() === "todo"`. An issue with `stateType="started"` (explicitly categorized by the tracker as started) but `state="Todo"` (state name happens to be "Todo") is treated as unstarted due to the `||`. This means a started issue is incorrectly gated by blockers because its state name matches the hardcoded string "todo".  
**Reproduction:**
```ts
import { issueHasOpenBlockers } from "@symphony/dispatch";
const issue = {
  ...validIssue,
  state: "Todo",
  stateType: "started",
  blockers: [{ state: "In Progress" }],
};
issueHasOpenBlockers(issue, settings); // true — WRONG, stateType says it's started
```
**Suggested Fix:** Prefer `stateType` when available:
```ts
const unstarted = issue.stateType
  ? issue.stateType === "unstarted"
  : issue.state.trim().toLowerCase() === "todo";
```

---

## Summary of Distinct Bugs

| # | Module | Bug | Severity |
|---|--------|-----|----------|
| 1 | `dispatch/prioritySort` | Float priorities (e.g. 2.5) treated as valid | Low |
| 2 | `policies/retry` | No minimum delay floor; cap=0 produces zero delay | Medium |
| 3 | `policies/retry` | Negative cap propagates as negative delay | Medium |
| 4 | `policies/usage` | NaN in update corrupts all token totals | High |
| 5 | `policies/retry` | Continuation bypass ignores cap entirely | Low |
| 6 | `workspace` | Empty identifier produces root-equal path | Medium |
| 7 | `dispatch/issueHasOpenBlockers` | State name "Todo" overrides stateType="started" | Medium |

(Failures 4-6-7 are variants of bug #4; failures 5-9-10 are variants of bug #5)

---

# Symphony Invariant Test Scenarios

210 scenarios testing core logic against INVARIANTS.md.

---

## Dispatch Ordering

### S-001: Priority 1 sorts before priority 2
**Category:** Dispatch Ordering  
**Invariant:** Lower priority number dispatches first  
**Setup:** Two issues: A(priority=1), B(priority=2)  
**Action:** sortForDispatch([B, A])  
**Expected:** [A, B]  
**Status:** PENDING

### S-002: Priority 2 sorts before priority 3
**Category:** Dispatch Ordering  
**Invariant:** Lower priority number dispatches first  
**Setup:** Two issues: A(priority=3), B(priority=2)  
**Action:** sortForDispatch([A, B])  
**Expected:** [B, A]  
**Status:** PENDING

### S-003: Same priority, earlier createdAt first
**Category:** Dispatch Ordering  
**Invariant:** Same priority uses earlier creation time  
**Setup:** A(priority=2, createdAt="2024-01-01"), B(priority=2, createdAt="2024-01-02")  
**Action:** sortForDispatch([B, A])  
**Expected:** [A, B]  
**Status:** PENDING

### S-004: Same priority and createdAt, lexicographic identifier
**Category:** Dispatch Ordering  
**Invariant:** Same priority+time uses lexicographic identifier  
**Setup:** A(priority=2, createdAt="2024-01-01", identifier="MT-2"), B(priority=2, createdAt="2024-01-01", identifier="MT-1")  
**Action:** sortForDispatch([A, B])  
**Expected:** [B, A]  
**Status:** PENDING

### S-005: Null priority sorts after valid priority
**Category:** Dispatch Ordering  
**Invariant:** Null/missing/out-of-range priority sorts last  
**Setup:** A(priority=null), B(priority=4)  
**Action:** sortForDispatch([A, B])  
**Expected:** [B, A]  
**Status:** PENDING

### S-006: Priority 0 is out of range, sorts last
**Category:** Dispatch Ordering  
**Invariant:** Out-of-range priority sorts last  
**Setup:** A(priority=0), B(priority=4)  
**Action:** sortForDispatch([A, B])  
**Expected:** [B, A] (0 is out of valid 1-4 range)  
**Status:** PENDING

### S-007: Priority 5 is out of range, sorts last
**Category:** Dispatch Ordering  
**Invariant:** Out-of-range priority sorts last  
**Setup:** A(priority=5), B(priority=4)  
**Action:** sortForDispatch([A, B])  
**Expected:** [B, A]  
**Status:** PENDING

### S-008: Null createdAt sorts last within priority group
**Category:** Dispatch Ordering  
**Invariant:** Null/missing creation time sorts last  
**Setup:** A(priority=2, createdAt=null), B(priority=2, createdAt="2024-01-01")  
**Action:** sortForDispatch([A, B])  
**Expected:** [B, A]  
**Status:** PENDING

### S-009: Empty string createdAt sorts last within priority group
**Category:** Dispatch Ordering  
**Invariant:** Missing/unparseable creation time sorts last  
**Setup:** A(priority=2, createdAt=""), B(priority=2, createdAt="2024-01-01")  
**Action:** sortForDispatch([A, B])  
**Expected:** [B, A]  
**Status:** PENDING

### S-010: Invalid date string createdAt sorts last
**Category:** Dispatch Ordering  
**Invariant:** Unparseable creation time sorts last  
**Setup:** A(priority=2, createdAt="not-a-date"), B(priority=2, createdAt="2024-01-01")  
**Action:** sortForDispatch([A, B])  
**Expected:** [B, A]  
**Status:** PENDING

### S-011: Sort is a permutation (no additions or drops)
**Category:** Dispatch Ordering  
**Invariant:** Result is permutation of input  
**Setup:** 10 issues with random priorities  
**Action:** sortForDispatch(issues)  
**Expected:** Same issues, different order, length preserved  
**Status:** PENDING

### S-012: Sort is idempotent
**Category:** Dispatch Ordering  
**Invariant:** Sorting twice yields same result  
**Setup:** 10 issues with mixed priorities  
**Action:** sortForDispatch(sortForDispatch(issues))  
**Expected:** Same as single sort  
**Status:** PENDING

### S-013: Single-element list is unchanged
**Category:** Dispatch Ordering  
**Invariant:** Permutation of input  
**Setup:** [A]  
**Action:** sortForDispatch([A])  
**Expected:** [A]  
**Status:** PENDING

### S-014: Empty list returns empty
**Category:** Dispatch Ordering  
**Invariant:** Permutation of input  
**Setup:** []  
**Action:** sortForDispatch([])  
**Expected:** []  
**Status:** PENDING

### S-015: Two null priorities tie-break on createdAt
**Category:** Dispatch Ordering  
**Invariant:** Multiple null priorities use secondary sort  
**Setup:** A(priority=null, createdAt="2024-02-01"), B(priority=null, createdAt="2024-01-01")  
**Action:** sortForDispatch([A, B])  
**Expected:** [B, A]  
**Status:** PENDING

### S-016: Priority 0 and null both sort last, tie-break on createdAt
**Category:** Dispatch Ordering  
**Invariant:** Out-of-range and null both map to MAX_SAFE_INTEGER  
**Setup:** A(priority=0, createdAt="2024-02-01"), B(priority=null, createdAt="2024-01-01")  
**Action:** sortForDispatch([A, B])  
**Expected:** [B, A] (same priority bucket, earlier date wins)  
**Status:** PENDING

### S-017: Negative priority is out of range
**Category:** Dispatch Ordering  
**Invariant:** Out-of-range priority sorts last  
**Setup:** A(priority=-1), B(priority=4)  
**Action:** sortForDispatch([A, B])  
**Expected:** [B, A]  
**Status:** PENDING

### S-018: Large valid list sorted twice is stable
**Category:** Dispatch Ordering  
**Invariant:** Idempotent  
**Setup:** 50 issues with priorities 1-4 and varied dates  
**Action:** sortForDispatch(sortForDispatch(issues))  
**Expected:** Identical to single sort  
**Status:** PENDING

### S-019: Undefined priority sorts last
**Category:** Dispatch Ordering  
**Invariant:** Missing priority sorts last  
**Setup:** A(priority=undefined), B(priority=1)  
**Action:** sortForDispatch([A, B])  
**Expected:** [B, A]  
**Status:** PENDING

### S-020: Identifier comparison is lexicographic not numeric
**Category:** Dispatch Ordering  
**Invariant:** Lexicographic identifier ordering  
**Setup:** A(priority=2, createdAt=same, identifier="MT-9"), B(same, identifier="MT-10")  
**Action:** sortForDispatch([A, B])  
**Expected:** [B, A] ("MT-10" < "MT-9" lexicographically)  
**Status:** PENDING

### S-021: All same priority, varied dates
**Category:** Dispatch Ordering  
**Invariant:** Falls through to date comparison  
**Setup:** 5 issues all priority=2, different createdAt  
**Action:** sortForDispatch(issues)  
**Expected:** Ordered by createdAt ascending  
**Status:** PENDING

### S-022: Float priority (2.5) is out of range
**Category:** Dispatch Ordering  
**Invariant:** Out-of-range sorts last  
**Setup:** A(priority=2.5), B(priority=2)  
**Action:** sortForDispatch([A, B])  
**Expected:** Depends on prioritySort implementation - does it check integer?  
**Status:** **FAILED** — prioritySort does not check Number.isInteger(); 2.5 passes the >= 1 && <= 4 check

### S-023: Priority undefined vs null same behavior
**Category:** Dispatch Ordering  
**Invariant:** Both map to sort-last  
**Setup:** A(priority=undefined), B(priority=null), C(priority=1)  
**Action:** sortForDispatch([A, B, C])  
**Expected:** C first, then A and B by date/identifier  
**Status:** PENDING

### S-024: Epoch 0 date sorts before recent date
**Category:** Dispatch Ordering  
**Invariant:** Earlier creation time first  
**Setup:** A(createdAt="1970-01-01T00:00:00Z"), B(createdAt="2024-01-01")  
**Action:** sortForDispatch([A, B]) (same priority)  
**Expected:** [A, B]  
**Status:** PENDING

### S-025: Far future date sorts after present
**Category:** Dispatch Ordering  
**Invariant:** Earlier creation time first  
**Setup:** A(createdAt="2099-01-01"), B(createdAt="2024-01-01")  
**Action:** sortForDispatch([A, B]) (same priority)  
**Expected:** [B, A]  
**Status:** PENDING

---

## Dispatch Eligibility

### S-026: Missing id field makes issue ineligible
**Category:** Dispatch Eligibility  
**Invariant:** Missing required fields -> ineligible  
**Setup:** Issue with id="" (empty string)  
**Action:** shouldDispatchIssue(issue, settings, state)  
**Expected:** false  
**Status:** PENDING

### S-027: Missing identifier field makes issue ineligible
**Category:** Dispatch Eligibility  
**Invariant:** Missing required fields -> ineligible  
**Setup:** Issue with identifier=""  
**Action:** shouldDispatchIssue(issue, settings, state)  
**Expected:** false  
**Status:** PENDING

### S-028: Missing title field makes issue ineligible
**Category:** Dispatch Eligibility  
**Invariant:** Missing required fields -> ineligible  
**Setup:** Issue with title=""  
**Action:** shouldDispatchIssue(issue, settings, state)  
**Expected:** false  
**Status:** PENDING

### S-029: Missing state field makes issue ineligible
**Category:** Dispatch Eligibility  
**Invariant:** Missing required fields -> ineligible  
**Setup:** Issue with state=""  
**Action:** shouldDispatchIssue(issue, settings, state)  
**Expected:** false  
**Status:** PENDING

### S-030: Issue in terminal state "Done" is ineligible
**Category:** Dispatch Eligibility  
**Invariant:** Terminal state -> ineligible  
**Setup:** Issue(state="Done"), terminalStates=["Done"]  
**Action:** shouldDispatchIssue(issue, settings, state)  
**Expected:** false  
**Status:** PENDING

### S-031: Issue in non-active state "Backlog" is ineligible
**Category:** Dispatch Eligibility  
**Invariant:** Non-active state -> ineligible  
**Setup:** Issue(state="Backlog"), activeStates=["Todo", "In Progress"]  
**Action:** shouldDispatchIssue(issue, settings, state)  
**Expected:** false  
**Status:** PENDING

### S-032: Issue with assignedToWorker=false is ineligible
**Category:** Dispatch Eligibility  
**Invariant:** Not assigned to this worker -> ineligible  
**Setup:** Issue(assignedToWorker=false)  
**Action:** shouldDispatchIssue(issue, settings, state)  
**Expected:** false (via routedToThisWorker)  
**Status:** PENDING

### S-033: Unstarted issue with one non-terminal blocker
**Category:** Dispatch Eligibility  
**Invariant:** Unstarted + non-terminal blocker -> ineligible  
**Setup:** Issue(stateType="unstarted", blockers=[{state:"Todo"}])  
**Action:** shouldDispatchIssue(issue, settings, state)  
**Expected:** false  
**Status:** PENDING

### S-034: Unstarted issue with two blockers, one terminal one not
**Category:** Dispatch Eligibility  
**Invariant:** Any non-terminal blocker gates unstarted  
**Setup:** Issue(stateType="unstarted", blockers=[{state:"Done"},{state:"Todo"}])  
**Action:** shouldDispatchIssue(issue, settings, state)  
**Expected:** false  
**Status:** PENDING

### S-035: Started issue with non-terminal blocker is still eligible
**Category:** Dispatch Eligibility  
**Invariant:** Blockers only gate unstarted issues  
**Setup:** Issue(stateType="started", state="In Progress", blockers=[{state:"Todo"}])  
**Action:** shouldDispatchIssue(issue, settings, state)  
**Expected:** true  
**Status:** PENDING

### S-036: Unstarted issue with all terminal blockers is eligible
**Category:** Dispatch Eligibility  
**Invariant:** All blockers resolved -> eligible  
**Setup:** Issue(stateType="unstarted", blockers=[{state:"Done"},{state:"Cancelled"}])  
**Action:** shouldDispatchIssue(issue, settings, state)  
**Expected:** true  
**Status:** PENDING

### S-037: Global concurrency cap reached blocks dispatch
**Category:** Dispatch Eligibility  
**Invariant:** Global cap -> no new dispatches  
**Setup:** maxConcurrentAgents=2, runningCount=2  
**Action:** shouldDispatchIssue(issue, settings, {runningCount:2,...})  
**Expected:** false (via dispatchBlockReason)  
**Status:** PENDING

### S-038: Global concurrency one below cap allows dispatch
**Category:** Dispatch Eligibility  
**Invariant:** Below cap -> eligible  
**Setup:** maxConcurrentAgents=2, runningCount=1  
**Action:** shouldDispatchIssue(issue, settings, {runningCount:1,...})  
**Expected:** true (assuming other conditions met)  
**Status:** PENDING

### S-039: Per-state concurrency cap blocks dispatch in that state
**Category:** Dispatch Eligibility  
**Invariant:** Per-state cap -> no new in that state  
**Setup:** statusOverrides.Todo.agent.maxConcurrentAgents=1, runningByState={"Todo":1}  
**Action:** dispatchBlockReason(issue, settings, {runningByState})  
**Expected:** "local_concurrency_cap"  
**Status:** PENDING

### S-040: Worker host capacity full blocks dispatch
**Category:** Dispatch Eligibility  
**Invariant:** All hosts at capacity -> no dispatches  
**Setup:** sshHosts=["worker-a"], cap=1, running on worker-a=1  
**Action:** shouldDispatchIssue(issue, settings, {workerCapacityAvailable:false})  
**Expected:** false  
**Status:** PENDING

### S-041: All ensemble slots claimed makes issue ineligible
**Category:** Dispatch Eligibility  
**Invariant:** All slots claimed -> ineligible  
**Setup:** Issue(labels=["ensemble:2"]), claimedSlots={"id:0","id:1"}  
**Action:** shouldDispatchIssue(issue, settings, {claimedSlots})  
**Expected:** false  
**Status:** PENDING

### S-042: Some ensemble slots free keeps issue eligible
**Category:** Dispatch Eligibility  
**Invariant:** Unclaimed slots -> eligible  
**Setup:** Issue(labels=["ensemble:2"]), claimedSlots={"id:0"}  
**Action:** shouldDispatchIssue(issue, settings, {claimedSlots})  
**Expected:** true  
**Status:** PENDING

### S-043: Issue with state "Todo" in activeStates is eligible
**Category:** Dispatch Eligibility  
**Invariant:** Active state + all conditions met -> eligible  
**Setup:** Normal issue in "Todo", activeStates includes "Todo"  
**Action:** shouldDispatchIssue(issue, settings, normalState)  
**Expected:** true  
**Status:** PENDING

### S-044: Blocker with undefined state counts as non-terminal
**Category:** Dispatch Eligibility  
**Invariant:** isTerminalState(undefined) = false  
**Setup:** Unstarted issue, blocker has state=undefined  
**Action:** shouldDispatchIssue(issue, settings, state)  
**Expected:** false (blocker is non-terminal, blocks unstarted)  
**Status:** PENDING

### S-045: Issue with stateType "unstarted" but custom state name
**Category:** Dispatch Eligibility  
**Invariant:** issueHasOpenBlockers checks stateType OR state="todo"  
**Setup:** Issue(stateType="unstarted", state="Ready"), blocker(state="Todo")  
**Action:** shouldDispatchIssue(issue, settings, state)  
**Expected:** false (stateType="unstarted" triggers blocker check)  
**Status:** PENDING

### S-046: Issue with state "todo" (lowercase) but stateType=null triggers blocker check
**Category:** Dispatch Eligibility  
**Invariant:** issueHasOpenBlockers also checks state name "todo"  
**Setup:** Issue(stateType=null, state="todo"), blockers=[{state:"In Progress"}]  
**Action:** issueHasOpenBlockers(issue, settings)  
**Expected:** true (state.trim().toLowerCase()==="todo" triggers check)  
**Status:** PENDING

### S-047: Issue with state "TODO" (uppercase) triggers blocker check
**Category:** Dispatch Eligibility  
**Invariant:** State comparison is case-insensitive  
**Setup:** Issue(stateType=null, state="TODO"), blockers=[{state:"In Progress"}]  
**Action:** issueHasOpenBlockers(issue, settings)  
**Expected:** true  
**Status:** PENDING

### S-048: State in both active and terminal lists
**Category:** Dispatch Eligibility  
**Invariant:** Terminal check fails issueIsActive even if in active list  
**Setup:** activeStates=["Done"], terminalStates=["Done"], issue(state="Done")  
**Action:** issueIsActive(issue, settings)  
**Expected:** false (terminal takes precedence)  
**Status:** PENDING

### S-049: dispatchBlockReason returns null for ineligible issues
**Category:** Dispatch Eligibility  
**Invariant:** Block reasons only reported for otherwise-eligible issues  
**Setup:** Issue with empty id (ineligible)  
**Action:** dispatchBlockReason(issue, settings, {runningCount:999})  
**Expected:** null (not "global_concurrency_cap")  
**Status:** PENDING

### S-050: Issue with assignedToWorker=null is treated as eligible
**Category:** Dispatch Eligibility  
**Invariant:** routedToThisWorker checks assignedToWorker===false specifically  
**Setup:** Issue(assignedToWorker=null)  
**Action:** routedToThisWorker(issue, settings)  
**Expected:** true (only false blocks)  
**Status:** PENDING

### S-051: Blocker with stateType "completed" is terminal
**Category:** Dispatch Eligibility  
**Invariant:** Terminal blockers don't gate  
**Setup:** Unstarted issue, blocker(stateType="completed", state="Done")  
**Action:** issueHasOpenBlockers(issue, settings)  
**Expected:** false (blocker is terminal)  
**Status:** PENDING

### S-052: Issue with state matching active list case-insensitively
**Category:** Dispatch Eligibility  
**Invariant:** State matching is case-insensitive  
**Setup:** activeStates=["todo"], issue(state="Todo")  
**Action:** issueIsActive(issue, settings)  
**Expected:** true  
**Status:** PENDING

### S-053: Unstarted issue with empty blockers array is eligible
**Category:** Dispatch Eligibility  
**Invariant:** No blockers -> eligible  
**Setup:** Issue(stateType="unstarted", blockers=[])  
**Action:** issueHasOpenBlockers(issue, settings)  
**Expected:** false  
**Status:** PENDING

### S-054: Global cap = 0 blocks everything
**Category:** Dispatch Eligibility  
**Invariant:** Cap reached -> no dispatch  
**Setup:** maxConcurrentAgents=0, runningCount=0  
**Action:** dispatchBlockReason(issue, settings, {runningCount:0})  
**Expected:** "global_concurrency_cap" (0 >= 0)  
**Status:** PENDING

### S-055: Active state with leading whitespace matches
**Category:** Dispatch Eligibility  
**Invariant:** State matching is whitespace-tolerant  
**Setup:** activeStates=[" Todo "], issue(state="Todo")  
**Action:** issueIsActive(issue, settings)  
**Expected:** true  
**Status:** PENDING

---

## Routing

### S-056: Route label matches allowlist entry
**Category:** Routing  
**Invariant:** Valid route in allowlist -> eligible  
**Setup:** Issue(labels=["symphony:backend"]), onlyRoutes=["backend"]  
**Action:** routedToThisWorker(issue, settings)  
**Expected:** true  
**Status:** PENDING

### S-057: Route label case-insensitive matching
**Category:** Routing  
**Invariant:** Case-insensitive  
**Setup:** Issue(labels=["SYMPHONY:BACKEND"]), prefix="Symphony:", onlyRoutes=["backend"]  
**Action:** routedToThisWorker(issue, settings)  
**Expected:** true (labels are lowercased during normalization)  
**Status:** PENDING

### S-058: Route label with whitespace-only name after prefix
**Category:** Routing  
**Invariant:** Whitespace-only name -> not valid  
**Setup:** Issue(labels=["symphony: "]), acceptUnrouted=true  
**Action:** routedToThisWorker(issue, settings)  
**Expected:** false (hasRouteLabel=true, but routeNames=[], treated as routed-but-invalid)  
**Status:** PENDING

### S-059: No route label, acceptUnrouted=true
**Category:** Routing  
**Invariant:** Unrouted accepted when enabled  
**Setup:** Issue(labels=[]), acceptUnrouted=true  
**Action:** routedToThisWorker(issue, settings)  
**Expected:** true  
**Status:** PENDING

### S-060: No route label, acceptUnrouted=false
**Category:** Routing  
**Invariant:** Unrouted rejected when disabled  
**Setup:** Issue(labels=[]), acceptUnrouted=false  
**Action:** routedToThisWorker(issue, settings)  
**Expected:** false  
**Status:** PENDING

### S-061: Route label not in allowlist
**Category:** Routing  
**Invariant:** Route not in list -> rejected  
**Setup:** Issue(labels=["symphony:frontend"]), onlyRoutes=["backend"]  
**Action:** routedToThisWorker(issue, settings)  
**Expected:** false  
**Status:** PENDING

### S-062: onlyRoutes=null accepts all routes
**Category:** Routing  
**Invariant:** Null allowlist -> accept all  
**Setup:** Issue(labels=["symphony:anything"]), onlyRoutes=null  
**Action:** routedToThisWorker(issue, settings)  
**Expected:** true  
**Status:** PENDING

### S-063: onlyRoutes=[] rejects all routes
**Category:** Routing  
**Invariant:** Empty allowlist -> reject all  
**Setup:** Issue(labels=["symphony:backend"]), onlyRoutes=[]  
**Action:** routedToThisWorker(issue, settings)  
**Expected:** false  
**Status:** PENDING

### S-064: Multiple route labels, first matches
**Category:** Routing  
**Invariant:** Any matching route suffices  
**Setup:** Issue(labels=["symphony:frontend","symphony:backend"]), onlyRoutes=["backend"]  
**Action:** routedToThisWorker(issue, settings)  
**Expected:** true  
**Status:** PENDING

### S-065: Route prefix matching is case-insensitive
**Category:** Routing  
**Invariant:** Prefix matching case-insensitive  
**Setup:** routeLabelPrefix="Symphony:", issue has label "symphony:backend"  
**Action:** routeNames(issue, settings)  
**Expected:** ["backend"]  
**Status:** PENDING

### S-066: normalizeRouteName with empty string
**Category:** Routing  
**Invariant:** Normalization behavior  
**Setup:** Input ""  
**Action:** normalizeRouteName("")  
**Expected:** ""  
**Status:** PENDING

### S-067: normalizeRouteName with null
**Category:** Routing  
**Invariant:** Handles null  
**Setup:** Input null  
**Action:** normalizeRouteName(null)  
**Expected:** "" (String(null) = "null", trimmed, lowercased = "null")?  
**Status:** PENDING

### S-068: normalizeRouteName with undefined
**Category:** Routing  
**Invariant:** Handles undefined  
**Setup:** Input undefined  
**Action:** normalizeRouteName(undefined)  
**Expected:** "" (String(undefined) = "undefined")?  
**Status:** PENDING

### S-069: normalizeRouteName is idempotent
**Category:** Routing  
**Invariant:** Applied twice = same result  
**Setup:** Input "  Backend  "  
**Action:** normalizeRouteName(normalizeRouteName("  Backend  "))  
**Expected:** "backend" both times  
**Status:** PENDING

### S-070: Route label with extra internal whitespace
**Category:** Routing  
**Invariant:** Whitespace stripping  
**Setup:** Issue(labels=["symphony:  backend  "])  
**Action:** routeNames(issue, settings)  
**Expected:** ["backend"] (trimmed after prefix removal)  
**Status:** PENDING

### S-071: Issue with label that is prefix-only (no suffix at all)
**Category:** Routing  
**Invariant:** Empty name after prefix -> not valid  
**Setup:** Issue(labels=["symphony:"])  
**Action:** routeNames(issue, settings)  
**Expected:** [] (empty string after normalizeRouteName is filtered out)  
**Status:** PENDING

### S-072: hasRouteLabel true but routeNames empty (whitespace suffix)
**Category:** Routing  
**Invariant:** Routed-but-invalid -> rejected  
**Setup:** Issue(labels=["symphony:   "])  
**Action:** hasRouteLabel=true, routeNames=[], routedToThisWorker returns false  
**Expected:** false regardless of acceptUnrouted  
**Status:** PENDING

### S-073: Multiple labels, none match prefix
**Category:** Routing  
**Invariant:** No route label behavior  
**Setup:** Issue(labels=["bug","feature"]), acceptUnrouted=true  
**Action:** routedToThisWorker(issue, settings)  
**Expected:** true (unrouted, accepted)  
**Status:** PENDING

### S-074: Route allowlist with mixed case entries
**Category:** Routing  
**Invariant:** Allowlist comparison uses normalizeRouteName  
**Setup:** onlyRoutes=["Backend"], issue label "symphony:backend"  
**Action:** routedToThisWorker(issue, settings)  
**Expected:** true (allowlist entries are normalized)  
**Status:** PENDING

### S-075: assignedToWorker=false short-circuits routing check
**Category:** Routing  
**Invariant:** Assignment check before routing  
**Setup:** Issue(assignedToWorker=false, labels=["symphony:backend"]), onlyRoutes=["backend"]  
**Action:** routedToThisWorker(issue, settings)  
**Expected:** false  
**Status:** PENDING

---

## State Classification

### S-076: "Done" matches terminalStates=["Done"] case-insensitively
**Category:** State Classification  
**Invariant:** Case-insensitive comparison  
**Setup:** state="Done", terminalStates=["done"]  
**Action:** isTerminalState("Done", ["done"])  
**Expected:** true  
**Status:** PENDING

### S-077: " Done " with whitespace matches
**Category:** State Classification  
**Invariant:** Whitespace stripped  
**Setup:** state=" Done ", terminalStates=["Done"]  
**Action:** isTerminalState(" Done ", ["Done"])  
**Expected:** true  
**Status:** PENDING

### S-078: null state is non-terminal
**Category:** State Classification  
**Invariant:** Null -> non-terminal  
**Setup:** state=null  
**Action:** isTerminalState(null, ["Done"])  
**Expected:** false  
**Status:** PENDING

### S-079: undefined state is non-terminal
**Category:** State Classification  
**Invariant:** Undefined -> non-terminal  
**Setup:** state=undefined  
**Action:** isTerminalState(undefined, ["Done"])  
**Expected:** false  
**Status:** PENDING

### S-080: Unknown state is non-terminal
**Category:** State Classification  
**Invariant:** Not in list -> non-terminal  
**Setup:** state="Unknown", terminalStates=["Done","Cancelled"]  
**Action:** isTerminalState("Unknown", ["Done","Cancelled"])  
**Expected:** false  
**Status:** PENDING

### S-081: Empty string state is non-terminal
**Category:** State Classification  
**Invariant:** Empty state handling  
**Setup:** state=""  
**Action:** isTerminalState("", ["Done"])  
**Expected:** false (empty after trim won't match "done")  
**Status:** PENDING

### S-082: Mixed case "dOnE" matches "Done"
**Category:** State Classification  
**Invariant:** Case-insensitive  
**Setup:** state="dOnE", terminalStates=["Done"]  
**Action:** isTerminalState("dOnE", ["Done"])  
**Expected:** true  
**Status:** PENDING

### S-083: State with tabs and spaces
**Category:** State Classification  
**Invariant:** Whitespace stripped  
**Setup:** state="\tDone\t", terminalStates=["Done"]  
**Action:** isTerminalState("\tDone\t", ["Done"])  
**Expected:** true  
**Status:** PENDING

### S-084: Terminal states list contains whitespace entries
**Category:** State Classification  
**Invariant:** Both sides trimmed  
**Setup:** state="Done", terminalStates=[" Done "]  
**Action:** isTerminalState("Done", [" Done "])  
**Expected:** true  
**Status:** PENDING

### S-085: Empty terminal states list
**Category:** State Classification  
**Invariant:** Not in list -> non-terminal  
**Setup:** state="Done", terminalStates=[]  
**Action:** isTerminalState("Done", [])  
**Expected:** false  
**Status:** PENDING

---

## Ensemble Resolution

### S-086: Label "ensemble:3" returns size 3
**Category:** Ensemble Resolution  
**Invariant:** Valid positive integer used  
**Setup:** Issue(labels=["ensemble:3"])  
**Action:** ensembleSize(issue)  
**Expected:** 3  
**Status:** PENDING

### S-087: Label "ensemble:0" returns null (ignored)
**Category:** Ensemble Resolution  
**Invariant:** Zero ignored, use default  
**Setup:** Issue(labels=["ensemble:0"])  
**Action:** ensembleSize(issue)  
**Expected:** null  
**Status:** PENDING

### S-088: Label "ensemble:-1" is not matched by regex
**Category:** Ensemble Resolution  
**Invariant:** Negative ignored  
**Setup:** Issue(labels=["ensemble:-1"])  
**Action:** ensembleSize(issue)  
**Expected:** null (regex \d+ doesn't match negative)  
**Status:** PENDING

### S-089: Label "ENSEMBLE:5" after toLowerCase matches
**Category:** Ensemble Resolution  
**Invariant:** Case-insensitive matching  
**Setup:** Issue with raw label "ENSEMBLE:5" (normalizeLabels lowercases it to "ensemble:5")  
**Action:** ensembleSize(issue)  
**Expected:** 5  
**Status:** PENDING

### S-090: Multiple ensemble labels, first wins
**Category:** Ensemble Resolution  
**Invariant:** First valid label used  
**Setup:** Issue(labels=["ensemble:2", "ensemble:4"])  
**Action:** ensembleSize(issue)  
**Expected:** 2  
**Status:** PENDING

### S-091: Label "ensemble:abc" is not matched
**Category:** Ensemble Resolution  
**Invariant:** Non-numeric ignored  
**Setup:** Issue(labels=["ensemble:abc"])  
**Action:** ensembleSize(issue)  
**Expected:** null  
**Status:** PENDING

### S-092: No ensemble label returns null
**Category:** Ensemble Resolution  
**Invariant:** No label -> fallback to default  
**Setup:** Issue(labels=["bug","feature"])  
**Action:** ensembleSize(issue)  
**Expected:** null  
**Status:** PENDING

### S-093: Label "ensemble:1" is valid
**Category:** Ensemble Resolution  
**Invariant:** 1 is valid positive  
**Setup:** Issue(labels=["ensemble:1"])  
**Action:** ensembleSize(issue)  
**Expected:** 1  
**Status:** PENDING

### S-094: Label "ensemble:999999" is valid large size
**Category:** Ensemble Resolution  
**Invariant:** Any positive integer accepted  
**Setup:** Issue(labels=["ensemble:999999"])  
**Action:** ensembleSize(issue)  
**Expected:** 999999  
**Status:** PENDING

### S-095: Label with leading space " ensemble:3" after normalizeLabels
**Category:** Ensemble Resolution  
**Invariant:** Labels are trimmed during normalization  
**Setup:** Raw label " ensemble:3 " -> normalized to "ensemble:3"  
**Action:** ensembleSize(issue)  
**Expected:** 3  
**Status:** PENDING

---

## Retry and Backoff

### S-096: Failure attempt 1, cap 60000
**Category:** Retry and Backoff  
**Invariant:** Non-negative delay  
**Setup:** attempt=1, maxRetryBackoffMs=60000, kind="failure"  
**Action:** retryBackoffMs(1, 60000, "failure")  
**Expected:** 10000 (10000 * 2^0)  
**Status:** PENDING

### S-097: Failure attempt 2, monotonically increasing
**Category:** Retry and Backoff  
**Invariant:** Monotonically non-decreasing  
**Setup:** attempt=2, cap=60000  
**Action:** retryBackoffMs(2, 60000, "failure")  
**Expected:** 20000 >= 10000  
**Status:** PENDING

### S-098: Failure attempt 3
**Category:** Retry and Backoff  
**Invariant:** Monotonically non-decreasing  
**Setup:** attempt=3, cap=60000  
**Action:** retryBackoffMs(3, 60000, "failure")  
**Expected:** 40000 >= 20000  
**Status:** PENDING

### S-099: Failure attempt 4 hits cap
**Category:** Retry and Backoff  
**Invariant:** Never exceeds cap  
**Setup:** attempt=4, cap=60000  
**Action:** retryBackoffMs(4, 60000, "failure")  
**Expected:** 60000 (min(80000, 60000))  
**Status:** PENDING

### S-100: Failure attempt 100, respects cap
**Category:** Retry and Backoff  
**Invariant:** Never exceeds cap  
**Setup:** attempt=100, cap=60000  
**Action:** retryBackoffMs(100, 60000, "failure")  
**Expected:** 60000  
**Status:** PENDING

### S-101: Continuation always returns 1000
**Category:** Retry and Backoff  
**Invariant:** Fixed short delay  
**Setup:** attempt=1, cap=60000, kind="continuation"  
**Action:** retryBackoffMs(1, 60000, "continuation")  
**Expected:** 1000  
**Status:** PENDING

### S-102: Continuation ignores attempt number
**Category:** Retry and Backoff  
**Invariant:** Fixed regardless of attempt  
**Setup:** attempt=999, cap=60000, kind="continuation"  
**Action:** retryBackoffMs(999, 60000, "continuation")  
**Expected:** 1000  
**Status:** PENDING

### S-103: Failure attempt 0 edge case
**Category:** Retry and Backoff  
**Invariant:** Non-negative  
**Setup:** attempt=0, cap=60000  
**Action:** retryBackoffMs(0, 60000, "failure")  
**Expected:** Math.min(60000, 10000*2^max(0,-1)) = Math.min(60000, 10000*2^0) = 10000  
**Status:** PENDING

### S-104: Failure with negative attempt
**Category:** Retry and Backoff  
**Invariant:** Non-negative  
**Setup:** attempt=-1, cap=60000  
**Action:** retryBackoffMs(-1, 60000, "failure")  
**Expected:** Math.min(60000, 10000*2^max(0,-2)) = 10000  
**Status:** PENDING

### S-105: Cap = 0 means result is 0
**Category:** Retry and Backoff  
**Invariant:** Never exceeds cap + non-negative  
**Setup:** attempt=1, cap=0  
**Action:** retryBackoffMs(1, 0, "failure")  
**Expected:** Math.min(0, 10000) = 0. Non-negative? Yes. But invariant says "minimum delay floor prevents zero-delay storms"  
**Status:** **FAILED** — No minimum floor; zero delay allows retry storms

### S-106: Negative cap produces negative result
**Category:** Retry and Backoff  
**Invariant:** Non-negative delay  
**Setup:** attempt=1, cap=-1  
**Action:** retryBackoffMs(1, -1, "failure")  
**Expected:** Math.min(-1, 10000) = -1. NEGATIVE! Invariant violation?  
**Status:** **FAILED** — Negative cap propagates to negative return value

### S-107: Monotonicity across attempts 1 through 10
**Category:** Retry and Backoff  
**Invariant:** Monotonically non-decreasing  
**Setup:** cap=120000  
**Action:** retryBackoffMs for attempts 1..10  
**Expected:** Each >= previous  
**Status:** PENDING

### S-108: Continuation with cap=0 still returns 1000
**Category:** Retry and Backoff  
**Invariant:** Continuation uses fixed delay regardless  
**Setup:** attempt=1, cap=0, kind="continuation"  
**Action:** retryBackoffMs(1, 0, "continuation")  
**Expected:** 1000 (continuation ignores cap)  
**Status:** PENDING

### S-109: Continuation with cap=-1 still returns 1000
**Category:** Retry and Backoff  
**Invariant:** Fixed short delay  
**Setup:** attempt=1, cap=-1, kind="continuation"  
**Action:** retryBackoffMs(1, -1, "continuation")  
**Expected:** 1000  
**Status:** PENDING

### S-110: Very large attempt number (1000) with reasonable cap
**Category:** Retry and Backoff  
**Invariant:** Cap prevents overflow  
**Setup:** attempt=1000, cap=300000  
**Action:** retryBackoffMs(1000, 300000, "failure")  
**Expected:** 300000 (capped, even though 10000*2^999 is astronomically large)  
**Status:** PENDING

---

## Usage Accounting

### S-111: Update with higher tokens increases entry totals
**Category:** Usage Accounting  
**Invariant:** Monotonic growth  
**Setup:** entryTotals={input:10,output:5,total:15}, update={input:20,output:10,total:30}  
**Action:** mergeMonotonicUsage(...)  
**Expected:** entryTotals={input:20,output:10,total:30}  
**Status:** PENDING

### S-112: Update with lower tokens keeps entry totals same
**Category:** Usage Accounting  
**Invariant:** Never decrease  
**Setup:** entryTotals={input:20,output:10,total:30}, update={input:15,output:8,total:23}  
**Action:** mergeMonotonicUsage(...)  
**Expected:** entryTotals={input:20,output:10,total:30} (unchanged)  
**Status:** PENDING

### S-113: Update with negative tokens is clamped to 0
**Category:** Usage Accounting  
**Invariant:** Never negative  
**Setup:** entryTotals={input:0,output:0,total:0}, update={input:-5,output:-3,total:-8}  
**Action:** mergeMonotonicUsage(...)  
**Expected:** entryTotals={input:0,output:0,total:0} (Math.max with 0 floor)  
**Status:** PENDING

### S-114: Global totals delta calculation
**Category:** Usage Accounting  
**Invariant:** Correct deltas  
**Setup:** global={input:100}, reported={input:10}, entry={input:10}, update={input:20}  
**Action:** mergeMonotonicUsage(...)  
**Expected:** globalInput=100+(20-10)=110, reported=20  
**Status:** PENDING

### S-115: Same update applied twice is idempotent
**Category:** Usage Accounting  
**Invariant:** Idempotent  
**Setup:** Apply update, then apply same update to result  
**Action:** mergeMonotonicUsage(mergeMonotonicUsage(initial, update), update)  
**Expected:** Same as single application  
**Status:** PENDING

### S-116: Update with only inputTokens, others undefined
**Category:** Usage Accounting  
**Invariant:** Partial update  
**Setup:** update={inputTokens:50}, others undefined  
**Action:** mergeMonotonicUsage(...)  
**Expected:** inputTokens updated, others keep entryTotals value  
**Status:** PENDING

### S-117: secondsRunning preserved independently
**Category:** Usage Accounting  
**Invariant:** Independent preservation  
**Setup:** entryTotals.secondsRunning=100, update has no secondsRunning  
**Action:** mergeMonotonicUsage(...)  
**Expected:** result.entryTotals.secondsRunning=100  
**Status:** PENDING

### S-118: Global totals never decrease
**Category:** Usage Accounting  
**Invariant:** Global monotonic  
**Setup:** globalTotals={input:100}, update causes 0 delta  
**Action:** mergeMonotonicUsage(...)  
**Expected:** globalTotals.input >= 100  
**Status:** PENDING

### S-119: Negative delta from reported to next is clamped to 0
**Category:** Usage Accounting  
**Invariant:** No negative deltas  
**Setup:** reportedTotals={input:30}, next would be 20 (from lower update)  
**Action:** mergeMonotonicUsage(...)  
**Expected:** delta = Math.max(0, 20-30) = 0, global unchanged  
**Status:** PENDING

### S-120: NaN in update.inputTokens
**Category:** Usage Accounting  
**Invariant:** Never negative, stable  
**Setup:** entryTotals={input:10}, update={inputTokens:NaN}  
**Action:** mergeMonotonicUsage(...)  
**Expected:** Math.max(10, 0, NaN) = 10? Or NaN? (Math.max behavior with NaN)  
**Status:** **FAILED** — Math.max(10, 0, NaN) returns NaN in JavaScript; corrupts all downstream totals

### S-121: NaN in update.totalTokens only
**Category:** Usage Accounting  
**Invariant:** Never negative  
**Setup:** entryTotals={total:10}, update={totalTokens:NaN, inputTokens:20}  
**Action:** mergeMonotonicUsage(...)  
**Expected:** total: Math.max(10, 0, NaN) = NaN! Bug?  
**Status:** **FAILED** — NaN propagates per-field; totalTokens becomes NaN while inputTokens correctly updates

### S-122: Very large token value (Number.MAX_SAFE_INTEGER)
**Category:** Usage Accounting  
**Invariant:** Handles large numbers  
**Setup:** update={inputTokens: Number.MAX_SAFE_INTEGER}  
**Action:** mergeMonotonicUsage(...)  
**Expected:** Works without overflow  
**Status:** PENDING

### S-123: Zero tokens update does not change anything
**Category:** Usage Accounting  
**Invariant:** Monotonic (0 is not > previous)  
**Setup:** entryTotals={input:10}, update={inputTokens:0}  
**Action:** mergeMonotonicUsage(...)  
**Expected:** entryTotals.input stays 10 (max(10,0,0)=10)  
**Status:** PENDING

### S-124: Initial entry totals are 0, first update sets values
**Category:** Usage Accounting  
**Invariant:** Growth from zero  
**Setup:** entryTotals={input:0,output:0,total:0}, update={input:100,output:50,total:150}  
**Action:** mergeMonotonicUsage(...)  
**Expected:** entryTotals={100,50,150}, delta=100/50/150 added to global  
**Status:** PENDING

### S-125: Reported totals watermark stays in sync
**Category:** Usage Accounting  
**Invariant:** Watermark in sync  
**Setup:** After merge, reportedTotals should equal entryTotals (for token fields)  
**Action:** Check result.reportedTotals vs result.entryTotals  
**Expected:** reportedTotals.inputTokens === entryTotals.inputTokens etc.  
**Status:** PENDING

---

## Worker Host Selection

### S-126: Empty host list returns null
**Category:** Worker Host Selection  
**Invariant:** Empty -> null  
**Setup:** hosts=[], cap=5  
**Action:** selectLeastLoadedHost({hosts:[], runningCounts:new Map(), cap:5})  
**Expected:** null  
**Status:** PENDING

### S-127: Single host below cap is selected
**Category:** Worker Host Selection  
**Invariant:** Available host selected  
**Setup:** hosts=["a"], runningCounts={a:0}, cap=2  
**Action:** selectLeastLoadedHost(...)  
**Expected:** "a"  
**Status:** PENDING

### S-128: Single host at cap returns undefined
**Category:** Worker Host Selection  
**Invariant:** At capacity -> undefined  
**Setup:** hosts=["a"], runningCounts={a:2}, cap=2  
**Action:** selectLeastLoadedHost(...)  
**Expected:** undefined (null for empty, undefined for at-capacity)  
**Status:** PENDING

### S-129: Two hosts, one at cap, select the other
**Category:** Worker Host Selection  
**Invariant:** Only below-cap hosts eligible  
**Setup:** hosts=["a","b"], runningCounts={a:2,b:1}, cap=2  
**Action:** selectLeastLoadedHost(...)  
**Expected:** "b"  
**Status:** PENDING

### S-130: Two hosts both below cap, select lowest load
**Category:** Worker Host Selection  
**Invariant:** Lowest load wins  
**Setup:** hosts=["a","b"], runningCounts={a:1,b:0}, cap=3  
**Action:** selectLeastLoadedHost(...)  
**Expected:** "b"  
**Status:** PENDING

### S-131: Two hosts same load, first in list wins
**Category:** Worker Host Selection  
**Invariant:** Deterministic selection  
**Setup:** hosts=["a","b"], runningCounts={a:1,b:1}, cap=3  
**Action:** selectLeastLoadedHost(...)  
**Expected:** "a" (first found with lowest)  
**Status:** PENDING

### S-132: All hosts at capacity returns undefined
**Category:** Worker Host Selection  
**Invariant:** All full -> undefined  
**Setup:** hosts=["a","b"], runningCounts={a:2,b:2}, cap=2  
**Action:** selectLeastLoadedHost(...)  
**Expected:** undefined  
**Status:** PENDING

### S-133: Host with 0 running, cap=1
**Category:** Worker Host Selection  
**Invariant:** 0 < 1 -> selected  
**Setup:** hosts=["a"], runningCounts=new Map(), cap=1  
**Action:** selectLeastLoadedHost(...)  
**Expected:** "a" (count defaults to 0 via ?? 0)  
**Status:** PENDING

### S-134: Cap = 0 means no host ever eligible
**Category:** Worker Host Selection  
**Invariant:** count < 0 never true  
**Setup:** hosts=["a"], runningCounts=new Map(), cap=0  
**Action:** selectLeastLoadedHost(...)  
**Expected:** undefined (0 < 0 is false)  
**Status:** PENDING

### S-135: Duplicate host names in list
**Category:** Worker Host Selection  
**Invariant:** Behavior with duplicates  
**Setup:** hosts=["a","a"], runningCounts={a:0}, cap=2  
**Action:** selectLeastLoadedHost(...)  
**Expected:** "a" (first iteration finds it)  
**Status:** PENDING

### S-136: Host not in runningCounts defaults to 0
**Category:** Worker Host Selection  
**Invariant:** Missing count = 0  
**Setup:** hosts=["a","b"], runningCounts={a:1}, cap=2  
**Action:** selectLeastLoadedHost(...)  
**Expected:** "b" (count 0 < count 1)  
**Status:** PENDING

### S-137: Negative cap means all hosts eligible
**Category:** Worker Host Selection  
**Invariant:** count < negativeNumber  
**Setup:** hosts=["a"], runningCounts={a:5}, cap=-1  
**Action:** selectLeastLoadedHost(...)  
**Expected:** undefined? (5 < -1 is false) or "a"?  
**Status:** PENDING

### S-138: No false starvation - one host below cap always selected
**Category:** Worker Host Selection  
**Invariant:** No false starvation  
**Setup:** hosts=["a","b","c"], runningCounts={a:5,b:5,c:1}, cap=5  
**Action:** selectLeastLoadedHost(...)  
**Expected:** "c" (1 < 5)  
**Status:** PENDING

---

## Configuration Overrides

### S-139: No override for state returns unchanged settings
**Category:** Configuration Overrides  
**Invariant:** No override -> base unchanged  
**Setup:** statusOverrides={}, issue state="Todo"  
**Action:** settingsForIssueState(settings, "Todo")  
**Expected:** Same as base settings  
**Status:** PENDING

### S-140: Override for "todo" matches "Todo" (case insensitive)
**Category:** Configuration Overrides  
**Invariant:** Case-insensitive lookup  
**Setup:** statusOverrides={"todo": {agent:{maxConcurrentAgents:1}}}  
**Action:** settingsForIssueState(settings, "Todo")  
**Expected:** agent.maxConcurrentAgents=1  
**Status:** PENDING

### S-141: Override for "In Progress" with different casing
**Category:** Configuration Overrides  
**Invariant:** Case-insensitive  
**Setup:** statusOverrides={"in progress": {agent:{kind:"claude"}}}  
**Action:** settingsForIssueState(settings, "In Progress")  
**Expected:** agent.kind="claude"  
**Status:** PENDING

### S-142: Unknown state has no override
**Category:** Configuration Overrides  
**Invariant:** Missing -> base  
**Setup:** statusOverrides={"todo":{...}}, state="Unknown"  
**Action:** settingsForIssueState(settings, "Unknown")  
**Expected:** Base settings unchanged  
**Status:** PENDING

### S-143: Partial override preserves unmentioned fields
**Category:** Configuration Overrides  
**Invariant:** Partial preserves rest  
**Setup:** base agent.kind="codex", override={agent:{maxConcurrentAgents:1}}  
**Action:** settingsForIssueState(settings, state)  
**Expected:** agent.kind still "codex", agent.maxConcurrentAgents=1  
**Status:** PENDING

### S-144: Two states have independent overrides
**Category:** Configuration Overrides  
**Invariant:** Independent application  
**Setup:** overrides: "todo"->{agent:{kind:"claude"}}, "in progress"->{agent:{kind:"codex"}}  
**Action:** settingsForIssueState for each state  
**Expected:** Each gets its own override independently  
**Status:** PENDING

### S-145: Override with whitespace in state name key
**Category:** Configuration Overrides  
**Invariant:** State name normalized for lookup  
**Setup:** statusOverrides={" todo ":{...}}, normalizeStateName trims  
**Action:** settingsForIssueState(settings, "Todo")  
**Expected:** Match found (both normalize to "todo")  
**Status:** PENDING

---

## Orchestrator Scheduling

### S-146: Claim with ensemble=1, second claim returns null
**Category:** Orchestrator Scheduling  
**Invariant:** No duplicate concurrent workers  
**Setup:** Orchestrator with ensembleSize=1  
**Action:** claim(issue) twice  
**Expected:** First returns entry, second returns null  
**Status:** PENDING

### S-147: Claim with ensemble=2, claims two slots
**Category:** Orchestrator Scheduling  
**Invariant:** Distinct slots  
**Setup:** Issue with ensemble:2 label  
**Action:** claim(issue) twice  
**Expected:** slot 0 then slot 1  
**Status:** PENDING

### S-148: Third claim on ensemble=2 returns null
**Category:** Orchestrator Scheduling  
**Invariant:** All slots claimed -> null  
**Setup:** After claiming slots 0 and 1  
**Action:** claim(issue) third time  
**Expected:** null  
**Status:** PENDING

### S-149: finish() removes from running and claimed
**Category:** Orchestrator Scheduling  
**Invariant:** Cleanup on finish  
**Setup:** Claimed issue  
**Action:** finish(issueId, 0, true)  
**Expected:** running.size decreases, claimed no longer has key  
**Status:** PENDING

### S-150: finish() with normal=true creates retry entry
**Category:** Orchestrator Scheduling  
**Invariant:** Normal exit -> continuation retry  
**Setup:** Running issue  
**Action:** finish(issueId, 0, true)  
**Expected:** retryAttempts has entry for issueId  
**Status:** PENDING

### S-151: finish() for non-existent key does nothing
**Category:** Orchestrator Scheduling  
**Invariant:** No crash  
**Setup:** Empty orchestrator  
**Action:** finish("nonexistent", 0, true)  
**Expected:** No error, state unchanged  
**Status:** PENDING

### S-152: applyUpdate for missing entry does nothing
**Category:** Orchestrator Scheduling  
**Invariant:** No crash  
**Setup:** Empty orchestrator  
**Action:** applyUpdate("missing", 0, {type:"turn_completed"})  
**Expected:** No error  
**Status:** PENDING

### S-153: eligibleIssues filters retries not yet due
**Category:** Orchestrator Scheduling  
**Invariant:** Retry timing respected  
**Setup:** Issue with retry dueAt in future  
**Action:** eligibleIssues([issue])  
**Expected:** [] (filtered out)  
**Status:** PENDING

### S-154: eligibleIssues includes retries that are past due
**Category:** Orchestrator Scheduling  
**Invariant:** Past-due retries become eligible  
**Setup:** Issue with retry dueAt in past  
**Action:** eligibleIssues([issue])  
**Expected:** [issue] (included)  
**Status:** PENDING

### S-155: cleanupIssue removes all traces
**Category:** Orchestrator Scheduling  
**Invariant:** Complete cleanup  
**Setup:** Running issue with retry  
**Action:** cleanupIssue(issueId)  
**Expected:** Gone from running, claimed, retryAttempts; in completed  
**Status:** PENDING

### S-156: Usage applied via applyUpdate
**Category:** Orchestrator Scheduling  
**Invariant:** Watermark deltas  
**Setup:** Running entry  
**Action:** applyUpdate(id, 0, {type:"usage", usage:{inputTokens:100}})  
**Expected:** Entry and global totals updated  
**Status:** PENDING

### S-157: secondsRunning added on finish only
**Category:** Orchestrator Scheduling  
**Invariant:** No double-counting  
**Setup:** Entry started 10s ago  
**Action:** finish(id, 0, true)  
**Expected:** usageTotals.secondsRunning += ~10  
**Status:** PENDING

### S-158: finish with normal=true, retryKind="failure" increments attempt
**Category:** Orchestrator Scheduling  
**Invariant:** Failure retry escalates  
**Setup:** Running entry  
**Action:** finish(id, 0, true, "error", "failure")  
**Expected:** retryAttempts.attempt increases  
**Status:** PENDING

### S-159: finish with normal=true, retryKind="continuation" uses attempt=1
**Category:** Orchestrator Scheduling  
**Invariant:** Continuation retry  
**Setup:** Running entry  
**Action:** finish(id, 0, true, undefined, "continuation")  
**Expected:** retryAttempts.attempt=1  
**Status:** PENDING

### S-160: Slot key format
**Category:** Orchestrator Scheduling  
**Invariant:** Correct key format  
**Setup:** issueId="abc", slotIndex=2  
**Action:** slotKey("abc", 2)  
**Expected:** "abc:2"  
**Status:** PENDING

---

## Reconciliation

### S-161: Terminal state stops worker and cleans workspace
**Category:** Reconciliation  
**Invariant:** Terminal -> stop + cleanup  
**Setup:** Running issue, tracker reports state="Done" (terminal)  
**Action:** reconcileTrackedIssues()  
**Expected:** Worker aborted, workspace removed  
**Status:** PENDING

### S-162: Non-active non-terminal stops worker, keeps workspace
**Category:** Reconciliation  
**Invariant:** Inactive -> stop, keep workspace  
**Setup:** Running issue, tracker reports state="Backlog" (not active, not terminal)  
**Action:** reconcileTrackedIssues()  
**Expected:** Worker aborted, workspace NOT removed  
**Status:** PENDING

### S-163: Assignee no longer matches stops worker
**Category:** Reconciliation  
**Invariant:** Routing mismatch -> stop  
**Setup:** Running issue, tracker reports assignedToWorker=false  
**Action:** reconcileTrackedIssues()  
**Expected:** Worker aborted  
**Status:** PENDING

### S-164: Route labels no longer match stops worker
**Category:** Reconciliation  
**Invariant:** Route mismatch -> stop  
**Setup:** Running issue, labels changed to different route  
**Action:** reconcileTrackedIssues()  
**Expected:** Worker aborted  
**Status:** PENDING

### S-165: Tracker refresh failure keeps workers running
**Category:** Reconciliation  
**Invariant:** Failure -> keep running, retry  
**Setup:** fetchIssuesByIds throws error  
**Action:** reconcileTrackedIssues()  
**Expected:** Workers still running, error logged  
**Status:** PENDING

### S-166: Issue disappears from tracker
**Category:** Reconciliation  
**Invariant:** Missing issue -> stop worker  
**Setup:** Running issue, fetchIssuesByIds returns empty  
**Action:** reconcileTrackedIssues()  
**Expected:** Worker aborted, cleanup  
**Status:** PENDING

### S-167: Active issue with matching route stays running
**Category:** Reconciliation  
**Invariant:** Valid issue -> refresh and continue  
**Setup:** Running issue still active and routed  
**Action:** reconcileTrackedIssues()  
**Expected:** refreshRunningIssue called, worker continues  
**Status:** PENDING

### S-168: Issue gains open blocker during run
**Category:** Reconciliation  
**Invariant:** Blocked issue reconciled  
**Setup:** Running started issue gains blocker (but since it's started, blockers don't gate)  
**Action:** reconcileTrackedIssues()  
**Expected:** Worker continues (blockers only gate unstarted)  
**Status:** PENDING

---

## Workspace Containment

### S-169: safeIdentifier removes special characters
**Category:** Workspace Containment  
**Invariant:** Only alphanumeric, dots, hyphens, underscores  
**Setup:** identifier="MT-123/../../etc"  
**Action:** safeIdentifier("MT-123/../../etc")  
**Expected:** "MT-123_.._.._etc" (/ replaced with _)  
**Status:** PENDING

### S-170: safeIdentifier is idempotent
**Category:** Workspace Containment  
**Invariant:** Double application same result  
**Setup:** identifier="MT-123"  
**Action:** safeIdentifier(safeIdentifier("MT-123"))  
**Expected:** "MT-123" both times  
**Status:** PENDING

### S-171: workspacePath for single slot has no suffix
**Category:** Workspace Containment  
**Invariant:** No slot suffix for single-slot  
**Setup:** root="/tmp/w", identifier="MT-1", slotIndex=0, ensembleSize=1  
**Action:** workspacePath("/tmp/w", "MT-1", 0, 1)  
**Expected:** "/tmp/w/MT-1" (no /0 suffix)  
**Status:** PENDING

### S-172: workspacePath for multi-slot includes slot index
**Category:** Workspace Containment  
**Invariant:** Distinct paths per slot  
**Setup:** ensembleSize=3  
**Action:** workspacePath("/tmp/w", "MT-1", 0, 3) vs workspacePath("/tmp/w", "MT-1", 1, 3)  
**Expected:** "/tmp/w/MT-1/0" and "/tmp/w/MT-1/1" (distinct)  
**Status:** PENDING

### S-173: workspacePath is deterministic
**Category:** Workspace Containment  
**Invariant:** Same inputs -> same path  
**Setup:** Same arguments  
**Action:** Call twice  
**Expected:** Identical result  
**Status:** PENDING

### S-174: safeIdentifier with empty string
**Category:** Workspace Containment  
**Invariant:** Safe output  
**Setup:** identifier=""  
**Action:** safeIdentifier("")  
**Expected:** ""  
**Status:** PENDING

### S-175: Control characters rejected in workspace input
**Category:** Workspace Containment  
**Invariant:** Control chars rejected  
**Setup:** workspace path with \n  
**Action:** invalidWorkspaceInput("/tmp/w/test\n")  
**Expected:** true (invalid)  
**Status:** PENDING

### S-176: Null byte in path rejected
**Category:** Workspace Containment  
**Invariant:** Control chars rejected  
**Setup:** workspace path with \0  
**Action:** invalidWorkspaceInput("/tmp/w/test\0bad")  
**Expected:** true (invalid)  
**Status:** PENDING

### S-177: Blank workspace path rejected
**Category:** Workspace Containment  
**Invariant:** Blank rejected  
**Setup:** workspace=" "  
**Action:** invalidWorkspaceInput("   ")  
**Expected:** true (invalid)  
**Status:** PENDING

### S-178: Path equal to root rejected
**Category:** Workspace Containment  
**Invariant:** Root not usable as cwd  
**Setup:** workspace=root="/tmp/w"  
**Action:** validateWorkspaceCwd attempts  
**Expected:** Error thrown  
**Status:** PENDING

---

## Additional Edge Cases

### S-179: shouldDispatchIssue with issue.id as empty string
**Category:** Dispatch Eligibility  
**Invariant:** Missing required field  
**Setup:** Issue manually constructed with id=""  
**Action:** shouldDispatchIssue({id:"", identifier:"X", title:"T", state:"Todo",...})  
**Expected:** false (empty string is falsy in !issue.id check)  
**Status:** PENDING

### S-180: dispatchBlockReason for ineligible issue returns null not a reason
**Category:** Dispatch Eligibility  
**Invariant:** Block reasons only for eligible issues  
**Setup:** Issue(state="Done") terminal, runningCount=999  
**Action:** dispatchBlockReason(issue, settings, {runningCount:999})  
**Expected:** null (returns early before capacity check)  
**Status:** PENDING

### S-181: Orchestrator.finish() always creates retry even for normal exits
**Category:** Orchestrator Scheduling  
**Invariant:** Normal exit -> continuation retry  
**Setup:** finish(id, 0, true)  
**Action:** Check state.completed and state.retryAttempts  
**Expected:** Both populated  
**Status:** PENDING

### S-182: selectLeastLoadedHost returns null vs undefined distinction
**Category:** Worker Host Selection  
**Invariant:** null=empty list, undefined=all full  
**Setup:** Check Orchestrator.claim() handling of both  
**Action:** Trace workerCapacityAvailable() and selectWorkerHost()  
**Expected:** Both cases handled (claim returns null)  
**Status:** PENDING

### S-183: issueHasOpenBlockers with state "TODO" and stateType=null
**Category:** Dispatch Eligibility  
**Invariant:** State name "todo" triggers blocker check  
**Setup:** Issue(state="TODO", stateType=null), blockers with non-terminal  
**Action:** issueHasOpenBlockers(issue, settings)  
**Expected:** true (state.trim().toLowerCase()==="todo" is true)  
**Status:** PENDING

### S-184: Issue in state "Todo" but stateType="started" - blocker check?
**Category:** Dispatch Eligibility  
**Invariant:** || means either condition triggers  
**Setup:** Issue(state="Todo", stateType="started"), non-terminal blocker  
**Action:** issueHasOpenBlockers(issue, settings)  
**Expected:** true! (stateType!=="unstarted" but state==="todo" triggers the check)  
**Status:** **FAILED** — Started issue incorrectly gated by blockers due to state name "Todo" matching hardcoded check

### S-185: retryBackoffMs "continuation" ignores cap entirely
**Category:** Retry and Backoff  
**Invariant:** Fixed short delay  
**Setup:** cap=500 (less than 1000)  
**Action:** retryBackoffMs(1, 500, "continuation")  
**Expected:** 1000 (doesn't go through Math.min(cap,...) path)  
**Status:** **FAILED** — Continuation bypasses cap; returns 1000 even when cap is 500

### S-186: mergeMonotonicUsage with all NaN update
**Category:** Usage Accounting  
**Invariant:** Never negative  
**Setup:** update={inputTokens:NaN, outputTokens:NaN, totalTokens:NaN}  
**Action:** mergeMonotonicUsage(...)  
**Expected:** Math.max(prev, 0, NaN) = NaN when prev > 0? Actually Math.max(10, 0, NaN) = NaN!  
**Status:** **FAILED** — All token fields become NaN, corrupting entry, reported, and global totals

### S-187: ensembleSize with label "ensemble:01" (leading zero)
**Category:** Ensemble Resolution  
**Invariant:** Positive integer  
**Setup:** Issue(labels=["ensemble:01"])  
**Action:** ensembleSize(issue)  
**Expected:** 1 (Number("01")=1, isInteger=true, >0=true)  
**Status:** PENDING

### S-188: Float priority handled by prioritySort
**Category:** Dispatch Ordering  
**Invariant:** Out-of-range sorts last  
**Setup:** Issue with priority=2.5  
**Action:** prioritySort(2.5)  
**Expected:** 2.5 passes range check (>=1 && <=4) but isn't integer. Does check exist?  
**Status:** PENDING

### S-189: normalizeRouteName with non-string input (number)
**Category:** Routing  
**Invariant:** Handles non-string  
**Setup:** normalizeRouteName(42)  
**Action:** String(42).trim().toLowerCase()  
**Expected:** "42" (not empty, would be a valid route name)  
**Status:** PENDING

### S-190: reconciliationStopReason with active+routed but has blockers
**Category:** Reconciliation  
**Invariant:** Stop reason classification  
**Setup:** Active, routed, but has open blockers  
**Action:** reconciliationStopReason(issue, settings)  
**Expected:** "blocked"  
**Status:** PENDING

### S-191: Orchestrator.claim() race between eligibleIssues and claim
**Category:** Orchestrator Scheduling  
**Invariant:** No corruption in single-threaded  
**Setup:** eligibleIssues returns issue, then concurrency changes before claim  
**Action:** claim(issue) after cap reached by another claim  
**Expected:** Returns null (re-checks shouldDispatchIssue internally)  
**Status:** PENDING

### S-192: finish() called twice for same slot
**Category:** Orchestrator Scheduling  
**Invariant:** Idempotent / no crash  
**Setup:** claim then finish twice  
**Action:** finish(id, 0, true); finish(id, 0, true)  
**Expected:** Second call does nothing (entry already removed)  
**Status:** PENDING

### S-193: Retry entry with slotIndex preference
**Category:** Orchestrator Scheduling  
**Invariant:** Preferred slot reclaimed  
**Setup:** Retry with slotIndex=1, firstUnclaimedSlot called  
**Action:** claim after retry is due  
**Expected:** Gets slot 1 if available  
**Status:** PENDING

### S-194: sortForDispatch preserves object identity
**Category:** Dispatch Ordering  
**Invariant:** Returns same objects (not copies)  
**Setup:** Issues array  
**Action:** sorted = sortForDispatch(issues); sorted[0] === issues[?]  
**Expected:** Same references (spread creates new array but same objects)  
**Status:** PENDING

### S-195: stateIn with empty string state and empty string in list
**Category:** State Classification  
**Invariant:** Matching behavior  
**Setup:** state="", states=[""]  
**Action:** stateIn("", [""])  
**Expected:** true ("".trim().toLowerCase() === "".trim().toLowerCase())  
**Status:** PENDING

### S-196: Orchestrator with clock override
**Category:** Orchestrator Scheduling  
**Invariant:** Uses injected clock  
**Setup:** Custom clock returning fixed time  
**Action:** claim(issue), check startedAt  
**Expected:** Uses clock.now() not system time  
**Status:** PENDING

### S-197: Multiple usage updates accumulate correctly
**Category:** Usage Accounting  
**Invariant:** Correct aggregate  
**Setup:** Two sequential updates: {input:10}, then {input:25}  
**Action:** Two applyUpdate calls  
**Expected:** entry.input=25, global delta=25 total (10 first, then 15 more)  
**Status:** PENDING

### S-198: Issue with priority=4 sorts before priority=null
**Category:** Dispatch Ordering  
**Invariant:** Valid before invalid  
**Setup:** A(priority=4), B(priority=null)  
**Action:** sortForDispatch([B, A])  
**Expected:** [A, B]  
**Status:** PENDING

### S-199: ensembleSize regex anchored - "my-ensemble:3-label" doesn't match
**Category:** Ensemble Resolution  
**Invariant:** Exact match required  
**Setup:** Issue(labels=["my-ensemble:3-label"])  
**Action:** ensembleSize(issue)  
**Expected:** null (regex is ^ensemble:(\d+)$, won't match)  
**Status:** PENDING

### S-200: selectLeastLoadedHost with very large counts
**Category:** Worker Host Selection  
**Invariant:** Correct comparison  
**Setup:** hosts=["a"], runningCounts={a:Number.MAX_SAFE_INTEGER}, cap=Infinity  
**Action:** selectLeastLoadedHost(...)  
**Expected:** "a" (MAX_SAFE_INTEGER < Infinity is true)  
**Status:** PENDING

### S-201: Issue with " " (space only) state
**Category:** Dispatch Eligibility  
**Invariant:** shouldDispatchIssue with empty-ish state  
**Setup:** Issue with state=" " (whitespace only)  
**Action:** shouldDispatchIssue(issue, settings, ...)  
**Expected:** false? (state is truthy " ", passes !issue.state, but issueIsActive would check lists)  
**Status:** PENDING

### S-202: mergeMonotonicUsage secondsRunning from reportedTotals preserved
**Category:** Usage Accounting  
**Invariant:** reportedTotals.secondsRunning independent  
**Setup:** reportedTotals.secondsRunning=50  
**Action:** mergeMonotonicUsage(...)  
**Expected:** result.reportedTotals.secondsRunning=50 (preserved)  
**Status:** PENDING

### S-203: Orchestrator snapshot is a copy not reference
**Category:** Orchestrator Scheduling  
**Invariant:** Snapshot isolation  
**Setup:** Take snapshot, modify original  
**Action:** snapshot() then state change  
**Expected:** Snapshot unchanged (spread operator copies)  
**Status:** PENDING

### S-204: finish adds to completed set before retry
**Category:** Orchestrator Scheduling  
**Invariant:** Completed + retry both set  
**Setup:** finish(id, 0, true)  
**Action:** Check completed.has(id) and retryAttempts.has(id)  
**Expected:** Both true  
**Status:** PENDING

### S-205: eligibleIssues cleans up retries for terminal issues
**Category:** Orchestrator Scheduling  
**Invariant:** Terminal issues clear retries  
**Setup:** Issue in terminal state with retry entry  
**Action:** eligibleIssues([terminalIssue])  
**Expected:** retryAttempts entry removed  
**Status:** PENDING

### S-206: retryBackoffMs type safety - continuation always 1000
**Category:** Retry and Backoff  
**Invariant:** Fixed regardless of inputs  
**Setup:** Various attempt values with continuation  
**Action:** retryBackoffMs(0, 0, "continuation")  
**Expected:** 1000  
**Status:** PENDING

### S-207: selectLeastLoadedHost with selectedCount tracking
**Category:** Worker Host Selection  
**Invariant:** Deterministic tie-breaking  
**Setup:** Three hosts all with count=0  
**Action:** selectLeastLoadedHost(...)  
**Expected:** First host in list (iteration order determines winner)  
**Status:** PENDING

### S-208: safeIdentifier with dots and hyphens preserved
**Category:** Workspace Containment  
**Invariant:** Dots, hyphens, underscores preserved  
**Setup:** identifier="MT-1.0_beta"  
**Action:** safeIdentifier("MT-1.0_beta")  
**Expected:** "MT-1.0_beta" (all chars in [A-Za-z0-9_.-])  
**Status:** PENDING

### S-209: workspacePath with empty identifier
**Category:** Workspace Containment  
**Invariant:** Safe behavior  
**Setup:** safeIdentifier("")  
**Action:** workspacePath("/tmp/w", "", 0, 1)  
**Expected:** "/tmp/w/" or "/tmp/w" (path.join handles empty)  
**Status:** **FAILED** — path.join("/tmp/w", "") returns "/tmp/w" which equals root, violating strict-descendant invariant

### S-210: Continuation retry cap ignored
**Category:** Retry and Backoff  
**Invariant:** Continuation returns 1000 regardless  
**Setup:** cap=100 (less than 1000)  
**Action:** retryBackoffMs(1, 100, "continuation")  
**Expected:** 1000 (cap not applied to continuation)  
**Status:** **FAILED** — Same as S-185; continuation early-return bypasses Math.min(cap,...)
