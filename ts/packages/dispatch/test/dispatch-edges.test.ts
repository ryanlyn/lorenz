import { describe, test } from "vitest";
import {
  dispatchBlockReason,
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
    state: { name: "Todo", type: "unstarted" },
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
    const issue = makeIssue({ state: { name: "Done", type: "completed" } });
    assert.equal(shouldDispatchIssue(issue, settings, { runningCount: 0 }), false);
  });

  test("returns true for valid active issue with unclaimed slots", () => {
    const settings = makeSettings();
    const issue = makeIssue();
    const state = { runningCount: 0, claimedSlots: new Set<string>() };
    assert.equal(shouldDispatchIssue(issue, settings, state), true);
  });

  test("returns false when all ensemble slots are claimed", () => {
    const settings = makeSettings({ agent: { ensemble_size: 2 } });
    const issue = makeIssue();
    const claimed = new Set([slotKey(issue.id, 0), slotKey(issue.id, 1)]);
    const state = { runningCount: 0, claimedSlots: claimed };
    assert.equal(shouldDispatchIssue(issue, settings, state), false);
  });

  test("returns true when some ensemble slots are unclaimed", () => {
    const settings = makeSettings({ agent: { ensemble_size: 3 } });
    const issue = makeIssue();
    const claimed = new Set([slotKey(issue.id, 0), slotKey(issue.id, 1)]);
    const state = { runningCount: 0, claimedSlots: claimed };
    assert.equal(shouldDispatchIssue(issue, settings, state), true);
  });

  test("returns false when global concurrency cap is reached", () => {
    const settings = makeSettings({ agent: { max_concurrent_agents: 2 } });
    const issue = makeIssue();
    const state = { runningCount: 2, claimedSlots: new Set<string>() };
    assert.equal(shouldDispatchIssue(issue, settings, state), false);
  });

  test("returns false when local concurrency cap via runningByState is reached", () => {
    const settings = makeSettings({
      agent: { max_concurrent_agents: 10 },
      status_overrides: { Todo: { agent: { max_concurrent_agents: 1 } } },
    });
    const issue = makeIssue();
    const runningByState = new Map([["todo", 1]]);
    const state = { runningCount: 1, runningByState, claimedSlots: new Set<string>() };
    assert.equal(shouldDispatchIssue(issue, settings, state), false);
  });

  test("returns false when workerCapacityAvailable is false", () => {
    const settings = makeSettings();
    const issue = makeIssue();
    const state = {
      runningCount: 0,
      claimedSlots: new Set<string>(),
      workerCapacityAvailable: false,
    };
    assert.equal(shouldDispatchIssue(issue, settings, state), false);
  });

  test("returns true when workerCapacityAvailable is undefined (no constraint)", () => {
    const settings = makeSettings();
    const issue = makeIssue();
    const state = {
      runningCount: 0,
      claimedSlots: new Set<string>(),
      workerCapacityAvailable: undefined,
    };
    assert.equal(shouldDispatchIssue(issue, settings, state), true);
  });

  test("returns false when issue has open blockers", () => {
    const settings = makeSettings();
    const issue = normalizeIssue({
      id: "i1",
      identifier: "MT-1",
      title: "Title",
      state: { name: "Todo", type: "unstarted" },
      blockers: [{ state: "In Progress" }],
    });
    const state = { runningCount: 0, claimedSlots: new Set<string>() };
    assert.equal(shouldDispatchIssue(issue, settings, state), false);
  });

  test("returns false when issue is not routed to this worker", () => {
    const settings = makeSettings({
      tracker: {
        active_states: ["Todo"],
        terminal_states: ["Done", "Canceled"],
        dispatch: { only_routes: ["frontend"] },
      },
    });
    const issue = makeIssue({ labels: ["Symphony:Backend"] });
    const state = { runningCount: 0, claimedSlots: new Set<string>() };
    assert.equal(shouldDispatchIssue(issue, settings, state), false);
  });

  test("uses ensemble label on issue to determine slot count", () => {
    const settings = makeSettings({ agent: { ensemble_size: 1 } });
    const issue = makeIssue({ labels: ["ensemble:3"] });
    // With ensemble:3 label, there are 3 slots. Claiming only slot 0 leaves 2 unclaimed.
    const claimed = new Set([slotKey(issue.id, 0)]);
    const state = { runningCount: 0, claimedSlots: claimed };
    assert.equal(shouldDispatchIssue(issue, settings, state), true);
    // Claim all 3 slots
    claimed.add(slotKey(issue.id, 1));
    claimed.add(slotKey(issue.id, 2));
    assert.equal(shouldDispatchIssue(issue, settings, state), false);
  });

  test("ignores oversized ensemble labels and uses settings slot count", () => {
    const settings = makeSettings({ agent: { ensemble_size: 1 } });
    const issue = makeIssue({ labels: ["ensemble:101"] });
    const claimed = new Set([slotKey(issue.id, 0)]);
    const state = { runningCount: 0, claimedSlots: claimed };
    assert.equal(shouldDispatchIssue(issue, settings, state), false);
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

  test("returns true when onlyRoutes is null and issue has a route label", () => {
    const settings = makeSettings({
      tracker: {
        active_states: ["Todo"],
        terminal_states: ["Done"],
        dispatch: { only_routes: null },
      },
    });
    const issue = makeIssue({ labels: ["Symphony:Backend"] });
    assert.equal(routedToThisWorker(issue, settings), true);
  });

  test("returns true when issue route matches an entry in onlyRoutes", () => {
    const settings = makeSettings({
      tracker: {
        active_states: ["Todo"],
        terminal_states: ["Done"],
        dispatch: { only_routes: ["backend", "infra"] },
      },
    });
    const issue = makeIssue({ labels: ["Symphony:Backend"] });
    assert.equal(routedToThisWorker(issue, settings), true);
  });

  test("returns false when issue route does not match onlyRoutes", () => {
    const settings = makeSettings({
      tracker: {
        active_states: ["Todo"],
        terminal_states: ["Done"],
        dispatch: { only_routes: ["frontend"] },
      },
    });
    const issue = makeIssue({ labels: ["Symphony:Backend"] });
    assert.equal(routedToThisWorker(issue, settings), false);
  });

  test("returns true when acceptUnrouted=true and issue has no route labels", () => {
    const settings = makeSettings({
      tracker: {
        active_states: ["Todo"],
        terminal_states: ["Done"],
        dispatch: { accept_unrouted: true },
      },
    });
    const issue = makeIssue();
    assert.equal(routedToThisWorker(issue, settings), true);
  });

  test("returns false when issue has route label prefix but empty suffix", () => {
    const settings = makeSettings({
      tracker: {
        active_states: ["Todo"],
        terminal_states: ["Done"],
        dispatch: { accept_unrouted: true, only_routes: null },
      },
    });
    // "Symphony:" is a route label (hasRouteLabel returns true) but routeNames returns []
    // because the suffix is empty after trimming. So this goes into the hasRouteLabel branch
    // and returns false.
    const issue = makeIssue({ labels: ["Symphony:"] });
    assert.equal(routedToThisWorker(issue, settings), false);
  });

  test("route matching is case-insensitive", () => {
    const settings = makeSettings({
      tracker: {
        active_states: ["Todo"],
        terminal_states: ["Done"],
        dispatch: { only_routes: ["BACKEND"] },
      },
    });
    const issue = makeIssue({ labels: ["symphony:backend"] });
    assert.equal(routedToThisWorker(issue, settings), true);
  });
});

