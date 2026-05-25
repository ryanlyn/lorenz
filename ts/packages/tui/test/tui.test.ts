import fs from "node:fs";
import path from "node:path";

import React from "react";
import { test } from "vitest";
import { render } from "ink-testing-library";
import type { RuntimeSnapshot } from "@symphony/runtime";

import { assert } from "../../../test/assert.js";

import {
  formatElixirStyleDashboard,
  humanizeAgentMessage,
  humanizeCodexMessage,
  rollingThroughput,
  RuntimeDashboard,
  updateTokenSamples,
} from "@symphony/tui";

test("Ink dashboard renders Elixir-style operational sections", () => {
  const { lastFrame } = render(
    React.createElement(RuntimeDashboard, { snapshot: snapshotFixture() }),
  );
  const frame = stripAnsi(lastFrame() ?? "");

  assert.match(frame, /SYMPHONY STATUS/);
  assert.match(frame, /Agents: 1\/10/);
  assert.match(frame, /Throughput:/);
  assert.match(frame, /Running/);
  assert.match(frame, /MT-1/);
  assert.match(frame, /Backoff queue/);
  assert.match(frame, /Dispatch blocks/);
});

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

test("terminal dashboard formatter matches exported Elixir golden fixtures", () => {
  for (const scenario of dashboardScenarios()) {
    assert.equal(
      formatElixirStyleDashboard(scenario.snapshot, scenario.options),
      readEvidence(scenario.name),
      `${scenario.name} plain fixture`,
    );
    const ansiOutput = formatElixirStyleDashboard(scenario.snapshot, {
      ...scenario.options,
      ansi: true,
    });
    assert.equal(ansiOutput.includes("\x1b[1m"), true);
    assert.equal(ansiOutput.includes("\\e["), false);
    assert.equal(ansiOutput, readAnsiSnapshot(scenario.name), `${scenario.name} ansi fixture`);
  }
});

test("terminal dashboard preserves tracker states in the running stage column", () => {
  const rendered = formatElixirStyleDashboard(
    dashboardSnapshot({
      now: "2026-05-05T02:00:00.000Z",
      running: [
        runningFixture(
          "MT-STATE",
          "codex",
          "Agent Review",
          "4242",
          30,
          2,
          50,
          "reviewing",
          "2026-05-05T02:00:00.000Z",
        ),
      ],
    }),
    { now: "2026-05-05T02:00:00.000Z", runtimeSeconds: 30, throughputTps: 2 },
  );

  assert.match(rendered, /codex\s+Agent Review\s+4242/);
  assert.notMatch(rendered, /codex\s+running\s+4242/);
});

test("TUI humanizes Codex and Claude event variants like the Elixir dashboard", () => {
  assert.equal(
    humanizeCodexMessage({
      event: "approval_auto_approved",
      message: {
        payload: {
          method: "item/commandExecution/requestApproval",
          params: { command: "gh pr view" },
        },
        decision: "acceptForSession",
      },
    }),
    "command approval requested (gh pr view) (auto-approved): acceptForSession",
  );
  assert.equal(
    humanizeCodexMessage({
      event: "tool_call_failed",
      message: { payload: { method: "item/tool/call", params: { name: "linear_graphql" } } },
    }),
    "dynamic tool call failed (linear_graphql)",
  );
  assert.equal(
    humanizeCodexMessage({ event: "malformed", message: '{"method":"turn/completed"' }),
    "malformed JSON event from codex",
  );
  assert.equal(
    humanizeCodexMessage({
      method: "turn/plan/updated",
      params: { plan: [{ step: "one" }, { step: "two" }] },
    }),
    "plan updated (2 steps)",
  );
  assert.equal(
    humanizeCodexMessage({ method: "turn/diff/updated", params: { diff: "a\nb\n" } }),
    "turn diff updated (2 lines)",
  );
  assert.equal(
    humanizeCodexMessage({
      method: "thread/tokenUsage/updated",
      params: { tokenUsage: { total: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } } },
    }),
    "thread token usage updated (in 2 out 3 total 5)",
  );
  assert.equal(
    humanizeAgentMessage({
      agent_kind: "claude",
      event: "assistant_message",
      message: { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } },
    }),
    "tool requested (Bash)",
  );
  assert.equal(
    humanizeAgentMessage({
      agent_kind: "claude",
      event: "rate_limit",
      message: { type: "rate_limit_event", rate_limit_info: { status: "near_limit" } },
    }),
    "rate limit status: near_limit",
  );
});

