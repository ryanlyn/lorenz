import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { mergeMonotonicUsage } from "@lorenz/policies/usage";
import type { UsageMergeInput } from "@lorenz/policies/usage";

const totals = (inputTokens = 0, outputTokens = 0, totalTokens = 0, secondsRunning = 0) => ({
  inputTokens,
  outputTokens,
  totalTokens,
  secondsRunning,
});

test("UsageMergeInput update rejects runtime accounting fields at compile time", () => {
  const update: UsageMergeInput["update"] = {
    inputTokens: 1,
    // @ts-expect-error Runtime is accounted when a run finishes, not by this merge helper.
    secondsRunning: 30,
  };

  assert.equal(update.inputTokens, 1);
});

test("mergeMonotonicUsage preserves secondsRunning when update type is bypassed", () => {
  const result = mergeMonotonicUsage({
    entryTotals: totals(1, 2, 3, 4),
    reportedTotals: totals(1, 2, 3, 5),
    globalTotals: totals(10, 20, 30, 6),
    update: { inputTokens: 8, secondsRunning: 999 } as unknown as UsageMergeInput["update"],
  });

  assert.equal(result.entryTotals.secondsRunning, 4);
  assert.equal(result.reportedTotals.secondsRunning, 5);
  assert.equal(result.globalTotals.secondsRunning, 6);
});
