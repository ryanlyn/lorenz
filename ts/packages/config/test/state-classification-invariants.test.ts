import { test, describe } from "vitest";
import fc from "fast-check";
import { normalizeStateName, isTerminalState } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

describe("INVARIANT: When states are normalized, normalization SHALL be case-insensitive.", () => {
  test("normalizeStateName — mixed case variants all normalize to the same value", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 40 }),
        (input, casePattern) => {
          // Create a random casing of the input
          const randomCased = input
            .split("")
            .map((ch, i) =>
              casePattern[i % casePattern.length] ? ch.toUpperCase() : ch.toLowerCase(),
            )
            .join("");
          assert.equal(normalizeStateName(randomCased), normalizeStateName(input));
        },
      ),
      { numRuns: 1000 },
    );
  });
});

test("normalizeStateName — output is always fully lowercase (no uppercase chars remain)", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 50 }), (input) => {
      const result = normalizeStateName(input);
      assert.equal(result, result.toLowerCase());
    }),
    { numRuns: 1000 },
  );
});

describe("INVARIANT: When state normalization is applied twice, the result SHALL be the same.", () => {
  test("normalizeStateName — applying normalization twice yields the same result as once (idempotent)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 100 }), (input) => {
        const once = normalizeStateName(input);
        const twice = normalizeStateName(once);
        assert.equal(twice, once);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("INVARIANT: When states are normalized, leading and trailing whitespace SHALL be stripped.", () => {
  test("normalizeStateName — leading and trailing whitespace is stripped", () => {
    const whitespaceArb = fc
      .array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 1, maxLength: 5 })
      .map((a) => a.join(""));
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }),
        whitespaceArb,
        whitespaceArb,
        (core, leading, trailing) => {
          const padded = leading + core + trailing;
          assert.equal(normalizeStateName(padded), normalizeStateName(core));
        },
      ),
      { numRuns: 1000 },
    );
  });
});

test("normalizeStateName — result never starts or ends with whitespace (non-empty input)", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 50 }), (input) => {
      const result = normalizeStateName(input);
      if (result.length > 0) {
        assert.equal(result, result.trim());
      }
    }),
    { numRuns: 1000 },
  );
});

test("normalizeStateName — whitespace-only input normalizes to empty string", () => {
  const whitespaceOnlyArb = fc
    .array(fc.constantFrom(" ", "\t", "\n", "\r", "\x0B", "\x0C"), { minLength: 1, maxLength: 20 })
    .map((a) => a.join(""));
  fc.assert(
    fc.property(whitespaceOnlyArb, (input) => {
      assert.equal(normalizeStateName(input), "");
    }),
    { numRuns: 1000 },
  );
});

test("normalizeStateName — internal whitespace is preserved (only leading/trailing stripped)", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
      fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
      (left, right) => {
        const leftTrimmed = left.trim().toLowerCase();
        const rightTrimmed = right.trim().toLowerCase();
        // A string like "foo bar" should preserve the internal space and both parts
        const withSpace = `${left.trim()} ${right.trim()}`;
        const result = normalizeStateName(withSpace);
        // Verify both trimmed parts appear in the result separated by a space
        assert.ok(result.includes(leftTrimmed));
        assert.ok(result.includes(rightTrimmed));
        assert.ok(result.includes(" "));
      },
    ),
    { numRuns: 1000 },
  );
});

describe("INVARIANT: When a state value is null or undefined, it SHALL be classified as non-terminal.", () => {
  test("isTerminalState — null and undefined states are always classified as non-terminal", () => {
    // The function short-circuits on falsy state before examining the list,
    // so a simple unit test suffices -- random lists add no value here.
    assert.equal(isTerminalState(null, []), false);
    assert.equal(isTerminalState(null, ["done", "closed"]), false);
    assert.equal(isTerminalState(null, ["", " ", "null", "NULL"]), false);
    assert.equal(isTerminalState(undefined, []), false);
    assert.equal(isTerminalState(undefined, ["done", "closed"]), false);
    assert.equal(isTerminalState(undefined, ["", " ", "undefined", "UNDEFINED"]), false);
  });
});