test("terminal throughput uses Elixir-style rolling token samples", () => {
  let samples = updateTokenSamples([], 10_000, 100);
  assert.equal(rollingThroughput(samples, 10_000, 100), 0);

  samples = updateTokenSamples(samples, 12_000, 700);
  assert.equal(Math.trunc(rollingThroughput(samples, 12_000, 700)), 300);

  samples = updateTokenSamples(samples, 16_500, 1_600);
  assert.deepEqual(
    samples.map((sample) => sample.timestampMs),
    [16_500, 12_000],
  );
  assert.equal(Math.trunc(rollingThroughput(samples, 16_500, 1_600)), 200);
});

function snapshotFixture(): RuntimeSnapshot {
  return {
    appStatus: "running",
    workflowPath: "/tmp/WORKFLOW.md",
    poll: {
      status: "idle",
      candidates: 2,
      eligible: 1,
      lastPollAt: "2026-05-05T00:00:00.000Z",
      nextPollAt: "2026-05-05T00:00:05.000Z",
      lastError: null,
    },
    running: [
      {
        issueId: "issue-1",
        issueIdentifier: "MT-1",
        title: "Build the thing",
        state: "Todo",
        slotIndex: 0,
        ensembleSize: 1,
        agentKind: "codex",
        sessionId: "session-1",
        resumeId: "resume-1",
        executorPid: "123",
        turnCount: 1,
        startedAt: "2026-05-05T00:00:00.000Z",
        lastEvent: "turn_completed",
        workspacePath: "/tmp/symphony/MT-1",
        usageTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, secondsRunning: 4 },
      },
    ],
    retrying: [],
    blocked: [],
    runHistory: [],
    usageTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, secondsRunning: 4 },
    rateLimits: { primary: { used: 1 } },
    logFile: null,
    recentEvents: [
      { type: "turn_completed", message: "MT-1 turn_completed", at: "2026-05-05T00:00:01.000Z" },
    ],
  };
}

function dashboardScenarios(): Array<{
  name: string;
  snapshot: RuntimeSnapshot;
  options: Parameters<typeof formatElixirStyleDashboard>[1];
}> {
  const idle = dashboardSnapshot({
    now: "2026-05-05T00:00:00.000Z",
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    rateLimits: null,
  });
  const backoffNow = "2026-05-05T00:45:00.000Z";
  return [
    {
      name: "backoff_queue",
      snapshot: dashboardSnapshot({
        now: backoffNow,
        usageTotals: {
          inputTokens: 18_000,
          outputTokens: 2_200,
          totalTokens: 20_200,
          secondsRunning: 2_700,
        },
        rateLimits: rateLimits("gpt-5", 0, 20_000, 95, 0, 60, 45, null),
        running: [
          runningFixture(
            "MT-638",
            "codex",
            "retrying",
            "4242",
            20 * 60 + 25,
            7,
            14_200,
            "agent message streami...",
            backoffNow,
          ),
        ],
        retrying: [
          retryFixture("MT-450", 4, 1.25, "rate limit exhausted", backoffNow),
          retryFixture("MT-451", 2, 3.9, "retrying after API timeout with jitter", backoffNow),
          retryFixture("MT-452", 6, 8.1, "worker crashed restarting cleanly", backoffNow),
          retryFixture(
            "MT-453",
            1,
            11,
            "fourth queued retry should also render after removing the top-three limit",
            backoffNow,
          ),
        ],
      }),
      options: { now: backoffNow, runtimeSeconds: 2_700, throughputTps: 15 },
    },
    {
      name: "credits_unlimited",
      snapshot: dashboardSnapshot({
        now: "2026-05-05T00:01:15.000Z",
        usageTotals: { inputTokens: 90, outputTokens: 12, totalTokens: 102, secondsRunning: 75 },
        rateLimits: rateLimits("priority-tier", 100, 100, 1, 500, 500, 1, "unlimited"),
        running: [
          runningFixture(
            "MT-777",
            "codex",
            "running",
            "4242",
            75,
            7,
            3_200,
            "thread token usage up...",
            "2026-05-05T00:01:15.000Z",
            "usage",
          ),
        ],
      }),
      options: { now: "2026-05-05T00:01:15.000Z", runtimeSeconds: 75, throughputTps: 42 },
    },
    {
      name: "idle",
      snapshot: idle,
      options: { now: "2026-05-05T00:00:00.000Z", runtimeSeconds: 0, throughputTps: 0 },
    },
    {
      name: "idle_with_dashboard_url",
      snapshot: idle,
      options: {
        now: "2026-05-05T00:00:00.000Z",
        runtimeSeconds: 0,
        throughputTps: 0,
        dashboardUrl: "http://127.0.0.1:4000",
      },
    },
    {
      name: "super_busy",
      snapshot: dashboardSnapshot({
        now: "2026-05-05T01:12:01.000Z",
        usageTotals: {
          inputTokens: 250_000,
          outputTokens: 18_500,
          totalTokens: 268_500,
          secondsRunning: 4_321,
        },
        rateLimits: rateLimits("gpt-5", 12_345, 20_000, 30, 45, 60, 12, 9_876.5),
        running: [
          runningFixture(
            "MT-101",
            "codex",
            "running",
            "4242",
            13 * 60 + 5,
            11,
            120_450,
            "turn completed (compl...",
            "2026-05-05T01:12:01.000Z",
            "turn_completed",
          ),
          runningFixture(
            "MT-102",
            "claude",
            "running",
            "5252",
            6 * 60 + 52,
            4,
            89_200,
            "mix test --cover",
            "2026-05-05T01:12:01.000Z",
            "turn_started",
          ),
        ],
      }),
      options: { now: "2026-05-05T01:12:01.000Z", runtimeSeconds: 4_321, throughputTps: 1_842 },
    },
  ];
}

