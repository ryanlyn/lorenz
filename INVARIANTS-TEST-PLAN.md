# Implementation Plan: Property-Based and Integration Tests for Symphony Invariants

## 1. Summary

| Metric | Count |
|--------|-------|
| **Total new tests** | 18 |
| **Property-based tests (PBT)** | 5 |
| **Integration tests** | 13 |
| **New test files to create** | 1 |
| **Existing files to modify** | 7 |

Already-covered tests (confirmed via code review): 37 tests across all categories require no new work.

---

## 2. Shared Infrastructure

### Existing (`ts/test/arbitraries.ts`)
- `arbUsageTotals` -- reused by usage PBT
- `arbIssue` -- reused by dispatch/routing PBT
- `arbPriority` -- reused by dispatch sort PBT
- `arbIssueStateType` -- reused by state classification

### Existing (`ts/test/helpers.ts`)
- `tempDir(prefix)` -- used by workspace and runtime integration tests
- `writeExecutable(filePath, source)` -- used by hook tests
- `initGitRepo(dir)` -- used by workspace creation tests
- `sampleIssue` -- used by workspace integration tests

### New Arbitraries to Add

Add the following to `ts/test/arbitraries.ts`:

1. **`arbWhitespaceOnly`** -- `fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 0, maxLength: 8 })`. Generates strings composed entirely of whitespace characters for routing edge-case tests.

2. **`arbNonEnsembleLabels`** -- `fc.array(fc.string({minLength:1,maxLength:20}).filter(s => !/^ensemble:\d+$/i.test(s.trim())), {maxLength:5})`. Generates label arrays that never contain valid ensemble labels.

3. **`arbMonotonicUsageSequence`** -- Generates a sequence of 2-5 monotonically increasing `UsageTotals` snapshots (each field >= previous) for testing watermark delta computation.

### Existing Test Helpers Per Package (no changes needed)
- `ts/packages/dispatch/test/routing-props.test.ts` -- `makeSettings()`, `issueWith()`
- `ts/packages/agent-runner/test/agent-runner.test.ts` -- `fakeIssue()`, `fakeSettings()`, `fakeSession()`, `fakeExecutor()`, `fakeAdapters()`
- `ts/packages/workspace/test/workspace.test.ts` -- `makeSettings(root, hooks)`

---

## 3. Implementation Order

### Phase A: Pure-Function PBT Tests (no IO)

These test pure functions with no filesystem, network, or process dependencies. They can be implemented immediately and run in < 1s.

| Order | Category | File | Test |
|-------|----------|------|------|
| A1 | Dispatch Eligibility | `ts/packages/dispatch/test/routing-props.test.ts` | `shouldDispatchIssue -- issue in arbitrary non-active state is never eligible` |
| A2 | Dispatch Eligibility | `ts/packages/dispatch/test/routing-props.test.ts` | `dispatchBlockReason -- per-state concurrency cap blocks dispatch when state count meets limit` |
| A3 | Routing | `ts/packages/dispatch/test/routing-props.test.ts` | `routedToThisWorker -- whitespace-only route suffix is routed-but-invalid` |
| A4 | Ensemble Resolution | `ts/packages/dispatch/test/ensemble-fallback-props.test.ts` (NEW FILE) | `firstUnclaimedSlot uses configured default ensemble size when issue has no valid ensemble label` |
| A5 | Orchestrator Scheduling | `ts/packages/policies/test/usage-props.test.ts` | `mergeMonotonicUsage -- sequential absolute updates accumulate global delta (no double-counting)` |

### Phase B: Stateful PBT Tests

No stateful state-machine PBT tests are required in this plan. All PBT tests operate on pure functions.

### Phase C: Integration Tests (filesystem, process, network)

These require `tempDir`, child processes, abort controllers, or mocked runtime interactions. Order by dependency (workspace first, then runtime, then agent-runner).

