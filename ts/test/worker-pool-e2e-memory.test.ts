import fs from "node:fs/promises";
import path from "node:path";

import { assert, tempDir, writeExecutable } from "@lorenz/test-utils";
import { afterEach, beforeEach, test } from "vitest";
import {
  buildWorkerPool,
  createTrackerClient,
  parseConfig,
  registerBuiltinBackends,
  runAgentAttempt,
  runtimeAdapters,
  LorenzRuntime,
} from "@lorenz/cli";
import type { WorkerLease, WorkerPool, Settings, WorkflowDefinition } from "@lorenz/cli";

// The composition root decides which tracker/executor backends exist; the e2e
// harness mirrors the CLI entrypoints and registers the built-ins once.
registerBuiltinBackends();

// ---------------------------------------------------------------------------
// Always-on end-to-end demo (T17): the REAL `runDaemon` wiring with a
// `tracker.kind=memory` client and the REAL `@lorenz/worker-pool`
// (driver=fake, max=1, warm=1). No fakes are injected into the runtime - the
// pool, orchestrator, runner, and ACP executor are all the real production
// code paths. The pool yields `fake://worker-<id>` as the workerHost; the runner
// then drives the ACP bridge (and its per-run MCP reverse tunnel) over
// `ssh fake://worker-<id> ...`, so a PATH-shimmed `ssh` evaluates the remote
// workspace + bridge commands locally (HOME pinned to a sandbox), making the
// demo hermetic while exercising the same code an SSH-addressable worker would.
// ---------------------------------------------------------------------------

const MEMORY_ENV = "LORENZ_MEMORY_TRACKER_ISSUES_JSON";

interface Harness {
  root: string;
  remoteHome: string;
  settings: Settings;
  workflow: WorkflowDefinition;
  pool: WorkerPool;
  runtime: LorenzRuntime;
  restoreEnv(): void;
}

let activeHarness: Harness | null = null;

afterEach(async () => {
  const harness = activeHarness;
  activeHarness = null;
  if (!harness) return;
  // Always drain so no warm worker leaks between tests, then restore process env.
  await harness.pool.drain({ deadlineMs: 5_000 }).catch(() => undefined);
  harness.restoreEnv();
});

beforeEach(() => {
  delete process.env[MEMORY_ENV];
});

test("memory-tracker daemon leases a fake worker, completes a run, and returns it to warm", async () => {
  const harness = await setupHarness({ issues: [eligibleIssue("issue-e2e-1", "WORKER-E2E-1")] });

  // One deterministic poll through the REAL runtime: poll -> eligible ->
  // claim (host-less reservation) -> acquire fake worker -> bindReservation ->
  // real runner over the eval-ssh shim -> run completes -> lease released.
  await harness.runtime.start({ once: true, dryRun: false });

  const snapshot = harness.runtime.snapshot();
  const history = snapshot.runHistory[0];
  assert.ok(history);
  assert.equal(history?.outcome, "success");
  // The pool produced the workerHost string end to end: history + the in-run
  // running entry both carry the concrete fake worker address, never `local`.
  assert.match(history?.workerHost ?? "", /^fake:\/\/worker-/);

  // Lease released healthy: the single worker is back in the warm pool, not destroyed.
  const pool = harness.pool.snapshot();
  assert.equal(pool.enabled, true);
  assert.equal(pool.driver, "fake");
  assert.equal(pool.total, 1);
  assert.equal(pool.warmIdle, 1);
  assert.equal(pool.leased, 0);
  assert.equal(pool.inFlight, 0);
  // The warm worker's address matches the one threaded through the run history.
  assert.equal(pool.workers[0]?.workerHost, history?.workerHost);
  assert.equal(pool.workers[0]?.state, "WARM_IDLE");

  // The lease settled exactly as a healthy completion: the worker was returned to
  // warm, never destroyed, and never re-leased after the run.
  assert.equal(snapshot.running.length, 0);
});

