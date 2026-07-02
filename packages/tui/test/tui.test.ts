import fs from "node:fs";
import path from "node:path";

import React from "react";
import { test, vi } from "vitest";
import { render } from "ink-testing-library";
import type { RuntimeSnapshot } from "@lorenz/runtime";
import { assert } from "@lorenz/test-utils";

import {
  formatAgentDetail,
  formatDashboard,
  humanizeAgentMessage,
  humanizeCodexMessage,
  rollingThroughput,
  RuntimeApp,
  RuntimeDashboard,
  tokenRateSparkline,
  updateTokenSamples,
} from "@lorenz/tui";
import type { RuntimeViewSource } from "@lorenz/tui";

test("Ink dashboard renders the flight board with an event tape at the bottom", () => {
  const { lastFrame } = render(
    React.createElement(RuntimeDashboard, { snapshot: snapshotFixture() }),
  );
  const frame = stripAnsi(lastFrame() ?? "");

  assert.match(frame, /LORENZ/);
  assert.match(frame, /1 running/);
  // The configured cap renders only when the caller provides it.
  assert.notMatch(frame, /1\/10/);
  assert.match(frame, /tps/);
  assert.match(frame, /LANE/);
  assert.match(frame, /run\s+MT-1/);
  assert.match(frame, /Build the thing/);
  assert.match(frame, /events/);
  assert.match(frame, /turn_completed\s+MT-1 turn_completed/);
  // The tape sits below the table.
  assert.ok(frame.indexOf("LANE") < frame.indexOf("events"));
});

test("board adapts its columns to the viewport width", () => {
  const snapshot = dashboardSnapshot({
    now: "2026-05-05T02:00:00.000Z",
    running: [
      runningFixture(
        "MT-WIDE",
        "codex",
        "In Progress",
        "4242",
        90,
        3,
        12_345,
        "a fairly long humanized activity message that should truncate",
        "2026-05-05T02:00:00.000Z",
      ),
    ],
    retrying: [
      retryFixture(
        "MT-RTY",
        2,
        30,
        "a long error string that also needs truncation to fit narrow viewports",
        "2026-05-05T02:00:00.000Z",
      ),
    ],
    recentEvents: [
      {
        type: "run_started",
        message: "MT-WIDE started with a fairly verbose event message attached to it",
        at: "2026-05-05T01:59:00.000Z",
      },
    ],
  });
  const opts = {
    now: "2026-05-05T02:00:00.000Z",
    runtimeSeconds: 90,
    throughputTps: 100,
    interactive: true,
    projectUrl: "https://linear.app/northwind/team/ENG",
    dashboardUrl: "http://127.0.0.1:8771",
  };

  // Invariant: no rendered line ever exceeds the viewport width.
  for (const columns of [60, 72, 84, 100, 132, 180, 220]) {
    const rendered = formatDashboard(snapshot, { ...opts, columns });
    for (const line of rendered.split("\n")) {
      assert.ok(line.length <= columns, `width ${columns} overflowed: "${line}" (${line.length})`);
    }
    const detail = formatAgentDetail(snapshot.running[0]!, snapshot, {
      ...opts,
      columns,
      sparkline: "▁▁▂▃▅▇█▅▃▂",
      runTps: 42,
    });
    for (const line of detail.split("\n")) {
      assert.ok(
        line.length <= columns,
        `detail width ${columns} overflowed: "${line}" (${line.length})`,
      );
    }
  }

  // Narrow boards drop low-priority columns but keep the essentials.
  const narrow = formatDashboard(snapshot, { ...opts, columns: 72 });
  assert.notMatch(narrow, /LANE/);
  assert.notMatch(narrow, /HOST/);
  assert.match(narrow, /ID\s+TITLE/);
  assert.match(narrow, /LAST ACTIVITY/);
  assert.match(narrow, /MT-WIDE/);

  // Wide boards keep every column and let flexible ones breathe.
  const wide = formatDashboard(snapshot, { ...opts, columns: 180 });
  assert.match(wide, /LANE\s+ID\s+TITLE\s+STAGE\s+AGENT\s+HOST/);
  const extraWide = formatDashboard(snapshot, { ...opts, columns: 220 });
  assert.match(extraWide, /a fairly long humanized activity message that should truncate/);
});

