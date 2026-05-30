import { test } from "vitest";
import fc from "fast-check";
import { ensembleSize } from "@symphony/cli";
import type { Issue } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_ENSEMBLE_SIZE = 1;

function issueWith(labels: string[]): Issue {
  return {
    id: "id-1",
    identifier: "TEST-1",
    title: "Test issue",
    state: "Todo",
    stateType: null,
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

/**
 * Resolves the effective ensemble size from an issue, falling back to the
 * configured default when ensembleSize returns null. This mirrors what the
 * runtime does but does NOT duplicate the label-parsing logic.
 */
function resolveEnsembleSize(issue: Issue, defaultSize: number = DEFAULT_ENSEMBLE_SIZE): number {
  return ensembleSize(issue) ?? defaultSize;
}

// Arbitrary: a label string that is definitely NOT a valid ensemble label.
const nonEnsembleLabelArb = fc
  .oneof(
    // Random strings filtered to not match
    fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !/^ensemble:\d+$/i.test(s.trim())),
    // Explicitly tricky near-misses
    fc.constantFrom(
      "ensemble:",
      "ensemble:abc",
      "ensemble:1.5",
      "ensemble:-1",
      "ensemble:0x10",
      "ensemble:1e3",
      "ensemble: 5",
      "ensembl:3",
      "Ensemble",
      ":5",
      "bug",
      "feature",
      "",
      "ensemble:two",
      "ensemble:1,000",
      "ensemble:+5",
    ),
  )
  .filter((s) => !/^ensemble:\d+$/i.test(s.trim()));

// Arbitrary: random case permutation of "ensemble"
const randomCaseEnsembleArb = fc
  .array(fc.boolean(), { minLength: 8, maxLength: 8 })
  .map((bits) => {
    const base = "ensemble";
    return base
      .split("")
      .map((ch, i) => (bits[i] ? ch.toUpperCase() : ch.toLowerCase()))
      .join("");
  });

// Arbitrary: whitespace padding (leading/trailing)
const whitespaceArb = fc
  .array(fc.constantFrom(" ", "\t", "  ", "\t "), { minLength: 0, maxLength: 3 })
  .map((a) => a.join(""));

// ---------------------------------------------------------------------------
// Invariant 1: When a valid label with a positive integer is present, the
// system SHALL use that integer as ensemble size.
// ---------------------------------------------------------------------------

test("Invariant 1 -- valid label with positive integer is used as ensemble size", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 10000 }),
      fc.array(nonEnsembleLabelArb, { minLength: 0, maxLength: 5 }),
      (n, noise) => {
        // Place the valid label among noise labels at the front
        const labels = [`ensemble:${n}`, ...noise];
        const issue = issueWith(labels);
        const result = ensembleSize(issue);
        assert.equal(result, n);
        assert.ok(Number.isInteger(result));
        assert.ok(result !== null && result > 0);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 1 -- valid label at the end of a list is still found", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 500 }),
      fc.array(nonEnsembleLabelArb, { minLength: 1, maxLength: 8 }),
      (n, noise) => {
        // Place the valid label at the END among only invalid noise labels
        const labels = [...noise, `ensemble:${n}`];
        const issue = issueWith(labels);
        const result = ensembleSize(issue);
        assert.equal(result, n);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 1 -- very large positive integers are accepted", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 2_000_000 }), (n) => {
      const issue = issueWith([`ensemble:${n}`]);
      const result = ensembleSize(issue);
      assert.equal(result, n);
    }),
    { numRuns: 200 },
  );
});

test("Invariant 1 -- boundary value: ensemble:1 is the minimum valid size", () => {
  const issue = issueWith(["ensemble:1"]);
  const result = ensembleSize(issue);
  assert.equal(result, 1);
});

test("Invariant 1 -- leading zeros in the number are accepted (parsed as decimal)", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 999 }), (n) => {
      // e.g. "ensemble:007" should parse as 7
      const padded = String(n).padStart(3, "0");
      const issue = issueWith([`ensemble:${padded}`]);
      const result = ensembleSize(issue);
      assert.equal(result, n);
    }),
    { numRuns: 200 },
  );
});

test("Invariant 1 -- result is always a positive integer (type correctness)", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 50000 }), (n) => {
      const issue = issueWith([`ensemble:${n}`]);
      const result = ensembleSize(issue);
      // Not null
      assert.ok(result !== null);
      // Is a finite number
      assert.ok(Number.isFinite(result));
      // Is an integer (no fractional part)
      assert.equal(result, Math.floor(result!));
      // Is positive
      assert.ok(result! > 0);
    }),
    { numRuns: 200 },
  );
});

