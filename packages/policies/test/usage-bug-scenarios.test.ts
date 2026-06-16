import { describe, test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { mergeMonotonicUsage } from "@lorenz/policies";

function makeTotals(input = 10, output = 5, total = 15) {
  return { inputTokens: input, outputTokens: output, totalTokens: total, secondsRunning: 0 };
}

describe("Bug 4: NaN in update corrupts all token totals", () => {
  test("single field NaN: update.inputTokens=NaN should not corrupt entryTotals.inputTokens", () => {
    const result = mergeMonotonicUsage({
      entryTotals: makeTotals(10, 5, 15),
      reportedTotals: makeTotals(10, 5, 15),
      globalTotals: makeTotals(100, 50, 150),
      update: { inputTokens: NaN },
    });

    // Should stay 10, but NaN ?? fallback evaluates to NaN (not the fallback),
    // so Math.max(10, 0, NaN) returns NaN.
    assert.equal(Number.isNaN(result.entryTotals.inputTokens), false);
  });

  test("all fields NaN: update with all NaN should not corrupt any results", () => {
    const result = mergeMonotonicUsage({
      entryTotals: makeTotals(10, 5, 15),
      reportedTotals: makeTotals(10, 5, 15),
      globalTotals: makeTotals(100, 50, 150),
      update: { inputTokens: NaN, outputTokens: NaN, totalTokens: NaN },
    });

    // All entry totals should remain valid numbers, not NaN
    assert.equal(Number.isNaN(result.entryTotals.inputTokens), false);
    assert.equal(Number.isNaN(result.entryTotals.outputTokens), false);
    assert.equal(Number.isNaN(result.entryTotals.totalTokens), false);

    // Reported totals should also remain valid
    assert.equal(Number.isNaN(result.reportedTotals.inputTokens), false);
    assert.equal(Number.isNaN(result.reportedTotals.outputTokens), false);
    assert.equal(Number.isNaN(result.reportedTotals.totalTokens), false);
  });

  test("NaN propagation to globalTotals: NaN in update should not corrupt globalTotals", () => {
    const result = mergeMonotonicUsage({
      entryTotals: makeTotals(10, 5, 15),
      reportedTotals: makeTotals(10, 5, 15),
      globalTotals: makeTotals(100, 50, 150),
      update: { inputTokens: NaN, outputTokens: NaN, totalTokens: NaN },
    });

    // Global totals should remain valid numbers, not NaN
    assert.equal(Number.isNaN(result.globalTotals.inputTokens), false);
    assert.equal(Number.isNaN(result.globalTotals.outputTokens), false);
    assert.equal(Number.isNaN(result.globalTotals.totalTokens), false);
  });
});
