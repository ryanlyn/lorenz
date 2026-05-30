import { test } from "vitest";
import fc from "fast-check";
import { normalizeStateName, isTerminalState } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

// --- Invariant 1: Normalization SHALL be case-insensitive ---

test("normalizeStateName — normalization is case-insensitive (upper and lower produce same result)", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 30 }), (input) => {
      assert.equal(
        normalizeStateName(input.toUpperCase()),
        normalizeStateName(input.toLowerCase()),
      );
    }),
    { numRuns: 200 },
  );
});

test("normalizeStateName — mixed case variants all normalize to the same value", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
      (input, casePattern) => {
        // Create a random casing of the input
        const randomCased = input
          .split("")
          .map((ch, i) => (casePattern[i % casePattern.length] ? ch.toUpperCase() : ch.toLowerCase()))
          .join("");
        assert.equal(normalizeStateName(randomCased), normalizeStateName(input));
      },
    ),
    { numRuns: 200 },
  );
});

test("normalizeStateName — case-insensitivity holds for unicode characters", () => {
  // Test with characters that have round-trip case mappings.
  // Note: some Unicode characters (e.g. "ß" -> "SS" -> "ss") do not round-trip
  // through toUpperCase().toLowerCase(), so we only test characters where
  // the JavaScript runtime produces consistent case folding.
  const unicodeArb = fc.constantFrom(
    "Σ", // Greek capital sigma
    "σ", // Greek small sigma
    "é", // e with acute
    "É", // E with acute
    "中", // Chinese character (no case)
    "😀", // emoji (no case)
    "ñ", // n with tilde
    "Ñ", // N with tilde
    "ü", // u with diaeresis
    "Ü", // U with diaeresis
    "å", // a with ring above
    "Å", // A with ring above
  );
  fc.assert(
    fc.property(unicodeArb, (input) => {
      // The key property: upper/lower of the same input must converge
      assert.equal(
        normalizeStateName(input.toUpperCase()),
        normalizeStateName(input.toLowerCase()),
      );
    }),
    { numRuns: 200 },
  );
});

test("normalizeStateName — output is always fully lowercase (no uppercase chars remain)", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 40 }), (input) => {
      const result = normalizeStateName(input);
      assert.equal(result, result.toLowerCase());
    }),
    { numRuns: 200 },
  );
});

// --- Invariant 2: Normalization applied twice SHALL produce the same result (idempotent) ---

test("normalizeStateName — applying normalization twice yields the same result as once (idempotent)", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 50 }), (input) => {
      const once = normalizeStateName(input);
      const twice = normalizeStateName(once);
      assert.equal(twice, once);
    }),
    { numRuns: 200 },
  );
});

test("normalizeStateName — idempotency holds for unicode and special characters", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 0, maxLength: 40, unit: "grapheme" }), (input) => {
      const once = normalizeStateName(input);
      const twice = normalizeStateName(once);
      assert.equal(twice, once);
    }),
    { numRuns: 200 },
  );
});

test("normalizeStateName — idempotency holds for strings with control characters and mixed whitespace", () => {
  // Build strings that mix control characters with normal text
  const controlCharArb = fc
    .array(
      fc.oneof(
        fc.string({ minLength: 1, maxLength: 3 }),
        fc.constantFrom(
          "\x00", "\x01", "\x02", "\x0B", "\x0C", "\x1F", "\x7F",
          "​", "﻿", "​", "‌", "‍", "﻿",
        ),
      ),
      { minLength: 1, maxLength: 15 },
    )
    .map((parts) => parts.join(""));
  fc.assert(
    fc.property(controlCharArb, (input) => {
      const once = normalizeStateName(input);
      const twice = normalizeStateName(once);
      assert.equal(twice, once);
    }),
    { numRuns: 200 },
  );
});

test("normalizeStateName — triple application equals single application", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 50 }), (input) => {
      const once = normalizeStateName(input);
      const thrice = normalizeStateName(normalizeStateName(once));
      assert.equal(thrice, once);
    }),
    { numRuns: 200 },
  );
});

// --- Invariant 3: Leading and trailing whitespace SHALL be stripped ---

