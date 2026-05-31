import { test } from "vitest";
import fc from "fast-check";
import { ensembleSize, isTerminalState } from "@symphony/cli";
import { ENSEMBLE_SIZE_MAX } from "@symphony/config";
import type { Issue } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

function issueWith(labels: string[]): Issue {
  return {
    id: "id-1",
    identifier: "TEST-1",
    title: "Test",
    state: "Todo",
    stateType: "unstarted",
    description: null,
    branchName: null,
    url: null,
    priority: null,
    createdAt: null,
    updatedAt: null,
    labels,
    blockers: [],
    assigneeId: null,
    assignedToWorker: true,
  };
}

test("ensembleSize — valid ensemble label returns positive integer", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: ENSEMBLE_SIZE_MAX }), (n) => {
      const issue = issueWith([`ensemble:${n}`]);
      const result = ensembleSize(issue);
      assert.equal(result, n);
      assert.ok(result !== null && result >= 1);
      assert.ok(Number.isInteger(result));
    }),
  );
});

test("ensembleSize — first valid label wins", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 50 }),
      fc.integer({ min: 1, max: 50 }),
      (first, second) => {
        const issue = issueWith([`ensemble:${first}`, `ensemble:${second}`]);
        assert.equal(ensembleSize(issue), first);
      },
    ),
  );
});

test("ensembleSize — returns null when no valid label", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !/^ensemble:\d+$/i.test(s.trim())),
        { maxLength: 5 },
      ),
      (labels) => {
        const issue = issueWith(labels);
        assert.equal(ensembleSize(issue), null);
      },
    ),
  );
});

test("ensembleSize — zero or negative numbers return null", () => {
  fc.assert(
    fc.property(fc.integer({ min: -100, max: 0 }), (n) => {
      const issue = issueWith([`ensemble:${n}`]);
      assert.equal(ensembleSize(issue), null);
    }),
  );
});

test("ensembleSize — case insensitive and trims", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 50 }), (n) => {
      const variations = [`ensemble:${n}`, ` ensemble:${n} `, `ENSEMBLE:${n}`, `Ensemble:${n}`];
      for (const label of variations) {
        const issue = issueWith([label]);
        assert.equal(ensembleSize(issue), n);
      }
    }),
  );
});

// --- isTerminalState ---

test("isTerminalState — null/undefined state is never terminal", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 15 }), { minLength: 1, maxLength: 5 }),
      (terminalStates) => {
        assert.ok(!isTerminalState(null, terminalStates));
        assert.ok(!isTerminalState(undefined, terminalStates));
      },
    ),
  );
});

test("isTerminalState — case insensitive matching", () => {
  const alpha = "abcdefghijklmnopqrstuvwxyz";
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...alpha), { minLength: 1, maxLength: 10 }).map((a) => a.join("")),
      (state) => {
        const terminalStates = [state];
        assert.ok(isTerminalState(state.toUpperCase(), terminalStates));
        assert.ok(isTerminalState(state.toLowerCase(), terminalStates));
      },
    ),
  );
});

test("isTerminalState — whitespace trimmed during comparison", () => {
  const alpha = "abcdefghij";
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...alpha), { minLength: 1, maxLength: 10 }).map((a) => a.join("")),
      (state) => {
        const terminalStates = [state];
        assert.ok(isTerminalState(`  ${state}  `, terminalStates));
      },
    ),
  );
});

test("isTerminalState — state not in list returns false", () => {
  const setA = "abcdefghij";
  const setB = "klmnopqrst";
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...setA), { minLength: 1, maxLength: 10 }).map((a) => a.join("")),
      fc.array(
        fc.array(fc.constantFrom(...setB), { minLength: 1, maxLength: 10 }).map((a) => a.join("")),
        { minLength: 1, maxLength: 5 },
      ),
      (state, terminalStates) => {
        assert.ok(!isTerminalState(state, terminalStates));
      },
    ),
  );
});
