import { test } from "vitest";
import fc from "fast-check";
import type { Issue } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

import { ensembleSize, normalizeIssue } from "@symphony/issue";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function issueWith(labels: string[]): Issue {
  return {
    id: "id-1",
    identifier: "TEST-1",
    title: "Test issue",
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

/**
 * Creates a normalized issue through the production pipeline with the given
 * raw labels. This exercises the full normalizeIssue -> ensembleSize path.
 */
function normalizedIssueWith(rawLabels: string[]): Issue {
  return normalizeIssue({
    id: "id-1",
    identifier: "TEST-1",
    title: "Test issue",
    state: { name: "Todo", type: "unstarted" },
    labels: rawLabels,
  });
}

// Arbitrary: a label string that is definitely NOT a valid ensemble label.
// The filter is only applied to the random string branch (explicit constants
// are guaranteed non-matching by construction).
const nonEnsembleLabelArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !/^ensemble:\d+$/i.test(s.trim())),
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
    "ensemble:two",
    "ensemble:1,000",
    "ensemble:+5",
  ),
);

// Arbitrary: random case permutation of "ensemble"
const randomCaseEnsembleArb = fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }).map((bits) => {
  const base = "ensemble";
  return base
    .split("")
    .map((ch, i) => (bits[i] ? ch.toUpperCase() : ch.toLowerCase()))
    .join("");
});

// INVARIANT: When a valid label with a positive integer is present, the system SHALL use that integer as ensemble size.

test("valid label with positive integer is used as ensemble size", () => {
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

test("very large positive integers are accepted", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 2_000_000 }), (n) => {
      const issue = issueWith([`ensemble:${n}`]);
      const result = ensembleSize(issue);
      assert.equal(result, n);
    }),
  );
});

test("leading zeros in the number are accepted (parsed as decimal)", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 999 }), (n) => {
      // e.g. "ensemble:007" should parse as 7
      const padded = String(n).padStart(3, "0");
      const issue = issueWith([`ensemble:${padded}`]);
      const result = ensembleSize(issue);
      assert.equal(result, n);
    }),
  );
});

// INVARIANT: When multiple valid labels are present, the system SHALL use the first encountered.

test("first valid ensemble label wins when multiple are present", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 5 }),
      (first, rest) => {
        const labels = [`ensemble:${first}`, ...rest.map((n) => `ensemble:${n}`)];
        const issue = issueWith(labels);
        assert.equal(ensembleSize(issue), first);
      },
    ),
    { numRuns: 200 },
  );
});

test("first valid label wins even when interleaved with invalid labels", () => {
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

test("order matters: swapping labels changes result", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 51, max: 100 }), (a, b) => {
      const issueAB = issueWith([`ensemble:${a}`, `ensemble:${b}`]);
      const issueBA = issueWith([`ensemble:${b}`, `ensemble:${a}`]);
      assert.equal(ensembleSize(issueAB), a);
      assert.equal(ensembleSize(issueBA), b);
    }),
    { numRuns: 200 },
  );
});

// INVARIANT: When a label specifies zero or a negative integer, the system SHALL ignore it.

test("any label with numeric value <= 0 is ignored", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constant("ensemble:0"),
        fc.constant("ensemble:00"),
        fc.constant("ensemble:000"),
        // Negative integers produce labels like "ensemble:-5" which don't match
        // the pattern at all (no \d+ match for negative sign)
        fc.integer({ min: -10000, max: -1 }).map((n) => `ensemble:${n}`),
      ),
      (label) => {
        const issue = issueWith([label]);
        assert.equal(ensembleSize(issue), null);
      },
    ),
  );
});

test("zero label followed by valid label: valid label is used", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100 }), (n) => {
      // ensemble:0 is skipped, ensemble:n is returned
      const issue = issueWith(["ensemble:0", `ensemble:${n}`]);
      assert.equal(ensembleSize(issue), n);
    }),
  );
});