| Order | Category | File | Test |
|-------|----------|------|------|
| C1 | Workspace Containment | `ts/packages/workspace/test/workspace.test.ts` | `validateWorkspaceCwd rejects symlinks at arbitrary intermediate path segments` |
| C2 | Hooks | `ts/packages/workspace/test/workspace.test.ts` | `createWorkspaceForIssue -- does NOT run afterCreate hook when workspace already exists` |
| C3 | Hooks | `ts/packages/workspace/test/workspace.test.ts` | `createWorkspaceForIssue -- afterCreate hook times out and aborts workspace creation` |
| C4 | Hooks | `ts/packages/workspace/test/workspace.test.ts` | `runHook -- enforces timeout and throws on slow commands` |
| C5 | Orchestrator Scheduling | `ts/packages/runtime/test/runtime.test.ts` | `runtime reconciles tracked issues before dispatching new candidates` |
| C6 | Reconciliation | `ts/packages/runtime/test/runtime.test.ts` | `runtime aborts in-flight runs when reconciliation sees non-active non-terminal state` |
| C7 | Reconciliation | `ts/packages/runtime/test/runtime.test.ts` | `runtime aborts in-flight run when route label changed away from this worker` |
| C8 | Workflow Validation | `ts/packages/runtime/test/runtime.test.ts` | `runtime continues reconciliation when dispatch validation fails` |
| C9 | Observability | `ts/packages/runtime/test/runtime.test.ts` | `runtime continues dispatch when subscribe listener throws` |
| C10 | Resume State | `ts/packages/runtime/test/runtime.test.ts` | `runtime invalidates resume state before scheduling retry on force-termination` |
| C11 | Agent Execution | `ts/packages/agent-runner/test/agent-runner.test.ts` | `runAgentAttempt ends session when backend profile changes between turns` |
| C12 | Agent Execution | `ts/packages/agent-runner/test/agent-runner.test.ts` | `runAgentAttempt ends session after reaching maxTurns` |
| C13 | Hooks | `ts/packages/agent-runner/test/agent-runner.test.ts` | `runAgentAttempt aborts when beforeRun hook fails` |
| C14 | Secret Handling | `ts/packages/config/test/config.test.ts` | `parseConfig resolves env-var secrets without logging resolved value` |

---

## 4. Per-Category Details

### 4.1 Workspace Containment

**File:** `ts/packages/workspace/test/workspace.test.ts`

| Test | Type | Status |
|------|------|--------|
| `validateWorkspaceCwd rejects symlinks at arbitrary intermediate path segments between root and workspace` | integration | NEW |

**Sketch:**
```typescript
root = tempDir('ws-symlink-intermediate');
intermediate = path.join(root, 'level1');
outsideTarget = await tempDir('ws-outside');
fs.symlink(outsideTarget, intermediate);
fs.mkdir(path.join(outsideTarget, 'MT-1'));
candidatePath = path.join(intermediate, 'MT-1');
settings = makeSettings(root);
assert.rejects(() => validateWorkspaceCwd(settings, candidatePath), /unsafe symlink/);
```

**Invariant:** WHEN a symbolic link exists at any segment of a workspace path, THE SYSTEM SHALL reject the path.

---

### 4.2 Dispatch Ordering

All 7 tests already covered. No new work needed.

---

### 4.3 Dispatch Eligibility

**File:** `ts/packages/dispatch/test/routing-props.test.ts`

| Test | Type | Status |
|------|------|--------|
| `shouldDispatchIssue -- issue in arbitrary non-active state is never eligible` | PBT | NEW |
| `dispatchBlockReason -- per-state concurrency cap blocks dispatch when state count meets limit` | PBT | NEW |

**Test 1 Sketch:**
```typescript
fc.property(
  fc.string({ minLength: 1, maxLength: 20 }),
  (state) => {
    fc.pre(!['todo', 'in progress'].includes(state.trim().toLowerCase()));
    const settings = makeSettings({ activeStates: ['Todo', 'In Progress'] });
    const issue = issueWith({ state, stateType: 'unstarted' });
    const dispatchState = { runningCount: 0, claimedSlots: new Set<string>() };
    assert.equal(shouldDispatchIssue(issue, settings, dispatchState), false);
  }
);
```
**Invariant:** Non-active states never dispatch.

**Test 2 Sketch:**
```typescript
fc.property(
  fc.integer({ min: 1, max: 10 }),
  fc.integer({ min: 1, max: 10 }),
  (localCap, globalCap) => {
    fc.pre(globalCap > localCap);
    const settings = makeSettings({ activeStates: ['Todo'] });
    settings.agent.maxConcurrentAgents = globalCap + localCap;
    settings.statusOverrides.set('todo', { agent: { maxConcurrentAgents: localCap } });
    const issue = issueWith({ state: 'Todo', stateType: 'unstarted', blockers: [] });
    const state = {
      runningCount: localCap,
      runningByState: new Map([['Todo', localCap]]),
      claimedSlots: new Set<string>()
    };
    assert.equal(dispatchBlockReason(issue, settings, state), 'local_concurrency_cap');
  }
);
```
**Invariant:** Per-state concurrency limit blocks dispatch.

---

### 4.4 Routing

**File:** `ts/packages/dispatch/test/routing-props.test.ts`

