import { test } from "vitest";
import {
  retryBackoffMs,
  mergeMonotonicUsage,
  selectLeastLoadedHost,
  actionForStopReason,
  resumeIdentityMatches,
  reconciliationStopReason,
} from "@symphony/cli";
import type { Issue, Settings } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

test("retryBackoffMs — attempt 0 returns base (10s)", () => {
  assert.equal(retryBackoffMs(0, 60_000, "failure"), 10_000);
});

test("retryBackoffMs — negative attempt clamps to base", () => {
  assert.equal(retryBackoffMs(-1, 60_000, "failure"), 10_000);
});

test("retryBackoffMs — max backoff caps exponential growth", () => {
  assert.equal(retryBackoffMs(10, 60_000, "failure"), 60_000);
  assert.equal(retryBackoffMs(20, 60_000, "failure"), 60_000);
});

test("retryBackoffMs — continuation always returns 1s regardless of attempt number", () => {
  assert.equal(retryBackoffMs(0, 60_000, "continuation"), 1_000);
  assert.equal(retryBackoffMs(5, 60_000, "continuation"), 1_000);
  assert.equal(retryBackoffMs(100, 60_000, "continuation"), 1_000);
});

// --- mergeMonotonicUsage ---

test("mergeMonotonicUsage — all-zero inputs remain zero", () => {
  const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 };
  const result = mergeMonotonicUsage({
    entryTotals: zero,
    reportedTotals: zero,
    globalTotals: zero,
    update: {},
  });
  assert.deepEqual(result.entryTotals, zero);
  assert.deepEqual(result.reportedTotals, zero);
  assert.deepEqual(result.globalTotals, zero);
});

test("mergeMonotonicUsage — update with only partial fields preserves others", () => {
  const entry = { inputTokens: 10, outputTokens: 5, totalTokens: 15, secondsRunning: 3 };
  const result = mergeMonotonicUsage({
    entryTotals: entry,
    reportedTotals: entry,
    globalTotals: { inputTokens: 100, outputTokens: 50, totalTokens: 150, secondsRunning: 30 },
    update: { inputTokens: 20 },
  });
  assert.equal(result.entryTotals.inputTokens, 20);
  assert.equal(result.entryTotals.outputTokens, 5);
  assert.equal(result.entryTotals.totalTokens, 15);
  assert.equal(result.entryTotals.secondsRunning, 3);
});

test("mergeMonotonicUsage — negative update values are clamped to entry totals", () => {
  const entry = { inputTokens: 10, outputTokens: 5, totalTokens: 15, secondsRunning: 0 };
  const result = mergeMonotonicUsage({
    entryTotals: entry,
    reportedTotals: entry,
    globalTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    update: { inputTokens: -50, outputTokens: -10, totalTokens: -100 },
  });
  assert.equal(result.entryTotals.inputTokens, 10);
  assert.equal(result.entryTotals.outputTokens, 5);
  assert.equal(result.entryTotals.totalTokens, 15);
});

test("mergeMonotonicUsage — global delta accumulates across multiple merge calls", () => {
  const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 };
  const first = mergeMonotonicUsage({
    entryTotals: zero,
    reportedTotals: zero,
    globalTotals: zero,
    update: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  });
  assert.equal(first.globalTotals.inputTokens, 10);

  const second = mergeMonotonicUsage({
    entryTotals: first.entryTotals,
    reportedTotals: first.reportedTotals,
    globalTotals: first.globalTotals,
    update: { inputTokens: 25, outputTokens: 10, totalTokens: 35 },
  });
  assert.equal(second.globalTotals.inputTokens, 25);
  assert.equal(second.globalTotals.outputTokens, 10);
  assert.equal(second.globalTotals.totalTokens, 35);
});

// --- selectLeastLoadedHost ---

test("selectLeastLoadedHost — empty hosts returns null", () => {
  const result = selectLeastLoadedHost({ hosts: [], runningCounts: new Map(), cap: 5 });
  assert.equal(result, null);
});

