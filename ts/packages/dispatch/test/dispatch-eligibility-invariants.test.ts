import { test } from "vitest";
import fc from "fast-check";
import {
  shouldDispatchIssue,
  dispatchBlockReason,
  issueHasOpenBlockers,
  defaultSettings,
  slotKey,
  issueIsActive,
  routedToThisWorker,
} from "@symphony/cli";
import type { Issue, Settings } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

// --- Helper arbitraries and factories ---

function makeSettings(
  overrides: Partial<{
    activeStates: string[];
    terminalStates: string[];
    maxConcurrentAgents: number;
    ensembleSize: number;
  }> = {},
): Settings {
  const s = defaultSettings();
  if (overrides.activeStates) s.tracker.activeStates = overrides.activeStates;
  if (overrides.terminalStates) s.tracker.terminalStates = overrides.terminalStates;
  if (overrides.maxConcurrentAgents !== undefined)
    s.agent.maxConcurrentAgents = overrides.maxConcurrentAgents;
  if (overrides.ensembleSize !== undefined) s.agent.ensembleSize = overrides.ensembleSize;
  return s;
}

function validIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "TEST-1",
    title: "A valid test issue",
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

/** Arbitrary that takes a base string and applies random case/whitespace transformations */
function caseWhitespaceVariant(baseStates: string[]): fc.Arbitrary<string> {
  return fc.constantFrom(...baseStates).chain((s) =>
    fc
      .tuple(fc.constantFrom("upper", "lower", "mixed"), fc.nat({ max: 3 }), fc.nat({ max: 3 }))
      .map(([caseMode, padLeft, padRight]) => {
        let transformed: string;
        switch (caseMode) {
          case "upper":
            transformed = s.toUpperCase();
            break;
          case "lower":
            transformed = s.toLowerCase();
            break;
          case "mixed":
            transformed = s
              .split("")
              .map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase()))
              .join("");
            break;
          default:
            transformed = s;
        }
        return " ".repeat(padLeft) + transformed + " ".repeat(padRight);
      }),
  );
}

/** Arbitrary for a random Issue with controllable validity */
function issueArb(
  opts: {
    validFields?: boolean;
    activeState?: boolean;
    assignedToWorker?: boolean | null;
    hasOpenBlockers?: boolean;
  } = {},
): fc.Arbitrary<Issue> {
  const idArb =
    opts.validFields === false
      ? fc.oneof(fc.constant(""), fc.constant(null as unknown as string))
      : fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim() !== "");
  const identifierArb =
    opts.validFields === false
      ? fc.oneof(fc.constant(""), fc.constant(null as unknown as string))
      : fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim() !== "");
  const titleArb =
    opts.validFields === false
      ? fc.oneof(fc.constant(""), fc.constant(null as unknown as string))
      : fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim() !== "");

  const stateArb =
    opts.activeState === true
      ? fc.constantFrom("Todo", "In Progress")
      : opts.activeState === false
        ? fc.constantFrom("Done", "Backlog", "Staging", "QA")
        : fc.constantFrom("Todo", "In Progress", "Done", "Backlog");

  const assignedArb =
    opts.assignedToWorker === true
      ? (fc.constant(true) as fc.Arbitrary<boolean | null | undefined>)
      : opts.assignedToWorker === false
        ? (fc.constant(false) as fc.Arbitrary<boolean | null | undefined>)
        : opts.assignedToWorker === null
          ? (fc.constant(null) as fc.Arbitrary<boolean | null | undefined>)
          : (fc.constantFrom(true, false) as fc.Arbitrary<boolean | null | undefined>);

  const blockersArb =
    opts.hasOpenBlockers === true
      ? fc.array(
          fc.record({
            state: fc.constantFrom("In Progress", "Review", "Blocked") as fc.Arbitrary<
              string | undefined
            >,
            stateType: fc.constant(null as null),
          }),
          { minLength: 1, maxLength: 3 },
        )
      : opts.hasOpenBlockers === false
        ? fc.oneof(
            fc.constant([] as { state?: string | undefined; stateType: null }[]),
            fc.array(
              fc.record({
                state: fc.constantFrom("Done", "Closed", "Cancelled") as fc.Arbitrary<
                  string | undefined
                >,
                stateType: fc.constant(null as null),
              }),
              { minLength: 1, maxLength: 2 },
            ),
          )
        : fc.oneof(
            fc.constant([] as { state?: string | undefined; stateType: null }[]),
            fc.array(
              fc.record({
                state: fc.constantFrom("In Progress", "Done", "Review") as fc.Arbitrary<
                  string | undefined
                >,
                stateType: fc.constant(null as null),
              }),
              { minLength: 1, maxLength: 3 },
            ),
          );

  return fc
    .tuple(
      idArb,
      identifierArb,
      titleArb,
      stateArb,
      assignedArb,
      blockersArb,
      fc.integer({ min: 0, max: 4 }),
    )
    .map(([id, identifier, title, state, assignedToWorker, blockers, priority]) => ({
      id,
      identifier,
      title,
      state,
      stateType: (state === "Todo"
        ? "unstarted"
        : state === "In Progress"
          ? "started"
          : state === "Done"
            ? "completed"
            : "backlog") as Issue["stateType"],
      description: null,
      branchName: null,
      url: null,
      priority,
      createdAt: null,
      updatedAt: null,
      labels: [],
      blockers,
      assigneeId: null,
      assignedToWorker,
    }));
}

