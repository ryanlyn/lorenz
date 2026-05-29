import { match } from "ts-pattern";

// --- AgentRunState: 13-state linear lifecycle ---
//
// idle → preparingWorkspace → runningBeforeHook → checkingResumeState
//      → startingSession → runningTurn ⟷ persistingMidRunState ⟷ evaluatingContinuation
//      → stoppingSession → runningAfterHook → persistingFinalState → completed
//                                                                  → failed
//
// Events signal completion of the CURRENT phase and advance to the next.
// Abort only consulted at state-transition boundaries.
// session.stop() guaranteed exactly once: only stoppingSession calls it.

export type AgentRunState =
  | { kind: "idle" }
  | { kind: "preparingWorkspace" }
  | { kind: "runningBeforeHook" }
  | { kind: "checkingResumeState" }
  | { kind: "startingSession" }
  | { kind: "runningTurn" }
  | { kind: "persistingMidRunState" }
  | { kind: "evaluatingContinuation" }
  | { kind: "stoppingSession" }
  | { kind: "runningAfterHook" }
  | { kind: "persistingFinalState" }
  | { kind: "completed" }
  | { kind: "failed"; reason: string };

// --- AgentRunEvent discriminated union ---

export type AgentRunEvent =
  | { kind: "workspace_ready" }
  | { kind: "hook_done" }
  | { kind: "resume_checked" }
  | { kind: "session_started" }
  | { kind: "turn_done" }
  | { kind: "state_persisted" }
  | { kind: "continuation_yes" }
  | { kind: "continuation_no" }
  | { kind: "session_stopped" }
  | { kind: "after_hook_done" }
  | { kind: "final_persisted" }
  | { kind: "error"; reason: string }
  | { kind: "abort" };

// --- Pure transition function ---

export function agentRunTransition(
  state: AgentRunState,
  event: AgentRunEvent,
): AgentRunState | null {
  // Terminal states reject all events
  if (state.kind === "completed" || state.kind === "failed") return null;

  // Abort at any non-terminal boundary transitions to stoppingSession
  // (unless already in the teardown path: stoppingSession, runningAfterHook, persistingFinalState)
  if (event.kind === "abort") {
    return match(state.kind)
      .with("stoppingSession", () => null)
      .with("runningAfterHook", () => null)
      .with("persistingFinalState", () => null)
      .otherwise(() => ({ kind: "stoppingSession" as const }));
  }

  // Error from teardown path goes directly to failed
  // Error from any other state routes through stoppingSession first
  if (event.kind === "error") {
    return match(state.kind)
      .with("stoppingSession", () => ({ kind: "failed" as const, reason: event.reason }))
      .with("runningAfterHook", () => ({ kind: "failed" as const, reason: event.reason }))
      .with("persistingFinalState", () => ({ kind: "failed" as const, reason: event.reason }))
      .otherwise(() => ({ kind: "stoppingSession" as const }));
  }

  // Normal linear transitions
  return match([state, event] as const)
    .with([{ kind: "idle" }, { kind: "workspace_ready" }], () => ({
      kind: "preparingWorkspace" as const,
    }))
    .with([{ kind: "preparingWorkspace" }, { kind: "workspace_ready" }], () => ({
      kind: "runningBeforeHook" as const,
    }))
    .with([{ kind: "runningBeforeHook" }, { kind: "hook_done" }], () => ({
      kind: "checkingResumeState" as const,
    }))
    .with([{ kind: "checkingResumeState" }, { kind: "resume_checked" }], () => ({
      kind: "startingSession" as const,
    }))
    .with([{ kind: "startingSession" }, { kind: "session_started" }], () => ({
      kind: "runningTurn" as const,
    }))
    .with([{ kind: "runningTurn" }, { kind: "turn_done" }], () => ({
      kind: "persistingMidRunState" as const,
    }))
    .with([{ kind: "persistingMidRunState" }, { kind: "state_persisted" }], () => ({
      kind: "evaluatingContinuation" as const,
    }))
    .with([{ kind: "evaluatingContinuation" }, { kind: "continuation_yes" }], () => ({
      kind: "runningTurn" as const,
    }))
    .with([{ kind: "evaluatingContinuation" }, { kind: "continuation_no" }], () => ({
      kind: "stoppingSession" as const,
    }))
    .with([{ kind: "stoppingSession" }, { kind: "session_stopped" }], () => ({
      kind: "runningAfterHook" as const,
    }))
    .with([{ kind: "runningAfterHook" }, { kind: "after_hook_done" }], () => ({
      kind: "persistingFinalState" as const,
    }))
    .with([{ kind: "persistingFinalState" }, { kind: "final_persisted" }], () => ({
      kind: "completed" as const,
    }))
    .otherwise(() => null);
}

// --- Helper: check if session.stop() should be called in a given state ---

export function shouldCallSessionStop(state: AgentRunState): boolean {
  return state.kind === "stoppingSession";
}

// --- All state kinds for iteration in tests ---

export const ALL_STATE_KINDS = [
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
  "failed",
] as const;

export type AgentRunStateKind = (typeof ALL_STATE_KINDS)[number];