test("normalizeStateName — leading and trailing whitespace is stripped", () => {
  const whitespaceArb = fc
    .array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 1, maxLength: 5 })
    .map((a) => a.join(""));
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }),
      whitespaceArb,
      whitespaceArb,
      (core, leading, trailing) => {
        const padded = leading + core + trailing;
        assert.equal(normalizeStateName(padded), normalizeStateName(core));
      },
    ),
    { numRuns: 200 },
  );
});

test("normalizeStateName — result never starts or ends with whitespace (non-empty input)", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 30 }), (input) => {
      const result = normalizeStateName(input);
      if (result.length > 0) {
        assert.equal(result, result.trim());
      }
    }),
    { numRuns: 200 },
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
    { numRuns: 200 },
  );
});

test("normalizeStateName — empty string normalizes to empty string", () => {
  assert.equal(normalizeStateName(""), "");
});

test("normalizeStateName — internal whitespace is preserved (only leading/trailing stripped)", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.trim().length > 0),
      fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.trim().length > 0),
      (left, right) => {
        // A string like "foo bar" should preserve the internal space
        const withSpace = `${left.trim()} ${right.trim()}`;
        const result = normalizeStateName(withSpace);
        // The internal space must be preserved
        assert.ok(result.includes(" "));
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 4: Null or undefined state SHALL be classified as non-terminal ---

test("isTerminalState — null state is always classified as non-terminal", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 10 }),
      (terminalStates) => {
        assert.equal(isTerminalState(null, terminalStates), false);
      },
    ),
    { numRuns: 200 },
  );
});

test("isTerminalState — undefined state is always classified as non-terminal", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 10 }),
      (terminalStates) => {
        assert.equal(isTerminalState(undefined, terminalStates), false);
      },
    ),
    { numRuns: 200 },
  );
});

test("isTerminalState — null is non-terminal even when terminal list contains empty-looking strings", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("", " ", "\t", "\n", "null", "undefined", "NULL"), {
        minLength: 1,
        maxLength: 10,
      }),
      (terminalStates) => {
        assert.equal(isTerminalState(null, terminalStates), false);
        assert.equal(isTerminalState(undefined, terminalStates), false);
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 5: Unknown state SHALL be classified as non-terminal ---

test("isTerminalState — a state not in the terminal list is classified as non-terminal", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 10 }),
      (state, terminalStates) => {
        // Ensure the state (normalized) does not appear in the terminal list (normalized)
        const normalizedState = state.trim().toLowerCase();
        const normalizedTerminals = terminalStates.map((s) => s.trim().toLowerCase());
        fc.pre(!normalizedTerminals.includes(normalizedState));

        assert.equal(isTerminalState(state, terminalStates), false);
      },
    ),
    { numRuns: 200 },
  );
});

test("isTerminalState — empty string state is classified as non-terminal", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 10 }),
      (terminalStates) => {
        assert.equal(isTerminalState("", terminalStates), false);
      },
    ),
    { numRuns: 200 },
  );
});

test("isTerminalState — a state distinct by one character from all terminals is non-terminal", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 2, maxLength: 15 }).filter((s) => s.trim().length > 1),
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
        const normalizedMutated = mutated.trim().toLowerCase();
        const normalizedBase = baseState.trim().toLowerCase();
        fc.pre(normalizedMutated !== normalizedBase);
        fc.pre(normalizedMutated.length > 0);

        assert.equal(isTerminalState(mutated, terminalStates), false);
      },
    ),
    { numRuns: 200 },
  );
});

test("isTerminalState — empty terminal list means all states are non-terminal", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 30 }),
      (state) => {
        assert.equal(isTerminalState(state, []), false);
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 6: State comparison SHALL be case-insensitive and whitespace-tolerant ---

test("isTerminalState — comparison is case-insensitive (any casing of a terminal state matches)", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
      fc.array(fc.string({ minLength: 1, maxLength: 15 }), { minLength: 0, maxLength: 5 }),
      (terminalState, otherStates) => {
        const terminalStates = [terminalState, ...otherStates];
        // The same state in uppercase should still be recognized as terminal
        assert.equal(isTerminalState(terminalState.toUpperCase(), terminalStates), true);
        assert.equal(isTerminalState(terminalState.toLowerCase(), terminalStates), true);
      },
    ),
    { numRuns: 200 },
  );
});

