/**
 * End-to-end FSM composition test.
 *
 * Exercises the full lifecycle of the Symphony FSM hierarchy:
 *
 * SymphonyRuntime
 * ├── PollMachine (idle | polling)
 * ├── Orchestrator
 * │   └── SlotRegistry (Map<slotKey, SlotMachine>)
 * │       ├── SlotMachine("issue-1:0") → RunningHandle → AgentRunMachine
 * │       └── ...
 * └── RetryScheduler
 */
import { describe, it, expect } from "vitest";

import { PollMachine } from "../src/poll-machine.js";
import { SlotRegistry } from "../src/slot-registry.js";
import { RunningHandle } from "../src/running-handle.js";
import {
  transition,
  type SlotState,
  type RunningHandle as SlotHandle,
} from "../src/slot-machine.js";
import {
  agentRunTransition,
  type AgentRunState,
} from "../../agent-runner/src/agent-run-machine.js";

// --- Helpers ---

function makeSlotHandle(runId: string): SlotHandle {
  return { runId, controller: new AbortController() };
}

describe("FSM composition: full lifecycle", () => {
  it("exercises PollMachine → SlotRegistry → RunningHandle → AgentRunMachine → retry → done", async () => {
    // ===== Phase 1: PollMachine triggers a poll and discovers issues =====

    const registry = new SlotRegistry();
    const pollMachine = new PollMachine();
    const discoveredIssues: string[] = [];

    expect(pollMachine.state.kind).toBe("idle");

    // Simulate a poll that discovers an issue
    await pollMachine.requestPoll(async () => {
      discoveredIssues.push("issue-1");
    });

    expect(pollMachine.state.kind).toBe("idle");
    expect(pollMachine.state.kind === "idle" && pollMachine.state.lastError).toBeNull();
    expect(discoveredIssues).toEqual(["issue-1"]);

    // ===== Phase 2: SlotRegistry dispatches (idle → claimed → running) =====

    const issueId = "issue-1";
    const slotIndex = 0;
    const key = `${issueId}:${slotIndex}`;
    const runId = `run-001`;

    // Create the slot (idle)
    const initialState = registry.getOrCreate(key);
    expect(initialState.kind).toBe("idle");

    // Create a RunningHandle for this generation
    const handle = new RunningHandle(runId, key, slotIndex, issueId, registry);

    // Claim the slot (idle → claimed)
    const claimedState = registry.transition(key, {
      kind: "claim",
      runId,
      entry: { issueId },
      handle: { runId, controller: handle.controller },
    });
    expect(claimedState?.kind).toBe("claimed");
    expect(handle.isActive).toBe(true);

    // ===== Phase 3: AgentRunMachine drives the run =====

    // Simulate the agent run machine lifecycle
    let agentState: AgentRunState = { kind: "idle" };

    // idle → preparingWorkspace
    agentState = agentRunTransition(agentState, { kind: "start" })!;
    expect(agentState.kind).toBe("preparingWorkspace");

    // preparingWorkspace → runningBeforeHook
    agentState = agentRunTransition(agentState, { kind: "workspace_ready" })!;
    expect(agentState.kind).toBe("runningBeforeHook");

    // runningBeforeHook → checkingResumeState
    agentState = agentRunTransition(agentState, { kind: "hook_done" })!;
    expect(agentState.kind).toBe("checkingResumeState");

    // checkingResumeState → startingSession
    agentState = agentRunTransition(agentState, { kind: "resume_checked" })!;
    expect(agentState.kind).toBe("startingSession");

    // startingSession → runningTurn
    agentState = agentRunTransition(agentState, { kind: "session_started" })!;
    expect(agentState.kind).toBe("runningTurn");

    // First agent update transitions slot: claimed → running
    handle.applyUpdate({ progress: 10 });
    expect(registry.getState(key)?.kind).toBe("running");

    // runningTurn → persistingMidRunState
    agentState = agentRunTransition(agentState, { kind: "turn_done" })!;
    expect(agentState.kind).toBe("persistingMidRunState");

    // persistingMidRunState → evaluatingContinuation
    agentState = agentRunTransition(agentState, { kind: "state_persisted" })!;
    expect(agentState.kind).toBe("evaluatingContinuation");

    // evaluatingContinuation → stoppingSession (continuation_no = done with turns)
    agentState = agentRunTransition(agentState, { kind: "continuation_no" })!;
    expect(agentState.kind).toBe("stoppingSession");

    // stoppingSession → runningAfterHook
    agentState = agentRunTransition(agentState, { kind: "session_stopped" })!;
    expect(agentState.kind).toBe("runningAfterHook");

    // runningAfterHook → persistingFinalState
    agentState = agentRunTransition(agentState, { kind: "after_hook_done" })!;
    expect(agentState.kind).toBe("persistingFinalState");

    // persistingFinalState → completed
    agentState = agentRunTransition(agentState, { kind: "final_persisted" })!;
    expect(agentState.kind).toBe("completed");

    // ===== Phase 4: Run completes (running → retrying) =====

    // Agent run completed: signal the slot that run finished
    const retried = handle.finish({ success: true });
    expect(retried).toBe(true);

    const retryingState = registry.getState(key);
    expect(retryingState?.kind).toBe("retrying");
    expect(retryingState?.kind === "retrying" && retryingState.attempt).toBe(1);
    expect(retryingState?.kind === "retrying" && retryingState.lastRunId).toBe(runId);

    // Handle is now stale (slot has a new generation pending)
    expect(handle.isActive).toBe(false);

    // ===== Phase 5: Retry fires (retrying → claimed → running again) =====

    const retryRunId = "run-002";
    const retryHandle = new RunningHandle(retryRunId, key, slotIndex, issueId, registry);

    // RetryScheduler fires: claim the slot again with a new generation
    const reclaimedState = registry.transition(key, {
      kind: "claim",
      runId: retryRunId,
      entry: { issueId, retryAttempt: 1 },
      handle: { runId: retryRunId, controller: retryHandle.controller },
    });
    expect(reclaimedState?.kind).toBe("claimed");
    expect(retryHandle.isActive).toBe(true);

    // Agent update transitions to running
    retryHandle.applyUpdate({ progress: 0 });
    expect(registry.getState(key)?.kind).toBe("running");

    // Verify derived state shows 1 running
    const derived = registry.derivedState();
    expect(derived.runningCount).toBe(1);
    expect(derived.retryList).toHaveLength(0);

    // ===== Phase 6: Issue becomes terminal (→ done) =====

    // External reconciliation says the issue is now terminal (e.g., merged/closed)
    const finalState = registry.transition(key, {
      kind: "reconcile_terminal",
      reason: "issue_closed",
    });
    expect(finalState?.kind).toBe("done");

    // Handle is now aborted (reconcile_terminal aborts the controller)
    expect(retryHandle.controller.signal.aborted).toBe(true);
    expect(retryHandle.isActive).toBe(false);

    // Derived state reflects completion
    const finalDerived = registry.derivedState();
    expect(finalDerived.runningCount).toBe(0);
    expect(finalDerived.completedSet).toEqual(new Set([key]));
  });

  it("PollMachine coalesces concurrent polls while lifecycle proceeds", async () => {
    const pollMachine = new PollMachine();
    let pollCount = 0;
    let resolveCurrentPoll: (() => void) | null = null;

    // Start a slow poll
    const slowPollPromise = new Promise<void>((r) => {
      resolveCurrentPoll = r;
    });

    const p1 = pollMachine.requestPoll(() => {
      pollCount++;
      return slowPollPromise;
    });

    expect(pollMachine.state.kind).toBe("polling");

    // A second request coalesces (does not start another poll)
    const p2 = pollMachine.requestPoll(() => {
      pollCount++;
      return Promise.resolve();
    });

    expect(pollCount).toBe(1);

    // Complete the poll
    resolveCurrentPoll!();
    await Promise.all([p1, p2]);

    expect(pollMachine.state.kind).toBe("idle");
    expect(pollCount).toBe(1); // Only one executor call ever made
  });

  it("multiple slots for the same issue evolve independently", () => {
    const registry = new SlotRegistry();
    const issueId = "issue-multi";

    // Create two ensemble slots
    const key0 = `${issueId}:0`;
    const key1 = `${issueId}:1`;

    registry.getOrCreate(key0);
    registry.getOrCreate(key1);

    const handle0 = new RunningHandle("run-a", key0, 0, issueId, registry);
    const handle1 = new RunningHandle("run-b", key1, 1, issueId, registry);

    // Claim both slots
    registry.transition(key0, {
      kind: "claim",
      runId: "run-a",
      entry: { issueId },
      handle: { runId: "run-a", controller: handle0.controller },
    });
    registry.transition(key1, {
      kind: "claim",
      runId: "run-b",
      entry: { issueId },
      handle: { runId: "run-b", controller: handle1.controller },
    });

    // Advance slot 0 to running
    handle0.applyUpdate({ progress: 50 });
    expect(registry.getState(key0)?.kind).toBe("running");
    expect(registry.getState(key1)?.kind).toBe("claimed"); // slot 1 still claimed

    // Slot 1 fails
    handle1.fail(new Error("timeout"));
    expect(registry.getState(key1)?.kind).toBe("retrying");
    expect(registry.getState(key0)?.kind).toBe("running"); // slot 0 unaffected

    // Slot 0 finishes
    handle0.finish({ success: true });
    expect(registry.getState(key0)?.kind).toBe("retrying");

    const derived = registry.derivedState();
    expect(derived.runningCount).toBe(0);
    expect(derived.retryList).toHaveLength(2);
  });

  it("pure transition function rejects events in terminal state", () => {
    const doneState: SlotState = { kind: "done", completedAt: new Date() };

    // All events are rejected
    expect(
      transition(doneState, { kind: "claim", runId: "x", entry: {}, handle: makeSlotHandle("x") }),
    ).toBeNull();
    expect(transition(doneState, { kind: "agent_update", runId: "x" })).toBeNull();
    expect(transition(doneState, { kind: "run_finished", runId: "x" })).toBeNull();
    expect(transition(doneState, { kind: "abort", reason: "test" })).toBeNull();
    expect(transition(doneState, { kind: "reconcile_terminal", reason: "test" })).toBeNull();
    expect(transition(doneState, { kind: "retry_due" })).toBeNull();
  });

  it("AgentRunMachine abort mid-run routes through stoppingSession", () => {
    let state: AgentRunState = { kind: "idle" };

    // Advance to runningTurn
    state = agentRunTransition(state, { kind: "start" })!;
    state = agentRunTransition(state, { kind: "workspace_ready" })!;
    state = agentRunTransition(state, { kind: "hook_done" })!;
    state = agentRunTransition(state, { kind: "resume_checked" })!;
    state = agentRunTransition(state, { kind: "session_started" })!;
    expect(state.kind).toBe("runningTurn");

    // Abort while running
    state = agentRunTransition(state, { kind: "abort" })!;
    expect(state.kind).toBe("stoppingSession");

    // Complete teardown
    state = agentRunTransition(state, { kind: "session_stopped" })!;
    expect(state.kind).toBe("runningAfterHook");

    state = agentRunTransition(state, { kind: "after_hook_done" })!;
    expect(state.kind).toBe("persistingFinalState");

    state = agentRunTransition(state, { kind: "final_persisted" })!;
    expect(state.kind).toBe("completed");
  });

  it("generation safety: stale runId events are rejected", () => {
    const registry = new SlotRegistry();
    const key = "issue-gen:0";
    registry.getOrCreate(key);

    // First generation claims and runs
    const handle1 = new RunningHandle("gen-1", key, 0, "issue-gen", registry);
    registry.transition(key, {
      kind: "claim",
      runId: "gen-1",
      entry: {},
      handle: { runId: "gen-1", controller: handle1.controller },
    });
    handle1.applyUpdate({});
    expect(registry.getState(key)?.kind).toBe("running");

    // Run fails, enters retrying
    handle1.fail(new Error("crash"));
    expect(registry.getState(key)?.kind).toBe("retrying");

    // Second generation claims
    const handle2 = new RunningHandle("gen-2", key, 0, "issue-gen", registry);
    registry.transition(key, {
      kind: "claim",
      runId: "gen-2",
      entry: {},
      handle: { runId: "gen-2", controller: handle2.controller },
    });
    expect(registry.getState(key)?.kind).toBe("claimed");

    // Stale handle from gen-1 cannot affect current state
    expect(handle1.isActive).toBe(false);
    handle1.applyUpdate({}); // no-op
    expect(registry.getState(key)?.kind).toBe("claimed"); // unchanged

    expect(handle1.finish({ success: true })).toBe(false); // rejected
    expect(registry.getState(key)?.kind).toBe("claimed"); // still claimed by gen-2

    // Gen-2 handle works correctly
    expect(handle2.isActive).toBe(true);
    handle2.applyUpdate({});
    expect(registry.getState(key)?.kind).toBe("running");
  });
});
