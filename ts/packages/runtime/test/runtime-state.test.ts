import { test } from "vitest";

import { assert } from "../../../test/assert.js";

import {
  type RuntimePhase,
  transitionRuntime,
  deriveAppStatus,
  initialRuntimePhase,
  isStopRequested,
  isStopped,
} from "@symphony/runtime";

test("initialRuntimePhase starts in idle with startupCleanupDone=false", () => {
  const state = initialRuntimePhase();
  assert.deepEqual(state, { phase: "idle", startupCleanupDone: false });
});

test("deriveAppStatus maps each phase to the correct RuntimeAppStatus", () => {
  assert.equal(deriveAppStatus({ phase: "idle", startupCleanupDone: false }), "idle");
  assert.equal(deriveAppStatus({ phase: "idle", startupCleanupDone: true }), "idle");
  assert.equal(
    deriveAppStatus({ phase: "polling", startupCleanupDone: true, activeRuns: 0 }),
    "polling",
  );
  assert.equal(
    deriveAppStatus({ phase: "polling", startupCleanupDone: true, activeRuns: 1 }),
    "running",
  );
  assert.equal(deriveAppStatus({ phase: "running", activeRuns: 1 }), "running");
  assert.equal(deriveAppStatus({ phase: "stopping", activeRuns: 0 }), "stopping");
  assert.equal(deriveAppStatus({ phase: "error", lastError: "boom", activeRuns: 0 }), "error");
});

// --- idle phase transitions ---

test("idle + POLL_START -> polling (preserves startupCleanupDone)", () => {
  const state: RuntimePhase = { phase: "idle", startupCleanupDone: false };
  const next = transitionRuntime(state, { type: "POLL_START" });
  assert.deepEqual(next, { phase: "polling", startupCleanupDone: false, activeRuns: 0 });
});

test("idle + POLL_START after cleanup -> polling with startupCleanupDone=true", () => {
  const state: RuntimePhase = { phase: "idle", startupCleanupDone: true };
  const next = transitionRuntime(state, { type: "POLL_START" });
  assert.deepEqual(next, { phase: "polling", startupCleanupDone: true, activeRuns: 0 });
});

test("idle + STOP_REQUESTED -> stopping", () => {
  const state: RuntimePhase = { phase: "idle", startupCleanupDone: false };
  const next = transitionRuntime(state, { type: "STOP_REQUESTED" });
  assert.deepEqual(next, { phase: "stopping", activeRuns: 0 });
});

test("idle + RUN_STARTED is a no-op (cannot start run outside polling)", () => {
  const state: RuntimePhase = { phase: "idle", startupCleanupDone: true };
  const next = transitionRuntime(state, { type: "RUN_STARTED" });
  assert.equal(next, state);
  assert.deepEqual(next, { phase: "idle", startupCleanupDone: true });
});

test("idle + irrelevant events are no-ops", () => {
  const state: RuntimePhase = { phase: "idle", startupCleanupDone: true };
  assert.equal(transitionRuntime(state, { type: "POLL_SUCCESS" }), state);
  assert.equal(transitionRuntime(state, { type: "RUN_STARTED" }), state);
  assert.equal(transitionRuntime(state, { type: "RUN_FINISHED" }), state);
  assert.equal(transitionRuntime(state, { type: "STARTUP_CLEANUP_DONE" }), state);
  assert.equal(transitionRuntime(state, { type: "POLL_ERROR", error: "x" }), state);
});

// --- polling phase transitions ---

test("polling + RUN_STARTED increments activeRuns", () => {
  const state: RuntimePhase = { phase: "polling", startupCleanupDone: true, activeRuns: 0 };
  const next = transitionRuntime(state, { type: "RUN_STARTED" });
  assert.deepEqual(next, { phase: "polling", startupCleanupDone: true, activeRuns: 1 });
});