| Test | Type | Status |
|------|------|--------|
| `routedToThisWorker -- whitespace-only route suffix is routed-but-invalid` | PBT | NEW |

**Sketch:**
```typescript
fc.property(
  fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 0, maxLength: 8 }),
  (ws) => {
    const prefix = 'Symphony:';
    const issue = issueWith({ labels: [`${prefix}${ws}`] });
    const settings = makeSettings({ routeLabelPrefix: prefix, acceptUnrouted: true });
    assert.ok(hasRouteLabel(issue, settings) === true);
    assert.deepEqual(routeNames(issue, settings), []);
    assert.ok(routedToThisWorker(issue, settings) === false);
  }
);
```
**Invariant:** Whitespace-only route suffix is treated as routed-but-invalid (rejected even when acceptUnrouted is true).

---

### 4.5 State Classification

All 9 tests already covered. No new work needed.

---

### 4.6 Ensemble Resolution

**File (NEW):** `ts/packages/dispatch/test/ensemble-fallback-props.test.ts`

| Test | Type | Status |
|------|------|--------|
| `firstUnclaimedSlot uses configured default ensemble size when issue has no valid ensemble label` | PBT | NEW |

**Sketch:**
```typescript
import { test } from "vitest";
import fc from "fast-check";
import { firstUnclaimedSlot, slotKey } from "@symphony/cli";
import { ensembleSize } from "@symphony/cli";
import { defaultSettings } from "@symphony/cli";

test("firstUnclaimedSlot uses configured default ensemble size when no valid ensemble label", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 10 }),
      fc.array(
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => !/^ensemble:\d+$/i.test(s.trim())),
        { maxLength: 5 }
      ),
      (defaultSize, labels) => {
        const settings = defaultSettings();
        settings.agent.ensembleSize = defaultSize;
        const issue = { id: 'i1', identifier: 'MT-1', title: 'T', state: 'Todo', labels, blockers: [] };
        // Verify no valid ensemble label
        assert.equal(ensembleSize(issue), null);
        // All slots claimed => null
        const allClaimed = new Set(Array.from({ length: defaultSize }, (_, i) => slotKey('i1', i)));
        assert.equal(firstUnclaimedSlot(issue, settings, allClaimed), null);
        // One slot free => returns that slot index
        const partialClaimed = new Set(Array.from({ length: defaultSize - 1 }, (_, i) => slotKey('i1', i)));
        assert.equal(firstUnclaimedSlot(issue, settings, partialClaimed), defaultSize - 1);
      }
    )
  );
});
```
**Invariant:** When no valid ensemble label exists, system falls back to configured `agent.ensembleSize`.

---

### 4.7 Retry and Backoff

All 7 tests already covered. No new work needed.

---

### 4.8 Usage Accounting

**File:** `ts/packages/policies/test/usage-props.test.ts`

| Test | Type | Status |
|------|------|--------|
| Existing 6 PBT tests | PBT | already_covered |
| `mergeMonotonicUsage -- sequential absolute updates accumulate global delta (no double-counting)` | PBT | NEW |

**Sketch:**
```typescript
test("mergeMonotonicUsage -- sequential absolute updates with no double-counting", () => {
  const arbMonotonicSequence = fc.array(
    fc.nat({ max: 100_000 }),
    { minLength: 2, maxLength: 5 }
  ).map(arr => arr.sort((a, b) => a - b));

  fc.assert(
    fc.property(arbMonotonicSequence, arbMonotonicSequence, (inputSeq, outputSeq) => {
      let entry = { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 };
      let reported = { ...entry };
      let global = { ...entry };
      for (let i = 0; i < inputSeq.length; i++) {
        const result = mergeMonotonicUsage({
          entryTotals: entry, reportedTotals: reported, globalTotals: global,
          update: { inputTokens: inputSeq[i], outputTokens: outputSeq[i], totalTokens: inputSeq[i] + outputSeq[i] },
        });
        entry = result.entryTotals;
        reported = result.reportedTotals;
        global = result.globalTotals;
      }
      // Final global should equal the max of the sequence minus initial (0)
      const maxInput = inputSeq[inputSeq.length - 1]!;
      const maxOutput = outputSeq[outputSeq.length - 1]!;
      assert.equal(global.inputTokens, maxInput);
      assert.equal(global.outputTokens, maxOutput);
    })
  );
});
```
**Invariant:** Sequential absolute usage updates accumulate deltas from watermark without double-counting.

---

### 4.9 Worker Host Selection

All 7 tests already covered. No new work needed.

---

### 4.10 Configuration Overrides

