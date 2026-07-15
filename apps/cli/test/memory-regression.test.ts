/**
 * Memory regression tests for the long-running daemon.
 *
 * A daemon running the slack tracker OOMed after ~half a day: several paths
 * retained per-update / per-run state for unbounded lifetimes (execa buffering
 * bridge stdout, RunResult.updates, the acp per-turn batch, the trace-emitter
 * write queue). These tests drive the REAL runtime + slack web transport
 * through hundreds of poll->dispatch->run->retry cycles in virtual time and
 * assert that post-GC heap growth stays bounded, so a reintroduced
 * retained-per-update leak fails loudly.
 *
 * Each run's fake agent streams ~160KB of session notifications; retaining
 * them (the reverted-fix failure mode) grows the heap by tens of MB over the
 * measured window, far past the assertion threshold, while healthy steady
 * state stays within single-digit MB.
 *
 * Scenarios mirror the deployment matrix:
 *  - default: in-memory claim store, local worker
 *  - durable claims + daemon lease (the `daemon.enabled` +
 *    `claim_store.backend=sqlite` feature flags)
 *  - static ssh worker hosts (`worker.ssh_hosts`)
 */

import { accessSync, constants as fsConstants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";

import { beforeAll, test } from "vitest";
import type { AgentExecutor, ClockPort, TimerHandle } from "@lorenz/domain";
import { runAgentAttempt } from "@lorenz/agent-runner";
import type { RuntimeRunner } from "@lorenz/runtime";
import { SlackTrackerClient, SlackWebTransport } from "@lorenz/slack-tracker";
import { assert, settle } from "@lorenz/test-utils";

import { registerBuiltinBackends } from "../src/daemon.js";
import { buildClaimStoreHandle, type ClaimStoreHandle } from "../src/claimStore.js";
import {
  acquireDaemonLock,
  createDaemonIdentity,
  daemonLockPath,
  type DaemonLock,
} from "../src/daemonLock.js";

import {
  parseConfig,
  LorenzRuntime,
  type AgentUpdate,
  type Settings,
  type WorkflowDefinition,
} from "@lorenz/cli";

beforeAll(() => {
  registerBuiltinBackends();
});

// ---------------------------------------------------------------------------
// GC + heap measurement
// ---------------------------------------------------------------------------

/** Obtain a forced-GC hook even when vitest was not started with --expose-gc. */
const forceGc: () => void = (() => {
  if (typeof globalThis.gc === "function") return globalThis.gc.bind(globalThis);
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  v8.setFlagsFromString("--no-expose-gc");
  return gc;
})();

function heapUsedAfterGc(): number {
  forceGc();
  forceGc();
  return process.memoryUsage().heapUsed;
}

/**
 * Post-GC heap growth allowed across the measured window. Healthy steady state
 * measures low single-digit MB; the guarded regression class (retaining each
 * run's streamed updates) adds ~30MB+ here.
 */
const MAX_HEAP_GROWTH_BYTES = 12 * 1024 * 1024;

const WARMUP_CYCLES = 40;
const MEASURED_CYCLES = 200;

/**
 * These scenarios measure HEAP growth; their runtime must not depend on disk
 * throughput. The durable-claims scenario writes sqlite claim-store
 * transactions on every cycle, and a CI runner with degraded disk I/O (the
 * observed failure: a runner where module import ran ~40x slower than usual)
 * stretched those ~6s of I/O past the 120s test timeout while the pure-CPU
 * sibling scenarios ran at full speed. Keep every scenario's workspace (claim
 * store db, daemon lock) on tmpfs when the platform has one.
 */
const SCENARIO_ROOT_BASE = (() => {
  try {
    accessSync("/dev/shm", fsConstants.W_OK);
    return "/dev/shm";
  } catch {
    return tmpdir();
  }
})();

/**
 * Real-time budget for one scenario, well under the 120s test timeout. If a
 * runner is still too slow (tmpfs unavailable, extreme CPU contention), the
 * cycle loop stops here and the heap assertion runs over the shortened window
 * - a loud warning plus a meaningful assertion instead of an opaque timeout.
 */
const SCENARIO_WALL_CLOCK_BUDGET_MS = 90_000;

// ---------------------------------------------------------------------------
// Virtual clock (compact copy of sandbox/fake-clock.ts)
// ---------------------------------------------------------------------------

interface FakeClock extends ClockPort {
  readonly nowMs: number;
  advance(ms: number): Promise<void>;
}

function createFakeClock(startMs = 1_700_000_000_000): FakeClock {
  let current = startMs;
  let nextId = 1;
  const timers = new Map<number, { id: number; fireAt: number; cb: () => void }>();
  return {
    get nowMs() {
      return current;
    },
    now: () => new Date(current),
    monotonicMs: () => current,
    setTimeout(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { id, fireAt: current + Math.max(0, delayMs), cb: callback });
      return { _id: id, unref() {} } as unknown as TimerHandle;
    },
    clearTimeout(handle) {
      const id = (handle as unknown as { _id?: number } | undefined)?._id;
      if (id != null) timers.delete(id);
    },
    async advance(ms) {
      const target = current + Math.max(0, ms);
      for (;;) {
        let due: { id: number; fireAt: number; cb: () => void } | undefined;
        for (const timer of timers.values()) {
          if (timer.fireAt > target) continue;
          if (
            !due ||
            timer.fireAt < due.fireAt ||
            (timer.fireAt === due.fireAt && timer.id < due.id)
          )
            due = timer;
        }
        if (!due) break;
        current = Math.max(current, due.fireAt);
        timers.delete(due.id);
        due.cb();
        // Flush the real micro/macrotask queue so cascaded async work settles.
        await settle(0);
      }
      current = target;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake Slack Web API (served through the real SlackWebTransport)
// ---------------------------------------------------------------------------

const CHANNELS = ["C1", "C2"];
const MESSAGES_PER_CHANNEL = 40;
const REPLIES_PER_THREAD = 10;
const ACTIVE_MENTIONS_PER_CHANNEL = 2;

/** Fake Slack backend: active bot mentions (dispatched every cycle) plus busy
 * human threads whose latest_reply advances every poll, like a live channel. */
class FakeSlack {
  tick = 0;

  private history(channel: string): Record<string, unknown> {
    const messages: Array<Record<string, unknown>> = [];
    for (let i = 0; i < MESSAGES_PER_CHANNEL; i++) {
      const ts = `170000${i.toString().padStart(4, "0")}.000100`;
      if (i % 10 === 0 && i / 10 < ACTIVE_MENTIONS_PER_CHANNEL) {
        messages.push({
          ts,
          text: `<@U_BOT> active task ${channel}:${i} keep working`,
          user: "U_HUMAN",
          reactions: [],
        });
      } else if (i % 10 === 0) {
        messages.push({
          ts,
          text: `<@U_BOT> task ${channel}:${i} please do the thing`,
          user: "U_HUMAN",
          reactions: [{ name: "white_check_mark", users: ["U_BOT"] }],
        });
      } else {
        messages.push({
          ts,
          text: `human chatter ${channel}:${i} with some longer text to look realistic`,
          user: "U_HUMAN",
          reply_count: REPLIES_PER_THREAD,
          latest_reply: `17000${this.tick.toString().padStart(5, "0")}.000900`,
        });
      }
    }
    return { ok: true, messages };
  }

  private replies(): Record<string, unknown> {
    const messages: Array<Record<string, unknown>> = [{ ts: "1700000000.000100", text: "root" }];
    for (let i = 0; i < REPLIES_PER_THREAD; i++) {
      messages.push({
        ts: `1700000${i.toString().padStart(3, "0")}.000200`,
        text: `reply ${i} some discussion text of moderate length`,
        user: "U_HUMAN",
      });
    }
    return { ok: true, messages };
  }

  fetch: typeof fetch = async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = url.pathname.split("/").pop() ?? "";
    let body: Record<string, unknown>;
    if (method === "auth.test") body = { ok: true, url: "https://example.slack.com" };
    else if (method === "conversations.history")
      body = this.history(url.searchParams.get("channel") ?? "C1");
    else if (method === "conversations.replies") body = this.replies();
    else body = { ok: true };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

// ---------------------------------------------------------------------------
// Scenario harness
// ---------------------------------------------------------------------------

const UPDATES_PER_RUN = 20;
let nextUpdateSerial = 0;

/** ~8KB of text that is UNIQUE and FLAT per call: shared or rope strings would
 * make retained updates nearly free, hiding the very leak class under test.
 * Word-separated filler keeps the diagnostic redaction regex scan (which runs
 * on every snapshot) linear and cheap - unbroken multi-KB tokens are not what
 * this test is about. */
function uniqueUpdateText(): string {
  nextUpdateSerial += 1;
  return `payload ${nextUpdateSerial} `.padEnd(64, "x ").repeat(128);
}

/** Fake executor streaming ~160KB of session notifications per turn. The runs
 * go through the REAL runAgentAttempt (RunController), so retention anywhere in
 * the runtime -> agent-runner -> update-fanout pipeline is on the measured path
 * - that pipeline retaining streamed updates is exactly the leak class this
 * test guards against. */
function fakeStreamingExecutor(): AgentExecutor {
  let emit: ((update: AgentUpdate) => void) | undefined;
  return {
    kind: "codex",
    async startSession(input) {
      emit = input.onUpdate;
      input.onUpdate?.({
        type: "session_started",
        message: "session started (fake)",
        sessionId: "fake-session",
      });
      return {
        agentKind: "codex",
        sessionId: "fake-session",
        executorPid: "0",
        stop: async () => {},
      };
    },
    async runTurn() {
      for (let i = 0; i < UPDATES_PER_RUN; i++) {
        emit?.({
          type: "session_notification",
          message: {
            sessionId: "fake-session",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: uniqueUpdateText() },
            },
          },
        } as unknown as AgentUpdate);
      }
      return [{ type: "turn_completed" }];
    },
  };
}

/** The production runAgentAttempt with test adapters: no real workspace, hooks,
 * or agent process, but the full run/turn/update plumbing. */
function realRunnerWithFakeExecutor(seen: {
  runs: number;
  workerHosts: Set<string>;
}): RuntimeRunner {
  return async (input) => {
    seen.runs += 1;
    seen.workerHosts.add(input.workerHost ?? "local");
    return runAgentAttempt({
      ...input,
      adapters: {
        createWorkspaceForIssue: async () => `/tmp/fake-workspaces/${input.issue.identifier}`,
        runHook: async () => {},
        executorFactory: () => fakeStreamingExecutor(),
      },
    });
  };
}

interface ScenarioOptions {
  sshHosts?: string[];
  /** Durable claims (`claim_store.backend=sqlite`) + daemon lease (`daemon.enabled`). */
  durableDaemon?: boolean;
}

function scenarioSettings(root: string, options: ScenarioOptions): Settings {
  return parseConfig(
    {
      tracker: {
        kind: "slack",
        channels: CHANNELS,
        bot_user_id: "U_BOT",
        active_states: ["Todo", "In Progress"],
        terminal_states: ["Done", "Cancelled"],
      },
      polling: { interval_ms: 1000 },
      logging: { log_file: path.join(root, "lorenz.log") },
      workspace: { root },
      agent: { max_concurrent_agents: 2 },
      ...(options.sshHosts ? { worker: { ssh_hosts: options.sshHosts } } : {}),
    },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
}

async function runScenario(options: ScenarioOptions): Promise<{
  heapGrowth: number;
  runs: number;
  workerHosts: Set<string>;
}> {
  const root = await mkdtemp(path.join(SCENARIO_ROOT_BASE, "lorenz-mem-regression-"));
  const settings = scenarioSettings(root, options);
  const workflow: WorkflowDefinition = {
    path: path.join(root, "WORKFLOW.md"),
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };

  // Durable-claims / daemon-flags configuration: the sqlite claim store is what
  // `claim_store.backend=sqlite` builds, and the held-and-heartbeated lease is
  // what `daemon.enabled` adds around the runtime loop.
  let claimStoreHandle: ClaimStoreHandle | null = null;
  let daemonLock: DaemonLock | null = null;
  if (options.durableDaemon) {
    claimStoreHandle = await buildClaimStoreHandle(workflow, { backend: "sqlite" });
    const acquired = await acquireDaemonLock({
      lockPath: daemonLockPath(workflow.path),
      identity: createDaemonIdentity({
        workflowPath: workflow.path,
        workspaceRoot: settings.workspace.root,
      }),
      endpoint: { kind: "none", address: "" },
      replaceDeadOwner: true,
    });
    assert.equal(acquired.status, "acquired");
    if (acquired.status === "acquired") daemonLock = acquired.lock;
  }

  const clock = createFakeClock();
  const fake = new FakeSlack();
  const transport = new SlackWebTransport(
    settings,
    fake.fetch,
    async () => {},
    { warn: () => {} },
    { now: () => clock.nowMs },
  );
  const client = new SlackTrackerClient(settings, transport);
  const seen = { runs: 0, workerHosts: new Set<string>() };
  const runtime = new LorenzRuntime({
    workflow,
    client,
    clock,
    runner: realRunnerWithFakeExecutor(seen),
    appendLogEvent: async () => {},
    removeIssueWorkspaces: async () => {},
    listIssueWorkspaces: async () => [],
    validateDispatch: () => {},
    ...(claimStoreHandle?.claimStore ? { claimStore: claimStoreHandle.claimStore } : {}),
  });

  try {
    const cycle = async (i: number): Promise<void> => {
      fake.tick = i;
      await runtime.pollOnce();
      // Let runs settle and continuation-retry timers fire, like a daemon
      // sitting through its polling interval.
      await clock.advance(settings.polling.intervalMs);
      if (daemonLock && i % 10 === 0) await daemonLock.heartbeat();
    };

    const deadlineMs = Date.now() + SCENARIO_WALL_CLOCK_BUDGET_MS;
    let budgetHitAtCycle = 0;
    for (let i = 1; i <= WARMUP_CYCLES; i++) {
      await cycle(i);
      if (Date.now() >= deadlineMs) {
        budgetHitAtCycle = i;
        break;
      }
    }
    const baseline = heapUsedAfterGc();
    let heapGrowth = 0;
    if (!budgetHitAtCycle) {
      for (let i = WARMUP_CYCLES + 1; i <= WARMUP_CYCLES + MEASURED_CYCLES; i++) {
        await cycle(i);
        // Check periodically so a reintroduced leak fails within seconds instead
        // of grinding the worker under GC pressure until the test times out.
        if (i % 25 === 0) {
          heapGrowth = heapUsedAfterGc() - baseline;
          if (heapGrowth > MAX_HEAP_GROWTH_BYTES) break;
        }
        if (Date.now() >= deadlineMs) {
          budgetHitAtCycle = i;
          break;
        }
      }
    }
    if (budgetHitAtCycle)
      process.stderr.write(
        `[memory-regression] wall-clock budget (${SCENARIO_WALL_CLOCK_BUDGET_MS}ms) hit after ` +
          `${budgetHitAtCycle}/${WARMUP_CYCLES + MEASURED_CYCLES} cycles - asserting over the ` +
          "shortened window instead of timing out (degraded runner?)\n",
      );
    heapGrowth = Math.max(heapGrowth, heapUsedAfterGc() - baseline);
    return { heapGrowth, runs: seen.runs, workerHosts: seen.workerHosts };
  } finally {
    runtime.stop();
    await daemonLock?.release();
    await claimStoreHandle?.close();
    // The root may live on tmpfs (RAM); do not leave scenario dirs behind.
    await rm(root, { recursive: true, force: true });
  }
}

function assertBounded(result: Awaited<ReturnType<typeof runScenario>>): void {
  // The scenario must actually have churned through runs, or a silently idle
  // loop would pass the heap assertion without guarding anything.
  assert.ok(result.runs >= 50, `expected sustained run churn, got ${result.runs} runs`);
  assert.ok(
    result.heapGrowth < MAX_HEAP_GROWTH_BYTES,
    `post-GC heap grew ${(result.heapGrowth / 1048576).toFixed(1)}MB over ${MEASURED_CYCLES} ` +
      `poll cycles (limit ${(MAX_HEAP_GROWTH_BYTES / 1048576).toFixed(0)}MB) - a ` +
      "retained-per-update/run leak has likely been reintroduced",
  );
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

test("daemon memory stays bounded across run churn (in-memory claims, local worker)", async () => {
  assertBounded(await runScenario({}));
}, 120_000);

test("daemon memory stays bounded with durable claims + daemon lease flags on", async () => {
  assertBounded(await runScenario({ durableDaemon: true }));
}, 120_000);

test("daemon memory stays bounded with static ssh worker hosts", async () => {
  const result = await runScenario({ sshHosts: ["worker-a", "worker-b"] });
  // Dispatch must have routed runs to the configured hosts (proving the ssh
  // selection path was exercised, not the local fallback).
  assert.ok(
    [...result.workerHosts].every((host) => host === "worker-a" || host === "worker-b"),
    `expected runs on ssh hosts, saw: ${[...result.workerHosts].join(", ")}`,
  );
  assertBounded(result);
}, 120_000);