test("polling + RUN_FINISHED decrements activeRuns (clamped at 0)", () => {
  const state: RuntimePhase = { phase: "polling", startupCleanupDone: true, activeRuns: 2 };
  const next = transitionRuntime(state, { type: "RUN_FINISHED" });
  assert.deepEqual(next, { phase: "polling", startupCleanupDone: true, activeRuns: 1 });

  const zero: RuntimePhase = { phase: "polling", startupCleanupDone: true, activeRuns: 0 };
  const clamped = transitionRuntime(zero, { type: "RUN_FINISHED" });
  assert.deepEqual(clamped, { phase: "polling", startupCleanupDone: true, activeRuns: 0 });
});

test("polling + STARTUP_CLEANUP_DONE sets flag", () => {
  const state: RuntimePhase = { phase: "polling", startupCleanupDone: false, activeRuns: 0 };
  const next = transitionRuntime(state, { type: "STARTUP_CLEANUP_DONE" });
  assert.deepEqual(next, { phase: "polling", startupCleanupDone: true, activeRuns: 0 });
});

test("polling + POLL_SUCCESS with no active runs -> idle", () => {
  const state: RuntimePhase = { phase: "polling", startupCleanupDone: true, activeRuns: 0 };
  const next = transitionRuntime(state, { type: "POLL_SUCCESS" });
  assert.deepEqual(next, { phase: "idle", startupCleanupDone: true });
});

test("polling + POLL_SUCCESS with active runs -> running", () => {
  const state: RuntimePhase = { phase: "polling", startupCleanupDone: true, activeRuns: 2 };
  const next = transitionRuntime(state, { type: "POLL_SUCCESS" });
  assert.deepEqual(next, { phase: "running", activeRuns: 2 });
});

test("polling + POLL_ERROR -> error (preserves activeRuns)", () => {
  const state: RuntimePhase = { phase: "polling", startupCleanupDone: true, activeRuns: 1 };
  const next = transitionRuntime(state, { type: "POLL_ERROR", error: "timeout" });
  assert.deepEqual(next, { phase: "error", lastError: "timeout", activeRuns: 1 });
});

test("polling + STOP_REQUESTED -> stopping (preserves activeRuns)", () => {
  const state: RuntimePhase = { phase: "polling", startupCleanupDone: true, activeRuns: 3 };
  const next = transitionRuntime(state, { type: "STOP_REQUESTED" });
  assert.deepEqual(next, { phase: "stopping", activeRuns: 3 });
});

// --- running phase transitions ---

test("running + RUN_FINISHED with 1 active run -> idle", () => {
  const state: RuntimePhase = { phase: "running", activeRuns: 1 };
  const next = transitionRuntime(state, { type: "RUN_FINISHED" });
  assert.deepEqual(next, { phase: "idle", startupCleanupDone: true });
});

test("running + RUN_FINISHED with multiple runs -> running (decremented)", () => {
  const state: RuntimePhase = { phase: "running", activeRuns: 3 };
  const next = transitionRuntime(state, { type: "RUN_FINISHED" });
  assert.deepEqual(next, { phase: "running", activeRuns: 2 });
});

test("running + RUN_STARTED -> running (incremented)", () => {
  const state: RuntimePhase = { phase: "running", activeRuns: 1 };
  const next = transitionRuntime(state, { type: "RUN_STARTED" });
  assert.deepEqual(next, { phase: "running", activeRuns: 2 });
});

test("running + POLL_START -> polling (preserves activeRuns)", () => {
  const state: RuntimePhase = { phase: "running", activeRuns: 2 };
  const next = transitionRuntime(state, { type: "POLL_START" });
  assert.deepEqual(next, { phase: "polling", startupCleanupDone: true, activeRuns: 2 });
});

test("running + STOP_REQUESTED -> stopping", () => {
  const state: RuntimePhase = { phase: "running", activeRuns: 2 };
  const next = transitionRuntime(state, { type: "STOP_REQUESTED" });
  assert.deepEqual(next, { phase: "stopping", activeRuns: 2 });
});

test("running + POLL_ERROR is a no-op (errors only captured during polling phase)", () => {
  const state: RuntimePhase = { phase: "running", activeRuns: 2 };
  const next = transitionRuntime(state, { type: "POLL_ERROR", error: "timeout" });
  assert.equal(next, state);
  assert.deepEqual(next, { phase: "running", activeRuns: 2 });
});

