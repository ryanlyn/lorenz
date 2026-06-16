import type { Issue } from "@lorenz/cli";
import { makeIssue } from "@lorenz/test-utils";

export { makeIssue, makeSettings } from "@lorenz/test-utils";

/** Promisified setTimeout. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Create N issues forming a dependency chain where each blocks the next. */
export function makeDependencyChain(count: number): Issue[] {
  const issues: Issue[] = [];
  for (let i = 0; i < count; i++) {
    const id = `chain-${i}`;
    const identifier = `CHAIN-${i}`;
    const blockers =
      i > 0
        ? [
            {
              id: `chain-${i - 1}`,
              identifier: `CHAIN-${i - 1}`,
              state: "Todo",
              stateType: "unstarted",
            },
          ]
        : [];
    issues.push(makeIssue(id, identifier, { blockers }));
  }
  return issues;
}

/** Create N issues with varied priorities (1 = urgent through N = low). */
export function makePrioritySpread(count: number): Issue[] {
  const issues: Issue[] = [];
  for (let i = 0; i < count; i++) {
    issues.push(makeIssue(`prio-${i}`, `PRIO-${i}`, { priority: i + 1 }));
  }
  return issues;
}

/** Create many concurrent issues for load testing. */
export function makeHighTraffic(count: number): Issue[] {
  const issues: Issue[] = [];
  for (let i = 0; i < count; i++) {
    issues.push(makeIssue(`traffic-${i}`, `TRAFFIC-${i}`, { priority: 2 }));
  }
  return issues;
}

export function cloneIssue(issue: Issue): Issue {
  return {
    ...issue,
    labels: [...issue.labels],
    blockers: issue.blockers.map((b) => ({ ...b })),
  };
}
