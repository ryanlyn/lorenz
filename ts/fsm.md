# FSM Refactor: Complete Design & Implementation Plan

## Problem

The lifecycle of a run is spread across multiple maps (`running`, `claimed`, `activeRunIds`, `activeAbortControllers`, `externallyFinishedRunKeys`) with implicit state transitions. Race conditions arise because nothing enforces that a slot moves through states sequentially, and nothing ties a transition to a specific generation of run.

The `test.fails("stale finally does not corrupt re-dispatched run")` in `runtime.test.ts` proves the primary bug: the old runner's `finally` block unconditionally deletes the new run's abort controller because they share the same slot key.

---

## Design Philosophy

Replace implicit state (scattered across 6+ Maps and Sets with ad-hoc invariant maintenance) with explicit state machines that make invalid transitions unrepresentable.

Core principles:
1. **Generation safety** — each run gets a unique `runId` baked into its `RunningHandle`, making stale-finally corruption structurally impossible
2. **Atomic transitions** — moving from Running to Aborting captures all relevant state in a single synchronous step, eliminating double-lookup-between-awaits races
3. **Derivability** — running count, claimed set, retry list, and completed set are all derivable from the registry's slot states rather than maintained as separate data structures that can drift

---

## Library Choice

**Hand-rolled discriminated unions with pure transition functions. No third-party FSM library.**

Rationale:
- CLI/server app where bundle size and dependency surface matter (xstate adds 40KB+)
- Discriminated-union FSMs integrate naturally with ts-pattern for exhaustive matching and fast-check for property-based testing
- The FSMs are simple enough (6/2/13 states) that xstate's visualization/devtools value doesn't justify the coupling
- Single file (~150 lines for SlotMachine) with zero runtime dependencies

---

## FSM Architecture

### 1. SlotMachine (6 states) — Orchestrator Slot Lifecycle

```
   ┌──────────────────────────────────────────────────────────────────┐
   │                                                                  │
   │  ┌──────┐  claim   ┌─────────┐  first_update  ┌─────────┐      │
   │  │ Idle │─────────▶│ Claimed │───────────────▶│ Running │      │
   │  └──────┘          └─────────┘                └────┬────┘      │
   │      ▲                  │                          │  │  │      │
   │      │                  │ run_failed               │  │  │      │
   │      │                  ▼                          │  │  │      │
   │      │            ┌──────────┐◀────────────────────┘  │  │      │
   │      │            │ Retrying │  run_finished/failed    │  │      │
   │      │            └────┬─────┘                        │  │      │
   │      │     retry_due   │                    abort     │  │      │
   │      │   (new claim)   │                              ▼  │      │
   │      └─────────────────┘                     ┌──────────┐│      │
   │                                              │ Aborting ││      │
   │                                              └────┬─────┘│      │
   │                                   cleanup_done    │      │      │
   │                                   (to Retrying)───┘      │      │
   │                                                          │      │
   │         reconcile_terminal from any non-done state       │      │
   │      ┌──────┐◀───────────────────────────────────────────┘      │
   │      │ Done │                                                   │
   │      └──────┘  (terminal — all events rejected)                 │
   └──────────────────────────────────────────────────────────────────┘
```

#### States

| State | Description | Key Data |
|-------|-------------|----------|
| **Idle** | Slot not tracked. Eligible for dispatch. | No entry anywhere |
| **Claimed** | Slot reserved, runner promise created, agent not yet started | `runId`, `handle`, `RunningEntry` |
| **Running** | Agent actively executing, updates streaming in | `runId`, `handle`, `RunningEntry` (mutated) |
| **Aborting** | Externally terminated (stall/reconcile), old runner draining | `runId`, `reason`, entry snapshot |
| **Retrying** | Finished, waiting for backoff timer before re-dispatch | `attempt`, `dueAt`, `slotIndex`, `workerHost` |
| **Done** | Terminal. Issue cleaned up. No further transitions. | `completedAt` |

#### Type Definition

```typescript
type SlotState =
  | { kind: 'idle' }
  | { kind: 'claimed'; runId: string; handle: RunningHandle; entry: RunningEntry; claimedAt: Date }
  | { kind: 'running'; runId: string; handle: RunningHandle; entry: RunningEntry; startedAt: Date }
  | { kind: 'aborting'; runId: string; reason: string; entry: RunningEntry; abortedAt: Date }
  | { kind: 'retrying'; attempt: number; dueAt: Date; lastError: string | null; lastRunId: string; slotIndex: number; workerHost: string | null; workspacePath: string | null }
  | { kind: 'done'; completedAt: Date };

type SlotEvent =
  | { kind: 'claim'; issue: Issue; runId: string; workerHost: string | null; settings: Settings }
  | { kind: 'agent_update'; runId: string; update: AgentUpdate }
  | { kind: 'run_finished'; runId: string; result: RunResult }
  | { kind: 'run_failed'; runId: string; error: Error }
  | { kind: 'abort'; reason: string }
  | { kind: 'cleanup_done'; runId: string }
  | { kind: 'retry_due' }
  | { kind: 'reconcile_terminal'; reason: string };
```