test("running + irrelevant events are no-ops", () => {
  const state: RuntimePhase = { phase: "running", activeRuns: 1 };
  assert.equal(transitionRuntime(state, { type: "POLL_SUCCESS" }), state);
  assert.equal(transitionRuntime(state, { type: "POLL_ERROR", error: "x" }), state);
  assert.equal(transitionRuntime(state, { type: "STARTUP_CLEANUP_DONE" }), state);
});

// --- stopping phase transitions ---

test("stopping + RUN_FINISHED decrements activeRuns", () => {
  const state: RuntimePhase = { phase: "stopping", activeRuns: 2 };
  const next = transitionRuntime(state, { type: "RUN_FINISHED" });
  assert.deepEqual(next, { phase: "stopping", activeRuns: 1 });
});

test("stopping + RUN_FINISHED with activeRuns=0 clamps to 0 (defensive guard)", () => {
  const state: RuntimePhase = { phase: "stopping", activeRuns: 0 };
  const next = transitionRuntime(state, { type: "RUN_FINISHED" });
  assert.deepEqual(next, { phase: "stopping", activeRuns: 0 });
});

test("stopping absorbs most events", () => {
  const state: RuntimePhase = { phase: "stopping", activeRuns: 1 };
  assert.equal(transitionRuntime(state, { type: "POLL_START" }), state);
  assert.equal(transitionRuntime(state, { type: "POLL_SUCCESS" }), state);
  assert.equal(transitionRuntime(state, { type: "RUN_STARTED" }), state);
  assert.equal(transitionRuntime(state, { type: "STARTUP_CLEANUP_DONE" }), state);
  assert.equal(transitionRuntime(state, { type: "STOP_REQUESTED" }), state);
});

// --- error phase transitions ---

test("error + POLL_START -> polling (allows recovery)", () => {
  const state: RuntimePhase = { phase: "error", lastError: "timeout", activeRuns: 0 };
  const next = transitionRuntime(state, { type: "POLL_START" });
  assert.deepEqual(next, { phase: "polling", startupCleanupDone: true, activeRuns: 0 });
});

test("error + RUN_FINISHED decrements activeRuns", () => {
  const state: RuntimePhase = { phase: "error", lastError: "x", activeRuns: 2 };
  const next = transitionRuntime(state, { type: "RUN_FINISHED" });
  assert.deepEqual(next, { phase: "error", lastError: "x", activeRuns: 1 });
});

test("error + STOP_REQUESTED -> stopping", () => {
  const state: RuntimePhase = { phase: "error", lastError: "x", activeRuns: 1 };
  const next = transitionRuntime(state, { type: "STOP_REQUESTED" });
  assert.deepEqual(next, { phase: "stopping", activeRuns: 1 });
});

test("error absorbs irrelevant events", () => {
  const state: RuntimePhase = { phase: "error", lastError: "x", activeRuns: 0 };
  assert.equal(transitionRuntime(state, { type: "POLL_SUCCESS" }), state);
  assert.equal(transitionRuntime(state, { type: "RUN_STARTED" }), state);
  assert.equal(transitionRuntime(state, { type: "STARTUP_CLEANUP_DONE" }), state);
});

// --- isStopRequested / isStopped ---

test("isStopRequested returns true only for stopping phase", () => {
  assert.equal(isStopRequested({ phase: "idle", startupCleanupDone: false }), false);
  assert.equal(
    isStopRequested({ phase: "polling", startupCleanupDone: true, activeRuns: 0 }),
    false,
  );
  assert.equal(isStopRequested({ phase: "running", activeRuns: 1 }), false);
  assert.equal(isStopRequested({ phase: "stopping", activeRuns: 0 }), true);
  assert.equal(isStopRequested({ phase: "stopping", activeRuns: 3 }), true);
  assert.equal(isStopRequested({ phase: "error", lastError: "x", activeRuns: 0 }), false);
});

test("isStopped is an alias for isStopRequested", () => {
  assert.equal(isStopped, isStopRequested);
});
