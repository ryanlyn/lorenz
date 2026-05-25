# TS Test Plan — Gaps vs Contrabass (Go)

Tests exercise only the public API exported from `@symphony/cli` — no source modifications needed.

## 1. `packages/policies/test/policies.test.ts` — Policy Unit Tests

**Gap filled:** Go `internal/orchestrator` has 113 tests covering backoff calculation, usage monotonicity edge cases, worker host selection boundaries. The TS `architecture-boundaries.test.ts` covers the happy path for each policy but misses edges.

- [x] retryBackoffMs — attempt 0 returns base (10s)
- [x] retryBackoffMs — negative attempt clamps to base
- [x] retryBackoffMs — max backoff caps exponential growth
- [x] retryBackoffMs — continuation always returns 1s regardless of attempt number
- [x] mergeMonotonicUsage — all-zero inputs remain zero
- [x] mergeMonotonicUsage — update with only partial fields preserves others
- [x] mergeMonotonicUsage — negative update values are clamped to entry totals
- [x] mergeMonotonicUsage — global delta accumulates across multiple merge calls
- [x] selectLeastLoadedHost — empty hosts returns null
- [x] selectLeastLoadedHost — single host at capacity returns undefined
- [x] selectLeastLoadedHost — all hosts at capacity returns undefined
- [x] selectLeastLoadedHost — selects host with lowest running count
- [x] selectLeastLoadedHost — tie-breaks by iteration order (first found)
- [x] actionForStopReason — all known stop reasons produce defined actions
- [x] actionForStopReason — unknown/unexpected string returns "retry"
- [x] resumeIdentityMatches — null workerHost matches undefined
- [x] resumeIdentityMatches — mismatched workspace path returns false
- [x] resumeIdentityMatches — empty string agent always returns false
- [x] reconciliationStopReason — terminal issue returns "terminal"
- [x] reconciliationStopReason — unrouted issue returns "unrouted"
- [x] reconciliationStopReason — blocked issue returns "blocked"
- [x] reconciliationStopReason — active, routed, unblocked issue returns "inactive"

---

## 2. `packages/workspace/test/workspace.test.ts` — Workspace Utilities

**Gap filled:** Go `internal/workspace` has 24 tests (creation, reuse, stale cleanup, path traversal safety, concurrent serialization). TS has zero dedicated workspace tests.

- [ ] safeIdentifier — strips non-alphanumeric characters
- [ ] safeIdentifier — empty/non-string returns empty
- [ ] workspacePath — single slot omits slot index subdirectory
- [ ] workspacePath — ensemble adds slot index subdirectory
- [ ] ensureInsideRoot — path within root does not throw
- [ ] ensureInsideRoot — path outside root throws
- [ ] ensureInsideRoot — root itself does not throw
- [ ] validateWorkspaceCwd — blank input throws "invalid_workspace_cwd"
- [ ] validateWorkspaceCwd — newline in path throws "invalid_workspace_cwd"
- [ ] validateWorkspaceCwd — rejects directory targets that are symlinks
- [ ] validateWorkspaceCwd — rejects workspace equal to workspace root
- [ ] createWorkspaceForIssue — creates directory and returns canonical path
- [ ] createWorkspaceForIssue — reuses existing workspace directory
- [ ] createWorkspaceForIssue — runs afterCreate hook on new workspace
- [ ] removeWorkspace — removes existing workspace directory
- [ ] removeWorkspace — refuses to remove workspace root
- [ ] removeWorkspace — runs beforeRemove hook before deletion
- [ ] removeWorkspace — nonexistent workspace returns empty array

---

## 3. `packages/resume-state/test/resume-state.test.ts` — Resume State I/O

**Gap filled:** Go tests verify state file writes in `internal/workspace/manager_test.go`. TS exports `readResumeState`, `writeResumeState`, `deleteResumeState`, `resumeStateMatches` but they have no test file.

- [ ] writeResumeState + readResumeState — round-trip preserves all fields
- [ ] readResumeState — missing file returns { status: "missing" }
- [ ] readResumeState — invalid JSON returns { status: "error" }
- [ ] readResumeState — non-git directory returns { status: "unavailable" }
- [ ] readResumeState — decodes legacy fields correctly (session_id, agent_kind, thread_id)
- [ ] writeResumeState — rejects empty agentKind
- [ ] writeResumeState — rejects empty resumeId
- [ ] deleteResumeState — removes existing file
- [ ] deleteResumeState — no-op when file already absent
- [ ] resumeStateMatches — full match returns true
- [ ] resumeStateMatches — mismatched issueState returns false
- [ ] resumeStateMatches — missing optional workerHost still matches when current is null
- [ ] resumeStateMatches — blank resumeId always returns false

---

## 4. `packages/orchestrator/test/orchestrator-edges.test.ts` — Orchestrator Edge Cases

**Gap filled:** Go has exhaustive state-transition tests (`TestTransitionIssueState_AllTransitions`), snapshot isolation, concurrent claim behavior, and `cleanupIssue` coverage. The existing TS orchestrator test focuses on the happy-path lifecycle.

