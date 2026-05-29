import { describe, it, expect } from "vitest";

import {
  transition,
  type SlotState,
  type SlotEvent,
  type RunningHandle as SlotHandle,
} from "../src/slot-machine.js";
import { SlotRegistry } from "../src/slot-registry.js";
import { RunningHandle } from "../src/running-handle.js";
import { PollMachine } from "../src/poll-machine.js";

// --- Helpers ---

function makeSlotHandle(runId: string): SlotHandle {
  return { runId, controller: new AbortController() };
}

function makeEntry(issueId = "issue-1"): Record<string, unknown> {
  return { issueId };
}

// --- Scenario: Stale-finally bug is structurally impossible ---

describe("Scenario: stale-finally race condition", () => {
  it("rejects old runner's finally block after new generation claims the slot", () => {
    const registry = new SlotRegistry();
    const slotKey = "slot-0";
    registry.getOrCreate(slotKey);

    // Step 1: Slot starts idle
    expect(registry.getState(slotKey)?.kind).toBe("idle");

    // Step 2: First run claimed (runId: "run-1")
    const handle1 = makeSlotHandle("run-1");
    const claimed1 = registry.transition(slotKey, {
      kind: "claim",
      runId: "run-1",
      entry: makeEntry(),
      handle: handle1,
    });
    expect(claimed1?.kind).toBe("claimed");
    expect(handle1.controller.signal.aborted).toBe(false);

    // Step 3: Run starts (transitions to running)
    const running = registry.transition(slotKey, {
      kind: "agent_update",
      runId: "run-1",
    });
    expect(running?.kind).toBe("running");

    // Step 4: External abort fires (transitions to aborting)
    const aborting = registry.transition(slotKey, {
      kind: "abort",
      reason: "user-requested",
    });
    expect(aborting?.kind).toBe("aborting");
    // The abort controller for run-1 is signaled
    expect(handle1.controller.signal.aborted).toBe(true);

    // Step 5: Abort cleanup completes, transitions to retrying
    const retrying = registry.transition(slotKey, {
      kind: "cleanup_done",
      runId: "run-1",
    });
    expect(retrying?.kind).toBe("retrying");

    // Step 5b: New run claimed with retry (runId: "run-2")
    const handle2 = makeSlotHandle("run-2");
    const claimed2 = registry.transition(slotKey, {
      kind: "claim",
      runId: "run-2",
      entry: makeEntry(),
      handle: handle2,
    });
    expect(claimed2?.kind).toBe("claimed");
    if (claimed2?.kind === "claimed") {
      expect(claimed2.runId).toBe("run-2");
    }

    // Step 6: Old runner's finally block tries to finish with runId "run-1" -- REJECTED
    // This is the exact race condition: the old runner's finally block
    // unconditionally calling finish/cleanup after the new run has started.
    const staleFinish = registry.transition(slotKey, {
      kind: "run_finished",
      runId: "run-1",
    });
    expect(staleFinish).toBeNull(); // REJECTED due to generation mismatch

    // Also rejected: old runner trying run_failed
    const staleFail = registry.transition(slotKey, {
      kind: "run_failed",
      runId: "run-1",
      error: "stale error from old runner",
    });
    expect(staleFail).toBeNull(); // REJECTED

    // Also rejected: old runner trying cleanup_done
    const staleCleanup = registry.transition(slotKey, {
      kind: "cleanup_done",
      runId: "run-1",
    });
    expect(staleCleanup).toBeNull(); // REJECTED

    // Step 7: New run proceeds normally
    const running2 = registry.transition(slotKey, {
      kind: "agent_update",
      runId: "run-2",
    });
    expect(running2?.kind).toBe("running");
    if (running2?.kind === "running") {
      expect(running2.runId).toBe("run-2");
    }

    // New run's abort controller is independent and still active
    expect(handle2.controller.signal.aborted).toBe(false);
  });

  it("RunningHandle.finish returns false when handle is stale after re-claim", () => {
    const registry = new SlotRegistry();
    const slotKey = "slot-0";
    registry.getOrCreate(slotKey);

    // Create handle for run-1 via the RunningHandle class
    const handle1 = new RunningHandle("run-1", slotKey, 0, "issue-1", registry);

    // Claim with run-1's controller
    registry.transition(slotKey, {
      kind: "claim",
      runId: "run-1",
      entry: makeEntry(),
      handle: { runId: "run-1", controller: handle1.controller },
    });
    expect(handle1.isActive).toBe(true);

    // Transition to running
    handle1.applyUpdate({ progress: 10 });
    expect(registry.getState(slotKey)?.kind).toBe("running");

    // Simulate crash -> retrying -> new claim
    registry.transition(slotKey, {
      kind: "run_failed",
      runId: "run-1",
      error: "crash",
    });
    expect(registry.getState(slotKey)?.kind).toBe("retrying");

    // New generation claims
    const handle2 = new RunningHandle("run-2", slotKey, 0, "issue-1", registry);
    registry.transition(slotKey, {
      kind: "claim",
      runId: "run-2",
      entry: makeEntry(),
      handle: { runId: "run-2", controller: handle2.controller },
    });

    // Old handle is now stale
    expect(handle1.isActive).toBe(false);
    expect(handle2.isActive).toBe(true);

    // Old runner's finally block: handle1.finish() returns false
    const result = handle1.finish({ success: true });
    expect(result).toBe(false);

    // State is still claimed with run-2
    const state = registry.getState(slotKey);
    expect(state?.kind).toBe("claimed");
    if (state?.kind === "claimed") {
      expect(state.runId).toBe("run-2");
    }
  });
});