No new tests needed (covered by `config-props.test.ts` tests for `settingsForIssueState`).

---

### 4.11 Orchestrator Scheduling

**File:** `ts/packages/runtime/test/runtime.test.ts`

| Test | Type | Status |
|------|------|--------|
| `runtime reconciles tracked issues before dispatching new candidates on each poll tick` | integration | NEW |

**Sketch:**
```typescript
test("runtime reconciles tracked issues before dispatching new candidates on each poll tick", async () => {
  const runningIssue = issueFixture("issue-running", "MT-RUN");
  const terminalIssue = { ...runningIssue, state: "Done", stateType: "completed" };
  const newCandidate = issueFixture("issue-new", "MT-NEW");
  const callOrder: string[] = [];

  const runtime = new SymphonyRuntime(runtimeOptions({
    workflow: workflowFixture(),
    client: {
      fetchCandidateIssues: async () => { callOrder.push("candidates"); return [newCandidate]; },
      fetchIssuesByIds: async (ids) => {
        callOrder.push("reconcile");
        return ids.includes(runningIssue.id) ? [terminalIssue] : [newCandidate];
      },
    },
    runner: async () => ({ workspace: "/tmp/x", turnCount: 1, updates: [], agentKind: "codex" }),
  }));

  await runtime.pollOnce({ waitForRuns: true });
  const reconcileIdx = callOrder.indexOf("reconcile");
  const candidatesIdx = callOrder.indexOf("candidates");
  assert.ok(reconcileIdx < candidatesIdx);
});
```
**Invariant:** Reconciliation runs before dispatch on each poll tick.

---

### 4.12 Reconciliation

**File:** `ts/packages/runtime/test/runtime.test.ts`

| Test | Type | Status |
|------|------|--------|
| `runtime aborts in-flight runs when reconciliation sees a non-active non-terminal issue state and preserves workspace` | integration | NEW |
| `runtime aborts in-flight run when reconciliation detects route label changed away from this worker and preserves workspace` | integration | NEW |

**Test 1 Sketch:**
Set up a runtime with a blocking runner. Issue goes from 'Todo' (active) to 'Paused' (non-active, non-terminal). After pollOnce triggers reconciliation, assert: run aborted, workspace preserved, no cleanup event.

**Test 2 Sketch:**
Set up a runtime with `onlyRoutes=['backend']`. Issue labels change from `['symphony:backend']` to `['symphony:frontend']` on refetch. Assert: run aborted, workspace preserved, event mentions 'unrouted'.

---

### 4.13 Workflow Validation

**File:** `ts/packages/runtime/test/runtime.test.ts`

| Test | Type | Status |
|------|------|--------|
| `runtime continues reconciliation and stays alive when dispatch validation fails on a tick` | integration | NEW |

**Sketch:** Configure a `reloadWorkflow` that returns invalid config (e.g., missing tracker kind). Assert: no runner calls, reconciliation still runs (terminal issue cleaned up), runtime status not permanently errored.

---

### 4.14 Agent Execution

**File:** `ts/packages/agent-runner/test/agent-runner.test.ts`

| Test | Type | Status |
|------|------|--------|
| `runAgentAttempt ends session when backend profile changes between turns` | integration | NEW |
| `runAgentAttempt ends session after reaching maxTurns without starting another turn` | integration | NEW |

**Test 1 Sketch:**
Use `fakeSettings` with `statusOverrides` that change `agent.kind` for a different state. Provide a `fetchIssue` that returns the issue in a new state after turn 1. Assert: `result.turnCount === 1`, session stopped.

**Test 2 Sketch:**
Set `maxTurns: 3`. Provide a `fakeExecutor` that counts `runTurn` calls. Assert: exactly 3 turns, session stopped, result reflects `turnCount: 3`.

---

### 4.15 Resume State

**File:** `ts/packages/runtime/test/runtime.test.ts`

| Test | Type | Status |
|------|------|--------|
| `runtime invalidates resume state before scheduling retry on force-termination via stop()` | integration | NEW |

**Sketch:**
1. Create workspace with valid resume state written.
2. Start runtime with blocking runner that signals workspace path.
3. Call `runtime.stop()` to force-terminate.
4. Assert: `readResumeState(workspace).status === 'missing'`, run_failed history entry exists.

---

### 4.16 Hooks

**Files:**
- `ts/packages/workspace/test/workspace.test.ts`
- `ts/packages/agent-runner/test/agent-runner.test.ts`

