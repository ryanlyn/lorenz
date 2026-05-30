import { test } from "vitest";
import fc from "fast-check";
import { mergeMonotonicUsage } from "@symphony/cli";

import { assert } from "../../../test/assert.js";
import { arbUsageTotals } from "../../../test/arbitraries.js";

/**
 * Arbitrary that generates partial updates including negative values,
 * large values, and undefined fields to stress edge cases.
 */
const arbPartialUsageUpdate = () =>
  fc.record({
    inputTokens: fc.option(fc.integer({ min: -1_000_000, max: 10_000_000 }), {
      nil: undefined,
    }),
    outputTokens: fc.option(fc.integer({ min: -1_000_000, max: 10_000_000 }), {
      nil: undefined,
    }),
    totalTokens: fc.option(fc.integer({ min: -1_000_000, max: 10_000_000 }), {
      nil: undefined,
    }),
  });

/**
 * Arbitrary that generates usage totals with zero values to test boundary conditions.
 */
const arbZeroBoundaryTotals = () =>
  fc.record({
    inputTokens: fc.constantFrom(0, 1),
    outputTokens: fc.constantFrom(0, 1),
    totalTokens: fc.constantFrom(0, 1),
    secondsRunning: fc.nat(),
  });

/**
 * Arbitrary that generates extreme value updates to stress overflow/boundary behavior.
 */
const arbExtremeUpdate = () =>
  fc.record({
    inputTokens: fc.option(
      fc.oneof(
        fc.constant(0),
        fc.constant(-1),
        fc.constant(Number.MAX_SAFE_INTEGER),
        fc.constant(Number.MIN_SAFE_INTEGER),
        fc.integer({ min: -2_000_000_000, max: 2_000_000_000 }),
      ),
      { nil: undefined },
    ),
    outputTokens: fc.option(
      fc.oneof(
        fc.constant(0),
        fc.constant(-1),
        fc.constant(Number.MAX_SAFE_INTEGER),
        fc.constant(Number.MIN_SAFE_INTEGER),
        fc.integer({ min: -2_000_000_000, max: 2_000_000_000 }),
      ),
      { nil: undefined },
    ),
    totalTokens: fc.option(
      fc.oneof(
        fc.constant(0),
        fc.constant(-1),
        fc.constant(Number.MAX_SAFE_INTEGER),
        fc.constant(Number.MIN_SAFE_INTEGER),
        fc.integer({ min: -2_000_000_000, max: 2_000_000_000 }),
      ),
      { nil: undefined },
    ),
  });

/**
 * Arbitrary that generates the all-undefined update (no-op scenario).
 */
const arbEmptyUpdate = () =>
  fc.constant({
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
  });

/**
 * Arbitrary that generates usage totals where reported may be higher than entry,
 * which is a realistic scenario (e.g., entry was reset or lagging).
 */
const arbMismatchedTotals = () =>
  fc.record({
    inputTokens: fc.nat({ max: 500_000 }),
    outputTokens: fc.nat({ max: 500_000 }),
    totalTokens: fc.nat({ max: 500_000 }),
    secondsRunning: fc.nat({ max: 100_000 }),
  });