// --- Scenario: Double-stop (session.stop called twice -- second is no-op) ---

describe("Scenario: double-stop", () => {
  it("reconcile_terminal from done is rejected (second stop is a no-op)", () => {
    const registry = new SlotRegistry();
    const slotKey = "slot-0";
    registry.getOrCreate(slotKey);

    // Set up a running slot
    const handle = makeSlotHandle("run-1");
    registry.transition(slotKey, {
      kind: "claim",
      runId: "run-1",
      entry: makeEntry(),
      handle,
    });
    registry.transition(slotKey, {
      kind: "agent_update",
      runId: "run-1",
    });
    expect(registry.getState(slotKey)?.kind).toBe("running");

    // First stop: reconcile_terminal -> done
    const done = registry.transition(slotKey, {
      kind: "reconcile_terminal",
      reason: "session stopped",
    });
    expect(done?.kind).toBe("done");
    expect(handle.controller.signal.aborted).toBe(true);

    // Second stop: reconcile_terminal from done -> REJECTED
    const secondStop = registry.transition(slotKey, {
      kind: "reconcile_terminal",
      reason: "session stopped again",
    });
    expect(secondStop).toBeNull();

    // State remains done
    expect(registry.getState(slotKey)?.kind).toBe("done");
  });

  it("all events are rejected from done state (absorbing)", () => {
    const doneState: SlotState = { kind: "done", completedAt: new Date() };

    const events: SlotEvent[] = [
      { kind: "claim", runId: "x", entry: {}, handle: makeSlotHandle("x") },
      { kind: "agent_update", runId: "x" },
      { kind: "run_finished", runId: "x" },
      { kind: "run_failed", runId: "x", error: "err" },
      { kind: "abort", reason: "stop" },
      { kind: "cleanup_done", runId: "x" },
      { kind: "retry_due" },
      { kind: "reconcile_terminal", reason: "closed" },
    ];

    for (const event of events) {
      const result = transition(doneState, event);
      expect(result).toBeNull();
    }
  });
});

// --- Scenario: Reconcile + redispatch same tick ---

describe("Scenario: reconcile + redispatch same tick", () => {
  it("reconcile_terminal transitions to done, then claim from done is rejected", () => {
    const registry = new SlotRegistry();
    const slotKey = "slot-0";
    registry.getOrCreate(slotKey);

    // Set up a retrying slot (simulating a slot waiting for redispatch)
    const handle1 = makeSlotHandle("run-1");
    registry.transition(slotKey, {
      kind: "claim",
      runId: "run-1",
      entry: makeEntry(),
      handle: handle1,
    });
    registry.transition(slotKey, {
      kind: "run_failed",
      runId: "run-1",
      error: "initial failure",
    });
    expect(registry.getState(slotKey)?.kind).toBe("retrying");

    // Reconcile fires: issue is closed -> done
    const done = registry.transition(slotKey, {
      kind: "reconcile_terminal",
      reason: "issue closed externally",
    });
    expect(done?.kind).toBe("done");

    // Same tick: redispatch logic tries to claim (race condition)
    const handle2 = makeSlotHandle("run-2");
    const claimFromDone = registry.transition(slotKey, {
      kind: "claim",
      runId: "run-2",
      entry: makeEntry(),
      handle: handle2,
    });
    expect(claimFromDone).toBeNull(); // REJECTED - slot is terminal

    // Done state is preserved
    expect(registry.getState(slotKey)?.kind).toBe("done");
  });

  it("reconcile from claimed state transitions to done", () => {
    const registry = new SlotRegistry();
    const slotKey = "slot-0";
    registry.getOrCreate(slotKey);

    const handle = makeSlotHandle("run-1");
    registry.transition(slotKey, {
      kind: "claim",
      runId: "run-1",
      entry: makeEntry(),
      handle,
    });
    expect(registry.getState(slotKey)?.kind).toBe("claimed");

    // Reconcile fires before run starts
    const done = registry.transition(slotKey, {
      kind: "reconcile_terminal",
      reason: "issue closed",
    });
    expect(done?.kind).toBe("done");

    // No further transitions possible
    const retry = registry.transition(slotKey, {
      kind: "claim",
      runId: "run-2",
      entry: makeEntry(),
      handle: makeSlotHandle("run-2"),
    });
    expect(retry).toBeNull();
  });
});

