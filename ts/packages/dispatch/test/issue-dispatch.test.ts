import { test } from "vitest";
import {
  dispatchBlockReason,
  firstUnclaimedSlot,
  hasRouteLabel,
  issueHasOpenBlockers,
  normalizeIssue,
  parseConfig,
  routeNames,
  routedToThisWorker,
  shouldDispatchIssue,
  slotKey,
  sortForDispatch,
} from "@lorenz/cli";
import { assert } from "@lorenz/test-utils";

test("normalizes Linear issue fields used by dispatch", () => {
  const issue = normalizeIssue(
    {
      id: "i1",
      identifier: "MT-1",
      title: "Title",
      description: "Body",
      state: { name: "Todo", type: "unstarted" },
      assignee: { id: "worker@example.com" },
      labels: [{ name: "Lorenz:Backend" }, { name: "ENSEMBLE:3" }],
      relations: [
        {
          type: " Blocks ",
          relatedIssue: {
            id: "b1",
            identifier: "MT-0",
            state: { name: "Closed", type: "completed" },
          },
        },
      ],
    },
    "worker@example.com",
  );

  assert.equal(issue.stateType, "unstarted");
  assert.equal(issue.assigneeId, "worker@example.com");
  assert.equal(issue.assignedToWorker, true);
  assert.deepEqual(issue.labels, ["lorenz:backend", "ensemble:3"]);
  assert.equal(issue.blockers[0]?.state, "Closed");
  assert.equal(issue.blockers[0]?.stateType, "completed");
  assert.throws(
    () =>
      normalizeIssue({
        id: "unknown-state-type",
        identifier: "MT-UNKNOWN-STATE-TYPE",
        title: "Unknown state type",
        state: { name: "Todo", type: "needs-review" },
      }),
    /stateType is required/,
  );
  assert.equal(
    normalizeIssue({
      id: "unknown-blocker-state-type-root",
      identifier: "MT-UNKNOWN-BLOCKER",
      title: "Unknown blocker state type",
      state: { name: "Todo", type: "unstarted" },
      relations: [
        {
          type: "Blocks",
          relatedIssue: {
            id: "unknown-blocker-state-type",
            identifier: "MT-BLOCKER",
            state: { name: "Review", type: "needs-review" },
          },
        },
      ],
    }).blockers[0]?.stateType,
    null,
  );
  assert.equal(
    normalizeIssue({
      id: "float-priority",
      identifier: "MT-FLOAT",
      title: "Float priority",
      state: { name: "Todo", type: "unstarted" },
      priority: 1.5,
    }).priority,
    null,
  );
  assert.throws(
    () =>
      normalizeIssue({
        id: "missing-state",
        identifier: "MT-MISSING-STATE",
        title: "Missing state",
      }),
    /issue.state is required/,
  );

  assert.equal(
    normalizeIssue(
      {
        id: "unassigned",
        identifier: "MT-UNASSIGNED",
        title: "Unassigned",
        state: { name: "Todo", type: "unstarted" },
        assignee: null,
      },
      "worker@example.com",
    ).assignedToWorker,
    false,
  );
  assert.equal(
    normalizeIssue(
      {
        id: "email-only",
        identifier: "MT-EMAIL",
        title: "Email only",
        state: { name: "Todo", type: "unstarted" },
        assignee: { email: "worker@example.com" },
      },
      "worker@example.com",
    ).assignedToWorker,
    false,
  );
});

test("route and assignee rules match the SPEC", () => {
  const settings = parseConfig({
    tracker: {
      dispatch: { only_routes: ["backend"] },
      active_states: ["Todo", "In Progress"],
    },
  });
  const issue = normalizeIssue({
    id: "i1",
    identifier: "MT-1",
    title: "Title",
    state: { name: "Todo", type: "unstarted" },
    labels: ["Lorenz:Backend"],
  });

  assert.deepEqual(routeNames(issue, settings), ["backend"]);
  assert.equal(shouldDispatchIssue(issue, settings, { runningCount: 0 }), true);

  const assignedElsewhere = { ...issue, assignedToWorker: false };
  assert.equal(shouldDispatchIssue(assignedElsewhere, settings, { runningCount: 0 }), false);
});

test("slack hashtag routing resolves #route- labels via route_label_prefix", () => {
  // Slack deriveLabels turns "#route-backend" into the label "route-backend";
  // with route_label_prefix "route-" dispatch resolves it to the route "backend".
  const matching = parseConfig({
    tracker: { dispatch: { route_label_prefix: "route-", only_routes: ["backend"] } },
  });
  const routed = normalizeIssue({
    id: "slk-1",
    identifier: "SLK-1",
    title: "Routed",
    state: "Todo",
    state_type: "unstarted",
    labels: ["route-backend"],
  });
  assert.deepEqual(routeNames(routed, matching), ["backend"]);
  assert.equal(routedToThisWorker(routed, matching), true);

  const otherRoute = parseConfig({
    tracker: { dispatch: { route_label_prefix: "route-", only_routes: ["frontend"] } },
  });
  assert.equal(routedToThisWorker(routed, otherRoute), false);
});

