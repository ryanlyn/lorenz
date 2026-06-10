import { test } from "vitest";
import fc from "fast-check";
import {
  routeNames,
  routedToThisWorker,
  shouldDispatchIssue,
  issueHasOpenBlockers,
  dispatchBlockReason,
  defaultSettings,
  normalizeRouteName,
} from "@symphony/cli";
import type { Issue, Settings } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

function makeSettings(
  overrides: {
    acceptUnrouted?: boolean;
    onlyRoutes?: string[] | null;
    routeLabelPrefix?: string;
    activeStates?: string[];
    terminalStates?: string[];
  } = {},
): Settings {
  const s = defaultSettings();
  s.tracker.dispatch.acceptUnrouted = overrides.acceptUnrouted ?? true;
  s.tracker.dispatch.onlyRoutes = overrides.onlyRoutes ?? null;
  s.tracker.dispatch.routeLabelPrefix = overrides.routeLabelPrefix ?? "Symphony:";
  if (overrides.activeStates) s.tracker.activeStates = overrides.activeStates;
  if (overrides.terminalStates) s.tracker.terminalStates = overrides.terminalStates;
  return s;
}

function issueWith(overrides: Partial<Issue>): Issue {
  return {
    id: "id-1",
    identifier: "TEST-1",
    title: "Test issue",
    state: "Todo",
    stateType: "unstarted",
    description: null,
    branchName: null,
    url: null,
    priority: 1,
    createdAt: null,
    updatedAt: null,
    labels: [],
    blockers: [],
    assigneeId: null,
    assignedToWorker: true,
    ...overrides,
  };
}

// --- routeNames ---

test("INVARIANT: When route labels are present, routeNames SHALL return the normalized suffix of each matching label.", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.string({ minLength: 1, maxLength: 20 }).map((s) => "Symphony:" + s),
        { minLength: 1, maxLength: 5 },
      ),
      (labels) => {
        const prefix = "Symphony:";
        const issue = issueWith({ labels });
        const settings = makeSettings({ routeLabelPrefix: prefix });
        const routes = routeNames(issue, settings);
        // Each route should be the normalized suffix after stripping the prefix
        const expected = labels
          .map((label) => normalizeRouteName(label.slice(prefix.length)))
          .filter((route) => route !== "");
        assert.deepEqual(routes, expected);
        // Also verify each route individually matches the derivation
        for (let i = 0; i < routes.length; i++) {
          assert.equal(routes[i], expected[i]);
        }
      },
    ),
  );
});

test("INVARIANT: When labels do not match the configured prefix, routeNames SHALL return an empty array.", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc
          .string({ minLength: 1, maxLength: 20 })
          .filter((s) => !s.toLowerCase().startsWith("symphony:")),
        { minLength: 1, maxLength: 5 },
      ),
      (labels) => {
        const issue = issueWith({ labels });
        const settings = makeSettings({ routeLabelPrefix: "Symphony:" });
        const routes = routeNames(issue, settings);
        assert.equal(routes.length, 0);
      },
    ),
  );
});

test("INVARIANT: When the suffix after the route prefix is blank, routeNames SHALL return an empty array.", () => {
  fc.assert(
    fc.property(fc.constantFrom("Symphony:", "Route:", "Team:"), (prefix) => {
      const issue = issueWith({ labels: [prefix, `${prefix}  `, `${prefix}\t`] });
      const settings = makeSettings({ routeLabelPrefix: prefix });
      const routes = routeNames(issue, settings);
      assert.equal(routes.length, 0);
    }),
  );
});

test("INVARIANT: When prefix matching is performed, matching SHALL be case-insensitive.", () => {
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 1, maxLength: 8 })
        .map((a) => a.join("")),
      (routeName) => {
        const prefix = "Symphony:";
        const variations = [
          `symphony:${routeName}`,
          `SYMPHONY:${routeName}`,
          `Symphony:${routeName}`,
        ];
        for (const label of variations) {
          const issue = issueWith({ labels: [label] });
          const settings = makeSettings({ routeLabelPrefix: prefix });
          const routes = routeNames(issue, settings);
          assert.ok(routes.length > 0);
          assert.equal(routes[0], routeName.trim().toLowerCase());
        }
      },
    ),
  );
});

// --- normalizeRouteName ---

test("INVARIANT: When route name normalization is applied twice, the result SHALL be the same (idempotent).", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 30 }), (input) => {
      const once = normalizeRouteName(input);
      const twice = normalizeRouteName(once);
      assert.equal(twice, once);
    }),
  );
});