test("pool at capacity surfaces worker_host_capacity via canAcquire with no claim-then-backoff churn", async () => {
  const harness = await setupHarness({
    issues: [eligibleIssue("issue-blocked", "WORKER-BLOCKED")],
  });

  // Fill the single worker (max=1, maxInFlight=1) by holding a lease, so
  // canAcquire() reports false at eligibility time.
  const held = await harness.pool.acquire({
    issueId: "occupant",
    slotIndex: 0,
    labels: [],
    timeoutMs: 5_000,
  });
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  const heldLease: WorkerLease = held.lease;
  assert.equal(harness.pool.canAcquire(), false);

  // Real poll: the orchestrator consults workerPool.canAcquire() during
  // eligibility, so the issue is reported blocked rather than claimed. There is
  // no claim-then-acquire-then-abandon cycle at all.
  await harness.runtime.pollOnce({ dryRun: false });

  const snapshot = harness.runtime.snapshot();
  const blocked = snapshot.blocked.find((entry) => entry.issueId === "issue-blocked");
  assert.ok(blocked);
  assert.equal(blocked?.reason, "worker_host_capacity");

  // The capacity surface came from eligibility (canAcquire), NOT from a wasted
  // claim that then backed off: nothing ran, nothing is retrying, nothing in
  // history.
  assert.deepEqual(snapshot.running, []);
  assert.deepEqual(snapshot.retrying, []);
  assert.deepEqual(snapshot.runHistory, []);

  // Release the occupant so the shared worker returns to warm (afterEach drains).
  await heldLease.release("healthy");
  assert.equal(harness.pool.canAcquire(), true);
});

test("stop then drainWorkerPool destroys every worker (zero workers remain)", async () => {
  const harness = await setupHarness({ issues: [eligibleIssue("issue-drain", "WORKER-DRAIN")] });

  // Run once so the pool actually holds a warm worker, then take the SIGINT path:
  // synchronous stop() followed by the awaited drainWorkerPool() the daemon's
  // finally invokes after start() returns.
  await harness.runtime.start({ once: true, dryRun: false });
  assert.equal(harness.pool.snapshot().total, 1);
  assert.equal(harness.pool.snapshot().warmIdle, 1);

  harness.runtime.stop();
  await harness.runtime.drainWorkerPool();

  // The leak fix: drain force-destroys all workers so nothing survives exit.
  const drained = harness.pool.snapshot();
  assert.equal(drained.total, 0);
  assert.equal(drained.warmIdle, 0);
  assert.equal(drained.leased, 0);
  assert.equal(drained.workers.length, 0);

  // drainWorkerPool is idempotent (the daemon may call it more than once).
  await harness.runtime.drainWorkerPool();
  assert.equal(harness.pool.snapshot().total, 0);
});

// ---------------------------------------------------------------------------
// Harness: wires the SAME objects `runDaemon` constructs (buildWorkerPool +
// LorenzRuntime with the real daemon adapters + hydrate), but drives polling
// deterministically instead of spinning the daemon's interval loop / TUI.
// ---------------------------------------------------------------------------

