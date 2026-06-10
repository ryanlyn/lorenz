import { test, describe } from "vitest";
import fc from "fast-check";
import { sortForDispatch } from "@symphony/cli";
import type { Issue, Priority } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

/**
 * Helper: determines whether a priority value is considered "valid" by the sort.
 * The Priority type enforces values are 1-4 at the type level, so the only
 * "invalid" priority values at runtime are null and undefined.
 */
function isValidPriority(p: number | null | undefined): boolean {
  return p !== null && p !== undefined;
}

/**
 * Helper: determines whether a createdAt value is parseable as a valid date.
 * A valid createdAt is a non-empty string that Date.parse() can interpret.
 */
function isValidCreatedAt(c: string | null | undefined): boolean {
  if (c === null || c === undefined || c === "") return false;
  return !Number.isNaN(Date.parse(c));
}

/**
 * Arbitrary that produces a minimal valid Issue with varied priority and createdAt values.
 * Focuses exotic values on sort-relevant fields (priority, createdAt, identifier).
 */
const arbIssue = (): fc.Arbitrary<Issue> =>
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 20 }),
    identifier: fc.oneof(
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.constant("ENG-999"),
      fc.constant("Z"),
      fc.constant("a"),
    ),
    title: fc.string({ minLength: 1, maxLength: 30 }),
    state: fc.constant("active"),
    stateType: fc.constant("started" as const),
    labels: fc.constant([] as string[]),
    blockers: fc.constant([]),
    priority: fc.oneof(
      fc.constantFrom(1, 2, 3, 4) as fc.Arbitrary<Priority | null | undefined>,
      fc.constant(null as Priority | null | undefined),
      fc.constant(undefined as Priority | null | undefined),
    ),
    createdAt: fc.oneof(
      fc
        .integer({ min: new Date("2000-01-01").getTime(), max: new Date("2040-01-01").getTime() })
        .map((ms) => new Date(ms).toISOString()),
      fc.constant(null as string | null),
      fc.constant(undefined as string | undefined),
      fc.constant(""),
      fc.constant("not-a-valid-date"),
    ),
  });

/**
 * Arbitrary that produces an Issue with a valid in-range priority (1-4) and valid createdAt.
 */
const arbIssueWithValidPriority = (): fc.Arbitrary<Issue> =>
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 20 }),
    identifier: fc.string({ minLength: 1, maxLength: 20 }),
    title: fc.string({ minLength: 1, maxLength: 30 }),
    state: fc.constant("active"),
    stateType: fc.constant("started" as const),
    labels: fc.constant([] as string[]),
    blockers: fc.constant([]),
    priority: fc.constantFrom(1, 2, 3, 4) as fc.Arbitrary<Priority>,
    createdAt: fc
      .integer({ min: new Date("2000-01-01").getTime(), max: new Date("2040-01-01").getTime() })
      .map((ms) => new Date(ms).toISOString()),
  });

/**
 * Arbitrary that produces an Issue with null/undefined priority.
 * The Priority type (1|2|3|4) enforces valid values at the type level,
 * so the only "invalid" priorities at runtime are null and undefined.
 */
const arbIssueWithInvalidPriority = (): fc.Arbitrary<Issue> =>
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 20 }),
    identifier: fc.string({ minLength: 1, maxLength: 20 }),
    title: fc.string({ minLength: 1, maxLength: 30 }),
    state: fc.constant("active"),
    stateType: fc.constant("started" as const),
    labels: fc.constant([] as string[]),
    blockers: fc.constant([]),
    priority: fc.constant(null) as fc.Arbitrary<Priority | null | undefined>,
    createdAt: fc
      .integer({ min: new Date("2000-01-01").getTime(), max: new Date("2040-01-01").getTime() })
      .map((ms) => new Date(ms).toISOString()),
  });

/**
 * Arbitrary that produces an Issue with null/missing/unparseable createdAt.
 */