test("INVARIANT: When route names are normalized, normalization SHALL be case-insensitive.", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 20 }), (input) => {
      assert.equal(
        normalizeRouteName(input.toUpperCase()),
        normalizeRouteName(input.toLowerCase()),
      );
    }),
  );
});

test("INVARIANT: When route names are normalized, leading and trailing whitespace SHALL be stripped.", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 20 }), (input) => {
      assert.equal(normalizeRouteName(`  ${input}  `), normalizeRouteName(input));
    }),
  );
});

// --- routedToThisWorker ---

test("INVARIANT: When the allowlist is null, the system SHALL accept all routes.", () => {
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(..."abcdefghijklmnop"), { minLength: 1, maxLength: 8 })
        .map((a) => a.join("")),
      (routeName) => {
        const issue = issueWith({ labels: [`symphony:${routeName}`] });
        const settings = makeSettings({ onlyRoutes: null });
        assert.ok(routedToThisWorker(issue, settings));
      },
    ),
  );
});

test("INVARIANT: When the allowlist is empty, the system SHALL reject all routes.", () => {
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(..."abcdefghijklmnop"), { minLength: 1, maxLength: 8 })
        .map((a) => a.join("")),
      (routeName) => {
        const issue = issueWith({ labels: [`symphony:${routeName}`] });
        const settings = makeSettings({ onlyRoutes: [] });
        assert.ok(!routedToThisWorker(issue, settings));
      },
    ),
  );
});

test("INVARIANT: When no route label is present and unrouted dispatch is disabled, the dispatch SHALL be ineligible.", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc
          .string({ minLength: 1, maxLength: 15 })
          .filter((l) => !l.toLowerCase().startsWith("symphony:")),
        { maxLength: 3 },
      ),
      (labels) => {
        const issue = issueWith({ labels });
        const settings = makeSettings({ acceptUnrouted: false });
        assert.ok(!routedToThisWorker(issue, settings));
      },
    ),
  );
});

test("INVARIANT: When an issue is not assigned to the worker, routing SHALL always reject regardless of other settings.", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 15 }), { maxLength: 3 }),
      fc.boolean(),
      (labels, acceptUnrouted) => {
        const issue = issueWith({ labels, assignedToWorker: false });
        const settings = makeSettings({ acceptUnrouted });
        assert.ok(!routedToThisWorker(issue, settings));
      },
    ),
  );
});

// --- issueHasOpenBlockers ---

test("INVARIANT: When an unstarted issue has non-terminal blockers, it SHALL be considered blocked.", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("Todo", "In Progress", "Review"),
      fc.array(
        fc.record({
          id: fc.constant("b1"),
          identifier: fc.constant("B-1"),
          state: fc.constantFrom("Todo", "In Progress"),
          stateType: fc.constant(null as string | null),
        }),
        { minLength: 1, maxLength: 3 },
      ),
      (state, blockers) => {
        const issue = issueWith({ state, stateType: "unstarted", blockers });
        const settings = makeSettings();
        assert.ok(issueHasOpenBlockers(issue, settings));
      },
    ),
  );
});

test("INVARIANT: When all blockers are in terminal states, the issue SHALL NOT be considered blocked.", () => {
  const terminalStates = ["Done", "Closed", "Cancelled"];
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          id: fc.constant("b1"),
          identifier: fc.constant("B-1"),
          state: fc.constantFrom(...terminalStates),
          stateType: fc.constant(null as string | null),
        }),
        { minLength: 1, maxLength: 3 },
      ),
      (blockers) => {
        const issue = issueWith({ state: "Todo", stateType: "unstarted", blockers });
        const settings = makeSettings({ terminalStates });
        assert.ok(!issueHasOpenBlockers(issue, settings));
      },
    ),
  );
});

test("issueHasOpenBlockers - non-unstarted issues with open blockers are not blocked", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("Todo", "In Progress", "Review"),
      fc.constantFrom("started", "completed", null),
      (blockerState, stateType) => {
        const issue = issueWith({
          state: "Todo",
          stateType,
          blockers: [{ id: "b1", identifier: "B-1", state: blockerState, stateType: null }],
        });
        const settings = makeSettings();
        assert.ok(!issueHasOpenBlockers(issue, settings));
      },
    ),
  );
});

// --- shouldDispatchIssue / dispatchBlockReason consistency ---

test("INVARIANT: When an issue is missing required fields, it SHALL never be eligible for dispatch.", () => {
  fc.assert(
    fc.property(fc.constantFrom("id", "identifier", "title", "state"), (field) => {
      const issue = issueWith({ [field]: "" });
      const settings = makeSettings();
      const state = { runningCount: 0, claimedSlots: new Set<string>() };
      assert.ok(!shouldDispatchIssue(issue, settings, state));
    }),
  );
});