function dashboardSnapshot(input: Partial<RuntimeSnapshot> & { now: string }): RuntimeSnapshot {
  return {
    appStatus: "running",
    workflowPath: "/tmp/WORKFLOW.md",
    poll: {
      status: "idle",
      candidates: 0,
      eligible: 0,
      lastPollAt: input.now,
      nextPollAt: null,
      lastError: null,
    },
    running: input.running ?? [],
    retrying: input.retrying ?? [],
    blocked: input.blocked ?? [],
    runHistory: [],
    usageTotals: input.usageTotals ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: 0,
    },
    rateLimits: input.rateLimits ?? null,
    logFile: null,
    recentEvents: [],
  };
}

function runningFixture(
  identifier: string,
  agentKind: string,
  state: string,
  executorPid: string,
  ageSeconds: number,
  turnCount: number,
  totalTokens: number,
  lastMessage: string,
  now: string,
  lastEvent: RuntimeSnapshot["running"][number]["lastEvent"] = "notification",
): RuntimeSnapshot["running"][number] {
  return {
    issueId: identifier,
    issueIdentifier: identifier,
    title: "Fixture issue",
    state,
    slotIndex: 0,
    ensembleSize: 1,
    agentKind,
    sessionId: "thread-1234567890",
    resumeId: "thread-1234567890",
    executorPid,
    turnCount,
    startedAt: new Date(new Date(now).getTime() - ageSeconds * 1000).toISOString(),
    lastEvent,
    lastMessage,
    lastEventAt: now,
    workspacePath: `/tmp/symphony/${identifier}`,
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens, secondsRunning: ageSeconds },
  };
}

function retryFixture(
  identifier: string,
  attempt: number,
  dueInSeconds: number,
  error: string,
  now: string,
): RuntimeSnapshot["retrying"][number] {
  return {
    issueId: identifier,
    identifier,
    attempt,
    dueAt: new Date(new Date(now).getTime() + dueInSeconds * 1000).toISOString(),
    error,
    slotIndex: 0,
  };
}

function rateLimits(
  model: string,
  primaryUsed: number,
  primaryLimit: number,
  primaryReset: number,
  secondaryUsed: number,
  secondaryLimit: number,
  secondaryReset: number,
  credits: number | string | null,
): unknown {
  return {
    model,
    primary: { used: primaryUsed, limit: primaryLimit, resetSeconds: primaryReset },
    secondary: { used: secondaryUsed, limit: secondaryLimit, resetSeconds: secondaryReset },
    credits,
  };
}

function readEvidence(name: string): string {
  const raw = fs.readFileSync(fixturePath(`${name}.evidence.md`), "utf8");
  const match = /```text\n([\s\S]*)```/.exec(raw);
  assert.ok(match);
  return match[1] ?? "";
}

function readAnsiSnapshot(name: string): string {
  return fs.readFileSync(fixturePath(`${name}.snapshot.txt`), "utf8").replaceAll("\\e", "\x1b");
}

function fixturePath(filename: string): string {
  return path.join(import.meta.dirname, "../../../test/fixtures/elixir-dashboard", filename);
}