// --- Scenario: Poll coalescing (PollMachine rejects concurrent polls) ---

describe("Scenario: poll coalescing", () => {
  it("second requestPoll during active poll does not invoke executor again", async () => {
    const pm = new PollMachine();
    let executorCallCount = 0;
    let resolveExecutor: () => void;
    const executorPromise = new Promise<void>((resolve) => {
      resolveExecutor = resolve;
    });

    // First poll starts the executor
    const p1 = pm.requestPoll(() => {
      executorCallCount++;
      return executorPromise;
    });
    expect(pm.state.kind).toBe("polling");
    expect(executorCallCount).toBe(1);

    // Second poll while first is in-flight - should NOT call executor
    const p2 = pm.requestPoll(() => {
      executorCallCount++;
      return Promise.resolve();
    });
    expect(executorCallCount).toBe(1); // Still 1

    // Third poll - also coalesced
    const p3 = pm.requestPoll(() => {
      executorCallCount++;
      return Promise.resolve();
    });
    expect(executorCallCount).toBe(1); // Still 1

    // Resolve the original executor
    resolveExecutor!();
    await Promise.all([p1, p2, p3]);

    // All waiters resolved, executor called exactly once
    expect(executorCallCount).toBe(1);
    expect(pm.state.kind).toBe("idle");
  });

  it("after first poll completes, next requestPoll starts a fresh executor", async () => {
    const pm = new PollMachine();
    let executorCallCount = 0;

    // First poll
    await pm.requestPoll(() => {
      executorCallCount++;
      return Promise.resolve();
    });
    expect(executorCallCount).toBe(1);
    expect(pm.state.kind).toBe("idle");

    // Second poll (after first completed) - should invoke executor again
    await pm.requestPoll(() => {
      executorCallCount++;
      return Promise.resolve();
    });
    expect(executorCallCount).toBe(2);
    expect(pm.state.kind).toBe("idle");
  });

  it("poll failure still resolves all waiters and records error", async () => {
    const pm = new PollMachine();
    let resolveExecutor: () => void;
    let rejectExecutor: (err: Error) => void;
    const executorPromise = new Promise<void>((resolve, reject) => {
      resolveExecutor = resolve;
      rejectExecutor = reject;
    });
    void resolveExecutor!;

    const p1 = pm.requestPoll(() => executorPromise);
    const p2 = pm.requestPoll(() => Promise.resolve()); // coalesced waiter

    // Reject the executor
    rejectExecutor!(new Error("network timeout"));
    await Promise.all([p1, p2]);

    // Both waiters resolved (not rejected - PollMachine swallows executor errors)
    expect(pm.state.kind).toBe("idle");
    if (pm.state.kind === "idle") {
      expect(pm.state.lastError).toBe("network timeout");
      expect(pm.state.lastPollAt).toBeInstanceOf(Date);
    }
  });

  it("state is idle after coalesced poll completes", async () => {
    const pm = new PollMachine();
    let resolveExec: () => void;
    const execPromise = new Promise<void>((r) => {
      resolveExec = r;
    });

    pm.requestPoll(() => execPromise);

    // Verify polling state has waiters
    if (pm.state.kind === "polling") {
      expect(pm.state.waiters.length).toBe(1);
    }

    // Add a coalesced waiter
    pm.requestPoll(() => Promise.resolve());
    if (pm.state.kind === "polling") {
      expect(pm.state.waiters.length).toBe(2);
    }

    resolveExec!();
    // Allow microtask to flush
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(pm.state.kind).toBe("idle");
  });
});
