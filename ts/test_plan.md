# Test Plan: Coverage Gaps

Tests to add for existing TS source packages that lack coverage compared to contrabass.
No new source code — only test files.

---

## 1. `packages/agent-runner` (Priority: HIGH, 337 LOC)

**File:** `packages/agent-runner/test/agent-runner.test.ts`

### Test cases

- `runAgentAttempt` returns success result on normal completion
- `runAgentAttempt` returns failure result when executor throws
- `runAgentAttempt` respects abort signal and stops executor mid-turn
- `executorFor` selects codex executor for codex backend profile
- `executorFor` selects ACP executor for claude backend profile
- `executorFor` throws on unknown backend
- `createWorkspaceForIssue` calls workspace adapter with correct issue/ensemble args
- `createWorkspaceForIssue` reuses existing workspace when resume state matches
- `persistResumeState` writes agentKind, resumeId, and backend fields
- `readResumeState` returns null when no state file exists
- `resumeStateMatches` returns true for matching agentKind + resumeId
- `resumeStateMatches` returns false on agentKind mismatch
- `runHook` executes afterCreate hook with workspace path
- `runHook` skips execution when hook is undefined
- `RunController` propagates updates from executor to caller
- `RunController` accumulates usage totals across turns
- `throwIfAborted` is no-op when signal not aborted
- `throwIfAborted` throws when signal is aborted
- `backendProfile` extracts profile from settings

### Mocking strategy

Stub the port interfaces (`RunAgentAttemptAdapters`) — workspace, resume-state, executor factory. Use fake executors that emit canned `SessionUpdate` events.

---

## 2. `packages/humanize` (Priority: HIGH, 339 LOC)

**File:** `packages/humanize/test/humanize.test.ts`

### Test cases

#### `humanizeAgentMessage`
- Dispatches to Codex humanizer for codex messages
- Dispatches to Claude humanizer for claude messages
- Returns raw string for unknown shape

#### `humanizeCodexMessage`
- Formats `tool_use_requested` with tool name
- Formats `approval` events
- Formats `item.created` / `item.completed` lifecycle
- Formats streaming token events
- Formats `dynamic_tool_call` with tool name extraction
- Formats `dynamic_tool_result` (success/failure)
- Formats usage/token count summaries
- Truncates long payloads to max length
- Strips newlines from inline text
- Handles malformed/missing payload gracefully

#### `humanizeClaudeMessage`
- Formats tool_use request with tool name
- Formats rate_limit event with retry info
- Returns null for unrecognized event types
- Handles null/undefined event field

#### Utility functions
- `sanitize` strips control characters
- `truncate` respects max length boundary
- `formatUsageCounts` renders usage map as string
- `formatReason` handles string and object reasons
- `unwrapPayload` unwraps nested message shapes

---

## 3. `packages/worker-host-pool` (Priority: MEDIUM, 103 LOC)

**File:** `packages/worker-host-pool/test/worker-host-pool.test.ts`

### Test cases

- `WorkerHostPool` starts empty with no leases
- `lease` creates a new MCP tunnel lease for a session
- `lease` reuses existing tunnel for same worker host
- `release` removes lease and decrements count
- `release` is idempotent (no-op for unknown session)
- `selectHost` picks least-loaded host from pool
- `selectHost` returns undefined when all hosts at capacity
- `selectHost` returns sole host when pool has one entry
- Concurrent lease/release maintains consistent count

---

## 4. `packages/workflow` (Priority: MEDIUM, 95 LOC)

**File:** `packages/workflow/test/workflow.test.ts`

### Test cases

- `workflowFilePath` returns default path when none specified
- `workflowFilePath` resolves relative path against project root
- `loadWorkflow` reads and parses YAML workflow file
- `loadWorkflow` returns error for missing file
- `loadWorkflow` returns error for malformed YAML
- `parseWorkflowContent` extracts frontmatter and body
- `parseWorkflowContent` handles content without frontmatter
- `parseWorkflowContent` handles empty content
- `effectivePromptTemplate` returns custom template when provided
- `effectivePromptTemplate` returns default template when empty string given
- `defaultPromptTemplate` contains issue field placeholders

---

## 5. `packages/projections` (Priority: MEDIUM, 62 LOC)

**File:** `packages/projections/test/projections.test.ts`

### Test cases

- `ProjectionActor` initializes with empty state
- `ProjectionActor` processes runtime snapshot into projection
- `ProjectionActor` updates projection on new events
- `ProjectionActor` preserves previous state when input unchanged
- `ProjectionActor` handles null/missing fields defensively

---

## 6. `packages/retry-scheduler` (Priority: LOW, 30 LOC)

**File:** `packages/retry-scheduler/test/retry-scheduler.test.ts`

### Test cases

- `RetryScheduler` fires callback after delay elapses
- `RetryScheduler` cancels pending retry on explicit cancel
- `RetryScheduler` resets timer when rescheduled before firing
- `RetryScheduler` does not fire after destroy

---

## 7. `packages/runtime-events` (Priority: MEDIUM, 122 LOC)

**File:** `packages/runtime-events/test/runtime-events.test.ts`

### Test cases

- `RuntimeSnapshot` shape contains all required fields with correct types
- `RuntimeEvent` structure validates known event types from `RUNTIME_EVENT_TYPES`
- `RUNTIME_RUN_OUTCOMES` includes success, failed, stalled, canceled
- `RuntimeRunHistoryEntry` round-trips through JSON serialization
- `RuntimeRunningEntry` includes issue, slot, and timing fields
- `RuntimeRetryEntry` includes attempt count and next retry time
- `RuntimeBlockedEntry` matches `DispatchBlockEntry` shape

---

## 8. `packages/prompt` (Priority: MEDIUM, 73 LOC)

**File:** `packages/prompt/test/prompt.test.ts`

### Test cases

- `buildPrompt` renders issue title and description into template
- `buildPrompt` includes issue URL when present
- `buildPrompt` handles missing optional fields (no description, no URL)
- `continuationPrompt` includes prior context and continuation reason
- `continuationPrompt` references resume state when available
- Template variable substitution replaces all placeholders

---

## 9. `packages/protocol` (Priority: LOW, 76 LOC)

**File:** `packages/protocol/test/protocol.test.ts`

### Test cases

- `StopReason` type accepts all valid values (end_turn, max_tokens, max_turn_requests, refusal, cancelled)
- `SESSION_UPDATE_KINDS` array is non-empty and contains expected members
- `SessionUpdate` discriminates correctly between UsageUpdate and TurnUpdate
- `TurnResult` includes stopReason and usage fields
- `UsageTotals` fields default to zero

---

## 10. `packages/memory-tracker` (Priority: LOW, 72 LOC)

**File:** `packages/memory-tracker/test/memory-tracker.test.ts`

### Test cases

- Stores and retrieves issues by ID
- Filters issues by state
- `claimIssue` transitions issue to claimed state
- `releaseIssue` returns issue to unclaimed state
- `updateIssueState` persists new state
- Mutation safety — returned issues are copies, not references
- Returns empty array when no issues match filter

---

## Implementation Notes

- All tests use Vitest (`import { test, describe, expect } from "vitest"`)
- Use the project's custom `assert` helper from `../../../test/assert.js` where appropriate
- Mock external I/O (filesystem, network) — never hit real services
- For `agent-runner`, create minimal fake executors that yield `SessionUpdate` objects
- For `humanize`, test with raw JSON payloads matching real Codex/Claude protocol shapes
- For `worker-host-pool`, test concurrency with `Promise.all` patterns
- Match existing test style: flat `test()` blocks preferred over deep `describe` nesting