// Invariant 1: When token counts are updated, they SHALL never become negative.
test("Invariant 1: token counts SHALL never become negative after update", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        // Entry totals token fields must be non-negative
        assert.ok(result.entryTotals.inputTokens >= 0);
        assert.ok(result.entryTotals.outputTokens >= 0);
        assert.ok(result.entryTotals.totalTokens >= 0);
        // Reported totals token fields must be non-negative
        assert.ok(result.reportedTotals.inputTokens >= 0);
        assert.ok(result.reportedTotals.outputTokens >= 0);
        assert.ok(result.reportedTotals.totalTokens >= 0);
        // Global totals token fields must be non-negative
        assert.ok(result.globalTotals.inputTokens >= 0);
        assert.ok(result.globalTotals.outputTokens >= 0);
        assert.ok(result.globalTotals.totalTokens >= 0);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 1: token counts non-negative even with zero-boundary inputs", () => {
  fc.assert(
    fc.property(
      arbZeroBoundaryTotals(),
      arbZeroBoundaryTotals(),
      arbZeroBoundaryTotals(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        assert.ok(result.entryTotals.inputTokens >= 0);
        assert.ok(result.entryTotals.outputTokens >= 0);
        assert.ok(result.entryTotals.totalTokens >= 0);
        assert.ok(result.reportedTotals.inputTokens >= 0);
        assert.ok(result.reportedTotals.outputTokens >= 0);
        assert.ok(result.reportedTotals.totalTokens >= 0);
        assert.ok(result.globalTotals.inputTokens >= 0);
        assert.ok(result.globalTotals.outputTokens >= 0);
        assert.ok(result.globalTotals.totalTokens >= 0);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 1: token counts non-negative with extreme value updates", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbExtremeUpdate(),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        assert.ok(result.entryTotals.inputTokens >= 0);
        assert.ok(result.entryTotals.outputTokens >= 0);
        assert.ok(result.entryTotals.totalTokens >= 0);
        assert.ok(result.reportedTotals.inputTokens >= 0);
        assert.ok(result.reportedTotals.outputTokens >= 0);
        assert.ok(result.reportedTotals.totalTokens >= 0);
        assert.ok(result.globalTotals.inputTokens >= 0);
        assert.ok(result.globalTotals.outputTokens >= 0);
        assert.ok(result.globalTotals.totalTokens >= 0);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 2: When token counters are updated, they SHALL never decrease (monotonic growth).
test("Invariant 2: entry token counters SHALL never decrease (monotonic growth)", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        // Entry totals must never decrease compared to input entry totals
        assert.ok(result.entryTotals.inputTokens >= entry.inputTokens);
        assert.ok(result.entryTotals.outputTokens >= entry.outputTokens);
        assert.ok(result.entryTotals.totalTokens >= entry.totalTokens);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 2: sequential updates produce monotonically non-decreasing entry totals", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update1, update2) => {
        const first = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update: update1,
        });
        const second = mergeMonotonicUsage({
          entryTotals: first.entryTotals,
          reportedTotals: first.reportedTotals,
          globalTotals: first.globalTotals,
          update: update2,
        });
        // After two sequential merges, entry totals only grow
        assert.ok(second.entryTotals.inputTokens >= first.entryTotals.inputTokens);
        assert.ok(second.entryTotals.outputTokens >= first.entryTotals.outputTokens);
        assert.ok(second.entryTotals.totalTokens >= first.entryTotals.totalTokens);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 2: monotonicity holds over N-step sequential chain", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      fc.array(arbPartialUsageUpdate(), { minLength: 2, maxLength: 10 }),
      (entry, reported, global, updates) => {
        let current = { entryTotals: entry, reportedTotals: reported, globalTotals: global };
        for (const update of updates) {
          const next = mergeMonotonicUsage({
            entryTotals: current.entryTotals,
            reportedTotals: current.reportedTotals,
            globalTotals: current.globalTotals,
            update,
          });
          // Each step must not decrease entry totals
          assert.ok(next.entryTotals.inputTokens >= current.entryTotals.inputTokens);
          assert.ok(next.entryTotals.outputTokens >= current.entryTotals.outputTokens);
          assert.ok(next.entryTotals.totalTokens >= current.entryTotals.totalTokens);
          current = next;
        }
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 2: entry totals monotonic even when reported > entry (lagging entry)", () => {
  fc.assert(
    fc.property(
      arbMismatchedTotals(),
      // reported can be higher than entry - simulating a lagging entry
      arbMismatchedTotals().map((t) => ({
        ...t,
        inputTokens: t.inputTokens + 1000,
        outputTokens: t.outputTokens + 1000,
        totalTokens: t.totalTokens + 1000,
      })),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        assert.ok(result.entryTotals.inputTokens >= entry.inputTokens);
        assert.ok(result.entryTotals.outputTokens >= entry.outputTokens);
        assert.ok(result.entryTotals.totalTokens >= entry.totalTokens);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 3: When global aggregates are updated, they SHALL never decrease.
test("Invariant 3: global aggregates SHALL never decrease after merge", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        assert.ok(result.globalTotals.inputTokens >= global.inputTokens);
        assert.ok(result.globalTotals.outputTokens >= global.outputTokens);
        assert.ok(result.globalTotals.totalTokens >= global.totalTokens);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 3: global aggregates never decrease across sequential merges", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update1, update2) => {
        const first = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update: update1,
        });
        const second = mergeMonotonicUsage({
          entryTotals: first.entryTotals,
          reportedTotals: first.reportedTotals,
          globalTotals: first.globalTotals,
          update: update2,
        });
        assert.ok(second.globalTotals.inputTokens >= first.globalTotals.inputTokens);
        assert.ok(second.globalTotals.outputTokens >= first.globalTotals.outputTokens);
        assert.ok(second.globalTotals.totalTokens >= first.globalTotals.totalTokens);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 3: global monotonicity over N-step sequential chain", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      fc.array(arbPartialUsageUpdate(), { minLength: 2, maxLength: 10 }),
      (entry, reported, global, updates) => {
        let current = { entryTotals: entry, reportedTotals: reported, globalTotals: global };
        for (const update of updates) {
          const next = mergeMonotonicUsage({
            entryTotals: current.entryTotals,
            reportedTotals: current.reportedTotals,
            globalTotals: current.globalTotals,
            update,
          });
          assert.ok(next.globalTotals.inputTokens >= current.globalTotals.inputTokens);
          assert.ok(next.globalTotals.outputTokens >= current.globalTotals.outputTokens);
          assert.ok(next.globalTotals.totalTokens >= current.globalTotals.totalTokens);
          current = next;
        }
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 3: global delta equals max(0, newEntry - oldReported) per field", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        // The global increment should be exactly max(0, newEntry - oldReported)
        const expectedInputDelta = Math.max(0, result.entryTotals.inputTokens - reported.inputTokens);
        const expectedOutputDelta = Math.max(0, result.entryTotals.outputTokens - reported.outputTokens);
        const expectedTotalDelta = Math.max(0, result.entryTotals.totalTokens - reported.totalTokens);

        assert.equal(
          result.globalTotals.inputTokens,
          global.inputTokens + expectedInputDelta,
        );
        assert.equal(
          result.globalTotals.outputTokens,
          global.outputTokens + expectedOutputDelta,
        );
        assert.equal(
          result.globalTotals.totalTokens,
          global.totalTokens + expectedTotalDelta,
        );
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 4: When reported-totals watermark is updated, it SHALL stay in sync with entry totals.
test("Invariant 4: reported-totals watermark SHALL stay in sync with entry totals", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        // Reported totals token values must equal entry totals token values
        assert.equal(result.reportedTotals.inputTokens, result.entryTotals.inputTokens);
        assert.equal(result.reportedTotals.outputTokens, result.entryTotals.outputTokens);
        assert.equal(result.reportedTotals.totalTokens, result.entryTotals.totalTokens);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 4: reported-totals sync holds across N sequential merges", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      fc.array(arbPartialUsageUpdate(), { minLength: 1, maxLength: 8 }),
      (entry, reported, global, updates) => {
        let current = { entryTotals: entry, reportedTotals: reported, globalTotals: global };
        for (const update of updates) {
          const next = mergeMonotonicUsage({
            entryTotals: current.entryTotals,
            reportedTotals: current.reportedTotals,
            globalTotals: current.globalTotals,
            update,
          });
          // After every single merge, reported must match entry tokens
          assert.equal(next.reportedTotals.inputTokens, next.entryTotals.inputTokens);
          assert.equal(next.reportedTotals.outputTokens, next.entryTotals.outputTokens);
          assert.equal(next.reportedTotals.totalTokens, next.entryTotals.totalTokens);
          current = next;
        }
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 4: reported-totals sync holds even with extreme mismatched inputs", () => {
  fc.assert(
    fc.property(
      arbMismatchedTotals(),
      // reported much higher than entry
      arbMismatchedTotals().map((t) => ({
        ...t,
        inputTokens: t.inputTokens + 999_999,
        outputTokens: t.outputTokens + 999_999,
        totalTokens: t.totalTokens + 999_999,
      })),
      arbUsageTotals(),
      arbExtremeUpdate(),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        assert.equal(result.reportedTotals.inputTokens, result.entryTotals.inputTokens);
        assert.equal(result.reportedTotals.outputTokens, result.entryTotals.outputTokens);
        assert.equal(result.reportedTotals.totalTokens, result.entryTotals.totalTokens);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 5: When usage is accounted, seconds-running SHALL be preserved independently.
test("Invariant 5: seconds-running SHALL be preserved independently for each aggregate", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        // secondsRunning is never modified by the merge — each aggregate keeps its own
        assert.equal(result.entryTotals.secondsRunning, entry.secondsRunning);
        assert.equal(result.reportedTotals.secondsRunning, reported.secondsRunning);
        assert.equal(result.globalTotals.secondsRunning, global.secondsRunning);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 5: seconds-running preserved even with large token updates", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      fc.record({
        inputTokens: fc.option(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), {
          nil: undefined,
        }),
        outputTokens: fc.option(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), {
          nil: undefined,
        }),
        totalTokens: fc.option(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), {
          nil: undefined,
        }),
      }),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        assert.equal(result.entryTotals.secondsRunning, entry.secondsRunning);
        assert.equal(result.reportedTotals.secondsRunning, reported.secondsRunning);
        assert.equal(result.globalTotals.secondsRunning, global.secondsRunning);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 5: seconds-running preserved across N-step chain", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      fc.array(arbPartialUsageUpdate(), { minLength: 2, maxLength: 8 }),
      (entry, reported, global, updates) => {
        let current = { entryTotals: entry, reportedTotals: reported, globalTotals: global };
        for (const update of updates) {
          const next = mergeMonotonicUsage({
            entryTotals: current.entryTotals,
            reportedTotals: current.reportedTotals,
            globalTotals: current.globalTotals,
            update,
          });
          // Entry and global secondsRunning must never change through the chain
          assert.equal(next.entryTotals.secondsRunning, entry.secondsRunning);
          assert.equal(next.globalTotals.secondsRunning, global.secondsRunning);
          current = next;
        }
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 5: secondsRunning in update is ignored (not applied)", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      fc.record({
        inputTokens: fc.option(fc.nat(), { nil: undefined }),
        outputTokens: fc.option(fc.nat(), { nil: undefined }),
        totalTokens: fc.option(fc.nat(), { nil: undefined }),
        secondsRunning: fc.option(fc.nat(), { nil: undefined }),
      }),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        // Even if update contains secondsRunning, it should not affect any aggregate
        assert.equal(result.entryTotals.secondsRunning, entry.secondsRunning);
        assert.equal(result.reportedTotals.secondsRunning, reported.secondsRunning);
        assert.equal(result.globalTotals.secondsRunning, global.secondsRunning);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 6: When the same update is applied twice, the result SHALL be the same (idempotent).
test("Invariant 6: applying the same update twice SHALL be idempotent", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update) => {
        const first = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        const second = mergeMonotonicUsage({
          entryTotals: first.entryTotals,
          reportedTotals: first.reportedTotals,
          globalTotals: first.globalTotals,
          update,
        });
        // After applying the same update to the result, nothing changes
        assert.deepEqual(second.entryTotals, first.entryTotals);
        assert.deepEqual(second.reportedTotals, first.reportedTotals);
        assert.deepEqual(second.globalTotals, first.globalTotals);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 6: idempotency holds across three consecutive identical applications", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update) => {
        const first = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        const second = mergeMonotonicUsage({
          entryTotals: first.entryTotals,
          reportedTotals: first.reportedTotals,
          globalTotals: first.globalTotals,
          update,
        });
        const third = mergeMonotonicUsage({
          entryTotals: second.entryTotals,
          reportedTotals: second.reportedTotals,
          globalTotals: second.globalTotals,
          update,
        });
        assert.deepEqual(third.entryTotals, first.entryTotals);
        assert.deepEqual(third.reportedTotals, first.reportedTotals);
        assert.deepEqual(third.globalTotals, first.globalTotals);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 6: idempotency holds with extreme updates", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbExtremeUpdate(),
      (entry, reported, global, update) => {
        const first = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        const second = mergeMonotonicUsage({
          entryTotals: first.entryTotals,
          reportedTotals: first.reportedTotals,
          globalTotals: first.globalTotals,
          update,
        });
        assert.deepEqual(second.entryTotals, first.entryTotals);
        assert.deepEqual(second.reportedTotals, first.reportedTotals);
        assert.deepEqual(second.globalTotals, first.globalTotals);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 7 (derived): An all-undefined update SHALL be a no-op for entry and reported tokens.
test("Invariant 7: empty update (all undefined) is a no-op for entry token fields", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbEmptyUpdate(),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        // When update has no fields, entry tokens stay the same
        assert.equal(result.entryTotals.inputTokens, entry.inputTokens);
        assert.equal(result.entryTotals.outputTokens, entry.outputTokens);
        assert.equal(result.entryTotals.totalTokens, entry.totalTokens);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 8 (derived): Global accumulation is additive - sum of deltas across a chain
// equals final global minus initial global.
test("Invariant 8: global accumulation across chain equals sum of individual deltas", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      fc.array(arbPartialUsageUpdate(), { minLength: 2, maxLength: 8 }),
      (entry, reported, global, updates) => {
        let current = { entryTotals: entry, reportedTotals: reported, globalTotals: global };
        let totalInputDelta = 0;
        let totalOutputDelta = 0;
        let totalTokenDelta = 0;
        for (const update of updates) {
          const next = mergeMonotonicUsage({
            entryTotals: current.entryTotals,
            reportedTotals: current.reportedTotals,
            globalTotals: current.globalTotals,
            update,
          });
          totalInputDelta += next.globalTotals.inputTokens - current.globalTotals.inputTokens;
          totalOutputDelta += next.globalTotals.outputTokens - current.globalTotals.outputTokens;
          totalTokenDelta += next.globalTotals.totalTokens - current.globalTotals.totalTokens;
          current = next;
        }
        // The total delta accumulated equals final - initial
        assert.equal(current.globalTotals.inputTokens - global.inputTokens, totalInputDelta);
        assert.equal(current.globalTotals.outputTokens - global.outputTokens, totalOutputDelta);
        assert.equal(current.globalTotals.totalTokens - global.totalTokens, totalTokenDelta);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 9 (derived): entry result equals max(entry, 0, update ?? entry) per field.
test("Invariant 9: entry result equals max(entry, 0, update ?? entry) per field", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUsageUpdate(),
      (entry, reported, global, update) => {
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        // Directly verify the max formula
        const expectedInput = Math.max(entry.inputTokens, 0, update.inputTokens ?? entry.inputTokens);
        const expectedOutput = Math.max(entry.outputTokens, 0, update.outputTokens ?? entry.outputTokens);
        const expectedTotal = Math.max(entry.totalTokens, 0, update.totalTokens ?? entry.totalTokens);
        assert.equal(result.entryTotals.inputTokens, expectedInput);
        assert.equal(result.entryTotals.outputTokens, expectedOutput);
        assert.equal(result.entryTotals.totalTokens, expectedTotal);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 10 (negative test): update with value lower than entry does NOT decrease entry.
test("Invariant 10: update with lower value than entry does NOT decrease entry", () => {
  fc.assert(
    fc.property(
      // Generate entry with positive values so we can go lower
      fc.record({
        inputTokens: fc.integer({ min: 100, max: 10_000_000 }),
        outputTokens: fc.integer({ min: 100, max: 10_000_000 }),
        totalTokens: fc.integer({ min: 100, max: 10_000_000 }),
        secondsRunning: fc.nat(),
      }),
      arbUsageTotals(),
      arbUsageTotals(),
      (entry, reported, global) => {
        // Update with values strictly less than entry
        const update = {
          inputTokens: entry.inputTokens - 1,
          outputTokens: entry.outputTokens - 1,
          totalTokens: entry.totalTokens - 1,
        };
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        // Entry must NOT decrease even when update is lower
        assert.ok(result.entryTotals.inputTokens >= entry.inputTokens);
        assert.ok(result.entryTotals.outputTokens >= entry.outputTokens);
        assert.ok(result.entryTotals.totalTokens >= entry.totalTokens);
        // In fact, it should be exactly the entry values (since max picks entry)
        assert.equal(result.entryTotals.inputTokens, entry.inputTokens);
        assert.equal(result.entryTotals.outputTokens, entry.outputTokens);
        assert.equal(result.entryTotals.totalTokens, entry.totalTokens);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 11 (negative test): Heavily negative updates do NOT corrupt state.
test("Invariant 11: heavily negative updates do not corrupt state", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      (entry, reported, global) => {
        const update = {
          inputTokens: -Number.MAX_SAFE_INTEGER,
          outputTokens: -Number.MAX_SAFE_INTEGER,
          totalTokens: -Number.MAX_SAFE_INTEGER,
        };
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        // All results must still be non-negative
        assert.ok(result.entryTotals.inputTokens >= 0);
        assert.ok(result.entryTotals.outputTokens >= 0);
        assert.ok(result.entryTotals.totalTokens >= 0);
        assert.ok(result.globalTotals.inputTokens >= 0);
        assert.ok(result.globalTotals.outputTokens >= 0);
        assert.ok(result.globalTotals.totalTokens >= 0);
        // Entry should still be >= its original values (monotonicity)
        assert.ok(result.entryTotals.inputTokens >= entry.inputTokens);
        assert.ok(result.entryTotals.outputTokens >= entry.outputTokens);
        assert.ok(result.entryTotals.totalTokens >= entry.totalTokens);
      },
    ),
    { numRuns: 200 },
  );
});