// INVARIANT: When a dispatch is missing required fields, it SHALL be ineligible.

test("missing required fields (id, identifier, title, state) SHALL be ineligible", () => {
  const requiredFields = ["id", "identifier", "title", "state"] as const;

  fc.assert(
    fc.property(
      fc.constantFrom(...requiredFields),
      fc.oneof(
        fc.constant(""),
        fc.constant(null as unknown as string),
        fc.constant(undefined as unknown as string),
      ),
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.string({ minLength: 0, maxLength: 30 }),
      (field, emptyValue, randomLabel, randomDesc) => {
        const issue = validIssue({
          [field]: emptyValue,
          labels: randomLabel ? [randomLabel] : [],
          description: randomDesc || null,
        });
        const settings = makeSettings();
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
    { numRuns: 100 },
  );
});

test("if shouldDispatchIssue rejects due to missing fields, dispatchBlockReason does not report a blocking reason", () => {
  const requiredFields = ["id", "identifier", "title", "state"] as const;

  fc.assert(
    fc.property(
      fc.constantFrom(...requiredFields),
      fc.oneof(fc.constant(""), fc.constant(null as unknown as string)),
      (field, emptyValue) => {
        const issue = validIssue({ [field]: emptyValue });
        const settings = makeSettings();
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
        const blockReason = dispatchBlockReason(issue, settings, state);
        assert.equal(
          blockReason === "global_concurrency_cap" ||
            blockReason === "local_concurrency_cap" ||
            blockReason === "worker_host_capacity",
          false,
        );
      },
    ),
    { numRuns: 50 },
  );
});

// INVARIANT: When a dispatch is in a terminal state, it SHALL be ineligible.

test("terminal state issues SHALL be ineligible", () => {
  const defaultTerminalStates = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];

  fc.assert(
    fc.property(
      caseWhitespaceVariant(defaultTerminalStates),
      fc.constantFrom("completed", "canceled" as const),
      (terminalState, stateType) => {
        const issue = validIssue({ state: terminalState, stateType });
        const settings = makeSettings();
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
    { numRuns: 200 },
  );
});

test("issueIsActive returns false for terminal states regardless of case/whitespace", () => {
  const defaultTerminalStates = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];

  fc.assert(
    fc.property(caseWhitespaceVariant(defaultTerminalStates), (terminalState) => {
      const issue = validIssue({ state: terminalState, stateType: "completed" });
      const settings = makeSettings();
      assert.equal(issueIsActive(issue, settings), false);
    }),
    { numRuns: 200 },
  );
});

test("custom terminal states configured via settings are respected", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
      (customTerminal) => {
        const issue = validIssue({
          state: customTerminal,
          stateType: "completed",
          assignedToWorker: true,
        });
        const settings = makeSettings({
          activeStates: [customTerminal],
          terminalStates: [customTerminal],
        });
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(issueIsActive(issue, settings), false);
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
    { numRuns: 200 },
  );
});

// INVARIANT: When a dispatch is in a non-active state, it SHALL be ineligible.

test("non-active state issues SHALL be ineligible", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => {
          const lower = s.trim().toLowerCase();
          return lower !== "todo" && lower !== "in progress" && lower !== "";
        }),
        fc.constantFrom("Backlog", "Review", "Blocked", "Staging", "QA", "Triaged"),
      ),
      (nonActiveState) => {
        const issue = validIssue({ state: nonActiveState, stateType: "unstarted" });
        const settings = makeSettings({
          activeStates: ["Todo", "In Progress"],
          terminalStates: ["Done"],
        });
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(issueIsActive(issue, settings), false);
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
    { numRuns: 200 },
  );
});