test("board windows the table to the viewport height with a cursor-following view", () => {
  const now = "2026-05-05T02:00:00.000Z";
  const running = Array.from({ length: 100 }, (_, i) =>
    runningFixture(
      `MT-${String(i + 1).padStart(3, "0")}`,
      "codex",
      "running",
      "4242",
      60,
      1,
      10,
      "working",
      now,
    ),
  );
  const snapshot = dashboardSnapshot({
    now,
    running,
    blocked: [
      { issueId: "b1", identifier: "MT-BLK", state: "Todo", reason: "global_concurrency_cap" },
    ],
    recentEvents: [
      { type: "run_started", message: "MT-001 started", at: "2026-05-05T01:59:00.000Z" },
    ],
  });
  const opts = { now, runtimeSeconds: 60, throughputTps: 10, interactive: true, columns: 120 };

  const top = formatDashboard(snapshot, { ...opts, rows: 30, cursor: 0 });
  assert.ok(top.split("\n").length <= 30, `expected <=30 lines, got ${top.split("\n").length}`);
  assert.match(top, /\b1 ▶/);
  assert.match(top, /↓ \d+ more \(\d+ run · 1 block\)/);
  assert.notMatch(top, /↑ \d+ more/);

  // The window follows the cursor deep into the list; both indicators show.
  const mid = formatDashboard(snapshot, { ...opts, rows: 30, cursor: 60 });
  assert.match(mid, /↑ \d+ more/);
  assert.match(mid, /↓ \d+ more/);
  assert.match(mid, /▸\s*61 ▶/);

  // Three-digit indexes align without assuming single-digit agent counts.
  assert.match(mid, /\b61 ▶ .*MT-061/);
});

test("running cap renders when provided and lane labels compress when narrow", () => {
  const snapshot = dashboardSnapshot({
    now: "2026-05-05T02:00:00.000Z",
    running: [
      runningFixture(
        "MT-1",
        "codex",
        "running",
        "1",
        10,
        1,
        5,
        "working",
        "2026-05-05T02:00:00.000Z",
      ),
    ],
  });
  const capped = formatDashboard(snapshot, {
    now: "2026-05-05T02:00:00.000Z",
    runtimeSeconds: 10,
    throughputTps: 1,
    maxAgents: 100,
    columns: 132,
  });
  assert.match(capped, /1\/100 running/);

  const narrow = formatDashboard(snapshot, {
    now: "2026-05-05T02:00:00.000Z",
    runtimeSeconds: 10,
    throughputTps: 1,
    columns: 72,
  });
  assert.match(narrow, /1 run\b/);
});

