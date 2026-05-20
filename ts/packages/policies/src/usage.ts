import type { UsageTotals } from "@symphony/domain";

export interface UsageMergeInput {
  entryTotals: UsageTotals;
  reportedTotals: UsageTotals;
  globalTotals: UsageTotals;
  update: Partial<UsageTotals>;
}

export interface UsageMergeResult {
  entryTotals: UsageTotals;
  reportedTotals: UsageTotals;
  globalTotals: UsageTotals;
}

export function mergeMonotonicUsage(input: UsageMergeInput): UsageMergeResult {
  const nextInput = Math.max(
    input.entryTotals.inputTokens,
    0,
    input.update.inputTokens ?? input.entryTotals.inputTokens,
  );
  const nextOutput = Math.max(
    input.entryTotals.outputTokens,
    0,
    input.update.outputTokens ?? input.entryTotals.outputTokens,
  );
  const nextTotal = Math.max(
    input.entryTotals.totalTokens,
    0,
    input.update.totalTokens ?? input.entryTotals.totalTokens,
  );

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