#### Transition Table

| From | Event | To | Guard |
|------|-------|----|-------|
| idle | claim | claimed | issue eligible, slot available, worker capacity |
| claimed | agent_update (matching runId) | running | first update received |
| claimed | run_failed (matching runId) | retrying | runner failed before producing any update |
| claimed | reconcile_terminal | done | issue became terminal before runner started |
| running | agent_update (matching runId) | running | self-loop: accumulates turnCount, usage |
| running | run_finished (matching runId) | retrying | runner resolved normally |
| running | run_failed (matching runId) | retrying | runner rejected with error |
| running | abort | aborting | stall detected or reconciliation |
| running | reconcile_terminal | done | issue terminal; aborts controller |
| aborting | cleanup_done (matching runId) | retrying | old runner settled |
| aborting | reconcile_terminal | done | issue terminal while draining |
| retrying | claim | claimed | retry is due; new runId |
| retrying | reconcile_terminal | done | issue became terminal during backoff |
| done | * | INVALID | terminal state |

**Generation safety invariant:** Every event carrying a `runId` is REJECTED if it doesn't match the current state's `runId`.

---

### 2. RunningHandle — Capability-Scoped to One Generation

```typescript
interface RunningHandle {
  readonly runId: string;
  readonly key: string;
  readonly slotIndex: number;
  readonly issueId: string;
  readonly controller: AbortController;

  applyUpdate(update: AgentUpdate): void;   // no-op if stale
  finish(result: RunResult): boolean;       // false if stale
  fail(error: Error): boolean;              // false if stale
  get isActive(): boolean;
  get signal(): AbortSignal;
}
```

**Ownership model:** The handle holds a back-reference to the SlotMachine and its own `runId`. Every mutation checks `slot.state.kind === 'running' && slot.state.runId === this.runId`. If the check fails, the method silently no-ops. This eliminates `externallyFinishedRunKeys` entirely — stale writes are structurally impossible.

---

### 3. PollMachine (2 states) — Coalescing

```typescript
type PollState =
  | { kind: 'idle'; lastPollAt: Date | null; lastError: string | null }
  | { kind: 'polling'; startedAt: Date; promise: Promise<void>; waiters: Array<...> };

type PollEvent =
  | { kind: 'poll_requested' }
  | { kind: 'poll_completed'; at: Date }
  | { kind: 'poll_failed'; error: string; at: Date };
```

Replaces `pollInProgress`, `pollStatus`, and the reference-equality guard.

---

### 4. AgentRunMachine (13 states) — Single-Attempt Lifecycle

```
idle → preparingWorkspace → runningBeforeHook → checkingResumeState
     → startingSession → runningTurn ⟷ persistingMidRunState ⟷ evaluatingContinuation
     → stoppingSession → runningAfterHook → persistingFinalState → completed
                                                                 → failed
```

- Linear lifecycle (no parallelism within the machine)
- Abort only consulted at state transition boundaries
- `session.stop()` guaranteed exactly once via state check

---

## Composition Model

```
SymphonyRuntime
├── PollMachine (idle | polling)
├── Orchestrator
│   └── SlotRegistry (Map<slotKey, SlotMachine>)
│       ├── SlotMachine("issue-1:0")  → RunningHandle → AgentRunMachine
│       ├── SlotMachine("issue-1:1")  → RunningHandle → AgentRunMachine
│       └── SlotMachine("issue-2:0")  → RunningHandle → AgentRunMachine
└── RetryScheduler (timers keyed by issueId)
```

- **Upward event flow:** AgentRunMachine emits updates via `handle.applyUpdate()`
- **Downward control:** PollMachine triggers reconciliation; reconcile calls `slot.transition({kind:'abort'})`
- **No shared mutable state:** `externallyFinishedRunKeys`, `claimed` Set, `running` Map, `retryAttempts` Map are all eliminated as separate structures — derivable from slot states

---

## Race Conditions Eliminated