// ---------------------------------------------------------------------------
// Invariant 2: When multiple valid labels are present, the system SHALL use
// the first encountered.
// ---------------------------------------------------------------------------

test("Invariant 2 -- first valid ensemble label wins when multiple are present", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 5 }),
      (first, rest) => {
        // Ensure at least one value in rest differs from first to avoid tautology
        const labels = [`ensemble:${first}`, ...rest.map((n) => `ensemble:${n}`)];
        const issue = issueWith(labels);
        assert.equal(ensembleSize(issue), first);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 2 -- first valid label wins with guaranteed different values", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 50 }),
      fc.integer({ min: 51, max: 100 }),
      (first, second) => {
        // first and second are guaranteed different due to non-overlapping ranges
        const labels = [`ensemble:${first}`, `ensemble:${second}`];
        const issue = issueWith(labels);
        const result = ensembleSize(issue);
        assert.equal(result, first);
        // Additionally verify it did NOT return second
        assert.notEqual(result, second);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 2 -- first valid label wins even when interleaved with invalid labels", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 50 }),
      fc.integer({ min: 51, max: 100 }),
      fc.array(nonEnsembleLabelArb, { minLength: 0, maxLength: 3 }),
      (first, second, noise) => {
        // noise -> valid(first) -> noise -> valid(second)
        const labels = [...noise, `ensemble:${first}`, ...noise, `ensemble:${second}`];
        const issue = issueWith(labels);
        assert.equal(ensembleSize(issue), first);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 2 -- order matters: swapping labels changes result", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 50 }),
      fc.integer({ min: 51, max: 100 }),
      (a, b) => {
        const issueAB = issueWith([`ensemble:${a}`, `ensemble:${b}`]);
        const issueBA = issueWith([`ensemble:${b}`, `ensemble:${a}`]);
        assert.equal(ensembleSize(issueAB), a);
        assert.equal(ensembleSize(issueBA), b);
      },
    ),
    { numRuns: 200 },
  );
});

// ---------------------------------------------------------------------------
// Invariant 3: When a label specifies zero or a negative integer, the system
// SHALL ignore it and use the default.
// ---------------------------------------------------------------------------

test("Invariant 3 -- zero in ensemble label is ignored, system uses default", () => {
  const issue = issueWith(["ensemble:0"]);
  const result = resolveEnsembleSize(issue);
  assert.equal(result, DEFAULT_ENSEMBLE_SIZE);
  // Raw function returns null to signal no valid label found
  assert.equal(ensembleSize(issue), null);
});

test("Invariant 3 -- negative integers in ensemble label are ignored (regex does not match negatives)", () => {
  fc.assert(
    fc.property(fc.integer({ min: -10000, max: -1 }), (n) => {
      // Negative numbers produce labels like "ensemble:-5" which don't match \d+ pattern
      const issue = issueWith([`ensemble:${n}`]);
      assert.equal(ensembleSize(issue), null);
      assert.equal(resolveEnsembleSize(issue), DEFAULT_ENSEMBLE_SIZE);
    }),
    { numRuns: 200 },
  );
});

test("Invariant 3 -- zero is ignored and system falls back to configured default", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 50 }), (configuredDefault) => {
      const issue = issueWith(["ensemble:0"]);
      assert.equal(resolveEnsembleSize(issue, configuredDefault), configuredDefault);
    }),
    { numRuns: 200 },
  );
});

test("Invariant 3 -- multiple zeros and negative labels all ignored", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          fc.constant("ensemble:0"),
          fc.integer({ min: -1000, max: -1 }).map((n) => `ensemble:${n}`),
          fc.constant("ensemble:00"),
          fc.constant("ensemble:000"),
        ),
        { minLength: 1, maxLength: 5 },
      ),
      fc.integer({ min: 1, max: 20 }),
      (labels, configuredDefault) => {
        const issue = issueWith(labels);
        assert.equal(ensembleSize(issue), null);
        assert.equal(resolveEnsembleSize(issue, configuredDefault), configuredDefault);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 3 -- zero label followed by valid label: valid label is used", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100 }), (n) => {
      // ensemble:0 is skipped, ensemble:n is returned
      const issue = issueWith(["ensemble:0", `ensemble:${n}`]);
      assert.equal(ensembleSize(issue), n);
    }),
    { numRuns: 200 },
  );
});

