import { test } from "vitest";
import type { Issue } from "@lorenz/domain";
import { assert, issueWith, settingsWith } from "@lorenz/test-utils";

import { reconciliationStopReason } from "@lorenz/runtime";

function trackedIssue(overrides: Partial<Issue> = {}): Issue {
  return issueWith({
    state: "In Progress",
    stateType: "started",
    ...overrides,
  });
}

test('terminal issue returns "terminal"', () => {
  const issue = trackedIssue({ state: "Done", stateType: "completed" });
  assert.equal(reconciliationStopReason(issue, settingsWith()), "terminal");
});

test('unrouted issue returns "unrouted"', () => {
  const issue = trackedIssue({ assignedToWorker: false });
  assert.equal(reconciliationStopReason(issue, settingsWith()), "unrouted");
});

test('blocked issue returns "blocked"', () => {
  const issue = trackedIssue({
    state: "Todo",
    stateType: "unstarted",
    blockers: [{ id: "blocker-1", identifier: "ENG-2", state: "In Progress" }],
  });
  assert.equal(reconciliationStopReason(issue, settingsWith()), "blocked");
});

test('started issue with open blockers returns "inactive"', () => {
  const issue = trackedIssue({
    blockers: [{ id: "blocker-1", identifier: "ENG-2", state: "Todo" }],
  });
  assert.equal(reconciliationStopReason(issue, settingsWith()), "inactive");
});

test('active, routed, unblocked issue returns "inactive"', () => {
  assert.equal(reconciliationStopReason(trackedIssue(), settingsWith()), "inactive");
});

test("terminal takes priority over unrouted", () => {
  const issue = trackedIssue({
    state: "Done",
    stateType: "completed",
    assignedToWorker: false,
  });
  assert.equal(reconciliationStopReason(issue, settingsWith()), "terminal");
});

test("terminal takes priority over unrouted and blocked", () => {
  const issue = trackedIssue({
    state: "Done",
    stateType: "unstarted",
    assignedToWorker: false,
    blockers: [{ id: "blocker-1", identifier: "ENG-2", state: "In Progress" }],
  });
  assert.equal(reconciliationStopReason(issue, settingsWith()), "terminal");
});

test("unrouted takes priority over blocked", () => {
  const issue = trackedIssue({
    state: "Todo",
    stateType: "unstarted",
    assignedToWorker: false,
    blockers: [{ id: "blocker-1", identifier: "ENG-2", state: "In Progress" }],
  });
  assert.equal(reconciliationStopReason(issue, settingsWith()), "unrouted");
});

test('state outside activeStates returns "terminal"', () => {
  const issue = trackedIssue({ state: "Backlog", stateType: "backlog" });
  assert.equal(reconciliationStopReason(issue, settingsWith()), "terminal");
});

test('route label mismatch returns "unrouted"', () => {
  const issue = trackedIssue({ labels: ["lorenz:backend"] });
  assert.equal(
    reconciliationStopReason(issue, settingsWith({ onlyRoutes: ["frontend"] })),
    "unrouted",
  );
});

test('terminal blockers return "inactive"', () => {
  const issue = trackedIssue({
    state: "Todo",
    stateType: "unstarted",
    blockers: [{ id: "blocker-1", identifier: "ENG-2", state: "Done" }],
  });
  assert.equal(reconciliationStopReason(issue, settingsWith()), "inactive");
});

test("completed issue with open blockers returns terminal", () => {
  const issue = trackedIssue({
    state: "Done",
    stateType: "completed",
    blockers: [{ id: "blocker-1", identifier: "ENG-2", state: "In Progress" }],
  });
  assert.equal(reconciliationStopReason(issue, settingsWith()), "terminal");
});

test("cancelled issue with open blockers returns terminal", () => {
  const issue = trackedIssue({
    state: "Cancelled",
    stateType: "completed",
    blockers: [
      { id: "blocker-1", identifier: "ENG-2", state: "Todo" },
      { id: "blocker-2", identifier: "ENG-3", state: "In Progress" },
    ],
  });
  assert.equal(reconciliationStopReason(issue, settingsWith()), "terminal");
});

test('started issue with multiple open blockers returns "inactive"', () => {
  const issue = trackedIssue({
    blockers: [
      { id: "blocker-1", identifier: "ENG-2", state: "Todo" },
      { id: "blocker-2", identifier: "ENG-3", state: "In Progress" },
    ],
  });
  assert.equal(reconciliationStopReason(issue, settingsWith()), "inactive");
});