test("INVARIANT: When an issue is in a terminal state, it SHALL never be eligible for dispatch.", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("Done", "Closed", "Cancelled", "Canceled", "Duplicate"),
      (terminalState) => {
        const issue = issueWith({ state: terminalState, stateType: "completed" });
        const settings = makeSettings();
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.ok(!shouldDispatchIssue(issue, settings, state));
      },
    ),
  );
});

test("INVARIANT: When the concurrency cap is reached, dispatch SHALL be blocked.", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 20 }), (cap) => {
      const issue = issueWith({ state: "Todo", stateType: "unstarted", blockers: [] });
      const settings = makeSettings();
      settings.agent.maxConcurrentAgents = cap;
      const state = { runningCount: cap, claimedSlots: new Set<string>() };
      assert.ok(!shouldDispatchIssue(issue, settings, state));
      assert.equal(dispatchBlockReason(issue, settings, state), "global_concurrency_cap");
    }),
  );
});

test("INVARIANT: dispatchBlockReason SHALL return null if and only if shouldDispatchIssue returns true (given unclaimed slots).", () => {
  // Terminal states that must be excluded from the generated issue state to ensure
  // the issue passes the issueIsActive check (which requires state in activeStates
  // AND state NOT in terminalStates).
  const terminalStates = ["Done", "Cancelled", "Canceled", "Closed", "Duplicate"];

  const arbTestIssue = (): fc.Arbitrary<Issue> =>
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 15 }),
      identifier: fc.string({ minLength: 1, maxLength: 10 }),
      title: fc.string({ minLength: 1, maxLength: 20 }),
      state: fc
        .string({ minLength: 1, maxLength: 15 })
        .filter(
          (s) => !terminalStates.some((t) => t.trim().toLowerCase() === s.trim().toLowerCase()),
        ),
      stateType: fc.option(fc.constantFrom("unstarted", "started", "completed", "cancelled"), {
        nil: null,
      }),
      description: fc.constant(null as string | null),
      branchName: fc.constant(null as string | null),
      url: fc.constant(null as string | null),
      priority: fc.option(fc.constantFrom(1, 2, 3, 4), { nil: null }),
      createdAt: fc.constant(null as string | null),
      updatedAt: fc.constant(null as string | null),
      labels: fc.array(
        fc.string({ minLength: 1, maxLength: 15 }).map((s) => s.trim().toLowerCase()),
        { maxLength: 3 },
      ),
      blockers: fc.constant([] as Issue["blockers"]),
      assigneeId: fc.constant(null as string | null),
      assignedToWorker: fc.constant(true as boolean | null),
    });

  fc.assert(
    fc.property(arbTestIssue(), (issue) => {
      const settings = makeSettings({
        activeStates: ["Todo", "In Progress", issue.state],
        terminalStates,
      });
      // Use empty claimedSlots so the slot-claiming logic in shouldDispatchIssue
      // does not reject (since dispatchBlockReason does not check slots)
      const state = { runningCount: 0, claimedSlots: new Set<string>() };
      const blocked = dispatchBlockReason(issue, settings, state);
      const shouldDispatch = shouldDispatchIssue(issue, settings, state);

      // Forward direction: if blocked, then should not dispatch
      if (blocked !== null) {
        assert.ok(!shouldDispatch);
      }
      // Converse: if not blocked, then shouldDispatch should be true
      // (because claimedSlots is empty, the slot check always succeeds)
      if (blocked === null) {
        assert.ok(shouldDispatch);
      }
    }),
  );
});

test("dispatchBlockReason — returns null for issues that fail preconditions (missing fields, inactive, unrouted)", () => {
  // dispatchBlockReason returns null early for issues that fail preconditions
  // (missing fields, not active, not routed, has blockers) - these are NOT dispatchable
  // but dispatchBlockReason returns null because it only reports capacity blocks
  fc.assert(
    fc.property(fc.constantFrom("id", "identifier", "title", "state"), (field) => {
      const issue = issueWith({ [field]: "" });
      const settings = makeSettings();
      const state = { runningCount: 0, claimedSlots: new Set<string>() };
      // dispatchBlockReason returns null (no capacity block) but shouldDispatch returns false
      const blocked = dispatchBlockReason(issue, settings, state);
      const shouldDispatch = shouldDispatchIssue(issue, settings, state);
      assert.equal(blocked, null);
      assert.ok(!shouldDispatch);
    }),
  );
});
