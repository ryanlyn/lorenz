import fs from "node:fs";
import path from "node:path";

import { test } from "vitest";
import { issuePayload, runsPayload, statePayload } from "@symphony/cli";
import type { RuntimeSnapshot } from "@symphony/runtime";

import { assert } from "../../../test/assert.js";

test("presenter preserves blocked dispatches, retry errors, run costs, retries, and log hints", () => {
  const snapshot = snapshotFixture();

  const state = statePayload(snapshot);
  const counts = state.counts as Record<string, unknown>;
  assert.equal(counts.blocked, 1);
  assert.deepEqual((state.running as any[])[0] as Record<string, unknown>, {
    issue_id: "running-1",
    issue_identifier: "MT-RUNNING",
    state: "Todo",
    slot_index: 0,
    ensemble_size: 1,
    worker_host: null,
    workspace_path: "/tmp/symphony/MT-RUNNING",
    session_id: null,
    resume_id: "resume-running",
    turn_count: 1,
    agent_kind: "codex",
    executor_pid: "123",
    usage_totals: { input_tokens: 2, output_tokens: 4, total_tokens: 6, seconds_running: 3 },
    last_event: null,
    last_message: null,
    started_at: "2026-05-06T00:00:00.000Z",
    last_event_at: null,
    tokens: { input_tokens: 2, output_tokens: 4, total_tokens: 6 },
  });
  assert.deepEqual(state.blocked_by_reason, { worker_host_capacity: 1 });
  assert.deepEqual((state.blocked as any[])[0], {
    issue_id: "blocked-1",
    issue_identifier: "MT-BLOCKED",
    state: "Todo",
    reason: "worker_host_capacity",
    label: "worker host capacity",
    worker_host: null,
  });
  assert.equal((state.retrying as any[])[0].error, "agent exited: boom");

  const issue = issuePayload(snapshot, "MT-RETRY");
  assert.equal(issue.status, "ok");
  if (issue.status !== "ok") throw new Error("issue payload should exist");
  assert.equal(issue.payload.last_error, "agent exited: boom");
  assert.deepEqual(issue.payload.retry, {
    attempt: 2,
    due_at: "2026-05-06T00:01:00.000Z",
    error: "agent exited: boom",
    worker_host: null,
    workspace_path: "/tmp/symphony/MT-RETRY",
  });

  const runningIssue = issuePayload(snapshot, "MT-RUNNING");
  assert.equal(runningIssue.status, "ok");
  if (runningIssue.status !== "ok") throw new Error("running issue payload should exist");
  assert.equal(runningIssue.payload.status, "running");
  assert.equal((runningIssue.payload.running as any).slot_index, 0);
  assert.equal((runningIssue.payload.running as any).ensemble_size, 1);
  assert.equal((runningIssue.payload.running as any).resume_id, "resume-running");

  const cost = runsPayload(snapshot, { cost: true });
  assert.equal(cost.status, "ok");
  if (cost.status !== "ok") throw new Error("cost payload should exist");
  assert.deepEqual((cost.payload.summary as any).totals, {
    run_count: 3,
    total_tokens: 15,
    estimated_cost_usd: null,
  });
  assert.deepEqual(
    (cost.payload.summary as any).by_agent.map((entry: any) => [
      entry.agent_kind,
      entry.completed_count,
    ]),
    [
      ["claude", 1],
      ["codex", 1],
    ],
  );

  const retries = runsPayload(snapshot, { retries: true });
  assert.equal(retries.status, "ok");
  if (retries.status !== "ok") throw new Error("retry payload should exist");
  assert.deepEqual((retries.payload.issues as any[])[0], {
    issue_identifier: "MT-RETRY",
    issue_id: "retry-1",
    issue_title: "Retry me",
    attempts: 2,
    latest_outcome: "success",
    total_tokens: 9,
    latest_run_id: "run-2",
    latest_failure_reason: null,
  });

  const detail = runsPayload(snapshot, { id: "run-2" });
  assert.equal(detail.status, "ok");
  if (detail.status !== "ok") throw new Error("detail payload should exist");
  assert.equal((detail.payload.run as any).retry_attempt, 1);
  assert.equal((detail.payload.run as any).last_event, null);
  assert.equal((detail.payload.run as any).log_hints.symphony_log_file, "/tmp/symphony.log");
});

