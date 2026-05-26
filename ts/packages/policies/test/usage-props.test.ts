import { test } from "vitest";
import fc from "fast-check";
import { mergeMonotonicUsage } from "@symphony/cli";

import { assert } from "../../../test/assert.js";
import { arbUsageTotals } from "../../../test/arbitraries.js";

const arbPartialUpdate = () =>
  fc.record({
    inputTokens: fc.option(fc.integer({ min: -100, max: 100_000 }), { nil: undefined }),
    outputTokens: fc.option(fc.integer({ min: -100, max: 100_000 }), { nil: undefined }),
    totalTokens: fc.option(fc.integer({ min: -100, max: 100_000 }), { nil: undefined }),
  });

test("mergeMonotonicUsage — entryTotals are always non-negative", () => {
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

test("mergeMonotonicUsage — entryTotals never decrease from input", () => {
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

test("mergeMonotonicUsage — globalTotals never decrease from input", () => {
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

test("mergeMonotonicUsage — reportedTotals sync with entryTotals token fields", () => {
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

test("mergeMonotonicUsage — secondsRunning preserved for each aggregate", () => {
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

test("mergeMonotonicUsage — idempotent when applied twice with same update", () => {
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