test("isTerminalState — comparison is case-insensitive with random mixed casing", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
      fc.array(fc.boolean(), { minLength: 1, maxLength: 15 }),
      (terminalState, casePattern) => {
        const terminalStates = [terminalState];
        // Create random mixed-case variant
        const variant = terminalState
          .split("")
          .map((ch, i) => (casePattern[i % casePattern.length] ? ch.toUpperCase() : ch.toLowerCase()))
          .join("");
        assert.equal(isTerminalState(variant, terminalStates), true);
      },
    ),
    { numRuns: 200 },
  );
});

test("isTerminalState — comparison is whitespace-tolerant (padded state matches)", () => {
  const wsArb = fc
    .array(fc.constantFrom(" ", "\t"), { minLength: 1, maxLength: 3 })
    .map((a) => a.join(""));
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
      fc.array(fc.string({ minLength: 1, maxLength: 15 }), { minLength: 0, maxLength: 5 }),
      wsArb,
      wsArb,
      (terminalState, otherStates, leading, trailing) => {
        const terminalStates = [terminalState, ...otherStates];
        const padded = leading + terminalState + trailing;
        assert.equal(isTerminalState(padded, terminalStates), true);
      },
    ),
    { numRuns: 200 },
  );
});

test("isTerminalState — comparison is whitespace-tolerant for both state and terminal list entries", () => {
  const wsArb = fc
    .array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 1, maxLength: 3 })
    .map((a) => a.join(""));
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
      wsArb,
      wsArb,
      (coreState, leadingState, trailingTerminal) => {
        // The terminal list entry is padded, and the state being checked is also padded differently
        const terminalStates = [coreState + trailingTerminal];
        const paddedState = leadingState + coreState;
        assert.equal(isTerminalState(paddedState, terminalStates), true);
      },
    ),
    { numRuns: 200 },
  );
});

test("isTerminalState — comparison is both case-insensitive and whitespace-tolerant simultaneously", () => {
  const wsArb = fc
    .array(fc.constantFrom(" ", "\t"), { minLength: 1, maxLength: 3 })
    .map((a) => a.join(""));
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
      wsArb,
      (terminalState, padding) => {
        const terminalStates = [terminalState];
        const variant = padding + terminalState.toUpperCase() + padding;
        assert.equal(isTerminalState(variant, terminalStates), true);
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 7: Consistency between normalizeStateName and isTerminalState ---

test("isTerminalState — a state matches its own normalized form in the terminal list", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
      (state) => {
        // If we put the normalized form in the terminal list, any case/whitespace variant should match
        const normalized = normalizeStateName(state);
        assert.equal(isTerminalState(state, [normalized]), true);
      },
    ),
    { numRuns: 200 },
  );
});

test("isTerminalState — normalizeStateName equivalence implies isTerminalState equivalence", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
      fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
      fc.array(fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.trim().length > 0), {
        minLength: 1,
        maxLength: 5,
      }),
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
    { numRuns: 200 },
  );
});

// --- Invariant 8: Negative tests - verify violations are caught ---

test("isTerminalState — a known terminal state returns true (positive confirmation)", () => {
  // This is not tautological: it confirms the implementation actually returns true for matches,
  // not just that it returns false for non-matches
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
      (state) => {
        // The exact state string must be recognized as terminal when it is in the list
        assert.equal(isTerminalState(state, [state]), true);
      },
    ),
    { numRuns: 200 },
  );
});

test("normalizeStateName — result length is at most input length (whitespace removed, case changed)", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 100 }), (input) => {
      const result = normalizeStateName(input);
      // Trimming can only reduce or maintain length, never increase
      assert.ok(result.length <= input.length);
    }),
    { numRuns: 200 },
  );
});

test("normalizeStateName — non-whitespace content is preserved (only case changes)", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
      (input) => {
        const result = normalizeStateName(input);
        // The result lowercased should equal the input trimmed and lowercased
        assert.equal(result, input.trim().toLowerCase());
      },
    ),
    { numRuns: 200 },
  );
});
