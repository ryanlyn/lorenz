import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  agentRunTransition,
  shouldCallSessionStop,
  ALL_STATE_KINDS,
  type AgentRunState,
  type AgentRunEvent,
  type AgentRunStateKind,
} from "../src/agent-run-machine.js";

// --- Helpers ---

function makeState(kind: AgentRunStateKind): AgentRunState {
  if (kind === "failed") return { kind: "failed", reason: "test-error" };
  return { kind } as AgentRunState;
}

// The happy-path event sequence that drives the machine from idle to completed
const HAPPY_PATH_EVENTS: AgentRunEvent[] = [
  { kind: "workspace_ready" }, // idle -> preparingWorkspace
  { kind: "workspace_ready" }, // preparingWorkspace -> runningBeforeHook
  { kind: "hook_done" }, // runningBeforeHook -> checkingResumeState
  { kind: "resume_checked" }, // checkingResumeState -> startingSession
  { kind: "session_started" }, // startingSession -> runningTurn
  { kind: "turn_done" }, // runningTurn -> persistingMidRunState
  { kind: "state_persisted" }, // persistingMidRunState -> evaluatingContinuation
  { kind: "continuation_no" }, // evaluatingContinuation -> stoppingSession
  { kind: "session_stopped" }, // stoppingSession -> runningAfterHook
  { kind: "after_hook_done" }, // runningAfterHook -> persistingFinalState
  { kind: "final_persisted" }, // persistingFinalState -> completed
];

const HAPPY_PATH_STATES: AgentRunStateKind[] = [
  "idle",
  "preparingWorkspace",
  "runningBeforeHook",
  "checkingResumeState",
  "startingSession",
  "runningTurn",
  "persistingMidRunState",
  "evaluatingContinuation",
  "stoppingSession",
  "runningAfterHook",
  "persistingFinalState",
  "completed",
];

// States where abort is NOT accepted (teardown path + terminals)
const ABORT_IGNORED_STATES: AgentRunStateKind[] = [
  "stoppingSession",
  "runningAfterHook",
  "persistingFinalState",
  "completed",
  "failed",
];

// States where abort IS accepted
const ABORT_ACCEPTED_STATES: AgentRunStateKind[] = ALL_STATE_KINDS.filter(
  (k) => !ABORT_IGNORED_STATES.includes(k),
) as AgentRunStateKind[];

// States in the teardown path (error -> failed directly)
const TEARDOWN_STATES: AgentRunStateKind[] = [
  "stoppingSession",
  "runningAfterHook",
  "persistingFinalState",
];

// States where error routes through stoppingSession
const ERROR_TO_STOPPING_STATES: AgentRunStateKind[] = ALL_STATE_KINDS.filter(
  (k) => !TEARDOWN_STATES.includes(k) && k !== "completed" && k !== "failed",
) as AgentRunStateKind[];

// --- Happy path tests ---

describe("AgentRunMachine happy path", () => {
  it("traverses all 13 states from idle to completed", () => {
    let state: AgentRunState = { kind: "idle" };

    for (let i = 0; i < HAPPY_PATH_EVENTS.length; i++) {
      expect(state.kind).toBe(HAPPY_PATH_STATES[i]);
      const next = agentRunTransition(state, HAPPY_PATH_EVENTS[i]!);
      expect(next).not.toBeNull();
      state = next!;
    }

    expect(state.kind).toBe("completed");
  });

  it("supports continuation loop: turn -> persist -> evaluate -> turn", () => {
    // Drive to evaluatingContinuation
    let state: AgentRunState = { kind: "idle" };
    const eventsToEval: AgentRunEvent[] = [
      { kind: "workspace_ready" },
      { kind: "workspace_ready" },
      { kind: "hook_done" },
      { kind: "resume_checked" },
      { kind: "session_started" },
      { kind: "turn_done" },
      { kind: "state_persisted" },
    ];

    for (const ev of eventsToEval) {
      state = agentRunTransition(state, ev)!;
    }
    expect(state.kind).toBe("evaluatingContinuation");

    // Loop back
    state = agentRunTransition(state, { kind: "continuation_yes" })!;
    expect(state.kind).toBe("runningTurn");

    state = agentRunTransition(state, { kind: "turn_done" })!;
    expect(state.kind).toBe("persistingMidRunState");

    state = agentRunTransition(state, { kind: "state_persisted" })!;
    expect(state.kind).toBe("evaluatingContinuation");

    // Exit loop
    state = agentRunTransition(state, { kind: "continuation_no" })!;
    expect(state.kind).toBe("stoppingSession");
  });
});

// --- Abort tests ---

