import { test } from "vitest";
import {
  actionForStopReason,
  resumeIdentityMatches,
  reconciliationStopReason,
} from "@symphony/cli";
import type { Issue, Settings } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

// --- actionForStopReason ---

test("actionForStopReason — all known stop reasons produce defined actions", () => {
  const known: Array<[string, string]> = [
    ["end_turn", "continue"],
    ["max_tokens", "continue"],
    ["max_turn_requests", "continue"],
    ["cancelled", "cancel"],
    ["refusal", "retry"],
  ];
  for (const [reason, expected] of known) {
    assert.equal(actionForStopReason(reason as never), expected);
  }
});

test('actionForStopReason — unknown/unexpected string returns "retry"', () => {
  assert.equal(actionForStopReason("something_unknown" as never), "retry");
  assert.equal(actionForStopReason("" as never), "retry");
});

// "refusal" is not handled by an explicit branch in the implementation;
// it falls through to the default "retry" return. This test confirms that
// "refusal" and an arbitrary unknown reason both follow the same default path.
test('actionForStopReason — "refusal" intentionally falls through to default "retry" path', () => {
  const refusalResult = actionForStopReason("refusal" as never);
  const unknownResult = actionForStopReason("totally_made_up" as never);
  assert.equal(refusalResult, "retry");
  assert.equal(unknownResult, "retry");
  // Both produce "retry" via the same default fallthrough
  assert.equal(refusalResult, unknownResult);
});

// --- resumeIdentityMatches ---

test("resumeIdentityMatches — null workerHost matches undefined", () => {
  const stored = {
    agent: "claude",
    issueId: "issue-1",
    workspacePath: "/tmp/ws",
    workerHost: null,
  };
  const current = {
    agent: "claude",
    issue: {
      id: "issue-1",
      identifier: "ENG-1",
      title: "t",
      state: "In Progress",
      stateType: "started",
      labels: [],
      blockers: [],
    } as Issue,
    workspacePath: "/tmp/ws",
    workerHost: undefined,
  };
  assert.equal(resumeIdentityMatches(stored, current), true);
});

test("resumeIdentityMatches — all fields match with non-null workerHost returns true", () => {
  const stored = {
    agent: "claude",
    issueId: "issue-1",
    workspacePath: "/tmp/ws",
    workerHost: "host-a",
  };
  const current = {
    agent: "claude",
    issue: {
      id: "issue-1",
      identifier: "ENG-1",
      title: "t",
      state: "In Progress",
      stateType: "started",
      labels: [],
      blockers: [],
    } as Issue,
    workspacePath: "/tmp/ws",
    workerHost: "host-a",
  };
  assert.equal(resumeIdentityMatches(stored, current), true);
});

test("resumeIdentityMatches — mismatched issueId returns false", () => {
  const stored = {
    agent: "claude",
    issueId: "issue-1",
    workspacePath: "/tmp/ws",
    workerHost: null,
  };
  const current = {
    agent: "claude",
    issue: {
      id: "issue-2",
      identifier: "ENG-2",
      title: "t",
      state: "In Progress",
      stateType: "started",
      labels: [],
      blockers: [],
    } as Issue,
    workspacePath: "/tmp/ws",
    workerHost: undefined,
  };
  assert.equal(resumeIdentityMatches(stored, current), false);
});

test("resumeIdentityMatches — stored workerHost string with current workerHost undefined returns false", () => {
  // This verifies the null coalescing logic: (stored.workerHost ?? null) yields "host-a",
  // while (current.workerHost ?? null) yields null, so they do not match.
  const stored = {
    agent: "claude",
    issueId: "issue-1",
    workspacePath: "/tmp/ws",
    workerHost: "host-a",
  };
  const current = {
    agent: "claude",
    issue: {
      id: "issue-1",
      identifier: "ENG-1",
      title: "t",
      state: "In Progress",
      stateType: "started",
      labels: [],
      blockers: [],
    } as Issue,
    workspacePath: "/tmp/ws",
    workerHost: undefined,
  };
  assert.equal(resumeIdentityMatches(stored, current), false);
});