test("header shows a moving throughput sparkline and a fleet status bar", () => {
  const now = "2026-05-05T02:00:00.000Z";
  const snapshot = {
    ...dashboardSnapshot({
      now,
      running: [runningFixture("MT-1", "codex", "running", "1", 10, 1, 5, "working", now)],
      retrying: [retryFixture("MT-2", 1, 30, "boom", now)],
    }),
    poll: {
      status: "idle" as const,
      candidates: 9,
      eligible: 6,
      lastPollAt: now,
      nextPollAt: null,
      lastError: null,
    },
    runHistory: [
      {
        id: "r1",
        issueId: "h1",
        issueIdentifier: "MT-OLD",
        slotIndex: 0,
        agentKind: "codex",
        outcome: "success" as const,
        turnCount: 2,
        startedAt: "2026-05-05T01:00:00.000Z",
        endedAt: "2026-05-05T01:10:00.000Z",
      },
      {
        id: "r2",
        issueId: "h2",
        issueIdentifier: "MT-BAD",
        slotIndex: 0,
        agentKind: "codex",
        outcome: "failed" as const,
        turnCount: 2,
        startedAt: "2026-05-05T01:00:00.000Z",
        endedAt: "2026-05-05T01:20:00.000Z",
      },
    ],
  };
  const rendered = formatDashboard(snapshot, {
    now,
    runtimeSeconds: 10,
    throughputTps: 1_234,
    throughputSparkline: "▁▂▃▅▇█▆▄▂▁",
    runSparkline: () => "▂▃▅▇▆▅▃▂▁▁",
    columns: 132,
  });

  // Line 1: the rolling throughput histogram sits beside the tps figure.
  assert.match(rendered, /▁▂▃▅▇█▆▄▂▁ 1,234 tps/);
  // Line 2: one stacked bar over history + live lanes + dispatchable backlog.
  assert.match(rendered, /issues [█░]+/);
  assert.match(rendered, /1✓/);
  assert.match(rendered, /1✗/);
  assert.match(rendered, /1 active/);
  assert.match(rendered, /1 waiting/);
  assert.match(rendered, /6 backlog/);
  // No model-specific gauge; rate limits are absent in this snapshot.
  assert.notMatch(rendered, /primary/);
  // The RATE column renders the per-run histogram.
  assert.match(rendered, /RATE/);
  assert.match(rendered, /▂▃▅▇▆▅▃▂▁▁/);

  // Without the sparkline callbacks the header and table stay chart-free.
  const plain = formatDashboard(snapshot, {
    now,
    runtimeSeconds: 10,
    throughputTps: 1,
    columns: 132,
  });
  assert.notMatch(plain, /RATE/);
});

test("board event tape reads oldest to newest, newest at the bottom", () => {
  const rendered = formatDashboard(
    dashboardSnapshot({
      now: "2026-05-05T02:00:00.000Z",
      recentEvents: [
        { type: "run_started", message: "MT-2 run started", at: "2026-05-05T00:00:02.000Z" },
        { type: "turn_completed", message: "MT-1 turn done", at: "2026-05-05T00:00:01.000Z" },
      ],
    }),
    { now: "2026-05-05T02:00:00.000Z", runtimeSeconds: 0, throughputTps: 0 },
  );
  assert.match(rendered, /MT-1 turn done[\s\S]*MT-2 run started/);
});

test("RuntimeApp narrows into an agent card on digit keys and returns on escape", async () => {
  const snapshot = snapshotFixture();
  const runtime: RuntimeViewSource = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  };
  const { frames, stdin, unmount } = render(React.createElement(RuntimeApp, { runtime }));
  const lastFrame = () => stripAnsi(frames.findLast((candidate) => candidate.trim() !== "") ?? "");
  try {
    await vi.waitFor(() => assert.match(lastFrame(), /LAST ACTIVITY/));

    stdin.write("1");
    await vi.waitFor(() => assert.match(lastFrame(), /session session-1/));
    const detail = lastFrame();
    assert.match(detail, /MT-1 · Build the thing/);
    assert.match(detail, /workspace \/tmp\/lorenz\/MT-1/);
    assert.match(detail, /rate [▁▂▃▄▅▆▇█]{10}/u);
    assert.match(detail, /events · MT-1/);
    assert.notMatch(detail, /LAST ACTIVITY/);

    stdin.write("\u001B"); // escape key
    await vi.waitFor(() => assert.match(lastFrame(), /LAST ACTIVITY/));
  } finally {
    unmount();
  }
});