| Test | Type | File | Status |
|------|------|------|--------|
| `createWorkspaceForIssue -- does NOT run afterCreate hook when workspace already exists` | integration | workspace.test.ts | NEW |
| `createWorkspaceForIssue -- afterCreate hook times out and aborts` | integration | workspace.test.ts | NEW |
| `runHook -- enforces timeout and throws on slow commands` | integration | workspace.test.ts | NEW |
| `runAgentAttempt aborts when beforeRun hook fails` | integration | agent-runner.test.ts | NEW |

**Hook-not-rerun sketch:**
```typescript
const root = await tempDir("ws-hook-reuse");
const settings = makeSettings(root, { afterCreate: 'echo ran >> hook.log' });
await createWorkspaceForIssue(settings, sampleIssue); // first call
await createWorkspaceForIssue(settings, sampleIssue); // second call (reuse)
const ws = path.join(await fs.realpath(root), safeIdentifier(sampleIssue.identifier));
const log = await fs.readFile(path.join(ws, 'hook.log'), 'utf8');
assert.equal(log.trim().split('\n').length, 1); // exactly once
```

**Hook-timeout sketch:**
```typescript
const root = await tempDir("ws-hook-timeout");
const settings = makeSettings(root, { afterCreate: 'sleep 5', timeoutMs: 50 });
await assert.rejects(() => createWorkspaceForIssue(settings, sampleIssue), /timed out/);
```

**beforeRun failure sketch:**
```typescript
let executorCalled = false;
await assert.rejects(() => runAgentAttempt({
  issue: fakeIssue(), workflow, settings: fakeSettings(),
  adapters: fakeAdapters({
    runHook: async () => { throw new Error('hook failed'); },
    executorFactory: () => { executorCalled = true; return fakeExecutor(); },
  }),
}), /hook failed/);
assert.equal(executorCalled, false);
```

---

### 4.17 Secret Handling

**File:** `ts/packages/config/test/config.test.ts`

| Test | Type | Status |
|------|------|--------|
| `parseConfig resolves env-var secrets without logging resolved value` | integration | NEW |

**Sketch:**
Intercept `process.stdout.write` and `process.stderr.write` during `parseConfig`. Provide `$MY_SECRET` env var indirection. Assert: resolved value is correct AND secret string does not appear in captured output.

---

### 4.18 Observability

**File:** `ts/packages/runtime/test/runtime.test.ts`

| Test | Type | Status |
|------|------|--------|
| `runtime continues dispatch correctly when a subscribe listener throws` | integration | NEW |

**Sketch:**
Subscribe a listener that always throws. Run `pollOnce({ waitForRuns: true })`. Assert: dispatch completed successfully (run in history), runtime status not errored, a second (non-throwing) subscriber still receives events.

---

## 5. Verification Checklist

After implementation, confirm all invariants are enforced:

1. **Run all tests:**
   ```bash
   cd /home/coder/work/symphony-2/ts && mise run check
   ```

2. **Verify new test file created:**
   - `ts/packages/dispatch/test/ensemble-fallback-props.test.ts` exists and passes

3. **Verify PBT tests run with sufficient examples:**
   - Each `fc.assert` call uses default numRuns (100) or higher
   - No `fc.pre()` filtering more than 50% of generated inputs (check with `{ verbose: true }`)

4. **Verify integration tests clean up temp directories:**
   - Each test using `tempDir()` should not leave orphaned dirs (OS handles cleanup via tmpdir)

5. **Verify no regressions in existing tests:**
   - All previously passing tests in `sort-props.test.ts`, `routing-props.test.ts`, `ensemble-props.test.ts`, `config-props.test.ts`, `usage-props.test.ts`, `retry-props.test.ts`, `workerHost-props.test.ts` still pass

6. **Coverage spot-check:**
   - `validateWorkspaceCwd` covers symlink at intermediate segments (not just final/root)
   - `shouldDispatchIssue` rejects for arbitrary non-active states (not just hardcoded list)
   - `dispatchBlockReason` returns `local_concurrency_cap` when per-state limit hit
   - `routedToThisWorker` rejects whitespace-only route suffixes even with `acceptUnrouted: true`
   - `firstUnclaimedSlot` uses `settings.agent.ensembleSize` when no ensemble label
   - `mergeMonotonicUsage` produces correct global delta without double-counting
   - Runtime reconciles before dispatching on each tick
   - Runtime aborts runs on state/route changes and preserves workspace
   - Runtime survives validation errors and listener crashes
   - Agent runner respects maxTurns, backend profile changes, and hook failures
   - Resume state invalidated before retry on force-termination
   - Hooks enforce timeout and do not re-run on workspace reuse
   - Secret resolution does not leak to stdout/stderr