test("selectLeastLoadedHost — single host at capacity returns undefined", () => {
  const result = selectLeastLoadedHost({
    hosts: ["host-a"],
    runningCounts: new Map([["host-a", 3]]),
    cap: 3,
  });
  assert.equal(result, undefined);
});

test("selectLeastLoadedHost — all hosts at capacity returns undefined", () => {
  const result = selectLeastLoadedHost({
    hosts: ["host-a", "host-b"],
    runningCounts: new Map([
      ["host-a", 5],
      ["host-b", 5],
    ]),
    cap: 5,
  });
  assert.equal(result, undefined);
});

test("selectLeastLoadedHost — selects host with lowest running count", () => {
  const result = selectLeastLoadedHost({
    hosts: ["host-a", "host-b", "host-c"],
    runningCounts: new Map([
      ["host-a", 3],
      ["host-b", 1],
      ["host-c", 2],
    ]),
    cap: 5,
  });
  assert.equal(result, "host-b");
});

test("selectLeastLoadedHost — tie-breaks by iteration order (first found)", () => {
  const result = selectLeastLoadedHost({
    hosts: ["host-a", "host-b", "host-c"],
    runningCounts: new Map([
      ["host-a", 2],
      ["host-b", 2],
      ["host-c", 2],
    ]),
    cap: 5,
  });
  assert.equal(result, "host-a");
});

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

test("actionForStopReason — unknown/unexpected string returns \"retry\"", () => {
  assert.equal(actionForStopReason("something_unknown" as never), "retry");
  assert.equal(actionForStopReason("" as never), "retry");
});

// --- resumeIdentityMatches ---

test("resumeIdentityMatches — null workerHost matches undefined", () => {
  const stored = { agent: "claude", issueId: "issue-1", workspacePath: "/tmp/ws", workerHost: null };
  const current = {
    agent: "claude",
    issue: { id: "issue-1", identifier: "ENG-1", title: "t", state: "In Progress", labels: [], blockers: [] } as Issue,
    workspacePath: "/tmp/ws",
    workerHost: undefined,
  };
  assert.equal(resumeIdentityMatches(stored, current), true);
});

test("resumeIdentityMatches — mismatched workspace path returns false", () => {
  const stored = { agent: "claude", issueId: "issue-1", workspacePath: "/tmp/ws-a" };
  const current = {
    agent: "claude",
    issue: { id: "issue-1", identifier: "ENG-1", title: "t", state: "In Progress", labels: [], blockers: [] } as Issue,
    workspacePath: "/tmp/ws-b",
  };
  assert.equal(resumeIdentityMatches(stored, current), false);
});

test("resumeIdentityMatches — empty string agent always returns false", () => {
  const stored = { agent: "", issueId: "issue-1", workspacePath: "/tmp/ws" };
  const current = {
    agent: "claude",
    issue: { id: "issue-1", identifier: "ENG-1", title: "t", state: "In Progress", labels: [], blockers: [] } as Issue,
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

function makeSettings(overrides: {
  activeStates?: string[];
  terminalStates?: string[];
  acceptUnrouted?: boolean;
} = {}): Settings {
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

test("reconciliationStopReason — terminal issue returns \"terminal\"", () => {
  const issue = makeIssue({ state: "Done" });
  const settings = makeSettings();
  assert.equal(reconciliationStopReason(issue, settings), "terminal");
});

test("reconciliationStopReason — unrouted issue returns \"unrouted\"", () => {
  const issue = makeIssue({ assignedToWorker: false });
  const settings = makeSettings();
  assert.equal(reconciliationStopReason(issue, settings), "unrouted");
});

test("reconciliationStopReason — blocked issue returns \"blocked\"", () => {
  const issue = makeIssue({
    state: "Todo",
    stateType: "unstarted",
    blockers: [{ id: "blocker-1", identifier: "ENG-2", state: "In Progress" }],
  });
  const settings = makeSettings();
  assert.equal(reconciliationStopReason(issue, settings), "blocked");
});

test("reconciliationStopReason — active, routed, unblocked issue returns \"inactive\"", () => {
  const issue = makeIssue({ state: "In Progress" });
  const settings = makeSettings();
  assert.equal(reconciliationStopReason(issue, settings), "inactive");
});