test("agent detail formatter shows run vitals and agent-filtered events", () => {
  const snapshot = dashboardSnapshot({
    now: "2026-05-05T02:00:00.000Z",
    running: [
      {
        ...runningFixture(
          "MT-CARD",
          "claude",
          "Agent Review",
          "4242",
          30,
          7,
          1_500,
          { method: "turn/diff/updated", params: { diff: "a\nb\n" } },
          "2026-05-05T02:00:00.000Z",
          "turn_completed",
        ),
        workerHost: "ssh-worker-2",
        toolCallCount: 12,
        retryAttempt: 2,
      },
    ],
    recentEvents: [
      { type: "run_started", message: "MT-CARD run started", at: "2026-05-05T01:59:40.000Z" },
      { type: "poll_error", message: "unrelated tracker noise", at: "2026-05-05T01:59:50.000Z" },
    ],
  });
  const run = snapshot.running[0];
  assert.ok(run);
  const rendered = formatAgentDetail(run, snapshot, {
    now: "2026-05-05T02:00:00.000Z",
    runtimeSeconds: 30,
    throughputTps: 5,
    sparkline: "▁▁▂▃▅▇█▅▃▂",
    runTps: 42,
  });

  assert.match(rendered, /MT-CARD · Fixture issue/);
  assert.match(rendered, /stage Agent Review/);
  assert.match(rendered, /host ssh-worker-2/);
  assert.match(rendered, /retry attempt 2/);
  assert.match(rendered, /turn 7/);
  assert.match(rendered, /tools 12/);
  assert.match(rendered, /rate ▁▁▂▃▅▇█▅▃▂ 42 tps/);
  assert.match(rendered, /session thre\.\.\.567890|session thread-1234567890/);
  assert.match(rendered, /pid 4242/);
  assert.match(rendered, /turn diff updated \(2 lines\)/);
  assert.match(rendered, /events · MT-CARD/);
  assert.match(rendered, /MT-CARD run started/);
  assert.notMatch(rendered, /unrelated tracker noise/);
});

test("token rate sparkline plots per-bucket deltas, not the cumulative ramp", () => {
  const nowMs = 60_000;
  // Steady climb: equal deltas per bucket -> a flat-topped histogram, not a ramp.
  const steady = Array.from({ length: 11 }, (_, i) => ({
    timestampMs: i * 6_000,
    totalTokens: i * 100,
  }));
  assert.equal(tokenRateSparkline(steady, nowMs), "██████████");

  // A single burst in the middle dominates; quiet buckets floor out.
  const burst = [
    { timestampMs: 0, totalTokens: 0 },
    { timestampMs: 30_000, totalTokens: 0 },
    { timestampMs: 36_000, totalTokens: 700 },
    { timestampMs: 60_000, totalTokens: 700 },
  ];
  const rendered = tokenRateSparkline(burst, nowMs);
  assert.equal(rendered.length, 10);
  assert.equal(rendered[5], "█");
  assert.equal(rendered[0], "▁");
  assert.equal(rendered[9], "▁");

  // No samples or no movement -> a flat floor.
  assert.equal(tokenRateSparkline([], nowMs), "▁▁▁▁▁▁▁▁▁▁");
});

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

test("terminal dashboard formatter matches exported golden fixtures", () => {
  for (const scenario of dashboardScenarios()) {
    const plainOutput = formatDashboard(scenario.snapshot, scenario.options);
    const ansiOutput = formatDashboard(scenario.snapshot, {
      ...scenario.options,
      ansi: true,
    });
    if (process.env.UPDATE_DASHBOARD_FIXTURES) {
      fs.writeFileSync(
        fixturePath(`${scenario.name}.evidence.md`),
        "```text\n" + plainOutput + "```\n",
      );
      fs.writeFileSync(
        fixturePath(`${scenario.name}.snapshot.txt`),
        ansiOutput.replaceAll("\x1b", "\\e"),
      );
      continue;
    }
    assert.equal(plainOutput, readEvidence(scenario.name), `${scenario.name} plain fixture`);
    assert.equal(ansiOutput.includes("\x1b[1m"), true);
    assert.equal(ansiOutput.includes("\\e["), false);
    assert.equal(ansiOutput, readAnsiSnapshot(scenario.name), `${scenario.name} ansi fixture`);
  }
});