test("presenter humanizes structured agent messages at the JSON API boundary", () => {
  const snapshot = snapshotFixture();
  snapshot.running[0]!.lastEvent = "assistant_message";
  snapshot.running[0]!.lastEventAt = "2026-05-06T00:00:02.000Z";
  snapshot.running[0]!.lastMessage = {
    agent_kind: "claude",
    event: "assistant_message",
    message: {
      type: "assistant",
      message: { content: [{ type: "text", text: "structured update\nfrom Claude" }] },
    },
  };
  snapshot.runHistory[0]!.lastEvent = "assistant_message";
  snapshot.runHistory[0]!.lastMessage = {
    event: "agent_message_delta",
    message: {
      payload: {
        method: "codex/event/agent_message_content_delta",
        params: { delta: "streaming update" },
      },
    },
  };

  const state = statePayload(snapshot);
  assert.equal((state.running as any[])[0].last_message, "structured update from Claude");

  const issue = issuePayload(snapshot, "MT-RUNNING");
  assert.equal(issue.status, "ok");
  if (issue.status !== "ok") throw new Error("issue payload should exist");
  assert.equal((issue.payload.recent_events as any[])[0].message, "structured update from Claude");

  const detail = runsPayload(snapshot, { id: "run-2" });
  assert.equal(detail.status, "ok");
  if (detail.status !== "ok") throw new Error("detail payload should exist");
  assert.equal(
    (detail.payload.run as any).last_message,
    "agent message content streaming: streaming update",
  );
});

test("presenter does not depend on the Ink TUI module for API projections", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "index.ts"), "utf8");
  assert.notMatch(source, /from "\.\/tui\.js"/);
});

function snapshotFixture(): RuntimeSnapshot {
  return {
    appStatus: "idle",
    workflowPath: "/tmp/WORKFLOW.md",
    poll: {
      status: "idle",
      candidates: 0,
      eligible: 0,
      lastPollAt: "2026-05-06T00:00:00.000Z",
      nextPollAt: null,
      lastError: null,
    },
    running: [
      {
        runId: "running-1",
        issueId: "running-1",
        issueIdentifier: "MT-RUNNING",
        title: "Running",
        state: "Todo",
        slotIndex: 0,
        ensembleSize: 1,
        agentKind: "codex",
        turnCount: 1,
        startedAt: "2026-05-06T00:00:00.000Z",
        workspacePath: "/tmp/symphony/MT-RUNNING",
        resumeId: "resume-running",
        executorPid: "123",
        usageTotals: { inputTokens: 2, outputTokens: 4, totalTokens: 6, secondsRunning: 3 },
        retryAttempt: 0,
      },
    ],
    retrying: [
      {
        issueId: "retry-1",
        identifier: "MT-RETRY",
        attempt: 2,
        dueAt: "2026-05-06T00:01:00.000Z",
        error: "agent exited: boom",
        workspacePath: "/tmp/symphony/MT-RETRY",
      },
    ],
    blocked: [
      {
        issueId: "blocked-1",
        identifier: "MT-BLOCKED",
        state: "Todo",
        reason: "worker_host_capacity",
      },
    ],
    runHistory: [
      {
        id: "run-2",
        issueId: "retry-1",
        issueIdentifier: "MT-RETRY",
        issueTitle: "Retry me",
        state: "Done",
        slotIndex: 0,
        ensembleSize: 1,
        agentKind: "claude",
        outcome: "success",
        turnCount: 1,
        workspace: "/tmp/symphony/MT-RETRY",
        usageTotals: { inputTokens: 3, outputTokens: 3, totalTokens: 6, secondsRunning: 8 },
        startedAt: "2026-05-06T00:00:20.000Z",
        endedAt: "2026-05-06T00:00:30.000Z",
        retryAttempt: 1,
      },
      {
        id: "run-1",
        issueId: "retry-1",
        issueIdentifier: "MT-RETRY",
        issueTitle: "Retry me",
        state: "Todo",
        slotIndex: 0,
        ensembleSize: 1,
        agentKind: "codex",
        outcome: "failed",
        turnCount: 0,
        workspace: "/tmp/symphony/MT-RETRY",
        usageTotals: { inputTokens: 3, outputTokens: 0, totalTokens: 3, secondsRunning: 1 },
        startedAt: "2026-05-06T00:00:00.000Z",
        endedAt: "2026-05-06T00:00:05.000Z",
        error: "agent exited: boom",
      },
    ],
    usageTotals: { inputTokens: 8, outputTokens: 7, totalTokens: 15, secondsRunning: 12 },
    rateLimits: null,
    logFile: "/tmp/symphony.log",
    recentEvents: [],
  };
}