test("resumeIdentityMatches — mismatched workspace path returns false", () => {
  const stored = { agent: "claude", issueId: "issue-1", workspacePath: "/tmp/ws-a" };
  const current = {
    agent: "claude",
    issue: {
      id: "issue-1",
      identifier: "ENG-1",
      title: "t",
      state: "In Progress",
      stateType: "started",
      labels: [],
      blockers: [],
    } as Issue,
    workspacePath: "/tmp/ws-b",
  };
  assert.equal(resumeIdentityMatches(stored, current), false);
});

test("resumeIdentityMatches — empty string agent always returns false", () => {
  const stored = { agent: "", issueId: "issue-1", workspacePath: "/tmp/ws" };
  const current = {
    agent: "claude",
    issue: {
      id: "issue-1",
      identifier: "ENG-1",
      title: "t",
      state: "In Progress",
      stateType: "started",
      labels: [],
      blockers: [],
    } as Issue,
    workspacePath: "/tmp/ws",
  };
  assert.equal(resumeIdentityMatches(stored, current), false);
});

test("resumeIdentityMatches — mismatched workerHost strings returns false", () => {
  const stored = {
    agent: "claude",
    issueId: "issue-1",
    workspacePath: "/tmp/ws",
    workerHost: "host-a",
  };
  const current = {
    agent: "claude",
    issue: {
      id: "issue-1",
      identifier: "ENG-1",
      title: "t",
      state: "In Progress",
      stateType: "started",
      labels: [],
      blockers: [],
    } as Issue,
    workspacePath: "/tmp/ws",
    workerHost: "host-b",
  };
  assert.equal(resumeIdentityMatches(stored, current), false);
});

// --- reconciliationStopReason ---

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Test issue",
    state: "In Progress",
    stateType: "started",
    labels: [],
    blockers: [],
    assignedToWorker: true,
    ...overrides,
  };
}

function makeSettings(
  overrides: {
    activeStates?: string[];
    terminalStates?: string[];
    acceptUnrouted?: boolean;
    onlyRoutes?: string[] | null;
  } = {},
): Settings {
  return {
    tracker: {
      activeStates: overrides.activeStates ?? ["In Progress", "Todo"],
      terminalStates: overrides.terminalStates ?? ["Done", "Cancelled"],
      dispatch: {
        acceptUnrouted: overrides.acceptUnrouted ?? true,
        onlyRoutes: overrides.onlyRoutes !== undefined ? overrides.onlyRoutes : null,
        routeLabelPrefix: "Symphony:",
      },
      endpoint: "",
    },
  } as unknown as Settings;
}

test('reconciliationStopReason — terminal issue returns "terminal"', () => {
  const issue = makeIssue({ state: "Done", stateType: "completed" });
  const settings = makeSettings();
  assert.equal(reconciliationStopReason(issue, settings), "terminal");
});

test('reconciliationStopReason — unrouted issue returns "unrouted"', () => {
  const issue = makeIssue({ assignedToWorker: false });
  const settings = makeSettings();
  assert.equal(reconciliationStopReason(issue, settings), "unrouted");
});

test('reconciliationStopReason — blocked issue returns "blocked"', () => {
  const issue = makeIssue({
    state: "Todo",
    stateType: "unstarted",
    stateType: "unstarted",
    blockers: [{ id: "blocker-1", identifier: "ENG-2", state: "In Progress" }],
  });
  const settings = makeSettings();
  assert.equal(reconciliationStopReason(issue, settings), "blocked");
});

test('reconciliationStopReason — active, routed, unblocked issue returns "inactive"', () => {
  const issue = makeIssue({ state: "In Progress" });
  const settings = makeSettings();
  assert.equal(reconciliationStopReason(issue, settings), "inactive");
});