test("terminal dashboard preserves tracker states in the running stage column", () => {
  const rendered = formatDashboard(
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

  assert.match(rendered, /MT-STATE\s+Fixture issue\s+Agent Review/);
  assert.notMatch(rendered, /MT-STATE\s+Fixture issue\s+running/);
});

test("terminal dashboard renders placeholder activity for claimed runs before agent events arrive", () => {
  const rendered = formatDashboard(
    dashboardSnapshot({
      now: "2026-05-05T02:00:00.000Z",
      running: [
        {
          ...runningFixture(
            "MT-PEND",
            "codex",
            "running",
            null,
            0,
            0,
            0,
            null,
            "2026-05-05T02:00:00.000Z",
            null,
          ),
          sessionId: null,
        },
      ],
    }),
    { now: "2026-05-05T02:00:00.000Z", runtimeSeconds: 0, throughputTps: 0 },
  );

  assert.match(
    rendered,
    /LANE\s+ID\s+TITLE\s+STAGE\s+AGENT\s+HOST\s+AGE\/TURN\s+TOKENS\s+LAST ACTIVITY/,
  );
  assert.match(rendered, /MT-PEND/);
  assert.match(rendered, /no agent message yet/);
  assert.notMatch(rendered, /\bundefined\b/);
});

test("terminal dashboard renders humanized last activity and worker host per run", () => {
  const rendered = formatDashboard(
    dashboardSnapshot({
      now: "2026-05-05T02:00:00.000Z",
      running: [
        {
          ...runningFixture(
            "MT-ACT",
            "codex",
            "In Progress",
            "4242",
            30,
            2,
            1_234,
            { method: "turn/diff/updated", params: { diff: "a\nb\n" } },
            "2026-05-05T02:00:00.000Z",
            "turn_completed",
          ),
          workerHost: "ssh-worker-2",
        },
      ],
    }),
    { now: "2026-05-05T02:00:00.000Z", runtimeSeconds: 30, throughputTps: 41 },
  );

  assert.match(rendered, /MT-ACT/);
  assert.match(rendered, /ssh-worker-2/);
  assert.match(rendered, /turn diff updated \(2 lines\)/);
  // Session ids and executor pids no longer spend board columns.
  assert.notMatch(rendered, /thre\.\.\.567890/);
  assert.notMatch(rendered, /4242/);
});

test("terminal dashboard sanitizes snapshot-derived strings before rendering", () => {
  const now = "2026-05-05T02:00:00.000Z";
  const rendered = formatDashboard(
    dashboardSnapshot({
      now,
      running: [
        runningFixture(
          "MT-1\n│ spoofed",
          "codex\n│ agent-kind\x1b[2J",
          "In Progress\x1b[2J",
          "4242",
          0,
          1,
          0,
          "boom\n│ fake-event\x1b[2J",
          now,
          "turn_ended_with_error",
        ),
      ],
      retrying: [retryFixture("MT-RETRY\n│ fake-retry\x1b[2J", 1, 1, "retry\n│ fake-error", now)],
      rateLimits: {
        model: "gpt-5\n│ fake-rate\x1b[2J",
        primary: { used: 1, limit: 2, resetSeconds: 3 },
        credits: "none\n│ fake-credit\x1b[2J",
      },
    }),
    {
      now,
      dashboardUrl: "http://127.0.0.1:4000\n│ fake-dashboard\x1b[2J",
      projectUrl: "https://linear.app/project\n│ fake-project\x1b[2J",
      runtimeSeconds: 0,
      throughputTps: 0,
    },
  );

  assert.match(rendered, /MT-1/);
  // The injected agent kind is sanitized, then truncated to the agent column.
  assert.match(rendered, /cod\.\.\./);
  assert.match(rendered, /In Progress/);
  assert.match(rendered, /MT-RET/);
  assert.match(rendered, /gpt-5/);
  assert.equal(rendered.includes("\x1b[2J"), false);
  assert.notMatch(rendered, /\n│ (agent-kind|fake-\w+|spoofed)/);
});

test("Runtime field uses the live snapshot aggregate without adding active run age again", () => {
  const snapshot = dashboardSnapshot({
    now: "2026-05-05T00:00:30.000Z",
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 30 },
    running: [
      runningFixture(
        "MT-1",
        "codex",
        "running",
        "4242",
        30,
        1,
        0,
        "working",
        "2026-05-05T00:00:30.000Z",
      ),
    ],
  });

  const runtimeToken = (now: string): string => {
    const frame = formatDashboard(snapshot, { now });
    return /\bup (\d+m \d+s)/.exec(frame)?.[1] ?? "";
  };

  assert.equal(runtimeToken("2026-05-05T00:00:30.000Z"), "0m 30s");
  assert.equal(runtimeToken("2026-05-05T00:01:30.000Z"), "0m 30s");
});

