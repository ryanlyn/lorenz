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
      labels: [],
      blockers: [],
    } as Issue,
    workspacePath: "/tmp/ws",
    workerHost: undefined,
  };
  assert.equal(resumeIdentityMatches(stored, current), true);
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
      labels: [],
      blockers: [],
    } as Issue,
    workspacePath: "/tmp/ws",
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
  } = {},
): Settings {
  return {
    tracker: {
      activeStates: overrides.activeStates ?? ["In Progress", "Todo"],
      terminalStates: overrides.terminalStates ?? ["Done", "Cancelled"],
      dispatch: {
        acceptUnrouted: overrides.acceptUnrouted ?? true,
        onlyRoutes: null,
        routeLabelPrefix: "Symphony:",
      },
      endpoint: "",
    },
  } as unknown as Settings;
}

test('reconciliationStopReason — terminal issue returns "terminal"', () => {
  const issue = makeIssue({ state: "Done" });
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
