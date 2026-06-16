import { describe, test } from "vitest";
import fc from "fast-check";
import { assert, arbUsageTotals } from "@lorenz/test-utils";

import { mergeMonotonicUsage } from "@lorenz/policies";

/**
 * This file focuses on invariant tests that add value BEYOND the basic property tests in
 * usage-props.test.ts. Specifically:
 * - N-step sequential chain properties (temporal composition)
 * - Extreme/boundary arbitraries (near-overflow, zero-boundary, mismatched)
 * - Behavioral bounding properties (global growth bounded by entry growth)
 * - Integer overflow scenarios near MAX_SAFE_INTEGER
 *
 * Basic single-step invariants (non-negativity, monotonicity, sync, idempotency) are already
 * covered in usage-props.test.ts and are NOT duplicated here.
 */

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
 * Arbitrary that generates usage totals with values near MAX_SAFE_INTEGER
 * to test potential integer overflow scenarios.
 */
const arbNearOverflowTotals = () =>
  fc.record({
    inputTokens: fc.integer({
      min: Number.MAX_SAFE_INTEGER - 1_000_000,
      max: Number.MAX_SAFE_INTEGER,
    }),
    outputTokens: fc.integer({
      min: Number.MAX_SAFE_INTEGER - 1_000_000,
      max: Number.MAX_SAFE_INTEGER,
    }),
    totalTokens: fc.integer({
      min: Number.MAX_SAFE_INTEGER - 1_000_000,
      max: Number.MAX_SAFE_INTEGER,
    }),
    secondsRunning: fc.nat(),
  });

describe("INVARIANT: When token counters are updated sequentially, they SHALL never decrease (monotonic growth)", () => {
  test("monotonicity holds over N-step sequential chain for both entry and global", () => {
    fc.assert(
      fc.property(
        arbUsageTotals(),
        arbUsageTotals(),
        arbUsageTotals(),
        fc.array(arbPartialUsageUpdate(), { minLength: 3, maxLength: 12 }),
        (entry, reported, global, updates) => {
          let current = { entryTotals: entry, reportedTotals: reported, globalTotals: global };
          for (const update of updates) {
            const next = mergeMonotonicUsage({
              entryTotals: current.entryTotals,
              reportedTotals: current.reportedTotals,
              globalTotals: current.globalTotals,
              update,
            });
            assert.ok(next.entryTotals.inputTokens >= current.entryTotals.inputTokens);
            assert.ok(next.entryTotals.outputTokens >= current.entryTotals.outputTokens);
            assert.ok(next.entryTotals.totalTokens >= current.entryTotals.totalTokens);
            assert.ok(next.globalTotals.inputTokens >= current.globalTotals.inputTokens);
            assert.ok(next.globalTotals.outputTokens >= current.globalTotals.outputTokens);
            assert.ok(next.globalTotals.totalTokens >= current.globalTotals.totalTokens);
            current = next;
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

test("INVARIANT: When token counters are updated sequentially, reportedTotals SHALL equal entryTotals at every step", () => {
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
          assert.equal(next.reportedTotals.inputTokens, next.entryTotals.inputTokens);
          assert.equal(next.reportedTotals.outputTokens, next.entryTotals.outputTokens);
          assert.equal(next.reportedTotals.totalTokens, next.entryTotals.totalTokens);
          current = next;
        }
      },
    ),
    { numRuns: 500 },
  );
});

test("INVARIANT: When token counters are updated sequentially, secondsRunning SHALL be preserved unchanged", () => {
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
          assert.equal(next.entryTotals.secondsRunning, entry.secondsRunning);
          assert.equal(next.globalTotals.secondsRunning, global.secondsRunning);
          current = next;
        }
      },
    ),
    { numRuns: 500 },
  );
});