test("Runtime field advances active aggregate from snapshot receipt time", () => {
  const snapshot = dashboardSnapshot({
    now: "2026-05-05T00:00:30.000Z",
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 30 },
    running: [
      runningFixture(
        "MT-1",
        "codex",
        "running",
        "4242",
        30,
        1,
        0,
        "working",
        "2026-05-05T00:00:30.000Z",
      ),
    ],
  });

  const frame = formatDashboard(snapshot, {
    now: "2026-05-05T00:01:30.000Z",
    snapshotReceivedAt: "2026-05-05T00:00:30.000Z",
  });

  assert.match(frame, /\bup 1m 30s/);
});

test("Runtime field uses wall-clock app runtime when the snapshot supplies it", () => {
  const snapshot = dashboardSnapshot({
    now: "2026-05-05T00:01:00.000Z",
    appStartedAt: "2026-05-05T00:00:00.000Z",
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 120 },
    running: [
      runningFixture(
        "MT-1",
        "codex",
        "running",
        "4242",
        60,
        1,
        0,
        "working",
        "2026-05-05T00:01:00.000Z",
      ),
      runningFixture(
        "MT-2",
        "codex",
        "running",
        "5252",
        60,
        1,
        0,
        "working",
        "2026-05-05T00:01:00.000Z",
      ),
    ],
  });

  const frame = formatDashboard(snapshot, {
    now: "2026-05-05T00:01:10.000Z",
    snapshotReceivedAt: "2026-05-05T00:01:00.000Z",
  });

  assert.match(frame, /\bup 1m 10s/);
  assert.notMatch(frame, /\bup 2m 20s/);
});

test("Runtime field includes completed and active seconds supplied by the snapshot", () => {
  const snapshot = dashboardSnapshot({
    now: "2026-05-05T00:00:30.000Z",
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 150 },
    running: [
      runningFixture(
        "MT-1",
        "codex",
        "running",
        "4242",
        30,
        1,
        0,
        "working",
        "2026-05-05T00:00:30.000Z",
      ),
    ],
  });
  const frame = formatDashboard(snapshot, { now: "2026-05-05T00:00:30.000Z" });
  assert.match(frame, /\bup 2m 30s/);
});