test("active state comparison is case-insensitive with whitespace handling", () => {
  fc.assert(
    fc.property(caseWhitespaceVariant(["Todo", "In Progress"]), (activeVariant) => {
      const issue = validIssue({
        state: activeVariant,
        stateType: "unstarted",
        assignedToWorker: true,
        blockers: [],
      });
      const settings = makeSettings({
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Done"],
      });
      assert.equal(issueIsActive(issue, settings), true);
    }),
    { numRuns: 200 },
  );
});

// INVARIANT: When a dispatch is not assigned to this worker, it SHALL be ineligible.

test("issues not assigned to this worker SHALL be ineligible", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 10 }),
      fc.constantFrom("Todo", "In Progress"),
      (runningCount, activeState) => {
        const issue = validIssue({ assignedToWorker: false, state: activeState });
        const settings = makeSettings();
        const state = { runningCount, claimedSlots: new Set<string>() };
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
    { numRuns: 100 },
  );
});

// INVARIANT: When an unstarted issue has a non-terminal blocker, it SHALL NOT be dispatched (blockers prevent starting).

test("unstarted issue with a non-terminal blocker SHALL be ineligible", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string({ minLength: 1, maxLength: 15 }).filter((s) => {
          const lower = s.trim().toLowerCase();
          return (
            lower !== "closed" &&
            lower !== "cancelled" &&
            lower !== "canceled" &&
            lower !== "duplicate" &&
            lower !== "done" &&
            lower !== ""
          );
        }),
        fc.constantFrom("Todo", "In Progress", "Review", "Backlog", "Blocked", "QA"),
      ),
      (blockerState) => {
        const issue = validIssue({
          state: "Todo",
          stateType: "unstarted",
          blockers: [{ state: blockerState, stateType: null }],
        });
        const settings = makeSettings();
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(issueHasOpenBlockers(issue, settings), true);
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
    { numRuns: 200 },
  );
});

test("multiple blockers with at least one non-terminal blocks dispatch", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 5 }),
      fc.constantFrom("In Progress", "Todo", "Review", "Blocked"),
      (numTerminalBlockers, nonTerminalState) => {
        const terminalBlockers = Array.from({ length: numTerminalBlockers }, () => ({
          state: "Done",
          stateType: "completed" as const,
        }));
        const nonTerminalBlocker = { state: nonTerminalState, stateType: null };
        const issue = validIssue({
          state: "Todo",
          stateType: "unstarted",
          blockers: [...terminalBlockers, nonTerminalBlocker],
        });
        const settings = makeSettings();
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(issueHasOpenBlockers(issue, settings), true);
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
    { numRuns: 100 },
  );
});

