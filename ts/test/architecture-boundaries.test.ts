import { test } from "vitest";
import {
  ProjectionActor,
  actionForStopReason,
  mergeMonotonicUsage,
  normalizeIssue,
  parseConfig,
  resumeIdentityMatches,
  retryBackoffMs,
  Orchestrator,
  slotKey,
} from "@symphony/cli";
import type { RuntimeProjectionInput, RuntimeRunHistoryEntry } from "@symphony/cli";

import { assert } from "./assert.js";

test("deterministic policies pin retry, stop reason, usage, and resume decisions", () => {
  assert.equal(retryBackoffMs(1, 60_000, "failure"), 10_000);
  assert.equal(retryBackoffMs(3, 60_000, "failure"), 40_000);
  assert.equal(retryBackoffMs(20, 60_000, "failure"), 60_000);
  assert.equal(retryBackoffMs(20, 60_000, "continuation"), 1_000);
  assert.equal(retryBackoffMs(1, 500, "continuation"), 1_000);

  assert.equal(actionForStopReason("end_turn"), "continue");
  assert.equal(actionForStopReason("max_tokens"), "continue");
  assert.equal(actionForStopReason("max_turn_requests"), "continue");
  assert.equal(actionForStopReason("refusal"), "retry");
  assert.equal(actionForStopReason("cancelled"), "cancel");

  const merged = mergeMonotonicUsage({
    entryTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, secondsRunning: 0 },
    reportedTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, secondsRunning: 0 },
    globalTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, secondsRunning: 0 },
    update: { inputTokens: 8, outputTokens: 7, totalTokens: 14 },
  });
  assert.deepEqual(merged.entryTotals, {
    inputTokens: 10,
    outputTokens: 7,
    totalTokens: 15,
    secondsRunning: 0,
  });
  assert.deepEqual(merged.globalTotals, {
    inputTokens: 10,
    outputTokens: 7,
    totalTokens: 15,
    secondsRunning: 0,
  });

  const issue = normalizeIssue({
    id: "issue-resume",
    identifier: "MT-RESUME",
    title: "Resume",
    state: { name: "Todo", type: "unstarted" },
  });
  assert.equal(
    resumeIdentityMatches(
      {
        agent: "codex",
        issueId: issue.id,
        workspacePath: "/tmp/workspace",
        workerHost: null,
      },
      { agent: "codex", issue, workspacePath: "/tmp/workspace", workerHost: null },
    ),
    true,
  );
  assert.equal(
    resumeIdentityMatches(
      {
        agent: "codex",
        issueId: issue.id,
        workspacePath: "/tmp/workspace",
        workerHost: null,
      },
      { agent: "claude", issue, workspacePath: "/tmp/workspace", workerHost: null },
    ),
    false,
  );
});

test("projection actor owns bounded read models and snapshots defensively", () => {
  const projection = new ProjectionActor();
  for (let index = 0; index < 25; index += 1) {
    projection.recordEvent({
      type: "notification",
      message: `event-${index}`,
      at: new Date(index).toISOString(),
    });
  }

  const historyEntry: RuntimeRunHistoryEntry = {
    id: "run-1",
    issueId: "issue-1",
    issueIdentifier: "MT-1",
    slotIndex: 0,
    agentKind: "codex",
    outcome: "failed",
    turnCount: 0,
    startedAt: "2026-05-07T00:00:00.000Z",
    endedAt: "2026-05-07T00:00:01.000Z",
    usageTotals: { inputTokens: 1, outputTokens: 2, totalTokens: 3, secondsRunning: 1 },
  };
  projection.recordRunHistory(historyEntry);

  const first = projection.snapshot(projectionInput());
  assert.equal(first.recentEvents.length, 20);
  assert.equal(first.recentEvents[0]?.message, "event-24");
  assert.equal(first.runHistory[0]?.id, "run-1");

  first.recentEvents.length = 0;
  first.runHistory[0]!.usageTotals!.totalTokens = 999;

  const second = projection.snapshot(projectionInput());
  assert.equal(second.recentEvents.length, 20);
  assert.equal(second.runHistory[0]?.usageTotals?.totalTokens, 3);
});

test("ugly retry flow keeps capacity authority in the orchestrator", () => {
  const settings = parseConfig({
    agent: { ensemble_size: 2, max_concurrent_agents: 2, max_retry_backoff_ms: 10_000 },
  });
  const orchestrator = new Orchestrator(settings);
  const issue = normalizeIssue({
    id: "ugly-retry-capacity",
    identifier: "MT-UGLY-RETRY",
    title: "Retry while full",
    state: { name: "Todo", type: "unstarted" },
  });

  assert.ok(orchestrator.claim(issue));
  assert.ok(orchestrator.claim(issue));
  orchestrator.state.retryAttempts.set(issue.id, {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt: 1,
    dueAt: new Date(Date.now() - 1),
    slotIndex: 1,
    error: "agent_stalled",
  });

  assert.deepEqual(orchestrator.eligibleIssues([issue]), []);
  assert.equal(orchestrator.snapshot().running.length, 2);
  assert.equal(orchestrator.snapshot().retrying.length, 1);

  orchestrator.finish(issue.id, 1, false);
  assert.equal(orchestrator.eligibleIssues([issue])[0]?.identifier, issue.identifier);
  assert.equal(orchestrator.claim(issue)?.slotIndex, 1);
  assert.equal(orchestrator.state.claimed.has(slotKey(issue.id, 1)), true);
});

function projectionInput(): RuntimeProjectionInput {
  return {
    appStatus: "idle",
    workflowPath: "/tmp/WORKFLOW.md",
    poll: {
      status: "idle",
      candidates: 0,
      eligible: 0,
      lastPollAt: null,
      nextPollAt: null,
      lastError: null,
    },
    running: [],
    retrying: [],
    blocked: [],
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    rateLimits: null,
    logFile: null,
  };
}