// ---------------------------------------------------------------------------
// Invariant 4: When matching ensemble labels, matching SHALL be
// case-insensitive and whitespace-insensitive.
// ---------------------------------------------------------------------------

test("Invariant 4 -- matching is case-insensitive", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100 }), (n) => {
      const variants = [
        `ensemble:${n}`,
        `ENSEMBLE:${n}`,
        `Ensemble:${n}`,
        `eNsEmBlE:${n}`,
        `ENSEMBLE:${n}`,
      ];
      for (const label of variants) {
        const issue = issueWith([label]);
        assert.equal(ensembleSize(issue), n);
      }
    }),
    { numRuns: 200 },
  );
});

test("Invariant 4 -- matching is whitespace-insensitive (leading/trailing spaces)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      fc.array(fc.constantFrom(" ", "\t", "  "), { minLength: 1, maxLength: 3 }).map((a) =>
        a.join(""),
      ),
      (n, ws) => {
        const variants = [`${ws}ensemble:${n}`, `ensemble:${n}${ws}`, `${ws}ensemble:${n}${ws}`];
        for (const label of variants) {
          const issue = issueWith([label]);
          assert.equal(ensembleSize(issue), n);
        }
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 4 -- random case permutation is still matched", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100 }), randomCaseEnsembleArb, (n, cased) => {
      const label = `${cased}:${n}`;
      const issue = issueWith([label]);
      assert.equal(ensembleSize(issue), n);
    }),
    { numRuns: 200 },
  );
});

test("Invariant 4 -- combined random case and whitespace padding", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      randomCaseEnsembleArb,
      whitespaceArb,
      whitespaceArb,
      (n, cased, wsBefore, wsAfter) => {
        const label = `${wsBefore}${cased}:${n}${wsAfter}`;
        const issue = issueWith([label]);
        assert.equal(ensembleSize(issue), n);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 4 -- internal whitespace between colon and number does NOT match", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100 }), (n) => {
      // Space between colon and number should fail the regex
      const issue = issueWith([`ensemble: ${n}`]);
      assert.equal(ensembleSize(issue), null);
    }),
    { numRuns: 200 },
  );
});

test("Invariant 4 -- internal whitespace within 'ensemble' keyword does NOT match", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100 }), (n) => {
      // "ens emble:5" should not match
      const issue = issueWith([`ens emble:${n}`]);
      assert.equal(ensembleSize(issue), null);
    }),
    { numRuns: 200 },
  );
});

// ---------------------------------------------------------------------------
// Invariant 5: When no valid ensemble label is present, the system SHALL use
// the configured default.
// ---------------------------------------------------------------------------

test("Invariant 5 -- no ensemble labels at all yields configured default", () => {
  fc.assert(
    fc.property(
      fc.array(nonEnsembleLabelArb, { minLength: 0, maxLength: 10 }),
      fc.integer({ min: 1, max: 20 }),
      (labels, configuredDefault) => {
        const issue = issueWith(labels);
        assert.equal(ensembleSize(issue), null);
        assert.equal(resolveEnsembleSize(issue, configuredDefault), configuredDefault);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 5 -- empty labels array yields configured default", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 50 }), (configuredDefault) => {
      const issue = issueWith([]);
      assert.equal(ensembleSize(issue), null);
      assert.equal(resolveEnsembleSize(issue, configuredDefault), configuredDefault);
    }),
    { numRuns: 200 },
  );
});

