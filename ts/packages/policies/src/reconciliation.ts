import { issueHasOpenBlockers, issueIsActive, routedToThisWorker } from "@symphony/dispatch";
import type { Issue, Settings } from "@symphony/domain";

export const RUNTIME_RECONCILIATION_REASONS = [
  "terminal",
  "unrouted",
  "blocked",
  "inactive",
] as const;
export type RuntimeReconciliationReason = (typeof RUNTIME_RECONCILIATION_REASONS)[number];

export function reconciliationStopReason(
  issue: Issue,
  settings: Settings,
): RuntimeReconciliationReason {
  if (!issueIsActive(issue, settings)) return "terminal";
  if (!routedToThisWorker(issue, settings)) return "unrouted";
  if (issueHasOpenBlockers(issue, settings)) return "blocked";
  return "inactive";
}