const arbIssueWithInvalidCreatedAt = (): fc.Arbitrary<Issue> =>
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 20 }),
    identifier: fc.string({ minLength: 1, maxLength: 20 }),
    title: fc.string({ minLength: 1, maxLength: 30 }),
    state: fc.constant("active"),
    stateType: fc.constant("started" as const),
    labels: fc.constant([] as string[]),
    blockers: fc.constant([]),
    priority: fc.constantFrom(1, 2, 3, 4),
    createdAt: fc.oneof(
      fc.constant(null as string | null),
      fc.constant(undefined as string | undefined),
      fc.constant(""),
      fc.constant("not-a-date"),
      fc.constant("NaN"),
      fc.constant(" "),
    ),
  });

describe("INVARIANT: When sort is applied, it SHALL NOT mutate the input array", () => {
  test("sort SHALL NOT mutate the input array", () => {
    fc.assert(
      fc.property(fc.array(arbIssue(), { minLength: 1, maxLength: 50 }), (issues) => {
        const original = [...issues];
        sortForDispatch(issues);
        assert.equal(issues.length, original.length);
        for (let i = 0; i < issues.length; i++) {
          assert.equal(issues[i], original[i]);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When sort is applied, the result SHALL be a permutation of the input", () => {
  test("sort output SHALL be a permutation of the input (no additions or drops)", () => {
    fc.assert(
      fc.property(fc.array(arbIssue(), { maxLength: 50 }), (issues) => {
        const sorted = sortForDispatch(issues);
        assert.equal(sorted.length, issues.length);
        for (const issue of issues) {
          assert.ok(sorted.includes(issue));
        }
        for (const issue of sorted) {
          assert.ok(issues.includes(issue));
        }
      }),
      { numRuns: 200 },
    );
  });
});

test("singleton: sort of single-element array returns that element", () => {
  fc.assert(
    fc.property(arbIssue(), (issue) => {
      const sorted = sortForDispatch([issue]);
      assert.equal(sorted.length, 1);
      assert.equal(sorted[0], issue);
    }),
    { numRuns: 200 },
  );
});

test("duplicates: sort handles duplicate references correctly", () => {
  fc.assert(
    fc.property(arbIssue(), fc.integer({ min: 2, max: 10 }), (issue, count) => {
      const issues = Array(count).fill(issue) as Issue[];
      const sorted = sortForDispatch(issues);
      assert.equal(sorted.length, count);
      for (const s of sorted) {
        assert.equal(s, issue);
      }
    }),
    { numRuns: 100 },
  );
});

describe("INVARIANT: When sort is applied to an already-sorted list, the result SHALL be identical", () => {
  test("sort applied to an already-sorted list SHALL be identical (idempotent)", () => {
    fc.assert(
      fc.property(fc.array(arbIssue(), { maxLength: 50 }), (issues) => {
        const once = sortForDispatch(issues);
        const twice = sortForDispatch(once);
        assert.equal(twice.length, once.length);
        for (let i = 0; i < once.length; i++) {
          assert.equal(twice[i], once[i]);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When two dispatches differ in priority number, the one with the lower number SHALL sort first", () => {
  test("dispatch with lower priority number SHALL sort before one with higher priority number", () => {
    fc.assert(
      fc.property(arbIssueWithValidPriority(), arbIssueWithValidPriority(), (issueA, issueB) => {
        fc.pre(issueA.priority !== issueB.priority);
        const sorted = sortForDispatch([issueA, issueB]);
        const first = sorted[0]!;
        const second = sorted[1]!;
        assert.ok(first.priority! < second.priority!);
      }),
      { numRuns: 200 },
    );
  });
});

test("all four priorities: list with one of each priority is sorted 1,2,3,4", () => {
  fc.assert(
    fc.property(
      fc
        .integer({ min: new Date("2000-01-01").getTime(), max: new Date("2030-01-01").getTime() })
        .map((ms) => new Date(ms).toISOString()),
      (createdAt) => {
        const issues: Issue[] = [3, 1, 4, 2].map((p) => ({
          id: `id-${p}`,
          identifier: `ID-${p}`,
          title: `Title ${p}`,
          state: "active",
          stateType: "started",
          labels: [],
          blockers: [],
          priority: p,
          createdAt,
        }));
        const sorted = sortForDispatch(issues);
        assert.equal(sorted[0]!.priority, 1);
        assert.equal(sorted[1]!.priority, 2);
        assert.equal(sorted[2]!.priority, 3);
        assert.equal(sorted[3]!.priority, 4);
      },
    ),
    { numRuns: 100 },
  );
});

describe("INVARIANT: When two dispatches share the same priority, the one with the earlier creation time SHALL sort first", () => {
  test("same priority with earlier creation time SHALL sort first", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(1, 2, 3, 4),
        fc.integer({
          min: new Date("2000-01-01").getTime(),
          max: new Date("2030-01-01").getTime(),
        }),
        fc.integer({
          min: new Date("2000-01-01").getTime(),
          max: new Date("2030-01-01").getTime(),
        }),
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (priority, timeA, timeB, idA, idB) => {
          fc.pre(timeA !== timeB);
          const issueA: Issue = {
            id: "a",
            identifier: idA,
            title: "A",
            state: "active",
            stateType: "started",
            labels: [],
            blockers: [],
            priority,
            createdAt: new Date(timeA).toISOString(),
          };
          const issueB: Issue = {
            id: "b",
            identifier: idB,
            title: "B",
            state: "active",
            stateType: "started",
            labels: [],
            blockers: [],
            priority,
            createdAt: new Date(timeB).toISOString(),
          };
          const sorted = sortForDispatch([issueA, issueB]);
          const first = sorted[0]!;
          if (timeA < timeB) {
            assert.equal(first, issueA);
          } else {
            assert.equal(first, issueB);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When two dispatches share the same priority and creation time, the one with the lexicographically earlier identifier SHALL sort first", () => {
  test("same priority and creation time, lexicographically earlier identifier SHALL sort first", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(1, 2, 3, 4),
        fc
          .integer({ min: new Date("2000-01-01").getTime(), max: new Date("2030-01-01").getTime() })
          .map((ms) => new Date(ms).toISOString()),
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (priority, createdAt, idA, idB) => {
          fc.pre(idA.localeCompare(idB) !== 0);
          const issueA: Issue = {
            id: "a",
            identifier: idA,
            title: "A",
            state: "active",
            stateType: "started",
            labels: [],
            blockers: [],
            priority,
            createdAt,
          };
          const issueB: Issue = {
            id: "b",
            identifier: idB,
            title: "B",
            state: "active",
            stateType: "started",
            labels: [],
            blockers: [],
            priority,
            createdAt,
          };
          const sorted = sortForDispatch([issueA, issueB]);
          const first = sorted[0]!;
          if (idA.localeCompare(idB) < 0) {
            assert.equal(first, issueA);
          } else {
            assert.equal(first, issueB);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

test("unicode identifiers: handles unicode comparison correctly", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(1, 2, 3, 4),
      fc
        .integer({ min: new Date("2000-01-01").getTime(), max: new Date("2030-01-01").getTime() })
        .map((ms) => new Date(ms).toISOString()),
      (priority, createdAt) => {
        const ids = ["é", "è", "a", "z", "A", "Z", "0", "9"];
        const issues: Issue[] = ids.map((id) => ({
          id: `id-${id}`,
          identifier: id,
          title: "T",
          state: "active",
          stateType: "started",
          labels: [],
          blockers: [],
          priority,
          createdAt,
        }));
        const sorted = sortForDispatch(issues);
        for (let i = 0; i < sorted.length - 1; i++) {
          assert.ok(sorted[i]!.identifier.localeCompare(sorted[i + 1]!.identifier) <= 0);
        }
      },
    ),
    { numRuns: 50 },
  );
});

describe("INVARIANT: When a dispatch has null, missing, or out-of-range priority, it SHALL sort last", () => {
  test("dispatch with null, missing, or out-of-range priority SHALL sort last", () => {
    fc.assert(
      fc.property(
        arbIssueWithValidPriority(),
        arbIssueWithInvalidPriority(),
        (validIssue, invalidIssue) => {
          const sorted = sortForDispatch([validIssue, invalidIssue]);
          assert.equal(sorted[0], validIssue);
          assert.equal(sorted[1], invalidIssue);
        },
      ),
      { numRuns: 200 },
    );
  });
});

test("multi: all invalid-priority dispatches sort after all valid-priority dispatches", () => {
  fc.assert(
    fc.property(
      fc.array(arbIssueWithValidPriority(), { minLength: 1, maxLength: 10 }),
      fc.array(arbIssueWithInvalidPriority(), { minLength: 1, maxLength: 10 }),
      (validIssues, invalidIssues) => {
        const mixed = [...invalidIssues, ...validIssues];
        const sorted = sortForDispatch(mixed);
        const validSet = new Set(validIssues);
        const firstInvalidIndex = sorted.findIndex((issue) => !validSet.has(issue));
        for (let i = 0; i < firstInvalidIndex; i++) {
          assert.ok(validSet.has(sorted[i]!));
        }
        for (let i = firstInvalidIndex; i < sorted.length; i++) {
          assert.ok(!validSet.has(sorted[i]!));
        }
      },
    ),
    { numRuns: 200 },
  );
});

describe("INVARIANT: When a dispatch has null, missing, or unparseable creation time, it SHALL sort last within its priority group", () => {
  test("dispatch with null, missing, or unparseable creation time SHALL sort last within its priority group", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(1, 2, 3, 4),
        fc
          .integer({ min: new Date("2000-01-01").getTime(), max: new Date("2030-01-01").getTime() })
          .map((ms) => new Date(ms).toISOString()),
        arbIssueWithInvalidCreatedAt(),
        (priority, validCreatedAt, invalidIssue) => {
          const fixedInvalidIssue = { ...invalidIssue, priority };
          const validIssue: Issue = {
            id: "valid-id",
            identifier: "VALID-1",
            title: "Valid",
            state: "active",
            stateType: "started",
            labels: [],
            blockers: [],
            priority,
            createdAt: validCreatedAt,
          };
          const sorted = sortForDispatch([fixedInvalidIssue, validIssue]);
          assert.equal(sorted[0], validIssue);
          assert.equal(sorted[1], fixedInvalidIssue);
        },
      ),
      { numRuns: 200 },
    );
  });
});

test("multi: within the same priority, all invalid-createdAt dispatches sort after valid ones", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(1, 2, 3, 4),
      fc.array(
        fc
          .integer({ min: new Date("2000-01-01").getTime(), max: new Date("2030-01-01").getTime() })
          .map((ms) => new Date(ms).toISOString()),
        { minLength: 1, maxLength: 5 },
      ),
      fc.array(
        fc.oneof(
          fc.constant(null as string | null),
          fc.constant(undefined as string | undefined),
          fc.constant(""),
          fc.constant("not-a-date"),
          fc.constant("NaN"),
        ),
        { minLength: 1, maxLength: 5 },
      ),
      (priority, validDates, invalidDates) => {
        const validIssues: Issue[] = validDates.map((createdAt, i) => ({
          id: `valid-${i}`,
          identifier: `V-${i}`,
          title: `Valid ${i}`,
          state: "active",
          stateType: "started",
          labels: [],
          blockers: [],
          priority,
          createdAt,
        }));
        const invalidIssues: Issue[] = invalidDates.map((createdAt, i) => ({
          id: `invalid-${i}`,
          identifier: `I-${i}`,
          title: `Invalid ${i}`,
          state: "active",
          stateType: "started",
          labels: [],
          blockers: [],
          priority,
          createdAt: createdAt ?? undefined,
        }));
        const mixed = [...invalidIssues, ...validIssues];
        const sorted = sortForDispatch(mixed);
        const validSet = new Set(validIssues);
        const firstInvalidIndex = sorted.findIndex((issue) => !validSet.has(issue));
        if (firstInvalidIndex === -1) return;
        for (let i = 0; i < firstInvalidIndex; i++) {
          assert.ok(validSet.has(sorted[i]!));
        }
        for (let i = firstInvalidIndex; i < sorted.length; i++) {
          assert.ok(!validSet.has(sorted[i]!));
        }
      },
    ),
    { numRuns: 200 },
  );
});

describe("INVARIANT: When sort is applied, adjacent pairs in the output SHALL respect the full comparison chain", () => {
  test("sorted output SHALL respect the full ordering chain for all adjacent pairs", () => {
    fc.assert(
      fc.property(fc.array(arbIssue(), { minLength: 2, maxLength: 50 }), (issues) => {
        const sorted = sortForDispatch(issues);
        for (let i = 0; i < sorted.length - 1; i++) {
          const left = sorted[i]!;
          const right = sorted[i + 1]!;

          const leftPrioValid = isValidPriority(left.priority);
          const rightPrioValid = isValidPriority(right.priority);

          // Valid priorities must come before invalid ones
          if (leftPrioValid && !rightPrioValid) continue; // correct ordering
          if (!leftPrioValid && rightPrioValid) {
            assert.ok(false, "Invalid priority sorted before valid priority");
            continue;
          }

          // Both valid: lower number first
          if (leftPrioValid && rightPrioValid) {
            assert.ok(left.priority! <= right.priority!);
            if (left.priority! < right.priority!) continue;
          }

          // Same effective priority group (both valid+equal, or both invalid).
          // Check createdAt sub-ordering.
          const leftDateValid = isValidCreatedAt(left.createdAt);
          const rightDateValid = isValidCreatedAt(right.createdAt);

          if (leftDateValid && !rightDateValid) continue; // valid dates before invalid
          if (!leftDateValid && rightDateValid) {
            assert.ok(
              false,
              "Invalid createdAt sorted before valid createdAt within same priority",
            );
            continue;
          }

          if (leftDateValid && rightDateValid) {
            const leftMs = Date.parse(left.createdAt!);
            const rightMs = Date.parse(right.createdAt!);
            assert.ok(leftMs <= rightMs);
            if (leftMs < rightMs) continue;
          }

          // Same priority and same createdAt: identifier tiebreak
          assert.ok(left.identifier.localeCompare(right.identifier) <= 0);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When issue A sorts before B and B sorts before C, A SHALL sort before C", () => {
  test("sort SHALL be transitive (A < B < C by priority implies A before C)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(1, 2, 3) as fc.Arbitrary<1 | 2 | 3>,
        fc
          .integer({ min: new Date("2000-01-01").getTime(), max: new Date("2030-01-01").getTime() })
          .map((ms) => new Date(ms).toISOString()),
        (basePriority, createdAt) => {
          // Construct three issues with guaranteed ordering: a < b < c by priority
          const a: Issue = {
            id: "a",
            identifier: "A",
            title: "A",
            state: "active",
            stateType: "started",
            labels: [],
            blockers: [],
            priority: basePriority,
            createdAt,
          };
          const b: Issue = {
            id: "b",
            identifier: "B",
            title: "B",
            state: "active",
            stateType: "started",
            labels: [],
            blockers: [],
            priority: (basePriority + 1) as 2 | 3 | 4,
            createdAt,
          };
          const c: Issue = {
            id: "c",
            identifier: "C",
            title: "C",
            state: "active",
            stateType: "started",
            labels: [],
            blockers: [],
            priority: (basePriority + 2) as 3 | 4 | 5,
            createdAt,
          };

          // Verify pairwise: a < b and b < c
          const ab = sortForDispatch([b, a]);
          assert.equal(ab[0], a);
          const bc = sortForDispatch([c, b]);
          assert.equal(bc[0], b);

          // Transitivity: a must sort before c
          const ac = sortForDispatch([c, a]);
          assert.equal(ac[0], a);

          // Also verify all three together maintain order
          const all = sortForDispatch([c, a, b]);
          assert.equal(all[0], a);
          assert.equal(all[1], b);
        },
      ),
      { numRuns: 100 },
    );
  });
});

test("transitivity via createdAt: A < B < C by date implies A before C", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(1, 2, 3, 4),
      fc.integer({ min: new Date("2000-01-01").getTime(), max: new Date("2010-01-01").getTime() }),
      fc.integer({ min: 86400000, max: 31536000000 }), // 1 day to 1 year gap
      (priority, baseMs, gap) => {
        const createdAtA = new Date(baseMs).toISOString();
        const createdAtB = new Date(baseMs + gap).toISOString();
        const createdAtC = new Date(baseMs + gap * 2).toISOString();

        const a: Issue = {
          id: "a",
          identifier: "ZZZ", // worst identifier, should not matter
          title: "A",
          state: "active",
          stateType: "started",
          labels: [],
          blockers: [],
          priority,
          createdAt: createdAtA,
        };
        const b: Issue = {
          id: "b",
          identifier: "MMM",
          title: "B",
          state: "active",
          stateType: "started",
          labels: [],
          blockers: [],
          priority,
          createdAt: createdAtB,
        };
        const c: Issue = {
          id: "c",
          identifier: "AAA", // best identifier, should not matter
          title: "C",
          state: "active",
          stateType: "started",
          labels: [],
          blockers: [],
          priority,
          createdAt: createdAtC,
        };

        const all = sortForDispatch([c, a, b]);
        assert.equal(all[0], a);
        assert.equal(all[1], b);
        assert.equal(all[2], c);
      },
    ),
    { numRuns: 100 },
  );
});

describe("INVARIANT: When the same inputs are provided, sort SHALL produce the same output", () => {
  test("sort SHALL be deterministic (same input, same output)", () => {
    fc.assert(
      fc.property(fc.array(arbIssue(), { minLength: 1, maxLength: 30 }), (issues) => {
        const result1 = sortForDispatch(issues);
        const result2 = sortForDispatch(issues);
        assert.equal(result1.length, result2.length);
        for (let i = 0; i < result1.length; i++) {
          assert.equal(result1[i], result2[i]);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When priorities differ, priority SHALL dominate createdAt and identifier in ordering", () => {
  test("priority SHALL dominate createdAt and identifier in ordering", () => {
    fc.assert(
      fc.property(fc.constantFrom(1, 2, 3) as fc.Arbitrary<1 | 2 | 3>, (lowerPriority) => {
        const higherPriority = (lowerPriority + 1) as 2 | 3 | 4;
        const betterPriorityIssue: Issue = {
          id: "better",
          identifier: "ZZZ-999",
          title: "Better",
          state: "active",
          stateType: "started",
          labels: [],
          blockers: [],
          priority: lowerPriority,
          createdAt: "2099-12-31T23:59:59.999Z", // much later
        };
        const worsePriorityIssue: Issue = {
          id: "worse",
          identifier: "AAA-001",
          title: "Worse",
          state: "active",
          stateType: "started",
          labels: [],
          blockers: [],
          priority: higherPriority,
          createdAt: "1970-01-01T00:00:00.000Z", // much earlier
        };
        const sorted = sortForDispatch([worsePriorityIssue, betterPriorityIssue]);
        assert.equal(sorted[0], betterPriorityIssue);
        assert.equal(sorted[1], worsePriorityIssue);
      }),
      { numRuns: 50 },
    );
  });
});

describe("INVARIANT: When priorities are equal, createdAt SHALL dominate identifier in ordering", () => {
  test("createdAt SHALL dominate identifier within the same priority group", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(1, 2, 3, 4),
        fc.integer({
          min: new Date("2000-01-01").getTime(),
          max: new Date("2020-01-01").getTime(),
        }),
        fc.integer({
          min: new Date("2020-01-02").getTime(),
          max: new Date("2040-01-01").getTime(),
        }),
        (priority, earlierMs, laterMs) => {
          const earlierDate: Issue = {
            id: "early",
            identifier: "ZZZ-999", // worse identifier
            title: "Early",
            state: "active",
            stateType: "started",
            labels: [],
            blockers: [],
            priority,
            createdAt: new Date(earlierMs).toISOString(),
          };
          const laterDate: Issue = {
            id: "late",
            identifier: "AAA-001", // better identifier
            title: "Late",
            state: "active",
            stateType: "started",
            labels: [],
            blockers: [],
            priority,
            createdAt: new Date(laterMs).toISOString(),
          };
          const sorted = sortForDispatch([laterDate, earlierDate]);
          assert.equal(sorted[0], earlierDate);
          assert.equal(sorted[1], laterDate);
        },
      ),
      { numRuns: 200 },
    );
  });
});