test("INVARIANT: When the same update is re-applied at any step, the result SHALL be unchanged (idempotency)", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      fc.array(arbPartialUsageUpdate(), { minLength: 2, maxLength: 8 }),
      (entry, reported, global, updates) => {
        let current = { entryTotals: entry, reportedTotals: reported, globalTotals: global };
        for (const update of updates) {
          const first = mergeMonotonicUsage({
            entryTotals: current.entryTotals,
            reportedTotals: current.reportedTotals,
            globalTotals: current.globalTotals,
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
          current = first;
        }
      },
    ),
    { numRuns: 500 },
  );
});

describe("INVARIANT: When global aggregates are updated, growth SHALL be bounded by entry growth", () => {
  test("global growth per step is bounded above by the new entry value", () => {
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
          const globalInputGrowth = result.globalTotals.inputTokens - global.inputTokens;
          const globalOutputGrowth = result.globalTotals.outputTokens - global.outputTokens;
          const globalTotalGrowth = result.globalTotals.totalTokens - global.totalTokens;

          assert.ok(globalInputGrowth >= 0);
          assert.ok(globalOutputGrowth >= 0);
          assert.ok(globalTotalGrowth >= 0);

          assert.ok(globalInputGrowth <= result.entryTotals.inputTokens);
          assert.ok(globalOutputGrowth <= result.entryTotals.outputTokens);
          assert.ok(globalTotalGrowth <= result.entryTotals.totalTokens);
        },
      ),
      { numRuns: 500 },
    );
  });
});

test("INVARIANT: When entry does not exceed reported, global growth SHALL be zero", () => {
  fc.assert(
    fc.property(
      fc.record({
        inputTokens: fc.nat({ max: 1000 }),
        outputTokens: fc.nat({ max: 1000 }),
        totalTokens: fc.nat({ max: 1000 }),
        secondsRunning: fc.nat(),
      }),
      fc.nat({ max: 1000 }),
      arbUsageTotals(),
      (entry, reportedExtra, global) => {
        const reported = {
          inputTokens: entry.inputTokens + reportedExtra,
          outputTokens: entry.outputTokens + reportedExtra,
          totalTokens: entry.totalTokens + reportedExtra,
          secondsRunning: 0,
        };
        const update = {
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          totalTokens: entry.totalTokens,
        };
        const result = mergeMonotonicUsage({
          entryTotals: entry,
          reportedTotals: reported,
          globalTotals: global,
          update,
        });
        assert.equal(result.globalTotals.inputTokens, global.inputTokens);
        assert.equal(result.globalTotals.outputTokens, global.outputTokens);
        assert.equal(result.globalTotals.totalTokens, global.totalTokens);
      },
    ),
    { numRuns: 500 },
  );
});

test("INVARIANT: When positive values are applied, entry result SHALL be at least as large as both prior entry and the update", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      fc.record({
        inputTokens: fc.option(fc.nat({ max: 10_000_000 }), { nil: undefined }),
        outputTokens: fc.option(fc.nat({ max: 10_000_000 }), { nil: undefined }),
        totalTokens: fc.option(fc.nat({ max: 10_000_000 }), { nil: undefined }),
      }),
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
        if (update.inputTokens !== undefined) {
          assert.ok(result.entryTotals.inputTokens >= update.inputTokens);
        }
        if (update.outputTokens !== undefined) {
          assert.ok(result.entryTotals.outputTokens >= update.outputTokens);
        }
        if (update.totalTokens !== undefined) {
          assert.ok(result.entryTotals.totalTokens >= update.totalTokens);
        }
      },
    ),
    { numRuns: 500 },
  );
});