describe("INVARIANT: When a state value is unknown, it SHALL be classified as non-terminal.", () => {
  test("isTerminalState — a state not in the terminal list is classified as non-terminal", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 1, maxLength: 10 }),
        (state, terminalStates) => {
          // Use the exported normalizeStateName to check the precondition,
          // ensuring we test the actual contract between the two functions.
          fc.pre(!terminalStates.map(normalizeStateName).includes(normalizeStateName(state)));

          assert.equal(isTerminalState(state, terminalStates), false);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

test("isTerminalState — a state distinct by one character from all terminals is non-terminal", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 2, maxLength: 20 }).filter((s) => s.trim().length > 1),
      fc.nat({ max: 25 }),
      (baseState, charOffset) => {
        // Create a terminal list with the base state
        const terminalStates = [baseState];
        // Mutate one character to create a definitely-different state
        const chars = baseState.split("");
        const idx = charOffset % chars.length;
        const original = chars[idx]!;
        // Shift the character code to ensure it differs
        chars[idx] = String.fromCharCode(original.charCodeAt(0) ^ 1);
        const mutated = chars.join("");
        // Only test if the mutation actually produces a different normalized value
        fc.pre(normalizeStateName(mutated) !== normalizeStateName(baseState));
        fc.pre(normalizeStateName(mutated).length > 0);

        assert.equal(isTerminalState(mutated, terminalStates), false);
      },
    ),
    { numRuns: 1000 },
  );
});

test("isTerminalState — empty terminal list means all states are non-terminal", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 50 }), (state) => {
      assert.equal(isTerminalState(state, []), false);
    }),
    { numRuns: 1000 },
  );
});

describe("INVARIANT: When states are compared, comparison SHALL be case-insensitive and whitespace-tolerant.", () => {
  test("isTerminalState — comparison is case-insensitive (any casing of a terminal state matches)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
        (terminalState, otherStates) => {
          const terminalStates = [terminalState, ...otherStates];
          // The same state in uppercase should still be recognized as terminal
          assert.equal(isTerminalState(terminalState.toUpperCase(), terminalStates), true);
          assert.equal(isTerminalState(terminalState.toLowerCase(), terminalStates), true);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

test("isTerminalState — comparison is whitespace-tolerant (padded state matches)", () => {
  const wsArb = fc
    .array(fc.constantFrom(" ", "\t"), { minLength: 1, maxLength: 3 })
    .map((a) => a.join(""));
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
      wsArb,
      wsArb,
      (terminalState, otherStates, leading, trailing) => {
        const terminalStates = [terminalState, ...otherStates];
        const padded = leading + terminalState + trailing;
        assert.equal(isTerminalState(padded, terminalStates), true);
      },
    ),
    { numRuns: 1000 },
  );
});

test("isTerminalState — comparison is both case-insensitive and whitespace-tolerant simultaneously", () => {
  const wsArb = fc
    .array(fc.constantFrom(" ", "\t"), { minLength: 1, maxLength: 3 })
    .map((a) => a.join(""));
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
      wsArb,
      (terminalState, padding) => {
        const terminalStates = [terminalState];
        const variant = padding + terminalState.toUpperCase() + padding;
        assert.equal(isTerminalState(variant, terminalStates), true);
      },
    ),
    { numRuns: 1000 },
  );
});

describe("INVARIANT: When two states normalize to the same value, they SHALL produce the same terminal classification.", () => {
  test("isTerminalState — a state matches its own normalized form in the terminal list", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
        (state) => {
          // If we put the normalized form in the terminal list, any case/whitespace variant should match
          const normalized = normalizeStateName(state);
          assert.equal(isTerminalState(state, [normalized]), true);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

test("isTerminalState — normalizeStateName equivalence implies isTerminalState equivalence", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
      fc.array(
        fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
        {
          minLength: 1,
          maxLength: 5,
        },
      ),
      (stateA, stateB, terminalStates) => {
        // If two states normalize to the same value, they must produce the same terminal classification
        if (normalizeStateName(stateA) === normalizeStateName(stateB)) {
          assert.equal(
            isTerminalState(stateA, terminalStates),
            isTerminalState(stateB, terminalStates),
          );
        }
      },
    ),
    { numRuns: 1000 },
  );
});