test("blocker terminal check is case-insensitive with whitespace trimming", () => {
  const defaultTerminalStates = ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"];
  fc.assert(
    fc.property(caseWhitespaceVariant(defaultTerminalStates), (terminalBlockerState) => {
      const issue = validIssue({
        state: "Todo",
        stateType: "unstarted",
        blockers: [{ state: terminalBlockerState, stateType: null }],
      });
      const settings = makeSettings();
      assert.equal(issueHasOpenBlockers(issue, settings), false);
    }),
    { numRuns: 200 },
  );
});

// INVARIANT: When a started issue has open blockers, it SHALL be blocked (blockers on started issues abort).

test("started issue with open blockers SHALL be blocked", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          state: fc.constantFrom("Todo", "In Progress", "Review"),
          stateType: fc.constant(null as null),
        }),
        { minLength: 1, maxLength: 3 },
      ),
      (blockers) => {
        const issue = validIssue({
          state: "In Progress",
          stateType: "started",
          blockers,
          assignedToWorker: true,
        });
        const settings = makeSettings({ activeStates: ["Todo", "In Progress"] });
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(issueHasOpenBlockers(issue, settings), true);
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
    { numRuns: 100 },
  );
});

test("started issue with many open blockers SHALL be blocked", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 10 }), (numBlockers) => {
      const blockers = Array.from({ length: numBlockers }, (_, i) => ({
        state: `Blocker-${i}`,
        stateType: null,
      }));
      const issue = validIssue({
        state: "In Progress",
        stateType: "started",
        blockers,
        assignedToWorker: true,
      });
      const settings = makeSettings({ activeStates: ["Todo", "In Progress"] });
      const state = { runningCount: 0, claimedSlots: new Set<string>() };
      assert.equal(issueHasOpenBlockers(issue, settings), true);
      assert.equal(shouldDispatchIssue(issue, settings, state), false);
    }),
    { numRuns: 50 },
  );
});

// INVARIANT: When a terminal issue has open blockers, it SHALL be a no-op (blockers on terminal issues are no-op).

test("terminal issue with open blockers SHALL still be ineligible via terminal check, not blockers", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("Done", "Closed", "Cancelled", "Canceled", "Duplicate"),
      fc.array(
        fc.record({
          state: fc.constantFrom("Todo", "In Progress", "Review"),
          stateType: fc.constant(null as null),
        }),
        { minLength: 1, maxLength: 3 },
      ),
      (terminalState, blockers) => {
        const issue = validIssue({
          state: terminalState,
          stateType: "completed",
          blockers,
          assignedToWorker: true,
        });
        const settings = makeSettings();
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(issueIsActive(issue, settings), false);
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
    { numRuns: 100 },
  );
});

test("terminal issue with open blockers does not produce a dispatch block reason", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("Done", "Closed", "Cancelled"),
      fc.array(
        fc.record({
          state: fc.constantFrom("Todo", "In Progress"),
          stateType: fc.constant(null as null),
        }),
        { minLength: 1, maxLength: 3 },
      ),
      (terminalState, blockers) => {
        const issue = validIssue({
          state: terminalState,
          stateType: "completed",
          blockers,
          assignedToWorker: true,
        });
        const settings = makeSettings();
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(dispatchBlockReason(issue, settings, state), null);
      },
    ),
    { numRuns: 50 },
  );
});

// INVARIANT: When an unstarted issue has only terminal blockers, it SHALL be eligible.

test("unstarted issue with only terminal blockers SHALL be eligible", () => {
  const defaultTerminalStates = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          state: fc.constantFrom(...defaultTerminalStates),
          stateType: fc.constant(null as null),
        }),
        { minLength: 1, maxLength: 4 },
      ),
      (blockers) => {
        const issue = validIssue({
          state: "Todo",
          stateType: "unstarted",
          blockers,
          assignedToWorker: true,
        });
        const settings = makeSettings();
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(issueHasOpenBlockers(issue, settings), false);
        assert.equal(shouldDispatchIssue(issue, settings, state), true);
      },
    ),
    { numRuns: 100 },
  );
});

