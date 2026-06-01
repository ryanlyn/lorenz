import fc from "fast-check";
import type { UsageTotals } from "@symphony/domain";

export const arbUsageTotals = (): fc.Arbitrary<UsageTotals> =>
  fc.record({
    inputTokens: fc.nat(),
    outputTokens: fc.nat(),
    totalTokens: fc.nat(),
    secondsRunning: fc.nat(),
  });