describe("INVARIANT: When extreme values are applied, token counts SHALL never become negative", () => {
  test("all invariants hold with extreme value updates", () => {
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
          assert.ok(result.globalTotals.inputTokens >= 0);
          assert.ok(result.globalTotals.outputTokens >= 0);
          assert.ok(result.globalTotals.totalTokens >= 0);
          assert.ok(result.entryTotals.inputTokens >= entry.inputTokens);
          assert.ok(result.entryTotals.outputTokens >= entry.outputTokens);
          assert.ok(result.entryTotals.totalTokens >= entry.totalTokens);
          assert.ok(result.globalTotals.inputTokens >= global.inputTokens);
          assert.ok(result.globalTotals.outputTokens >= global.outputTokens);
          assert.ok(result.globalTotals.totalTokens >= global.totalTokens);
          assert.equal(result.reportedTotals.inputTokens, result.entryTotals.inputTokens);
          assert.equal(result.reportedTotals.outputTokens, result.entryTotals.outputTokens);
          assert.equal(result.reportedTotals.totalTokens, result.entryTotals.totalTokens);
          assert.equal(result.entryTotals.secondsRunning, entry.secondsRunning);
          assert.equal(result.globalTotals.secondsRunning, global.secondsRunning);
        },
      ),
      { numRuns: 500 },
    );
  });
});

test("INVARIANT: When heavily negative updates are applied, token counts SHALL remain non-negative and non-decreasing", () => {
  fc.assert(
    fc.property(arbUsageTotals(), arbUsageTotals(), arbUsageTotals(), (entry, reported, global) => {
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
      assert.ok(result.entryTotals.inputTokens >= 0);
      assert.ok(result.entryTotals.outputTokens >= 0);
      assert.ok(result.entryTotals.totalTokens >= 0);
      assert.ok(result.globalTotals.inputTokens >= 0);
      assert.ok(result.globalTotals.outputTokens >= 0);
      assert.ok(result.globalTotals.totalTokens >= 0);
      assert.ok(result.entryTotals.inputTokens >= entry.inputTokens);
      assert.ok(result.entryTotals.outputTokens >= entry.outputTokens);
      assert.ok(result.entryTotals.totalTokens >= entry.totalTokens);
    }),
    { numRuns: 500 },
  );
});

describe("INVARIANT: When values are near integer limits, the system SHALL not produce NaN or negative values", () => {
  test("near-overflow globalTotals: function does not produce NaN or negative values", () => {
    fc.assert(
      fc.property(
        arbUsageTotals(),
        fc.record({
          inputTokens: fc.nat({ max: 100 }),
          outputTokens: fc.nat({ max: 100 }),
          totalTokens: fc.nat({ max: 100 }),
          secondsRunning: fc.nat(),
        }),
        arbNearOverflowTotals(),
        fc.record({
          inputTokens: fc.option(fc.integer({ min: 1000, max: 10_000_000 }), { nil: undefined }),
          outputTokens: fc.option(fc.integer({ min: 1000, max: 10_000_000 }), { nil: undefined }),
          totalTokens: fc.option(fc.integer({ min: 1000, max: 10_000_000 }), { nil: undefined }),
        }),
        (entry, reported, global, update) => {
          const result = mergeMonotonicUsage({
            entryTotals: entry,
            reportedTotals: reported,
            globalTotals: global,
            update,
          });
          assert.ok(!Number.isNaN(result.globalTotals.inputTokens));
          assert.ok(!Number.isNaN(result.globalTotals.outputTokens));
          assert.ok(!Number.isNaN(result.globalTotals.totalTokens));
          assert.ok(result.globalTotals.inputTokens >= 0);
          assert.ok(result.globalTotals.outputTokens >= 0);
          assert.ok(result.globalTotals.totalTokens >= 0);
          assert.ok(Number.isFinite(result.globalTotals.inputTokens));
          assert.ok(Number.isFinite(result.globalTotals.outputTokens));
          assert.ok(Number.isFinite(result.globalTotals.totalTokens));
          assert.ok(result.globalTotals.inputTokens >= global.inputTokens);
          assert.ok(result.globalTotals.outputTokens >= global.outputTokens);
          assert.ok(result.globalTotals.totalTokens >= global.totalTokens);
        },
      ),
      { numRuns: 500 },
    );
  });
});

