import { test } from "vitest";
import { statePayload } from "@lorenz/presenter";
import type { RuntimeDaemonStatus, RuntimeSnapshot } from "@lorenz/runtime-events";
import { assert, settle } from "@lorenz/test-utils";

import { startObservabilityServer, type RuntimeServerSource } from "@lorenz/server";

test("observability /ws pushes ops state on connect and broadcasts runtime updates", async () => {
  const listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  const daemon = daemonStatusFixture();
  const runtime: RuntimeServerSource = {
    snapshot: () => snapshotFixture(1),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestRefresh: () => ({ queued: true }),
    daemonStatus: () => daemon,
  };
  const server = await startObservabilityServer(runtime, {
    host: "127.0.0.1",
    port: 0,
    staticDir: "/tmp/nonexistent-dashboard-dist",
  });
  const ws = new WebSocket(server.url("/ws").replace(/^http/, "ws"));
  const messages: Array<Record<string, any>> = [];
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as Record<string, any>);
  });
  const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));

  try {
    await waitFor(() => messages.length >= 2);
    assert.deepEqual(messages[0], { type: "init", tickets: [] });
    assert.equal(messages[1]!.type, "ops_state");
    assert.deepEqual(
      messages[1]!.state,
      statePayload({ ...snapshotFixture(1), daemon }, messages[1]!.state.generated_at as string),
    );

    assert.equal(listeners.size, 1);
    for (const listener of listeners) listener(snapshotFixture(2));
    await waitFor(() => messages.length >= 3);
    assert.equal(messages[2]!.type, "ops_state");
    assert.equal(messages[2]!.state.running[0].turn_count, 2);
    assert.equal(messages[2]!.state.daemon.owner_id, "owner-daemon");
    assert.deepEqual(messages[2]!.state.counts, { running: 1, retrying: 0, blocked: 0 });
  } finally {
    ws.close();
    await closed;
    await server.stop();
  }

  assert.equal(listeners.size, 0, "server stop should unsubscribe from the runtime");
});

test("observability /ws still serves trace init when the runtime snapshot is unavailable", async () => {
  const runtime = {
    snapshot() {
      throw new Error("snapshot_unavailable");
    },
    requestRefresh() {
      throw new Error("orchestrator_unavailable");
    },
  } as unknown as RuntimeServerSource;
  const server = await startObservabilityServer(runtime, {
    host: "127.0.0.1",
    port: 0,
    staticDir: "/tmp/nonexistent-dashboard-dist",
  });
  const ws = new WebSocket(server.url("/ws").replace(/^http/, "ws"));
  const messages: Array<Record<string, any>> = [];
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as Record<string, any>);
  });
  const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));

  try {
    await waitFor(() => messages.length >= 1);
    assert.deepEqual(messages[0], { type: "init", tickets: [] });

    // Without a trace watcher, subscribe messages are ignored rather than answered
    ws.send(JSON.stringify({ type: "subscribe", issueId: "MT-WS" }));
    // Asserting an absence (the subscribe is ignored), which cannot be polled
    // for — settle briefly and confirm no extra message arrived.
    await settle(100);
    assert.equal(messages.length, 1);
  } finally {
    ws.close();
    await closed;
    await server.stop();
  }
});

function snapshotFixture(turnCount: number): RuntimeSnapshot {
  return {
    appStatus: "running",
    workflowPath: "/tmp/WORKFLOW.md",
    poll: {
      status: "idle",
      candidates: 0,
      eligible: 0,
      lastPollAt: null,
      nextPollAt: null,
      lastError: null,
    },
    running: [
      {
        issueId: "issue-ws",
        issueIdentifier: "MT-WS",
        issueTitle: "WS visibility",
        state: "In Progress",
        slotIndex: 0,
        ensembleSize: 1,
        agentKind: "codex",
        turnCount,
        startedAt: "2026-05-05T00:00:00.000Z",
        usageTotals: { inputTokens: 4, outputTokens: 8, totalTokens: 12, secondsRunning: 1 },
      },
    ],
    retrying: [],
    blocked: [],
    runHistory: [],
    usageTotals: { inputTokens: 4, outputTokens: 8, totalTokens: 12, secondsRunning: 1 },
    rateLimits: null,
    logFile: null,
    recentEvents: [],
  };
}

function daemonStatusFixture(): RuntimeDaemonStatus {
  return {
    ownerId: "owner-daemon",
    pid: 123,
    hostname: "host-a",
    startedAt: "2026-01-01T00:00:00.000Z",
    workflowPath: "/tmp/WORKFLOW.md",
    workspaceRoot: "/tmp",
    lockPath: "/tmp/.lorenz/daemon/test.lock.json",
    endpoint: { kind: "http", address: "http://127.0.0.1:4040/" },
    heartbeatAt: "2026-01-01T00:00:05.000Z",
    heartbeatAgeMs: 1000,
    stale: false,
    leadershipStoreKind: "local-file",
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await settle(10);
  }
}
