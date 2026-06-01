import { test } from "vitest";
import fc from "fast-check";
import { sortForDispatch } from "@symphony/cli";
import type { Issue, Priority } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

const arbSortableIssue = (): fc.Arbitrary<Issue> =>
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 10 }),
    identifier: fc.string({ minLength: 1, maxLength: 10 }),
    title: fc.string({ minLength: 1, maxLength: 20 }),
    state: fc.string({ minLength: 1, maxLength: 10 }),
    labels: fc.constant([] as string[]),
    blockers: fc.constant([]),
    priority: fc.oneof(
      fc.constantFrom(1, 2, 3, 4) as fc.Arbitrary<Priority | null>,
      fc.constant(null as Priority | null),
    ),
    createdAt: fc.oneof(
      fc
        .integer({ min: new Date("2020-01-01").getTime(), max: new Date("2030-01-01").getTime() })
        .map((ms) => new Date(ms).toISOString()),
      fc.constant(null as string | null),
      fc.constant("not-a-date"),
    ),
  });

test("INVARIANT: sortForDispatch SHALL return a permutation of the input (no elements added or removed).", () => {
  fc.assert(
    fc.property(fc.array(arbSortableIssue(), { maxLength: 20 }), (issues) => {
      const sorted = sortForDispatch(issues);
      assert.equal(sorted.length, issues.length);
      for (const issue of issues) {
        assert.ok(sorted.includes(issue));
      }
    }),
  );
});

test("INVARIANT: When sortForDispatch is applied twice, the result SHALL be the same (idempotent).", () => {
  fc.assert(
    fc.property(fc.array(arbSortableIssue(), { maxLength: 20 }), (issues) => {
      const once = sortForDispatch(issues);
      const twice = sortForDispatch(once);
      assert.deepEqual(
        twice.map((i) => i.identifier),
        once.map((i) => i.identifier),
      );
    }),
  );
});

function normalizedPriority(p: Priority | null | undefined): number {
  return p ?? Number.MAX_SAFE_INTEGER;
}

function normalizedCreatedAt(c: string | null | undefined): number {
  if (c === null || c === undefined || c === "") return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(c);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

test("INVARIANT: In the sorted output, each adjacent pair SHALL respect priority ordering (lower priority value first).", () => {
  fc.assert(
    fc.property(fc.array(arbSortableIssue(), { minLength: 2, maxLength: 20 }), (issues) => {
      const sorted = sortForDispatch(issues);
      for (let i = 0; i < sorted.length - 1; i++) {
        const left = sorted[i]!;
        const right = sorted[i + 1]!;
        assert.ok(normalizedPriority(left.priority) <= normalizedPriority(right.priority));
      }
    }),
  );
});

test("INVARIANT: Within the same priority, earlier createdAt SHALL come first.", () => {
  fc.assert(
    fc.property(fc.array(arbSortableIssue(), { minLength: 2, maxLength: 20 }), (issues) => {
      const sorted = sortForDispatch(issues);
      for (let i = 0; i < sorted.length - 1; i++) {
        const left = sorted[i]!;
        const right = sorted[i + 1]!;
        if (normalizedPriority(left.priority) === normalizedPriority(right.priority)) {
          assert.ok(normalizedCreatedAt(left.createdAt) <= normalizedCreatedAt(right.createdAt));
        }
      }
    }),
  );
});

test("INVARIANT: Within the same priority and createdAt, issues SHALL be ordered alphabetically by identifier.", () => {
  fc.assert(
    fc.property(fc.array(arbSortableIssue(), { minLength: 2, maxLength: 20 }), (issues) => {
      const sorted = sortForDispatch(issues);
      for (let i = 0; i < sorted.length - 1; i++) {
        const left = sorted[i]!;
        const right = sorted[i + 1]!;
        if (
          normalizedPriority(left.priority) === normalizedPriority(right.priority) &&
          normalizedCreatedAt(left.createdAt) === normalizedCreatedAt(right.createdAt)
        ) {
          assert.ok(left.identifier.localeCompare(right.identifier) <= 0);
        }
      }
    }),
  );
});
