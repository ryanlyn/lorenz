/**
 * Public-facing runtime app status. Defined here (single source of truth) and
 * re-exported from the runtime package index.
 *
 * Note: "starting" is included for API compatibility with external consumers
 * (e.g. runtime-events, TUI) but is never produced by deriveAppStatus().
 */
export type RuntimeAppStatus = "starting" | "idle" | "polling" | "running" | "stopping" | "error";

/**
 * Discriminated union representing the lifecycle phase of the SymphonyRuntime.
 * This is the single source of truth for app status -- no separate boolean flags needed.
 */
export type RuntimePhase =
  | { phase: "idle"; startupCleanupDone: boolean }
  | { phase: "polling"; startupCleanupDone: boolean; activeRuns: number }
  | { phase: "running"; activeRuns: number }
  | { phase: "stopping"; activeRuns: number }
  | { phase: "error"; lastError: string; activeRuns: number };

/**
 * Events that trigger phase transitions in the runtime state machine.
 */
export type RuntimeTransition =
  | { type: "POLL_START" }
  | { type: "POLL_SUCCESS" }
  | { type: "POLL_ERROR"; error: string }
  | { type: "RUN_STARTED" }
  | { type: "RUN_FINISHED" }
  | { type: "STARTUP_CLEANUP_DONE" }
  | { type: "STOP_REQUESTED" };

/**
 * Derives the public-facing RuntimeAppStatus from the internal phase.
 * This replaces the scattered `this.inFlight.size > 0 ? "running" : "idle"` computations.
 */
export function deriveAppStatus(state: RuntimePhase): RuntimeAppStatus {
  switch (state.phase) {
    case "idle":
      return "idle";
    case "polling":
      return state.activeRuns > 0 ? "running" : "polling";
    case "running":
      return "running";
    case "stopping":
      return "stopping";
    case "error":
      return "error";
  }
}

/**
 * Extract whether startup cleanup has been done from the current phase.
 */
export function isStartupCleanupDone(state: RuntimePhase): boolean {
  switch (state.phase) {
    case "idle":
    case "polling":
      return state.startupCleanupDone;
    case "running":
    case "stopping":
    case "error":
      // Once we reach running/stopping/error, startup cleanup has already occurred
      return true;
  }
}

/**
 * Extract the active run count from the current phase.
 * Internal helper used by transitionRuntime.
 */
function activeRunCount(state: RuntimePhase): number {
  switch (state.phase) {
    case "idle":
      return 0;
    case "polling":
      return state.activeRuns;
    case "running":
      return state.activeRuns;
    case "stopping":
      return state.activeRuns;
    case "error":
      return state.activeRuns;
  }
}

/**
 * Whether a stop has been requested (the runtime is draining active runs).
 * This replaces the old `stopped` boolean -- note that it means "stop requested",
 * not "fully quiesced".
 */
export function isStopRequested(state: RuntimePhase): boolean {
  return state.phase === "stopping";
}

/**
 * @deprecated Use `isStopRequested` for clarity. This alias is kept during migration.
 */
export const isStopped = isStopRequested;

/**
 * Transition function for the runtime state machine.
 * Given the current phase and an event, returns the next phase.
 *
 * @mutates state - For counter-only updates that stay within the same phase
 * (RUN_STARTED in polling/running, RUN_FINISHED in stopping/error,
 * STARTUP_CLEANUP_DONE in polling), the state object is mutated in place and
 * returned to avoid allocation overhead on the hot path. Phase-changing
 * transitions always return a new object. Do NOT rely on reference equality to
 * detect changes; compare the `phase` field or activeRuns count instead.
 */
export function transitionRuntime(state: RuntimePhase, event: RuntimeTransition): RuntimePhase {
  // STOP_REQUESTED transitions from any non-terminal state
  if (event.type === "STOP_REQUESTED") {
    if (state.phase === "stopping") return state;
    const runs = activeRunCount(state);
    return { phase: "stopping", activeRuns: runs };
  }

  switch (state.phase) {
    case "idle":
      if (event.type === "POLL_START")
        return { phase: "polling", startupCleanupDone: state.startupCleanupDone, activeRuns: 0 };
      return state;

    case "polling":
      if (event.type === "RUN_STARTED") {
        state.activeRuns += 1;
        return state;
      }
      if (event.type === "RUN_FINISHED") {
        state.activeRuns = Math.max(0, state.activeRuns - 1);
        return state;
      }
      if (event.type === "STARTUP_CLEANUP_DONE") {
        state.startupCleanupDone = true;
        return state;
      }
      if (event.type === "POLL_SUCCESS")
        return state.activeRuns > 0
          ? { phase: "running", activeRuns: state.activeRuns }
          : { phase: "idle", startupCleanupDone: state.startupCleanupDone };
      if (event.type === "POLL_ERROR")
        return { phase: "error", lastError: event.error, activeRuns: state.activeRuns };
      return state;

    case "running":
      if (event.type === "RUN_FINISHED")
        return state.activeRuns <= 1
          ? { phase: "idle", startupCleanupDone: true }
          : { phase: "running", activeRuns: Math.max(0, state.activeRuns - 1) };
      if (event.type === "RUN_STARTED") {
        state.activeRuns += 1;
        return state;
      }
      if (event.type === "POLL_START")
        return { phase: "polling", startupCleanupDone: true, activeRuns: state.activeRuns };
      return state;

    case "stopping":
      if (event.type === "RUN_FINISHED") {
        state.activeRuns = Math.max(0, state.activeRuns - 1);
        return state;
      }
      return state;

    case "error":
      if (event.type === "POLL_START")
        return { phase: "polling", startupCleanupDone: true, activeRuns: state.activeRuns };
      if (event.type === "RUN_FINISHED") {
        state.activeRuns = Math.max(0, state.activeRuns - 1);
        return state;
      }
      return state;
  }
}

/**
 * Initial state for the runtime state machine.
 */
export function initialRuntimePhase(): RuntimePhase {
  return { phase: "idle", startupCleanupDone: false };
}