async function setupHarness(
  options: { issues?: Record<string, unknown>[] } = {},
): Promise<Harness> {
  const root = await tempDir("lorenz-worker-e2e");
  const remoteHome = await fs
    .mkdir(path.join(root, "remote-home"), { recursive: true })
    .then(() => path.join(root, "remote-home"));
  const previousPath = process.env.PATH;
  const previousSshConfig = process.env.LORENZ_SSH_CONFIG;

  // PATH-shimmed `ssh`: the fake worker host (`fake://worker-<id>`) is not a real SSH
  // target, so the shim evaluates the runner's remote commands locally with
  // HOME pinned to a sandbox (and keeps reverse-tunnel `-N` children alive).
  // This is the only seam the demo replaces; the pool, orchestrator, runner,
  // and ACP executor are all real.
  await installEvalSsh(root, remoteHome);

  const fakeBridge = path.join(root, "fake-acp.mjs");
  await writeExecutable(fakeBridge, fakeAcpBridgeSource());

  const settings = parseConfig({
    tracker: {
      kind: "memory",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
    },
    polling: { interval_ms: 5 },
    // Ephemeral local MCP server port: the per-run endpoint binds it on demand.
    server: { port: 0 },
    // `~/workspaces` resolves under the eval-ssh sandbox HOME for the remote path.
    workspace: { root: "~/workspaces" },
    worker: {
      ssh_timeout_ms: 5_000,
      worker_pool: {
        enabled: true,
        driver: "fake",
        min: 0,
        max: 1,
        warm: 1,
        max_in_flight: 1,
        // Keep the reaper effectively dormant during the deterministic test.
        reap_interval_ms: 3_600_000,
        acquire_timeout_ms: 5_000,
        drain_deadline_ms: 5_000,
      },
    },
    hooks: { after_create: "git init -q", timeout_ms: 10_000 },
    agents: {
      codex: {
        bridge_command: `${process.execPath} ${fakeBridge}`,
        turn_timeout_ms: 5_000,
        stall_timeout_ms: 0,
      },
    },
    agent: { max_turns: 1 },
    logging: { log_file: path.join(root, "lorenz.log") },
  });

  const workflow: WorkflowDefinition = {
    path: path.join(root, "WORKFLOW.md"),
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };

  // The real production worker pool (the fake driver is in the default registry
  // populated by registerBuiltinBackends() above, same as the CLI entrypoint).
  const pool = await buildWorkerPool(settings, process.env);
  assert.ok(pool);
  if (!pool) throw new Error("worker pool was not constructed");

  // The memory tracker client reads the env once at construction (via the
  // clientFactory below), so the issue set must be in place before the runtime
  // is built - exactly as `runDaemon` sees `LORENZ_MEMORY_TRACKER_ISSUES_JSON`
  // at startup.
  process.env[MEMORY_ENV] = JSON.stringify(options.issues ?? []);

  // Identical construction to runDaemon: real tracker client factory (reads the
  // memory env), real runner, the real pool, and the real daemon adapters.
  const runtime = new LorenzRuntime({
    workflow,
    clientFactory: (s) => createTrackerClient(s, process.env),
    runner: runAgentAttempt,
    workerPool: pool,
    ...runtimeAdapters,
  });
  await pool.hydrate();

  const harness: Harness = {
    root,
    remoteHome,
    settings,
    workflow,
    pool,
    runtime,
    restoreEnv: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousSshConfig === undefined) delete process.env.LORENZ_SSH_CONFIG;
      else process.env.LORENZ_SSH_CONFIG = previousSshConfig;
      delete process.env[MEMORY_ENV];
    },
  };
  activeHarness = harness;
  return harness;
}

function eligibleIssue(id: string, identifier: string): Record<string, unknown> {
  return {
    id,
    identifier,
    title: `Warm worker pool issue ${identifier}`,
    description: "Run it on a warm worker.",
    state: "Todo",
    state_type: "unstarted",
    labels: [],
    blockers: [],
  };
}

// Mirrors workspace-prompt-resume.test.ts's eval-ssh transport: a `bash`-only
// shim that keeps reverse-tunnel (`-N`) children alive until killed, answers
// the runner's `$HOME` probe with the sandbox home, reports the tunnel's
// remote-port readiness probe as ready, and otherwise evaluates the last argv
// (the `bash -lc '<cmd>'` payload) locally.
async function installEvalSsh(root: string, remoteHome: string): Promise<string> {
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  const canonicalRemoteHome = await fs.realpath(remoteHome);
  await writeExecutable(
    path.join(bin, "ssh"),
    `#!/bin/sh
is_tunnel=0
for arg in "$@"; do
  if [ "$arg" = "-N" ]; then is_tunnel=1; fi
  last_arg="$arg"
done
if [ "$is_tunnel" = "1" ]; then
  trap 'exit 0' TERM INT
  while :; do sleep 1; done
fi
case "$last_arg" in
  *'printf "%s\\n" "$HOME"'*)
    printf '%s\\n' '${canonicalRemoteHome}'
    exit 0
    ;;
  *'/dev/tcp/127.0.0.1/'*) exit 0 ;;
esac
export HOME='${canonicalRemoteHome}'
eval "$last_arg"
`,
  );
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  return canonicalRemoteHome;
}

// A minimal ACP bridge: completes a single turn so the real runner drives one
// full session over the eval-ssh shim. Identical protocol to the fixtures in
// workspace-prompt-resume.test.ts.
function fakeAcpBridgeSource(): string {
  const acpModule = new URL("../node_modules/@agentclientprotocol/sdk/dist/acp.js", import.meta.url)
    .href;
  return `#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import * as acp from ${JSON.stringify(acpModule)};
class FakeAgent {
  constructor(connection) { this.connection = connection; }
  async initialize() { return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { close: {} } } }; }
  async authenticate() { return {}; }
  async newSession() { return { sessionId: "worker-e2e-session" }; }
  async prompt() {
    await this.connection.sessionUpdate({ sessionId: "worker-e2e-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
    return { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }
  async cancel() {}
  async closeSession() { return {}; }
}
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((connection) => new FakeAgent(connection), stream);
`;
}
