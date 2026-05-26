import fc from "fast-check";
import type { Issue, IssueRef, IssueStateType, UsageTotals } from "@symphony/domain";
import { ISSUE_STATE_TYPES } from "@symphony/domain";

export const arbUsageTotals = (): fc.Arbitrary<UsageTotals> =>
  fc.record({
    inputTokens: fc.nat(),
    outputTokens: fc.nat(),
    totalTokens: fc.nat(),
    secondsRunning: fc.nat(),
  });

export const arbIssueStateType = (): fc.Arbitrary<IssueStateType> =>
  fc.constantFrom(...ISSUE_STATE_TYPES);

export const arbIssueRef = (): fc.Arbitrary<IssueRef> =>
  fc.record({
    id: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
    identifier: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }),
    state: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
    stateType: fc.option(arbIssueStateType(), { nil: null }),
  });

export const arbPriority = (): fc.Arbitrary<number | null> =>
  fc.oneof(fc.constantFrom(1, 2, 3, 4), fc.constant(null as number | null));

export const arbIssue = (): fc.Arbitrary<Issue> =>
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 30 }),
    identifier: fc.string({ minLength: 1, maxLength: 15 }),
    title: fc.string({ minLength: 1, maxLength: 100 }),
    state: fc.string({ minLength: 1, maxLength: 30 }),
    stateType: fc.option(arbIssueStateType(), { nil: null }),
    description: fc.option(fc.string(), { nil: null }),
    branchName: fc.option(fc.string(), { nil: null }),
    url: fc.option(fc.string(), { nil: null }),
    priority: fc.option(fc.integer({ min: 0, max: 6 }), { nil: null }),
    createdAt: fc.option(
      fc.date().map((d) => d.toISOString()),
      { nil: null },
    ),
    updatedAt: fc.option(
      fc.date().map((d) => d.toISOString()),
      { nil: null },
    ),
    labels: fc.array(
      fc.string({ minLength: 1, maxLength: 30 }).map((s) => s.trim().toLowerCase()),
      {
        maxLength: 5,
      },
    ),
    blockers: fc.array(arbIssueRef(), { maxLength: 3 }),
    assigneeId: fc.option(fc.string({ minLength: 1 }), { nil: null }),
    assignedToWorker: fc.option(fc.boolean(), { nil: null }),
  });