test("terminal blockers in various case/whitespace forms still allow dispatch", () => {
  const defaultTerminalStates = ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"];
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          state: caseWhitespaceVariant(defaultTerminalStates),
          stateType: fc.constant(null as null),
        }),
        { minLength: 1, maxLength: 5 },
      ),
      (blockers) => {
        const issue = validIssue({
          state: "Todo",
          stateType: "unstarted",
          blockers,
          assignedToWorker: true,
        });
        const settings = makeSettings();
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(issueHasOpenBlockers(issue, settings), false);
        assert.equal(shouldDispatchIssue(issue, settings, state), true);
      },
    ),
    { numRuns: 200 },
  );
});

// INVARIANT: When the global concurrency cap is reached, the system SHALL not dispatch new work.

test("global concurrency cap reached SHALL not dispatch new work", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 50 }), fc.nat({ max: 10 }), (cap, extra) => {
      const issue = validIssue({
        state: "Todo",
        stateType: "unstarted",
        blockers: [],
        assignedToWorker: true,
      });
      const settings = makeSettings({ maxConcurrentAgents: cap });
      const state = { runningCount: cap + extra, claimedSlots: new Set<string>() };
      assert.equal(shouldDispatchIssue(issue, settings, state), false);
    }),
    { numRuns: 200 },
  );
});

test("dispatchBlockReason returns global_concurrency_cap when at limit", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 50 }), (cap) => {
      const issue = validIssue({
        state: "Todo",
        stateType: "unstarted",
        blockers: [],
        assignedToWorker: true,
      });
      const settings = makeSettings({ maxConcurrentAgents: cap });
      const state = { runningCount: cap, claimedSlots: new Set<string>() };
      assert.equal(dispatchBlockReason(issue, settings, state), "global_concurrency_cap");
    }),
    { numRuns: 200 },
  );
});

test("exactly at cap blocks, one below cap does not block", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 100 }), (cap) => {
      const issue = validIssue({
        state: "Todo",
        stateType: "unstarted",
        blockers: [],
        assignedToWorker: true,
      });
      const settings = makeSettings({ maxConcurrentAgents: cap });
      assert.equal(
        shouldDispatchIssue(issue, settings, {
          runningCount: cap,
          claimedSlots: new Set<string>(),
        }),
        false,
      );
      assert.equal(
        dispatchBlockReason(issue, settings, {
          runningCount: cap - 1,
          claimedSlots: new Set<string>(),
        }),
        null,
      );
    }),
    { numRuns: 200 },
  );
});

// INVARIANT: When a per-state concurrency cap is reached, the system SHALL not dispatch new work in that state.

test("per-state concurrency cap reached SHALL not dispatch new work in that state", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 20 }), fc.nat({ max: 5 }), (perStateCap, extra) => {
      const issue = validIssue({
        state: "Todo",
        stateType: "unstarted",
        blockers: [],
        assignedToWorker: true,
      });
      const settings = makeSettings({ maxConcurrentAgents: 100 });
      settings.statusOverrides.set("todo", { agent: { maxConcurrentAgents: perStateCap } });
      const state = {
        runningCount: 0,
        runningByState: new Map([["Todo", perStateCap + extra]]),
        claimedSlots: new Set<string>(),
      };
      assert.equal(shouldDispatchIssue(issue, settings, state), false);
      assert.equal(dispatchBlockReason(issue, settings, state), "local_concurrency_cap");
    }),
    { numRuns: 200 },
  );
});