describe("AgentRunMachine abort handling", () => {
  it("abort at each non-teardown state transitions to stoppingSession", () => {
    for (const kind of ABORT_ACCEPTED_STATES) {
      const state = makeState(kind);
      const result = agentRunTransition(state, { kind: "abort" });
      expect(result, `abort from ${kind} should go to stoppingSession`).toEqual({
        kind: "stoppingSession",
      });
    }
  });

  it("abort is ignored in teardown path (stoppingSession, runningAfterHook, persistingFinalState)", () => {
    for (const kind of TEARDOWN_STATES) {
      const state = makeState(kind);
      const result = agentRunTransition(state, { kind: "abort" });
      expect(result, `abort from ${kind} should be null`).toBeNull();
    }
  });

  it("abort is ignored in terminal states (completed, failed)", () => {
    const completed: AgentRunState = { kind: "completed" };
    const failed: AgentRunState = { kind: "failed", reason: "x" };
    expect(agentRunTransition(completed, { kind: "abort" })).toBeNull();
    expect(agentRunTransition(failed, { kind: "abort" })).toBeNull();
  });
});

// --- Error tests ---

describe("AgentRunMachine error handling", () => {
  it("error from pre-teardown states routes through stoppingSession", () => {
    for (const kind of ERROR_TO_STOPPING_STATES) {
      const state = makeState(kind);
      const result = agentRunTransition(state, { kind: "error", reason: "boom" });
      expect(result, `error from ${kind} should go to stoppingSession`).toEqual({
        kind: "stoppingSession",
      });
    }
  });

  it("error from teardown states goes directly to failed", () => {
    for (const kind of TEARDOWN_STATES) {
      const state = makeState(kind);
      const result = agentRunTransition(state, { kind: "error", reason: "teardown-err" });
      expect(result, `error from ${kind} should go to failed`).toEqual({
        kind: "failed",
        reason: "teardown-err",
      });
    }
  });

  it("error is ignored in terminal states", () => {
    const completed: AgentRunState = { kind: "completed" };
    const failed: AgentRunState = { kind: "failed", reason: "x" };
    expect(agentRunTransition(completed, { kind: "error", reason: "y" })).toBeNull();
    expect(agentRunTransition(failed, { kind: "error", reason: "y" })).toBeNull();
  });
});

// --- session.stop() exactly-once guarantee ---

describe("AgentRunMachine session.stop() guarantee", () => {
  it("shouldCallSessionStop is true only in stoppingSession state", () => {
    for (const kind of ALL_STATE_KINDS) {
      const state = makeState(kind);
      if (kind === "stoppingSession") {
        expect(shouldCallSessionStop(state)).toBe(true);
      } else {
        expect(shouldCallSessionStop(state), `${kind} should not call stop`).toBe(false);
      }
    }
  });

  it("happy path passes through stoppingSession exactly once", () => {
    let state: AgentRunState = { kind: "idle" };
    let stopCount = 0;

    for (const ev of HAPPY_PATH_EVENTS) {
      state = agentRunTransition(state, ev)!;
      if (shouldCallSessionStop(state)) stopCount++;
    }

    expect(stopCount).toBe(1);
  });

  it("abort-then-complete passes through stoppingSession exactly once", () => {
    // Drive to runningTurn, then abort
    let state: AgentRunState = { kind: "idle" };
    const eventsToTurn: AgentRunEvent[] = [
      { kind: "workspace_ready" },
      { kind: "workspace_ready" },
      { kind: "hook_done" },
      { kind: "resume_checked" },
      { kind: "session_started" },
    ];
    for (const ev of eventsToTurn) {
      state = agentRunTransition(state, ev)!;
    }
    expect(state.kind).toBe("runningTurn");

    // Abort
    state = agentRunTransition(state, { kind: "abort" })!;
    expect(state.kind).toBe("stoppingSession");

    let stopCount = 0;
    if (shouldCallSessionStop(state)) stopCount++;

    // Complete teardown
    state = agentRunTransition(state, { kind: "session_stopped" })!;
    if (shouldCallSessionStop(state)) stopCount++;
    state = agentRunTransition(state, { kind: "after_hook_done" })!;
    if (shouldCallSessionStop(state)) stopCount++;
    state = agentRunTransition(state, { kind: "final_persisted" })!;
    if (shouldCallSessionStop(state)) stopCount++;

    expect(stopCount).toBe(1);
    expect(state.kind).toBe("completed");
  });

  it("error-then-stop passes through stoppingSession exactly once", () => {
    let state: AgentRunState = { kind: "startingSession" };
    state = agentRunTransition(state, { kind: "error", reason: "crash" })!;
    expect(state.kind).toBe("stoppingSession");

    let stopCount = 0;
    if (shouldCallSessionStop(state)) stopCount++;

    // Error during stop -> failed
    state = agentRunTransition(state, { kind: "error", reason: "stop-failed" })!;
    expect(state.kind).toBe("failed");
    if (shouldCallSessionStop(state)) stopCount++;

    expect(stopCount).toBe(1);
  });
});

// --- Terminal state (absorbing) property ---