// Priority/precedence tests: when multiple stop conditions are true simultaneously,
// the function should return the highest-priority reason.
// Priority order: terminal > unrouted > blocked > inactive

test('reconciliationStopReason — terminal + unrouted: "terminal" takes priority over "unrouted"', () => {
  // Issue is in a terminal state AND is not assigned to this worker.
  // "terminal" should win because it is checked first.
  const issue = makeIssue({ state: "Done", stateType: "completed", assignedToWorker: false });
  const settings = makeSettings();
  assert.equal(reconciliationStopReason(issue, settings), "terminal");
});

test('reconciliationStopReason — terminal + unrouted + blocked: "terminal" takes priority over all', () => {
  // Issue is terminal, unrouted, and has blockers (if it were in an unstarted state).
  // Since "Done" is terminal, that check fires first regardless of other conditions.
  const issue = makeIssue({
    state: "Done",
    stateType: "completed",
    assignedToWorker: false,
    blockers: [{ id: "blocker-1", identifier: "ENG-2", state: "In Progress" }],
  });
  const settings = makeSettings();
  assert.equal(reconciliationStopReason(issue, settings), "terminal");
});

test('reconciliationStopReason — unrouted + blocked: "unrouted" takes priority over "blocked"', () => {
  // Issue is active (Todo is in activeStates), unrouted (assignedToWorker=false),
  // and would be blocked (unstarted state with open blocker). "unrouted" should win.
  const issue = makeIssue({
    state: "Todo",
    stateType: "unstarted",
    assignedToWorker: false,
    blockers: [{ id: "blocker-1", identifier: "ENG-2", state: "In Progress" }],
  });
  const settings = makeSettings();
  assert.equal(reconciliationStopReason(issue, settings), "unrouted");
});

test('reconciliationStopReason — state not in activeStates returns "terminal"', () => {
  // "Backlog" is not in activeStates ["In Progress", "Todo"] and not in terminalStates
  // ["Done", "Cancelled"]. issueIsActive requires state to be in activeStates, so this
  // returns false and the function returns "terminal".
  const issue = makeIssue({ state: "Backlog", stateType: "backlog" });
  const settings = makeSettings();
  assert.equal(reconciliationStopReason(issue, settings), "terminal");
});

test('reconciliationStopReason — unrouted via route label mismatch returns "unrouted"', () => {
  // Issue has a Symphony: route label but dispatch has onlyRoutes set to different routes,
  // so routedToThisWorker returns false.
  const issue = makeIssue({
    state: "In Progress",
    stateType: "started",
    labels: ["symphony:backend"],
  });
  const settings = makeSettings({ onlyRoutes: ["frontend"] });
  assert.equal(reconciliationStopReason(issue, settings), "unrouted");
});

test("reconciliationStopReason — blocked only fires for unstarted/todo state issues", () => {
  // Issue is "In Progress" (started state) with blockers - issueHasOpenBlockers requires
  // stateType "unstarted" or state "todo", so this should NOT return "blocked".
  const issue = makeIssue({
    state: "In Progress",
    stateType: "started",
    blockers: [{ id: "blocker-1", identifier: "ENG-2", state: "In Progress" }],
  });
  const settings = makeSettings();
  assert.equal(reconciliationStopReason(issue, settings), "inactive");
});

test('reconciliationStopReason — blocked with all blockers in terminal state returns "inactive"', () => {
  // Issue is in "Todo" (unstarted) state but all blockers are in a terminal state,
  // so issueHasOpenBlockers returns false and the issue falls through to "inactive".
  const issue = makeIssue({
    state: "Todo",
    stateType: "unstarted",
    blockers: [{ id: "blocker-1", identifier: "ENG-2", state: "Done" }],
  });
  const settings = makeSettings();
  assert.equal(reconciliationStopReason(issue, settings), "inactive");
});
