import { test } from "vitest";
import fc from "fast-check";

import { assert } from "../../../test/assert.js";
import { arbUsageTotals } from "../../../test/arbitraries.js";

import { mergeMonotonicUsage } from "@symphony/policies";

const arbPartialUpdate = () =>
  fc.record({
    inputTokens: fc.option(fc.integer({ min: -100, max: 100_000 }), { nil: undefined }),
    outputTokens: fc.option(fc.integer({ min: -100, max: 100_000 }), { nil: undefined }),
    totalTokens: fc.option(fc.integer({ min: -100, max: 100_000 }), { nil: undefined }),
  });

test("INVARIANT: When token counters are updated, entryTotals SHALL always be non-negative", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUpdate(),
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
      },
    ),
  );
});

test("INVARIANT: When token counters are updated, entryTotals SHALL never decrease from their input values", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUpdate(),
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
  );
});

test("INVARIANT: When token counters are updated, globalTotals SHALL never decrease from their input values", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUpdate(),
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
  );
});

test("INVARIANT: When token counters are updated, reportedTotals SHALL always equal entryTotals token fields", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUpdate(),
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
  );
});

test("INVARIANT: When token counters are updated, secondsRunning SHALL be preserved unchanged for each aggregate", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUpdate(),
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
  );
});

test("INVARIANT: When the same update is applied twice, the result SHALL be idempotent", () => {
  fc.assert(
    fc.property(
      arbUsageTotals(),
      arbUsageTotals(),
      arbUsageTotals(),
      arbPartialUpdate(),
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
  );
});