test("Invariant 5 -- labels with non-numeric ensemble values yield default", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          fc.constant("ensemble:"),
          fc.constant("ensemble:abc"),
          fc.constant("ensemble:1.5"),
          fc.constant("ensemble:two"),
          fc.constant("ensemble: "),
          fc.constant("ensemble:1e3"),
          fc.constant("ensemble:0xFF"),
          fc.constant("ensemble:+1"),
          fc.constant("ensemble:1_000"),
          fc.constant("ensemble:NaN"),
          fc.constant("ensemble:Infinity"),
        ),
        { minLength: 1, maxLength: 5 },
      ),
      fc.integer({ min: 1, max: 20 }),
      (labels, configuredDefault) => {
        const issue = issueWith(labels);
        assert.equal(ensembleSize(issue), null);
        assert.equal(resolveEnsembleSize(issue, configuredDefault), configuredDefault);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 5 -- unicode lookalikes and special characters do not match", () => {
  const trickLabels = [
    "ensemble:١٢٣", // Arabic-Indic digits that look like 123
    "ensemble:５", // Fullwidth digit 5
    "еnsemble:5", // Cyrillic 'e' (U+0435) looks like Latin 'e'
    "ensémble:3", // e-acute in ensemble
    "ensemble​:4", // zero-width space inside keyword
    "ensemble:​5", // zero-width space before digit
    "ensemble:5​", // zero-width space after digit
    "ensemble:۵", // Extended Arabic-Indic digit 5
    "ｅnsemble:5", // Fullwidth 'e'
  ];
  for (const label of trickLabels) {
    const issue = issueWith([label]);
    assert.equal(ensembleSize(issue), null);
  }
});

test("Invariant 5 -- non-whitespace control characters embedded in label prevent matching", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      // Only use control chars that are NOT whitespace (trim won't strip them)
      fc.constantFrom("\x00", "\x01", "\x02", "\x0E", "\x0F", "\x7F"),
      (n, controlChar) => {
        // Embedding non-whitespace control chars within the keyword or between colon and number
        const labels = [
          `ensemble:${controlChar}${n}`, // control char before digits
          `ensemble${controlChar}:${n}`, // control char before colon
          `ens${controlChar}emble:${n}`, // control char inside keyword
        ];
        for (const label of labels) {
          const issue = issueWith([label]);
          // Should not match (non-whitespace control char breaks the pattern)
          assert.equal(ensembleSize(issue), null);
        }
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 5 -- whitespace control chars at start/end are trimmed (label still matches)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      // Whitespace chars that trim() removes
      fc.constantFrom("\n", "\r", "\t", " ", "\x0B", "\x0C"),
      (n, wsChar) => {
        // Leading/trailing whitespace gets trimmed, so label should match
        const issue = issueWith([`${wsChar}ensemble:${n}${wsChar}`]);
        assert.equal(ensembleSize(issue), n);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 5 -- partial prefix matches do not count", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      fc.constantFrom("pre-", "x", "my-", "not"),
      (n, prefix) => {
        // Labels like "pre-ensemble:5" or "xensemble:5" should not match
        const issue = issueWith([`${prefix}ensemble:${n}`]);
        assert.equal(ensembleSize(issue), null);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 5 -- suffix after number prevents matching", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      fc.constantFrom("px", " units", "x", "-large", "+"),
      (n, suffix) => {
        // Labels like "ensemble:5px" or "ensemble:5 units" should not match
        const issue = issueWith([`ensemble:${n}${suffix}`]);
        assert.equal(ensembleSize(issue), null);
      },
    ),
    { numRuns: 200 },
  );
});

// ---------------------------------------------------------------------------
// Invariant 6 (implied): The function is pure -- same input always produces
// the same output. No hidden mutable state.
// ---------------------------------------------------------------------------

test("Invariant 6 -- ensembleSize is referentially transparent (pure)", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 0, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
      (labels) => {
        const issue = issueWith(labels);
        const result1 = ensembleSize(issue);
        const result2 = ensembleSize(issue);
        const result3 = ensembleSize(issue);
        assert.equal(result1, result2);
        assert.equal(result2, result3);
      },
    ),
    { numRuns: 200 },
  );
});

// ---------------------------------------------------------------------------
// Invariant 7 (implied): The return type is always either null or a positive
// integer. Never NaN, Infinity, fractional, or negative.
// ---------------------------------------------------------------------------

test("Invariant 7 -- return value is always null or positive integer (comprehensive inputs)", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          fc.string({ minLength: 0, maxLength: 30 }),
          fc.integer({ min: -1000, max: 10000 }).map((n) => `ensemble:${n}`),
          fc.constant(""),
          fc.constant("ensemble:"),
          fc.string({ minLength: 0, maxLength: 20 }),
        ),
        { minLength: 0, maxLength: 8 },
      ),
      (labels) => {
        const issue = issueWith(labels);
        const result = ensembleSize(issue);
        if (result === null) return; // null is valid
        // If not null, must be a positive integer
        assert.ok(typeof result === "number");
        assert.ok(Number.isFinite(result));
        assert.ok(Number.isInteger(result));
        assert.ok(result > 0);
      },
    ),
    { numRuns: 200 },
  );
});
