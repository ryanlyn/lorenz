import type { SandboxResult } from "./scenario.js";

/** Assertion types that can be checked against a SandboxResult. */
export type Assertion =
  | { type: "running_count"; expected: number }
  | { type: "not_running"; issueId: string }
  | { type: "is_running"; issueId: string }
  | { type: "event_occurred"; eventType: string; messageContains?: string }
  | { type: "event_not_occurred"; eventType: string; messageContains?: string }
  | { type: "retry_count"; issueId: string; minAttempts: number }
  | { type: "usage_bounds"; maxInputTokens?: number; maxOutputTokens?: number; maxTotalTokens?: number }
  | { type: "final_state"; issueId: string; expectedState: string }
  | { type: "dispatch_order"; issueIds: string[] }
  | { type: "no_errors" }
  | { type: "blocker_respected"; blockedIssueId: string; blockerIssueId: string }
  | { type: "concurrency_cap"; maxConcurrent: number };

/** Result of a single assertion check. */
export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  message: string;
}

/** Check all assertions against a SandboxResult. */
export function checkAssertions(result: SandboxResult, assertions: Assertion[]): AssertionResult[] {
  return assertions.map((assertion) => checkSingleAssertion(result, assertion));
}

function checkSingleAssertion(result: SandboxResult, assertion: Assertion): AssertionResult {
  switch (assertion.type) {
    case "running_count": {
      const actual = result.finalSnapshot.running.length;
      const passed = actual === assertion.expected;
      return {
        assertion,
        passed,
        message: passed
          ? `running_count: ${actual} === ${assertion.expected}`
          : `running_count: expected ${assertion.expected}, got ${actual}`,
      };
    }

    case "not_running": {
      const isRunning = result.finalSnapshot.running.some((r) => r.issueId === assertion.issueId);
      const passed = !isRunning;
      return {
        assertion,
        passed,
        message: passed
          ? `not_running: ${assertion.issueId} is not running`
          : `not_running: ${assertion.issueId} is still running`,
      };
    }

    case "is_running": {
      const isRunning = result.finalSnapshot.running.some((r) => r.issueId === assertion.issueId);
      return {
        assertion,
        passed: isRunning,
        message: isRunning
          ? `is_running: ${assertion.issueId} is running`
          : `is_running: ${assertion.issueId} is not running`,
      };
    }

    case "event_occurred": {
      const found = result.events.some(
        (e) =>
          e.type === assertion.eventType &&
          (!assertion.messageContains || e.message.includes(assertion.messageContains)),
      );
      return {
        assertion,
        passed: found,
        message: found
          ? `event_occurred: found ${assertion.eventType}`
          : `event_occurred: ${assertion.eventType} not found${
              assertion.messageContains ? ` (containing "${assertion.messageContains}")` : ""
            }`,
      };
    }

    case "event_not_occurred": {
      const found = result.events.some(
        (e) =>
          e.type === assertion.eventType &&
          (!assertion.messageContains || e.message.includes(assertion.messageContains)),
      );
      return {
        assertion,
        passed: !found,
        message: !found
          ? `event_not_occurred: ${assertion.eventType} correctly absent`
          : `event_not_occurred: ${assertion.eventType} unexpectedly found`,
      };
    }

    case "retry_count": {
      const retryEvents = result.events.filter(
        (e) => e.type === "run_failed" && e.message.includes(assertion.issueId),
      );
      const retryEntries = result.finalSnapshot.retrying.filter(
        (r) => r.issueId === assertion.issueId,
      );
      const maxAttempt = Math.max(
        retryEvents.length,
        ...retryEntries.map((r) => r.attempt),
        0,
      );
      const passed = maxAttempt >= assertion.minAttempts;
      return {
        assertion,
        passed,
        message: passed
          ? `retry_count: ${assertion.issueId} retried ${maxAttempt} times (>= ${assertion.minAttempts})`
          : `retry_count: ${assertion.issueId} retried ${maxAttempt} times (expected >= ${assertion.minAttempts})`,
      };
    }

    case "usage_bounds": {
      const usage = result.finalSnapshot.usageTotals;
      const checks: string[] = [];
      let passed = true;
      if (assertion.maxInputTokens !== undefined && (usage.inputTokens ?? 0) > assertion.maxInputTokens) {
        passed = false;
        checks.push(`inputTokens ${usage.inputTokens} > ${assertion.maxInputTokens}`);
      }
      if (
        assertion.maxOutputTokens !== undefined &&
        (usage.outputTokens ?? 0) > assertion.maxOutputTokens
      ) {
        passed = false;
        checks.push(`outputTokens ${usage.outputTokens} > ${assertion.maxOutputTokens}`);
      }
      if (assertion.maxTotalTokens !== undefined && (usage.totalTokens ?? 0) > assertion.maxTotalTokens) {
        passed = false;
        checks.push(`totalTokens ${usage.totalTokens} > ${assertion.maxTotalTokens}`);
      }
      return {
        assertion,
        passed,
        message: passed ? `usage_bounds: within limits` : `usage_bounds: exceeded - ${checks.join(", ")}`,
      };
    }

    case "final_state": {
      const historyEntries = result.finalSnapshot.runHistory.filter(
        (h) => h.issueId === assertion.issueId,
      );
      const lastEntry = historyEntries[historyEntries.length - 1];
      const actualState = lastEntry?.state ?? null;
      const passed = actualState === assertion.expectedState;
      return {
        assertion,
        passed,
        message: passed
          ? `final_state: ${assertion.issueId} in state "${assertion.expectedState}"`
          : `final_state: ${assertion.issueId} expected "${assertion.expectedState}", got "${actualState}"`,
      };
    }

    case "dispatch_order": {
      const startedEvents = result.events.filter((e) => e.type === "run_started");
      const dispatchedIds: string[] = [];
      for (const event of startedEvents) {
        const identifier = event.message.split(" ")[0];
        const histEntry = result.finalSnapshot.runHistory.find(
          (h) => h.issueIdentifier === identifier,
        );
        if (histEntry) {
          dispatchedIds.push(histEntry.issueId);
        }
      }
      let orderIdx = 0;
      for (const id of dispatchedIds) {
        if (orderIdx < assertion.issueIds.length && id === assertion.issueIds[orderIdx]) {
          orderIdx++;
        }
      }
      const passed = orderIdx === assertion.issueIds.length;
      return {
        assertion,
        passed,
        message: passed
          ? `dispatch_order: correct order observed`
          : `dispatch_order: expected [${assertion.issueIds.join(", ")}], dispatched [${dispatchedIds.join(", ")}]`,
      };
    }

    case "no_errors": {
      const passed = result.errors.length === 0;
      return {
        assertion,
        passed,
        message: passed
          ? `no_errors: no errors occurred`
          : `no_errors: ${result.errors.length} error(s) - ${result.errors.map((e) => e.message).join("; ")}`,
      };
    }

    case "blocker_respected": {
      const blockerCompleted = result.events.find(
        (e) => e.type === "run_completed" && e.message.includes(assertion.blockerIssueId),
      );
      const blockedStarted = result.events.find(
        (e) => e.type === "run_started" && e.message.includes(assertion.blockedIssueId),
      );
      if (!blockedStarted) {
        return {
          assertion,
          passed: true,
          message: `blocker_respected: ${assertion.blockedIssueId} never started (blocker respected)`,
        };
      }
      if (!blockerCompleted) {
        return {
          assertion,
          passed: false,
          message: `blocker_respected: ${assertion.blockedIssueId} started but blocker ${assertion.blockerIssueId} never completed`,
        };
      }
      const passed = new Date(blockerCompleted.at) <= new Date(blockedStarted.at);
      return {
        assertion,
        passed,
        message: passed
          ? `blocker_respected: ${assertion.blockerIssueId} completed before ${assertion.blockedIssueId} started`
          : `blocker_respected: ${assertion.blockedIssueId} started before ${assertion.blockerIssueId} completed`,
      };
    }

    case "concurrency_cap": {
      let maxConcurrent = 0;
      for (const snapshot of result.snapshots) {
        maxConcurrent = Math.max(maxConcurrent, snapshot.running.length);
      }
      const passed = maxConcurrent <= assertion.maxConcurrent;
      return {
        assertion,
        passed,
        message: passed
          ? `concurrency_cap: max concurrent ${maxConcurrent} <= ${assertion.maxConcurrent}`
          : `concurrency_cap: max concurrent ${maxConcurrent} > ${assertion.maxConcurrent}`,
      };
    }
  }
}