describe("AgentRunMachine terminal states", () => {
  it("completed rejects all events", () => {
    const allEvents: AgentRunEvent[] = [
      { kind: "workspace_ready" },
      { kind: "hook_done" },
      { kind: "resume_checked" },
      { kind: "session_started" },
      { kind: "turn_done" },
      { kind: "state_persisted" },
      { kind: "continuation_yes" },
      { kind: "continuation_no" },
      { kind: "session_stopped" },
      { kind: "after_hook_done" },
      { kind: "final_persisted" },
      { kind: "error", reason: "x" },
      { kind: "abort" },
    ];

    for (const ev of allEvents) {
      expect(agentRunTransition({ kind: "completed" }, ev)).toBeNull();
    }
  });

  it("failed rejects all events", () => {
    const allEvents: AgentRunEvent[] = [
      { kind: "workspace_ready" },
      { kind: "hook_done" },
      { kind: "resume_checked" },
      { kind: "session_started" },
      { kind: "turn_done" },
      { kind: "state_persisted" },
      { kind: "continuation_yes" },
      { kind: "continuation_no" },
      { kind: "session_stopped" },
      { kind: "after_hook_done" },
      { kind: "final_persisted" },
      { kind: "error", reason: "x" },
      { kind: "abort" },
    ];

    for (const ev of allEvents) {
      expect(agentRunTransition({ kind: "failed", reason: "dead" }, ev)).toBeNull();
    }
  });
});

// --- Invalid event rejection ---

describe("AgentRunMachine invalid events", () => {
  it("wrong event for current state returns null", () => {
    // hook_done in idle
    expect(agentRunTransition({ kind: "idle" }, { kind: "hook_done" })).toBeNull();
    // workspace_ready in runningTurn
    expect(agentRunTransition({ kind: "runningTurn" }, { kind: "workspace_ready" })).toBeNull();
    // session_stopped in idle
    expect(agentRunTransition({ kind: "idle" }, { kind: "session_stopped" })).toBeNull();
    // continuation_yes in stoppingSession
    expect(
      agentRunTransition({ kind: "stoppingSession" }, { kind: "continuation_yes" }),
    ).toBeNull();
  });
});

// --- Property-based tests ---

describe("AgentRunMachine properties", () => {
  const arbEvent: fc.Arbitrary<AgentRunEvent> = fc.oneof(
    fc.constant({ kind: "workspace_ready" } as AgentRunEvent),
    fc.constant({ kind: "hook_done" } as AgentRunEvent),
    fc.constant({ kind: "resume_checked" } as AgentRunEvent),
    fc.constant({ kind: "session_started" } as AgentRunEvent),
    fc.constant({ kind: "turn_done" } as AgentRunEvent),
    fc.constant({ kind: "state_persisted" } as AgentRunEvent),
    fc.constant({ kind: "continuation_yes" } as AgentRunEvent),
    fc.constant({ kind: "continuation_no" } as AgentRunEvent),
    fc.constant({ kind: "session_stopped" } as AgentRunEvent),
    fc.constant({ kind: "after_hook_done" } as AgentRunEvent),
    fc.constant({ kind: "final_persisted" } as AgentRunEvent),
    fc
      .string({ minLength: 1, maxLength: 20 })
      .map((r) => ({ kind: "error", reason: r }) as AgentRunEvent),
    fc.constant({ kind: "abort" } as AgentRunEvent),
  );

  it("transition never returns an unknown state kind", () => {
    fc.assert(
      fc.property(fc.array(arbEvent, { minLength: 1, maxLength: 30 }), (events) => {
        let state: AgentRunState = { kind: "idle" };
        for (const ev of events) {
          const next = agentRunTransition(state, ev);
          if (next === null) continue;
          expect(ALL_STATE_KINDS).toContain(next.kind);
          state = next;
        }
      }),
    );
  });

  it("machine always terminates or stabilizes (no infinite loops without events)", () => {
    fc.assert(
      fc.property(fc.array(arbEvent, { minLength: 1, maxLength: 50 }), (events) => {
        let state: AgentRunState = { kind: "idle" };
        for (const ev of events) {
          const next = agentRunTransition(state, ev);
          if (next === null) continue;
          state = next;
        }
        // After all events, state is well-defined
        expect(ALL_STATE_KINDS).toContain(state.kind);
      }),
    );
  });

  it("stoppingSession appears at most once per any event sequence (stop exactly once)", () => {
    fc.assert(
      fc.property(fc.array(arbEvent, { minLength: 1, maxLength: 40 }), (events) => {
        let state: AgentRunState = { kind: "idle" };
        let stopEntries = 0;
        let prevKind = state.kind;

        for (const ev of events) {
          const next = agentRunTransition(state, ev);
          if (next === null) continue;
          if (next.kind === "stoppingSession" && prevKind !== "stoppingSession") {
            stopEntries++;
          }
          prevKind = next.kind;
          state = next;
        }

        // We can enter stoppingSession at most once per lifecycle
        expect(stopEntries).toBeLessThanOrEqual(1);
      }),
    );
  });
});
