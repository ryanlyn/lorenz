import type { UsageTokenUpdate, UsageTotals } from "@symphony/domain";

export interface UsageMergeInput {
  entryTotals: UsageTotals;
  reportedTotals: UsageTotals;
  globalTotals: UsageTotals;
  update: UsageTokenUpdate;
}

export interface UsageMergeResult {
  entryTotals: UsageTotals;
  reportedTotals: UsageTotals;
  globalTotals: UsageTotals;
}

export function mergeMonotonicUsage(input: UsageMergeInput): UsageMergeResult {
  const safeInput = Number.isFinite(input.update.inputTokens)
    ? input.update.inputTokens!
    : input.entryTotals.inputTokens;
  const safeOutput = Number.isFinite(input.update.outputTokens)
    ? input.update.outputTokens!
    : input.entryTotals.outputTokens;
  const safeTotal = Number.isFinite(input.update.totalTokens)
    ? input.update.totalTokens!
    : input.entryTotals.totalTokens;

  const nextInput = Math.max(input.entryTotals.inputTokens, 0, safeInput);
  const nextOutput = Math.max(input.entryTotals.outputTokens, 0, safeOutput);
  const nextTotal = Math.max(input.entryTotals.totalTokens, 0, safeTotal);

  const inputDelta = Math.max(0, nextInput - input.reportedTotals.inputTokens);
  const outputDelta = Math.max(0, nextOutput - input.reportedTotals.outputTokens);
  const totalDelta = Math.max(0, nextTotal - input.reportedTotals.totalTokens);

  return {
    entryTotals: {
      inputTokens: nextInput,
      outputTokens: nextOutput,
      totalTokens: nextTotal,
      secondsRunning: input.entryTotals.secondsRunning,
    },
    reportedTotals: {
      inputTokens: nextInput,
      outputTokens: nextOutput,
      totalTokens: nextTotal,
      secondsRunning: input.reportedTotals.secondsRunning,
    },
    globalTotals: {
      inputTokens: input.globalTotals.inputTokens + inputDelta,
      outputTokens: input.globalTotals.outputTokens + outputDelta,
      totalTokens: input.globalTotals.totalTokens + totalDelta,
      secondsRunning: input.globalTotals.secondsRunning,
    },
  };
}