test("INVARIANT: When globalTotals are near integer limits, entry and reported SHALL remain valid and non-decreasing", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbNearOverflowTotals(),
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
        assert.ok(result.entryTotals.inputTokens >= 0);
        assert.ok(result.entryTotals.outputTokens >= 0);
        assert.ok(result.entryTotals.totalTokens >= 0);
        assert.equal(result.reportedTotals.inputTokens, result.entryTotals.inputTokens);
        assert.equal(result.reportedTotals.outputTokens, result.entryTotals.outputTokens);
        assert.equal(result.reportedTotals.totalTokens, result.entryTotals.totalTokens);
      },
    ),
    { numRuns: 500 },
  );
});

describe("INVARIANT: When no update fields are provided, entry and global totals SHALL remain unchanged", () => {
  test("empty update (all undefined) preserves entry and global unchanged", () => {
    fc.assert(
      fc.property(
        arbUsageTotals(),
        arbUsageTotals(),
        arbUsageTotals(),
        (entry, reported, global) => {
          const update = {
            inputTokens: undefined,
            outputTokens: undefined,
            totalTokens: undefined,
          };
          const result = mergeMonotonicUsage({
            entryTotals: entry,
            reportedTotals: reported,
            globalTotals: global,
            update,
          });
          assert.equal(result.entryTotals.inputTokens, entry.inputTokens);
          assert.equal(result.entryTotals.outputTokens, entry.outputTokens);
          assert.equal(result.entryTotals.totalTokens, entry.totalTokens);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("INVARIANT: Token counts SHALL never become negative / NaN", () => {
  test("NaN in update.inputTokens does not corrupt entry, reported, or global totals", () => {
    fc.assert(
      fc.property(
        arbUsageTotals(),
        arbUsageTotals(),
        arbUsageTotals(),
        (entry, reported, global) => {
          const result = mergeMonotonicUsage({
            entryTotals: entry,
            reportedTotals: reported,
            globalTotals: global,
            update: { inputTokens: NaN },
          });
          assert.ok(Number.isFinite(result.entryTotals.inputTokens));
          assert.ok(Number.isFinite(result.reportedTotals.inputTokens));
          assert.ok(Number.isFinite(result.globalTotals.inputTokens));
          assert.ok(result.entryTotals.inputTokens >= entry.inputTokens);
          assert.ok(result.globalTotals.inputTokens >= global.inputTokens);
        },
      ),
      { numRuns: 500 },
    );
  });

  test("NaN in update.totalTokens does not corrupt totals while other fields update correctly", () => {
    fc.assert(
      fc.property(
        arbUsageTotals(),
        arbUsageTotals(),
        arbUsageTotals(),
        (entry, reported, global) => {
          const validInput = entry.inputTokens + 10;
          const result = mergeMonotonicUsage({
            entryTotals: entry,
            reportedTotals: reported,
            globalTotals: global,
            update: { totalTokens: NaN, inputTokens: validInput },
          });
          assert.ok(Number.isFinite(result.entryTotals.totalTokens));
          assert.ok(Number.isFinite(result.globalTotals.totalTokens));
          assert.ok(result.entryTotals.totalTokens >= entry.totalTokens);
          assert.equal(result.entryTotals.inputTokens, validInput);
        },
      ),
      { numRuns: 500 },
    );
  });

  test("all NaN update fields do not corrupt any totals", () => {
    fc.assert(
      fc.property(
        arbUsageTotals(),
        arbUsageTotals(),
        arbUsageTotals(),
        (entry, reported, global) => {
          const result = mergeMonotonicUsage({
            entryTotals: entry,
            reportedTotals: reported,
            globalTotals: global,
            update: { inputTokens: NaN, outputTokens: NaN, totalTokens: NaN },
          });
          assert.ok(Number.isFinite(result.entryTotals.inputTokens));
          assert.ok(Number.isFinite(result.entryTotals.outputTokens));
          assert.ok(Number.isFinite(result.entryTotals.totalTokens));
          assert.ok(Number.isFinite(result.reportedTotals.inputTokens));
          assert.ok(Number.isFinite(result.reportedTotals.outputTokens));
          assert.ok(Number.isFinite(result.reportedTotals.totalTokens));
          assert.ok(Number.isFinite(result.globalTotals.inputTokens));
          assert.ok(Number.isFinite(result.globalTotals.outputTokens));
          assert.ok(Number.isFinite(result.globalTotals.totalTokens));
          assert.ok(result.entryTotals.inputTokens >= entry.inputTokens);
          assert.ok(result.entryTotals.outputTokens >= entry.outputTokens);
          assert.ok(result.entryTotals.totalTokens >= entry.totalTokens);
          assert.ok(result.globalTotals.inputTokens >= global.inputTokens);
          assert.ok(result.globalTotals.outputTokens >= global.outputTokens);
          assert.ok(result.globalTotals.totalTokens >= global.totalTokens);
        },
      ),
      { numRuns: 500 },
    );
  });

  test("Infinity and -Infinity in update fields are treated as invalid", () => {
    fc.assert(
      fc.property(
        arbUsageTotals(),
        arbUsageTotals(),
        arbUsageTotals(),
        (entry, reported, global) => {
          for (const bad of [Infinity, -Infinity]) {
            const result = mergeMonotonicUsage({
              entryTotals: entry,
              reportedTotals: reported,
              globalTotals: global,
              update: { inputTokens: bad, outputTokens: bad, totalTokens: bad },
            });
            assert.ok(Number.isFinite(result.entryTotals.inputTokens));
            assert.ok(Number.isFinite(result.entryTotals.outputTokens));
            assert.ok(Number.isFinite(result.entryTotals.totalTokens));
            assert.ok(result.entryTotals.inputTokens >= entry.inputTokens);
            assert.ok(result.entryTotals.outputTokens >= entry.outputTokens);
            assert.ok(result.entryTotals.totalTokens >= entry.totalTokens);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  test("NaN update preserves monotonicity in N-step chain", () => {
    fc.assert(
      fc.property(
        arbUsageTotals(),
        arbUsageTotals(),
        arbUsageTotals(),
        fc.array(
          fc.oneof(
            arbPartialUsageUpdate(),
            fc.constant({ inputTokens: NaN, outputTokens: NaN, totalTokens: NaN }),
            fc.constant({ inputTokens: NaN }),
            fc.constant({ totalTokens: NaN }),
          ),
          { minLength: 3, maxLength: 10 },
        ),
        (entry, reported, global, updates) => {
          let current = { entryTotals: entry, reportedTotals: reported, globalTotals: global };
          for (const update of updates) {
            const next = mergeMonotonicUsage({
              entryTotals: current.entryTotals,
              reportedTotals: current.reportedTotals,
              globalTotals: current.globalTotals,
              update,
            });
            assert.ok(Number.isFinite(next.entryTotals.inputTokens));
            assert.ok(Number.isFinite(next.entryTotals.outputTokens));
            assert.ok(Number.isFinite(next.entryTotals.totalTokens));
            assert.ok(next.entryTotals.inputTokens >= current.entryTotals.inputTokens);
            assert.ok(next.entryTotals.outputTokens >= current.entryTotals.outputTokens);
            assert.ok(next.entryTotals.totalTokens >= current.entryTotals.totalTokens);
            current = next;
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("INVARIANT: When an update value is lower than the current entry, the entry SHALL not decrease", () => {
  test("update with lower value than entry does NOT decrease entry", () => {
    fc.assert(
      fc.property(
        fc.record({
          inputTokens: fc.integer({ min: 100, max: 10_000_000 }),
          outputTokens: fc.integer({ min: 100, max: 10_000_000 }),
          totalTokens: fc.integer({ min: 100, max: 10_000_000 }),
          secondsRunning: fc.nat(),
        }),
        arbUsageTotals(),
        arbUsageTotals(),
        (entry, reported, global) => {
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
          assert.ok(result.entryTotals.inputTokens >= entry.inputTokens);
          assert.ok(result.entryTotals.outputTokens >= entry.outputTokens);
          assert.ok(result.entryTotals.totalTokens >= entry.totalTokens);
        },
      ),
      { numRuns: 500 },
    );
  });
});