test("multiple non-positive labels all ignored, first valid wins", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          fc.constant("ensemble:0"),
          fc.constant("ensemble:00"),
          fc.integer({ min: -1000, max: -1 }).map((n) => `ensemble:${n}`),
        ),
        { minLength: 1, maxLength: 5 },
      ),
      fc.integer({ min: 1, max: 100 }),
      (invalidLabels, validN) => {
        // All invalid labels followed by one valid label
        const issue = issueWith([...invalidLabels, `ensemble:${validN}`]);
        assert.equal(ensembleSize(issue), validN);
      },
    ),
  );
});

// INVARIANT: When matching ensemble labels, matching SHALL be case-insensitive and whitespace-insensitive.

test("end-to-end: mixed-case labels resolve correctly through normalizeIssue", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100 }), randomCaseEnsembleArb, (n, cased) => {
      const rawLabel = `${cased}:${n}`;
      const issue = normalizedIssueWith([rawLabel]);
      assert.equal(ensembleSize(issue), n);
    }),
    { numRuns: 200 },
  );
});

test("end-to-end: whitespace-padded labels resolve correctly through normalizeIssue", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      fc.constantFrom(" ", "\t", "  ", " \t "),
      (n, ws) => {
        const variants = [`${ws}ensemble:${n}`, `ensemble:${n}${ws}`, `${ws}ensemble:${n}${ws}`];
        for (const rawLabel of variants) {
          const issue = normalizedIssueWith([rawLabel]);
          assert.equal(ensembleSize(issue), n);
        }
      },
    ),
  );
});

test("end-to-end: combined random case and whitespace through normalizeIssue", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      randomCaseEnsembleArb,
      fc.constantFrom("", " ", "\t", "  "),
      fc.constantFrom("", " ", "\t", "  "),
      (n, cased, wsBefore, wsAfter) => {
        const rawLabel = `${wsBefore}${cased}:${n}${wsAfter}`;
        const issue = normalizedIssueWith([rawLabel]);
        assert.equal(ensembleSize(issue), n);
      },
    ),
    { numRuns: 200 },
  );
});

test("internal whitespace between colon and number does NOT match", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100 }), (n) => {
      // Space between colon and number should fail even through the pipeline
      const issue = normalizedIssueWith([`ensemble: ${n}`]);
      assert.equal(ensembleSize(issue), null);
    }),
  );
});

test("internal whitespace within 'ensemble' keyword does NOT match", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100 }), (n) => {
      // "ens emble:5" should not match even through the pipeline
      const issue = normalizedIssueWith([`ens emble:${n}`]);
      assert.equal(ensembleSize(issue), null);
    }),
  );
});

// INVARIANT: When no valid ensemble label is present, the system SHALL return null.

test("no ensemble labels at all yields null", () => {
  fc.assert(
    fc.property(fc.array(nonEnsembleLabelArb, { minLength: 0, maxLength: 10 }), (labels) => {
      const issue = issueWith(labels);
      assert.equal(ensembleSize(issue), null);
    }),
    { numRuns: 200 },
  );
});

test("labels with non-numeric ensemble values yield null", () => {
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
      (labels) => {
        const issue = issueWith(labels);
        assert.equal(ensembleSize(issue), null);
      },
    ),
  );
});

test("unicode lookalikes and special characters do not match", () => {
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

test("non-whitespace control characters embedded in label prevent matching", () => {
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
          assert.equal(ensembleSize(issue), null);
        }
      },
    ),
  );
});

test("partial prefix matches do not count", () => {
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
  );
});

test("suffix after number prevents matching", () => {
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
  );
});

// INVARIANT: When ensembleSize returns a value, it SHALL be a positive integer (never NaN, Infinity, fractional, or negative).

test("return value is always null or positive integer (comprehensive inputs)", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          fc.string({ minLength: 0, maxLength: 30 }),
          fc.integer({ min: -1000, max: 10000 }).map((n) => `ensemble:${n}`),
          fc.constant(""),
          fc.constant("ensemble:"),
          nonEnsembleLabelArb,
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
    { numRuns: 300 },
  );
});