- [ ] claim — null return when global concurrency cap reached
- [ ] claim — null return when all ensemble slots claimed
- [ ] claim — null return when worker hosts at capacity
- [ ] claim — preferred slot honored on retry
- [ ] claim — non-existent retry does not interfere with fresh claim
- [ ] applyUpdate — unknown slotKey is silently ignored
- [ ] applyUpdate — turnCount increments on each turn_completed
- [ ] applyUpdate — rateLimits propagated to state
- [ ] finish — non-normal finish does not create retry entry
- [ ] finish — secondsRunning accumulates across multiple finishes
- [ ] finish — finishing same slot twice is idempotent (second is no-op)
- [ ] cleanupIssue — removes running entry and claimed slot
- [ ] cleanupIssue — removes retry attempts for issue
- [ ] cleanupIssue — adds issue to completed set
- [ ] snapshot — returns defensive copy (mutation does not affect state)
- [ ] eligibleIssues — inactive issue cleared from retryAttempts
- [ ] eligibleIssues — issue with unresolved blockers excluded
- [ ] Orchestrator — accepts custom ClockPort for deterministic time assertions

---

## 5. `packages/dispatch/test/dispatch-edges.test.ts` — Dispatch Edge Cases

**Gap filled:** Go `internal/orchestrator` tests `DispatchUnclaimedIssues_GatesOnBlockedBy`, empty polls, and state-based concurrency. Existing TS dispatch tests cover the main paths but not edges like missing fields or degenerate input.

- [ ] shouldDispatchIssue — missing id/identifier/title/state returns false
- [ ] shouldDispatchIssue — terminal state returns false
- [ ] routedToThisWorker — issue with assignedToWorker=false returns false
- [ ] routedToThisWorker — no route labels + acceptUnrouted=false returns false
- [ ] routedToThisWorker — onlyRoutes=[] rejects all routed issues
- [ ] issueHasOpenBlockers — started state never counts as blocked (even with blockers)
- [ ] issueHasOpenBlockers — all blockers terminal returns false
- [ ] firstUnclaimedSlot — preferred slot already claimed falls through to next
- [ ] sortForDispatch — null priority sorts after numbered priorities
- [ ] sortForDispatch — priority outside 1-4 range is treated as missing and sorts last
- [ ] sortForDispatch — null/missing createdAt sorts last
- [ ] sortForDispatch — invalid string createdAt is treated as missing and sorts last
- [ ] sortForDispatch — ties broken by identifier alphabetically

---

## 6. `packages/mcp/test/auth.test.ts` — MCP Token Authentication

**Gap filled:** TS uses random cryptographic tokens for authorization of MCP clients over reverse SSH tunnels. These token lifetimes are critical for security but completely untested.

- [ ] issueMcpToken — returns a unique, non-empty cryptographically strong string
- [ ] validMcpToken — returns true for actively issued tokens
- [ ] validMcpToken — returns false for random/fake tokens
- [ ] revokeMcpToken — revoking a token causes validMcpToken to return false
- [ ] revokeMcpToken — calling revoke twice or with invalid inputs is a safe no-op

---

## 7. `packages/issue/test/issue.test.ts` — Issue Parser & Normalizer

**Gap filled:** Go `internal/tracker/linear_test.go` has exhaustive validation of label parsing and blocker extraction (`TestNormalizeIssue_BlockedByFromInverseRelations`, etc.). TS exports `normalizeIssue`, `ensembleSize` and `isTerminalState` but has no dedicated parser tests.

- [ ] normalizeIssue — throws if id, identifier, title, or state is missing
- [ ] normalizeIssue — extracts blocker relations (blocks type mapping)
- [ ] normalizeIssue — assigns assignedToWorker=false if assignee does not match current worker
- [ ] ensembleSize — parses "ensemble:X" label to return X
- [ ] ensembleSize — returns null if no ensemble label or malformed value
- [ ] isTerminalState — case-insensitively checks if a state is in terminalStates list

---

## Priority Ranking

| # | Test file | Tests | Rationale |
|---|-----------|-------|-----------|
| 1 | `policies.test.ts` | 22 | Pure functions, zero dependencies, high confidence gain, directly mirrors Go `TestCalculateBackoff*` / `TestEstimateCompletionAt*` |
| 2 | `workspace.test.ts` | 18 | Security-sensitive path and symlink validation; Go has 24 tests here, TS has 0 |
| 3 | `issue.test.ts` | 6 | Critical client payload parser/normalizer; Go tests labels & relations deeply, TS has 0 |
| 4 | `orchestrator-edges.test.ts` | 18 | State machine correctness and clock overrides; Go has 113 tests vs TS's 8 |
| 5 | `resume-state.test.ts` | 13 | File I/O and legacy key decode round-trip correctness; untested in TS |
| 6 | `dispatch-edges.test.ts` | 13 | Priority/createdAt bounds & input validation; extends existing 6 tests |
| 7 | `auth.test.ts` | 5 | Cryptographic MCP token session authorization checks; unique TS SSH worker dependency |

All tests import from `@symphony/cli` (the existing barrel) and use the `test/assert.ts` + `test/helpers.ts` patterns already established. None require touching source code.