| Bug | Current Cause | FSM Prevention |
|-----|--------------|----------------|
| **Stale finally corrupts re-dispatch** | finally block unconditionally deletes from shared maps | Handle's `finish()` rejected when `runId` doesn't match |
| **Double-lookup between awaits** | Entry disappears from running between two snapshot calls | FSM transitions are atomic; slot reference is stable |
| **Reconcile + re-dispatch same tick** | cleanupIssue then claim in same poll | `claim` only valid from `idle`/`retrying`, not from `done` |
| **Poll coalescing race** | pollInProgress reference-equality check | PollMachine atomic `idle→polling` transition |
| **externallyFinishedRunKeys leak** | Marker left when entry vanishes between checks | No marker exists; generation-check replaces it |
| **Ensemble retry overwrite** | retryAttempts keyed by issueId, not slotKey | Each slot has its own FSM with independent retry state |

---

## Invariants (Enforced by Construction)

1. `done` is absorbing: once reached, no event produces a new state
2. `runId` monotonicity: each claim produces a fresh runId greater than any prior
3. Generation safety: any event with `runId !== currentState.runId` is rejected
4. Running implies controller: the `AbortController` lives inside the `running` state — can't exist without it
5. At most one run per slot: only one `SlotMachine` exists per key, and only `running`/`claimed` states imply an active run
6. Retry independence: ensemble slots have independent FSMs with independent retry state

---

## Implementation Plan

Each phase is one or more stacked PRs forming a PR train. Each PR branches from the previous, merges in strict order, and is reviewable in isolation.

### Phase 1: Build FSM Package (Steps 1-3) — ~400-500 lines, 1 PR (base of train)

| Step | What | Files |
|------|------|-------|
| 1 | Create `@symphony/fsm` with SlotMachine + property-based tests | `ts/packages/fsm/{src,test}/*` |
| 2 | Add PollMachine, RunningHandle, SlotRegistry + scenario tests | Same package |
| 3 | Write stale-finally scenario test (passes from day 1) | `fsm/test/slot-machine-scenarios.test.ts` |

**Zero changes to existing code.** All additive.

### Phase 2: Migrate Orchestrator (Steps 4-5) — ~400 lines, 2 PRs (stacked on Phase 1)

| Step | What | Files |
|------|------|-------|
| 4 | Dual-write: orchestrator uses both old Maps AND new SlotRegistry | `orchestrator/src/index.ts` |
| 5 | Single-source: derive all state from SlotRegistry, remove old maps | Same file |

**Public API unchanged.** Existing tests pass without modification.

### Phase 3: Migrate Runtime (Step 6) — ~400-500 lines, 1 PR (stacked on Phase 2)

| Step | What | Files |
|------|------|-------|
| 6 | Replace activeRunIds/activeAbortControllers/externallyFinishedRunKeys with RunningHandle pattern | `runtime/src/index.ts`, `runtime/test/runtime.test.ts` |

**Fixes the stale-finally bug.** `test.fails` → `test` (passing).

### Phase 4: Migrate Agent Runner (Steps 7-8) — ~400 lines, 2 PRs (stacked on Phase 3)

| Step | What | Files |
|------|------|-------|
| 7 | Add AgentRunMachine FSM definition + tests (additive) | `agent-runner/src/agent-run-machine.ts` |
| 8 | Refactor RunController.run() to advance through FSM states | `agent-runner/src/index.ts` |

**runAgentAttempt() signature unchanged.** Abort semantics become explicit.

### Phase 5: Integration & Cleanup (Step 9) — ~100-200 lines, 1 PR (top of train)

Remove dual-write scaffolding, dead types, add end-to-end FSM composition test.

---

## Testing Strategy

| Layer | Technique | Coverage |
|-------|-----------|----------|
| **Property-based** | fast-check arbitrary event sequences | Invariant verification: absorbing states, generation safety, monotonicity |
| **Exhaustive BFS** | Walker enumerates all (state, event) pairs | 48 pairs for SlotMachine, 221 for AgentRunMachine |
| **Scenario** | One test per known race condition | Stale-finally, double-stop, reconcile+redispatch, poll-coalesce |
| **Regression** | Existing orchestrator.test.ts + runtime.test.ts | All pass at every step |
| **Integration** | Full composition test (Poll→Dispatch→Handle→FSM) | End-to-end lifecycle |

---

## Migration Safety

- **Stacked PR train:** each PR is branched from the previous one, forming a linear chain reviewable in sequence. Reviewers can read each diff in isolation knowing it builds on the prior step. Merge order is strict: step N merges only after step N-1.
- **Strangler-fig pattern:** dual-write ensures old and new paths agree before cutting over
- **Pause-safe:** migration can stop after any phase without inconsistency
- **PR-sized steps:** each step is 200-500 lines, independently reviewable as one link in the train
- **No public API changes:** SymphonyRuntime, Orchestrator constructors, runAgentAttempt all keep their signatures