test("slack plain hashtag labels are unrouted under route_label_prefix", () => {
  // A plain "#backend" hashtag yields label "backend", which does not start with
  // "route-" and so is a non-route label handled by accept_unrouted.
  const plain = normalizeIssue({
    id: "slk-2",
    identifier: "SLK-2",
    title: "Plain hashtag",
    state: "Todo",
    state_type: "unstarted",
    labels: ["backend"],
  });

  const accept = parseConfig({
    tracker: {
      dispatch: { route_label_prefix: "route-", only_routes: ["backend"], accept_unrouted: true },
    },
  });
  assert.deepEqual(routeNames(plain, accept), []);
  assert.equal(hasRouteLabel(plain, accept), false);
  assert.equal(routedToThisWorker(plain, accept), true);

  const reject = parseConfig({
    tracker: {
      dispatch: { route_label_prefix: "route-", only_routes: ["backend"], accept_unrouted: false },
    },
  });
  assert.equal(routedToThisWorker(plain, reject), false);
});

test("empty route labels are routed labels but are not dispatchable as unrouted", () => {
  const settings = parseConfig({ tracker: { dispatch: { accept_unrouted: true } } });
  const issue = normalizeIssue({
    id: "empty-route",
    identifier: "MT-EMPTY",
    title: "Empty route",
    state: { name: "Todo", type: "unstarted" },
    labels: ["Lorenz:"],
  });

  assert.equal(hasRouteLabel(issue, settings), true);
  assert.deepEqual(routeNames(issue, settings), []);
  assert.equal(shouldDispatchIssue(issue, settings, { runningCount: 0 }), false);
});

test("dispatch block reasons classify capacity gates without hiding routing failures", () => {
  const settings = parseConfig({
    agent: { max_concurrent_agents: 1 },
    status_overrides: { Todo: { agent: { max_concurrent_agents: 1 } } },
  });
  const issue = normalizeIssue({
    id: "i1",
    identifier: "MT-1",
    title: "Title",
    state: { name: "Todo", type: "unstarted" },
  });
  const runningByState = new Map([["todo", 1]]);

  assert.equal(
    dispatchBlockReason(issue, settings, { runningCount: 1, runningByState }),
    "global_concurrency_cap",
  );

  const localSettings = parseConfig({
    agent: { max_concurrent_agents: 5 },
    status_overrides: { Todo: { agent: { max_concurrent_agents: 1 } } },
  });
  assert.equal(
    dispatchBlockReason(issue, localSettings, { runningCount: 1, runningByState }),
    "local_concurrency_cap",
  );

  assert.equal(
    dispatchBlockReason(issue, localSettings, {
      runningCount: 0,
      runningByState: new Map(),
      workerCapacityAvailable: false,
    }),
    "worker_host_capacity",
  );

  const misrouted = normalizeIssue({ ...issue, labels: ["Lorenz:"] });
  assert.equal(dispatchBlockReason(misrouted, settings, { runningCount: 1, runningByState }), null);
});

test("unstarted blockers and ensemble slot claims are enforced", () => {
  const settings = parseConfig({ agent: { ensemble_size: 2 } });
  const blocked = normalizeIssue({
    id: "i1",
    identifier: "MT-1",
    title: "Title",
    state: { name: "Backlog", type: "unstarted" },
    blockers: [{ state: "In Progress" }],
  });

  assert.equal(issueHasOpenBlockers(blocked, settings), true);

  const issue = normalizeIssue({
    id: "i2",
    identifier: "MT-2",
    title: "Title",
    state: { name: "Todo", type: "unstarted" },
    labels: ["ensemble:3"],
  });
  const claimed = new Set([slotKey(issue.id, 0), slotKey(issue.id, 1)]);
  assert.equal(firstUnclaimedSlot(issue, settings, claimed), 2);
  claimed.add(slotKey(issue.id, 2));
  assert.equal(firstUnclaimedSlot(issue, settings, claimed), null);
});

test("dispatch sort is priority, creation time, identifier", () => {
  const sorted = sortForDispatch([
    {
      id: "3",
      identifier: "MT-3",
      title: "C",
      state: { name: "Todo", type: "unstarted" },
      labels: [],
      blockers: [],
      priority: null,
      createdAt: "2026-01-01",
    },
    {
      id: "2",
      identifier: "MT-2",
      title: "B",
      state: { name: "Todo", type: "unstarted" },
      labels: [],
      blockers: [],
      priority: 1,
      createdAt: "2026-01-03",
    },
    {
      id: "1",
      identifier: "MT-1",
      title: "A",
      state: { name: "Todo", type: "unstarted" },
      labels: [],
      blockers: [],
      priority: 1,
      createdAt: "2026-01-02",
    },
  ]);

  assert.deepEqual(
    sorted.map((issue) => issue.identifier),
    ["MT-1", "MT-2", "MT-3"],
  );

  assert.deepEqual(
    sortForDispatch([
      {
        id: "utc",
        identifier: "MT-UTC",
        title: "UTC",
        state: { name: "Todo", type: "unstarted" },
        labels: [],
        blockers: [],
        priority: 1,
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "offset",
        identifier: "MT-OFFSET",
        title: "Offset",
        state: { name: "Todo", type: "unstarted" },
        labels: [],
        blockers: [],
        priority: 1,
        createdAt: "2026-01-01T00:30:00+01:00",
      },
    ]).map((issue) => issue.identifier),
    ["MT-OFFSET", "MT-UTC"],
  );
});
