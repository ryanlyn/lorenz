import { describe, test } from "vitest";
import {
  firstUnclaimedSlot,
  issueHasOpenBlockers,
  normalizeIssue,
  parseConfig,
  routedToThisWorker,
  shouldDispatchIssue,
  slotKey,
} from "@symphony/cli";

import { assert } from "../../../test/assert.js";

function makeIssue(overrides: Record<string, unknown> = {}) {
  return normalizeIssue({
    id: "i1",
    identifier: "MT-1",
    title: "Title",
    state: "Todo",
    ...overrides,
  });
}

function makeSettings(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    tracker: { active_states: ["Todo", "In Progress"], terminal_states: ["Done", "Canceled"] },
    ...overrides,
  });
}

describe("shouldDispatchIssue", () => {
  test("missing id returns false", () => {
    const settings = makeSettings();
    const issue = { ...makeIssue(), id: "" };
    assert.equal(shouldDispatchIssue(issue, settings, { runningCount: 0 }), false);
  });

  test("missing identifier returns false", () => {
    const settings = makeSettings();
    const issue = { ...makeIssue(), identifier: "" };
    assert.equal(shouldDispatchIssue(issue, settings, { runningCount: 0 }), false);
  });

  test("missing title returns false", () => {
    const settings = makeSettings();
    const issue = { ...makeIssue(), title: "" };
    assert.equal(shouldDispatchIssue(issue, settings, { runningCount: 0 }), false);
  });

  test("missing state returns false", () => {
    const settings = makeSettings();
    const issue = { ...makeIssue(), state: "" };
    assert.equal(shouldDispatchIssue(issue, settings, { runningCount: 0 }), false);
  });

  test("terminal state returns false", () => {
    const settings = makeSettings();
    const issue = makeIssue({ state: "Done" });
    assert.equal(shouldDispatchIssue(issue, settings, { runningCount: 0 }), false);
  });
});

describe("routedToThisWorker", () => {
  test("issue with assignedToWorker=false returns false", () => {
    const settings = makeSettings();
    const issue = { ...makeIssue(), assignedToWorker: false };
    assert.equal(routedToThisWorker(issue, settings), false);
  });

  test("no route labels + acceptUnrouted=false returns false", () => {
    const settings = makeSettings({
      tracker: {
        active_states: ["Todo"],
        terminal_states: ["Done"],
        dispatch: { accept_unrouted: false },
      },
    });
    const issue = makeIssue();
    assert.equal(routedToThisWorker(issue, settings), false);
  });

  test("onlyRoutes=[] rejects all routed issues", () => {
    const settings = makeSettings({
      tracker: {
        active_states: ["Todo"],
        terminal_states: ["Done"],
        dispatch: { only_routes: [] },
      },
    });
    const issue = makeIssue({ labels: ["Symphony:Backend"] });
    assert.equal(routedToThisWorker(issue, settings), false);
  });
});

describe("issueHasOpenBlockers", () => {
  test("started state never counts as blocked even with blockers", () => {
    const settings = makeSettings();
    const issue = normalizeIssue({
      id: "i1",
      identifier: "MT-1",
      title: "Blocked?",
      state: { name: "In Progress", type: "started" },
      blockers: [{ state: "Todo" }],
    });
    assert.equal(issueHasOpenBlockers(issue, settings), false);
  });

  test("all blockers terminal returns false", () => {
    const settings = makeSettings();
    const issue = normalizeIssue({
      id: "i1",
      identifier: "MT-1",
      title: "Title",
      state: { name: "Todo", type: "unstarted" },
      blockers: [{ state: "Done" }, { state: "Canceled" }],
    });
    assert.equal(issueHasOpenBlockers(issue, settings), false);
  });
});

describe("firstUnclaimedSlot", () => {
  test("preferred slot already claimed falls through to next", () => {
    const settings = makeSettings({ agent: { ensemble_size: 3 } });
    const issue = makeIssue();
    const claimed = new Set([slotKey(issue.id, 1)]);
    assert.equal(firstUnclaimedSlot(issue, settings, claimed, 1), 0);
  });
});