describe("issueHasOpenBlockers", () => {
  test("started state with open blockers is not blocked", () => {
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

  test("returns true when unstarted with at least one non-terminal blocker", () => {
    const settings = makeSettings();
    const issue = normalizeIssue({
      id: "i1",
      identifier: "MT-1",
      title: "Title",
      state: { name: "Todo", type: "unstarted" },
      blockers: [{ state: "In Progress" }],
    });
    assert.equal(issueHasOpenBlockers(issue, settings), true);
  });

  test("returns true with mixed terminal and non-terminal blockers", () => {
    const settings = makeSettings();
    const issue = normalizeIssue({
      id: "i1",
      identifier: "MT-1",
      title: "Title",
      state: { name: "Todo", type: "unstarted" },
      blockers: [{ state: "Done" }, { state: "In Progress" }, { state: "Canceled" }],
    });
    assert.equal(issueHasOpenBlockers(issue, settings), true);
  });

  test("returns false with empty blockers array", () => {
    const settings = makeSettings();
    const issue = normalizeIssue({
      id: "i1",
      identifier: "MT-1",
      title: "Title",
      state: { name: "Todo", type: "unstarted" },
      blockers: [],
    });
    assert.equal(issueHasOpenBlockers(issue, settings), false);
  });

  test("normalizeIssue throws when stateType is missing", () => {
    assert.throws(() =>
      normalizeIssue({
        id: "i1",
        identifier: "MT-1",
        title: "Title",
        state: "Todo",
        blockers: [{ state: "Done" }],
      }),
    );
  });

  test("stateType='unstarted' with non-terminal blocker returns true", () => {
    const settings = makeSettings();
    const issue = normalizeIssue({
      id: "i1",
      identifier: "MT-1",
      title: "Title",
      state: { name: "Todo", type: "unstarted" },
      blockers: [{ state: "In Progress" }],
    });
    assert.equal(issueHasOpenBlockers(issue, settings), true);
  });

  test("completed state with open blockers is not blocked", () => {
    const settings = makeSettings();
    const issue = normalizeIssue({
      id: "i1",
      identifier: "MT-1",
      title: "Title",
      state: { name: "Done", type: "completed" },
      blockers: [{ state: "Todo" }],
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

  test("preferred slot unclaimed returns that slot directly", () => {
    const settings = makeSettings({ agent: { ensemble_size: 3 } });
    const issue = makeIssue();
    const claimed = new Set<string>();
    assert.equal(firstUnclaimedSlot(issue, settings, claimed, 2), 2);
  });

  test("all slots claimed returns null", () => {
    const settings = makeSettings({ agent: { ensemble_size: 2 } });
    const issue = makeIssue();
    const claimed = new Set([slotKey(issue.id, 0), slotKey(issue.id, 1)]);
    assert.equal(firstUnclaimedSlot(issue, settings, claimed), null);
  });

  test("no preferred slot returns first unclaimed from index 0", () => {
    const settings = makeSettings({ agent: { ensemble_size: 3 } });
    const issue = makeIssue();
    const claimed = new Set<string>();
    assert.equal(firstUnclaimedSlot(issue, settings, claimed), 0);
  });

  test("no preferred slot with first slot claimed returns next unclaimed", () => {
    const settings = makeSettings({ agent: { ensemble_size: 3 } });
    const issue = makeIssue();
    const claimed = new Set([slotKey(issue.id, 0)]);
    assert.equal(firstUnclaimedSlot(issue, settings, claimed), 1);
  });

  test("preferred slot null returns first unclaimed from index 0", () => {
    const settings = makeSettings({ agent: { ensemble_size: 3 } });
    const issue = makeIssue();
    const claimed = new Set<string>();
    assert.equal(firstUnclaimedSlot(issue, settings, claimed, null), 0);
  });

  test("ensemble label on issue overrides settings ensemble_size", () => {
    const settings = makeSettings({ agent: { ensemble_size: 1 } });
    const issue = makeIssue({ labels: ["ensemble:4"] });
    const claimed = new Set([slotKey(issue.id, 0), slotKey(issue.id, 1), slotKey(issue.id, 2)]);
    // ensemble:4 gives 4 slots, so slot 3 is still unclaimed
    assert.equal(firstUnclaimedSlot(issue, settings, claimed), 3);
  });

  test("oversized ensemble label falls back to settings ensemble_size", () => {
    const settings = makeSettings({ agent: { ensemble_size: 1 } });
    const issue = makeIssue({ labels: ["ensemble:101"] });
    const claimed = new Set([slotKey(issue.id, 0)]);
    assert.equal(firstUnclaimedSlot(issue, settings, claimed), null);
  });

  test("preferred slot out of range falls through to linear scan", () => {
    const settings = makeSettings({ agent: { ensemble_size: 2 } });
    const issue = makeIssue();
    const claimed = new Set<string>();
    // preferredSlotIndex=5 is beyond ensemble size of 2, so it falls through
    assert.equal(firstUnclaimedSlot(issue, settings, claimed, 5), 0);
  });

  test("preferred slot negative falls through to linear scan", () => {
    const settings = makeSettings({ agent: { ensemble_size: 2 } });
    const issue = makeIssue();
    const claimed = new Set<string>();
    assert.equal(firstUnclaimedSlot(issue, settings, claimed, -1), 0);
  });

  test("fractional preferred slot falls through to linear scan", () => {
    const settings = makeSettings({ agent: { ensemble_size: 2 } });
    const issue = makeIssue();
    const claimed = new Set<string>();
    assert.equal(firstUnclaimedSlot(issue, settings, claimed, 0.5), 0);
  });
});

describe("dispatchBlockReason", () => {
  test("returns null for dispatchable issue (no block)", () => {
    const settings = makeSettings();
    const issue = makeIssue();
    const state = { runningCount: 0, claimedSlots: new Set<string>() };
    assert.equal(dispatchBlockReason(issue, settings, state), null);
  });

  test("returns global_concurrency_cap when runningCount >= maxConcurrentAgents", () => {
    const settings = makeSettings({ agent: { max_concurrent_agents: 3 } });
    const issue = makeIssue();
    const state = { runningCount: 3, claimedSlots: new Set<string>() };
    assert.equal(dispatchBlockReason(issue, settings, state), "global_concurrency_cap");
  });

  test("returns local_concurrency_cap when state-specific limit exceeded", () => {
    const settings = makeSettings({
      agent: { max_concurrent_agents: 10 },
      status_overrides: { Todo: { agent: { max_concurrent_agents: 2 } } },
    });
    const issue = makeIssue();
    const runningByState = new Map([["todo", 2]]);
    const state = { runningCount: 2, runningByState, claimedSlots: new Set<string>() };
    assert.equal(dispatchBlockReason(issue, settings, state), "local_concurrency_cap");
  });

  test("returns worker_host_capacity when workerCapacityAvailable is false", () => {
    const settings = makeSettings();
    const issue = makeIssue();
    const state = {
      runningCount: 0,
      claimedSlots: new Set<string>(),
      workerCapacityAvailable: false,
    };
    assert.equal(dispatchBlockReason(issue, settings, state), "worker_host_capacity");
  });

  test("returns null when issue is missing required fields (not eligible for dispatch)", () => {
    const settings = makeSettings();
    const issue = { ...makeIssue(), id: "" };
    const state = { runningCount: 0, claimedSlots: new Set<string>() };
    assert.equal(dispatchBlockReason(issue, settings, state), null);
  });

  test("returns null when issue is in terminal state (not active)", () => {
    const settings = makeSettings();
    const issue = makeIssue({ state: { name: "Done", type: "completed" } });
    const state = { runningCount: 0, claimedSlots: new Set<string>() };
    assert.equal(dispatchBlockReason(issue, settings, state), null);
  });

  test("global cap takes priority over local cap", () => {
    const settings = makeSettings({
      agent: { max_concurrent_agents: 2 },
      status_overrides: { Todo: { agent: { max_concurrent_agents: 1 } } },
    });
    const issue = makeIssue();
    const runningByState = new Map([["todo", 2]]);
    const state = { runningCount: 2, runningByState, claimedSlots: new Set<string>() };
    // Global cap is checked first, so it wins
    assert.equal(dispatchBlockReason(issue, settings, state), "global_concurrency_cap");
  });

  test("local cap takes priority over worker_host_capacity", () => {
    const settings = makeSettings({
      agent: { max_concurrent_agents: 10 },
      status_overrides: { Todo: { agent: { max_concurrent_agents: 1 } } },
    });
    const issue = makeIssue();
    const runningByState = new Map([["todo", 1]]);
    const state = {
      runningCount: 1,
      runningByState,
      claimedSlots: new Set<string>(),
      workerCapacityAvailable: false,
    };
    assert.equal(dispatchBlockReason(issue, settings, state), "local_concurrency_cap");
  });
});