test("per-state cap below limit allows dispatch", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 20 }), (perStateCap) => {
      const issue = validIssue({
        state: "Todo",
        stateType: "unstarted",
        blockers: [],
        assignedToWorker: true,
      });
      const settings = makeSettings({ maxConcurrentAgents: 100 });
      settings.statusOverrides.set("todo", { agent: { maxConcurrentAgents: perStateCap } });
      const state = {
        runningCount: 0,
        runningByState: new Map([["Todo", perStateCap - 1]]),
        claimedSlots: new Set<string>(),
      };
      assert.notEqual(dispatchBlockReason(issue, settings, state), "local_concurrency_cap");
    }),
    { numRuns: 100 },
  );
});

test("state normalization for statusOverrides key matching", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("Todo", "In Progress"),
      fc.integer({ min: 1, max: 10 }),
      (issueState, perStateCap) => {
        const issue = validIssue({
          state: issueState,
          stateType: "unstarted",
          blockers: [],
          assignedToWorker: true,
        });
        const settings = makeSettings({ maxConcurrentAgents: 100 });
        settings.statusOverrides.set(issueState.trim().toLowerCase(), {
          agent: { maxConcurrentAgents: perStateCap },
        });
        const state = {
          runningCount: 0,
          runningByState: new Map([[issueState, perStateCap]]),
          claimedSlots: new Set<string>(),
        };
        assert.equal(dispatchBlockReason(issue, settings, state), "local_concurrency_cap");
      },
    ),
    { numRuns: 50 },
  );
});

// INVARIANT: When all ensemble slots are claimed, the dispatch SHALL be ineligible.

test("all ensemble slots claimed SHALL make the dispatch ineligible", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 5 }), (ensembleSize) => {
      const issueId = "issue-ensemble";
      const issue = validIssue({
        id: issueId,
        state: "Todo",
        stateType: "unstarted",
        blockers: [],
        assignedToWorker: true,
      });
      const settings = makeSettings({ ensembleSize });
      const claimed = new Set<string>();
      for (let i = 0; i < ensembleSize; i++) claimed.add(slotKey(issueId, i));
      assert.equal(
        shouldDispatchIssue(issue, settings, { runningCount: 0, claimedSlots: claimed }),
        false,
      );
    }),
    { numRuns: 50 },
  );
});

test("ensemble label overrides settings and all slots claimed blocks dispatch", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 5 }), (ensembleSize) => {
      const issueId = "issue-ensemble-label";
      const issue = validIssue({
        id: issueId,
        state: "Todo",
        stateType: "unstarted",
        blockers: [],
        assignedToWorker: true,
        labels: [`ensemble:${ensembleSize}`],
      });
      const settings = makeSettings({ ensembleSize: 1 });
      const claimed = new Set<string>();
      for (let i = 0; i < ensembleSize; i++) claimed.add(slotKey(issueId, i));
      assert.equal(
        shouldDispatchIssue(issue, settings, { runningCount: 0, claimedSlots: claimed }),
        false,
      );
    }),
    { numRuns: 50 },
  );
});

test("partially claimed ensemble slots still allow dispatch", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 5 }), (ensembleSize) => {
      const issueId = "issue-partial";
      const issue = validIssue({
        id: issueId,
        state: "Todo",
        stateType: "unstarted",
        blockers: [],
        assignedToWorker: true,
      });
      const settings = makeSettings({ ensembleSize });
      const claimed = new Set<string>();
      for (let i = 0; i < ensembleSize - 1; i++) claimed.add(slotKey(issueId, i));
      assert.equal(
        shouldDispatchIssue(issue, settings, { runningCount: 0, claimedSlots: claimed }),
        true,
      );
    }),
    { numRuns: 50 },
  );
});

test("slotKey is injective -- different inputs produce different keys", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 30 }),
      fc.string({ minLength: 1, maxLength: 30 }),
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 0, max: 100 }),
      (issueIdA, issueIdB, slotA, slotB) => {
        if (issueIdA !== issueIdB)
          assert.notEqual(slotKey(issueIdA, slotA), slotKey(issueIdB, slotA));
        if (slotA !== slotB) assert.notEqual(slotKey(issueIdA, slotA), slotKey(issueIdA, slotB));
        assert.equal(slotKey(issueIdA, slotA), slotKey(issueIdA, slotA));
      },
    ),
    { numRuns: 500 },
  );
});