test("TUI humanizes Codex and Claude event variants", () => {
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
      event: "tool_call_update",
      message: {
        payload: { method: "item/tool/call", params: { name: "linear_graphql", status: "failed" } },
      },
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
      event: "agent_message_chunk",
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

test("terminal throughput uses rolling token samples", () => {
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
        issueTitle: "Build the thing",
        state: "Todo",
        slotIndex: 0,
        ensembleSize: 1,
        agentKind: "codex",
        sessionId: "session-1",
        executorPid: "123",
        turnCount: 1,
        startedAt: "2026-05-05T00:00:00.000Z",
        lastEvent: "turn_completed",
        workspacePath: "/tmp/lorenz/MT-1",
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
  options: Parameters<typeof formatDashboard>[1];
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
      name: "full_pipeline",
      snapshot: {
        ...dashboardSnapshot({
          now: backoffNow,
          usageTotals: {
            inputTokens: 120_000,
            outputTokens: 9_400,
            totalTokens: 129_400,
            secondsRunning: 2_700,
          },
          rateLimits: rateLimits("gpt-5", 12_200, 20_000, 95, 10, 60, 45, null),
          running: [
            {
              ...runningFixture(
                "MT-700",
                "codex",
                "In Progress",
                "4242",
                14 * 60 + 2,
                6,
                89_350,
                "editing src/webhooks/retry.ts",
                backoffNow,
                "turn_started",
              ),
              issueTitle: "Dedupe webhook retries on 5xx with a title long enough to truncate",
              workerHost: "mac-mini-01",
            },
          ],
          retrying: [retryFixture("MT-450", 2, 34, "Linear 429: rate limited", backoffNow)],
          blocked: [
            {
              issueId: "MT-461",
              identifier: "MT-461",
              state: "Todo",
              reason: "global_concurrency_cap",
            },
          ],
        }),
        poll: {
          status: "idle",
          candidates: 14,
          eligible: 6,
          lastPollAt: backoffNow,
          nextPollAt: new Date(new Date(backoffNow).getTime() + 23_000).toISOString(),
          lastError: null,
        },
        reserving: [
          {
            issueId: "MT-458",
            identifier: "MT-458",
            slotIndex: 1,
            affinityHost: "ssh-worker-2",
            retryAttempt: null,
            reservedAtIso: new Date(new Date(backoffNow).getTime() - 4_000).toISOString(),
          },
        ],
        runHistory: [
          {
            id: "run-2",
            issueId: "MT-441",
            issueIdentifier: "MT-441",
            slotIndex: 0,
            agentKind: "codex",
            outcome: "failed",
            turnCount: 9,
            startedAt: "2026-05-05T00:00:00.000Z",
            endedAt: "2026-05-05T00:41:02.000Z",
            durationMs: 2_462_000,
            usageTotals: {
              inputTokens: 190_000,
              outputTokens: 13_000,
              totalTokens: 203_000,
              secondsRunning: 2_462,
            },
            error: "tests failed twice",
          },
          {
            id: "run-1",
            issueId: "MT-433",
            issueIdentifier: "MT-433",
            slotIndex: 1,
            agentKind: "claude",
            outcome: "success",
            turnCount: 4,
            startedAt: "2026-05-05T00:00:00.000Z",
            endedAt: "2026-05-05T00:22:00.000Z",
            durationMs: 1_320_000,
            usageTotals: {
              inputTokens: 131_000,
              outputTokens: 10_000,
              totalTokens: 141_000,
              secondsRunning: 1_320,
            },
          },
        ],
        recentEvents: [
          {
            type: "run_started",
            message: "MT-700 session e71a23 spawned on mac-mini-01 (slot 0)",
            at: "2026-05-05T00:44:41.000Z",
          },
        ],
      },
      options: { now: backoffNow, runtimeSeconds: 2_700, throughputTps: 48, maxAgents: 10 },
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
            "session_notification",
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
        projectUrl: "https://linear.app/project/mono/issues",
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
    ...(input.appStartedAt ? { appStartedAt: input.appStartedAt } : {}),
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
    recentEvents: input.recentEvents ?? [],
  };
}

function runningFixture(
  identifier: string,
  agentKind: string,
  state: string,
  executorPid: string | null,
  ageSeconds: number,
  turnCount: number,
  totalTokens: number,
  lastMessage: unknown,
  now: string,
  lastEvent: RuntimeSnapshot["running"][number]["lastEvent"] = "session_notification",
): RuntimeSnapshot["running"][number] {
  return {
    issueId: identifier,
    issueIdentifier: identifier,
    issueTitle: "Fixture issue",
    state,
    slotIndex: 0,
    ensembleSize: 1,
    agentKind,
    sessionId: "thread-1234567890",
    executorPid,
    turnCount,
    startedAt: new Date(new Date(now).getTime() - ageSeconds * 1000).toISOString(),
    lastEvent,
    lastMessage,
    lastEventAt: now,
    workspacePath: `/tmp/lorenz/${identifier}`,
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
    issueIdentifier: identifier,
    attempt,
    dueAtIso: new Date(new Date(now).getTime() + dueInSeconds * 1000).toISOString(),
    monotonicDeadlineMs: performance.now() + dueInSeconds * 1000,
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
  return path.join(import.meta.dirname, "../../../test/fixtures/dashboard", filename);
}