test("claiming slots for a different issue does not block this issue", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 5 }),
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim() !== ""),
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim() !== ""),
      (ensembleSize, issueIdA, issueIdB) => {
        fc.pre(issueIdA !== issueIdB);
        const issue = validIssue({
          id: issueIdA,
          state: "Todo",
          stateType: "unstarted",
          blockers: [],
          assignedToWorker: true,
        });
        const settings = makeSettings({ ensembleSize });
        const claimed = new Set<string>();
        for (let i = 0; i < ensembleSize; i++) claimed.add(slotKey(issueIdB, i));
        assert.equal(
          shouldDispatchIssue(issue, settings, { runningCount: 0, claimedSlots: claimed }),
          true,
        );
      },
    ),
    { numRuns: 100 },
  );
});

// INVARIANT: When all worker hosts are at capacity, the system SHALL not dispatch new work.

test("workerCapacityAvailable=false SHALL block dispatch", () => {
  fc.assert(
    fc.property(fc.constantFrom("Todo", "In Progress"), (activeState) => {
      const issue = validIssue({
        state: activeState,
        stateType: "unstarted",
        blockers: [],
        assignedToWorker: true,
      });
      const settings = makeSettings();
      const state = {
        runningCount: 0,
        claimedSlots: new Set<string>(),
        workerCapacityAvailable: false,
      };
      assert.equal(dispatchBlockReason(issue, settings, state), "worker_host_capacity");
      assert.equal(shouldDispatchIssue(issue, settings, state), false);
    }),
    { numRuns: 20 },
  );
});

test("workerCapacityAvailable=true or undefined does NOT block", () => {
  fc.assert(
    fc.property(fc.constantFrom(true, undefined), (workerCapacity) => {
      const issue = validIssue({
        state: "Todo",
        stateType: "unstarted",
        blockers: [],
        assignedToWorker: true,
      });
      const settings = makeSettings();
      const state = {
        runningCount: 0,
        claimedSlots: new Set<string>(),
        workerCapacityAvailable: workerCapacity,
      };
      assert.notEqual(dispatchBlockReason(issue, settings, state), "worker_host_capacity");
    }),
    { numRuns: 10 },
  );
});

// INVARIANT: When shouldDispatchIssue returns true, all sub-checks SHALL pass.

test("shouldDispatchIssue=true implies ALL sub-checks pass (random issues)", () => {
  fc.assert(
    fc.property(
      issueArb(),
      fc.integer({ min: 0, max: 5 }),
      fc.integer({ min: 1, max: 3 }),
      (issue, runningCount, ensembleSize) => {
        const settings = makeSettings({ ensembleSize, maxConcurrentAgents: 10 });
        const state = { runningCount, claimedSlots: new Set<string>() };
        const result = shouldDispatchIssue(issue, settings, state);
        if (result) {
          assert.equal(issueIsActive(issue, settings), true);
          assert.equal(routedToThisWorker(issue, settings), true);
          assert.equal(issueHasOpenBlockers(issue, settings), false);
          assert.equal(dispatchBlockReason(issue, settings, state), null);
        }
      },
    ),
    { numRuns: 500 },
  );
});

test("if ANY sub-check fails THEN shouldDispatchIssue returns false", () => {
  fc.assert(
    fc.property(
      issueArb({
        validFields: true,
        activeState: false,
        assignedToWorker: true,
        hasOpenBlockers: false,
      }),
      (issue) => {
        const settings = makeSettings();
        const state = { runningCount: 0, claimedSlots: new Set<string>() };
        assert.equal(issueIsActive(issue, settings), false);
        assert.equal(shouldDispatchIssue(issue, settings, state), false);
      },
    ),
    { numRuns: 100 },
  );
});
