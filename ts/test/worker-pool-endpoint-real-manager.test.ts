// Codex HIGH #1 regression: the FULL workflow Settings must be threaded end-to-end
// to the per-run endpoint open, NOT the coordinator's WorkerPoolSettings.
//
// This pins the integration the per-package unit suites cannot: the REAL
// `createPerRunEndpointManager` over a stub-at-the-ssh-child
// `acquireAgentMcpEndpointForRun` (structurally identical to the production one,
// reading `settings.server.port` exactly as the real `acquireRemoteMcpEndpoint`
// does), driven by the REAL `createDispatchCoordinator` over a fake machine pool.
// The ONLY thing stubbed is the leaf endpoint acquirer (so no token/local-server/
// ssh child is actually minted); the WHOLE settings-threading path the bug lived
// on is the real code.
//
// The bug: the coordinator forwarded its `WorkerPoolSettings` (cast to `Settings`) to
// `mcpEndpointManager.open`, so `settings.server.port` was undefined and the real
// `acquireAgentMcpEndpointForRun` threw `remote_acp_mcp_requires_server_port` ->
// every acquire skipped with worker_pool_acquire_error and the pool never dispatched.
// The fix threads the FULL workflow `Settings` (with `server.port`) through the
// `AcquireRunSlotRequest`. These tests assert the full Settings flows through and
// the endpoint opens, AND that the worker-pool-only settings WOULD have failed (so
// this test would have caught the original bug).
//
// Tests import the compiled package barrels (the suite runs against tsc --build).

import { test } from "vitest";
import { parseConfig } from "@symphony/config";
import type { WorkerPoolSettings } from "@symphony/domain";
import type { AgentMcpEndpointLease } from "@symphony/mcp";
import type {
  AcquireResult,
  WorkerLease,
  WorkerPool,
  WorkerPoolSnapshot,
  Settings,
} from "@symphony/cli";
import { assert } from "@symphony/test-utils";

import {
  createDispatchCoordinator,
  createPerRunEndpointManager,
} from "../packages/dispatch-coordinator/dist/index.js";

// The REAL coordinator + per-run endpoint manager. `@symphony/dispatch-coordinator`
// is a transitive dep (not declared at the workspace root), so it is imported via
// its compiled barrel by relative path - the same tsc --build output the cli
// re-export resolves to - to drive the genuine settings-threading code path.

// ---------------------------------------------------------------------------
// The stub-at-the-ssh-child endpoint acquirer: structurally identical to the
// production `acquireAgentMcpEndpointForRun(settings, workerHost, runKey)`, and -
// like the real one's `acquireRemoteMcpEndpoint` - it reads `settings.server.port`
// and rejects when it is missing (`remote_acp_mcp_requires_server_port`). It mints
// NO real token/local-server/ssh child; it returns a recognizable fake lease. This
// is the SOLE seam; the per-run manager + coordinator settings threading are real.
// ---------------------------------------------------------------------------

function makeFakeEndpoint(port: number): AgentMcpEndpointLease & { readonly localPort: number } {
  return {
    url: `http://127.0.0.1:46000/mcp#${port}`,
    token: `tok-${port}`,
    acpServer: () => ({ type: "http", name: "symphony_linear", url: "", headers: [] }),
    localPort: port,
    async release(): Promise<void> {},
  };
}

interface AcquireCall {
  settings: Settings;
  workerHost: string;
  runKey: string;
}

function makeStubAcquireForRun(
  calls: AcquireCall[],
): (settings: Settings, workerHost: string, runKey: string) => Promise<AgentMcpEndpointLease> {
  return async (settings, workerHost, runKey) => {
    calls.push({ settings, workerHost, runKey });
    // The exact field the real acquireRemoteMcpEndpoint reads. A WorkerPoolSettings
    // forwarded here leaves it undefined -> the real code path throws this error.
    const port = settings.server?.port;
    if (typeof port !== "number" || port <= 0) {
      throw new Error("remote_acp_mcp_requires_server_port");
    }
    return makeFakeEndpoint(port);
  };
}

// ---------------------------------------------------------------------------
// A minimal fake machine WorkerPool: each acquire mints a fresh leased worker on a real
// ssh-addressable host so the per-run manager opens (not the local-null path).
// ---------------------------------------------------------------------------

interface FakeLease extends WorkerLease {
  readonly settles: Array<{ kind: "release" | "fail"; arg?: string }>;
}

function makeFakeLease(workerId: string, workerHost: string): FakeLease {
  const settles: Array<{ kind: "release" | "fail"; arg?: string }> = [];
  return {
    leaseId: `lease-${workerId}`,
    workerId,
    workerHost,
    acquiredAtMs: 0,
    expiresAtMs: null,
    settles,
    async release(outcome?: "healthy" | "poison"): Promise<void> {
      settles.push({ kind: "release", arg: outcome });
    },
    async fail(reason: string): Promise<void> {
      settles.push({ kind: "fail", arg: reason });
    },
    heartbeat(): void {},
  };
}

function makeFakeMachinePool(): WorkerPool & { readonly leases: Map<string, FakeLease> } {
  const leases = new Map<string, FakeLease>();
  let nextWorker = 0;
  return {
    leases,
    async acquire(): Promise<AcquireResult> {
      const workerId = `worker-${nextWorker++}`;
      const lease = makeFakeLease(workerId, `ssh://${workerId}`);
      leases.set(workerId, lease);
      return { status: "leased", lease };
    },
    canAcquire: () => true,
    isEnabled: () => true,
    reconcile(): void {},
    swapDriver(): void {},
    onMachineRecycling(): void {},
    async hydrate(): Promise<void> {},
    async drain(): Promise<void> {},
    snapshot(): WorkerPoolSnapshot {
      return {
        enabled: true,
        driver: "fake",
        total: leases.size,
        warmIdle: 0,
        leased: leases.size,
        provisioning: 0,
        degraded: 0,
        inFlight: leases.size,
        spend: {
          concurrentWorkers: 0,
          workerSecondsUsed: 0,
          dailyWorkerSecondsUsed: 0,
          dayKey: "",
        },
        workers: [],
      };
    },
  };
}

// A FULL workflow Settings carrying a concrete server.port (the field the
// WorkerPoolSettings does NOT have). parseConfig builds a real Settings; we set the
// port the remote endpoint acquire requires.
function fullSettingsWithServerPort(port = 51_873): Settings {
  const settings = parseConfig({
    tracker: { kind: "memory", active_states: ["Todo"], terminal_states: ["Done"] },
  }) as unknown as Settings;
  settings.server.host = "127.0.0.1";
  settings.server.port = port;
  return settings;
}

// The coordinator-owned WorkerPoolSettings (no server.port). This is what the buggy
// coordinator forwarded to open() - the test below proves that path would FAIL.
function workerPoolOnlySettings(): WorkerPoolSettings {
  return {
    enabled: true,
    driver: "fake",
  } as unknown as WorkerPoolSettings;
}

const baseReq = { labels: [] as ReadonlyArray<string>, timeoutMs: 5_000 };

test("real per-run manager: the FULL Settings (with server.port) flows through acquireRunSlot.open and the endpoint opens", async () => {
  const calls: AcquireCall[] = [];
  const manager = createPerRunEndpointManager({ acquireForRun: makeStubAcquireForRun(calls) });
  const pool = makeFakeMachinePool();
  // The coordinator holds worker-pool-only settings (no server.port) - exactly the
  // production wiring. The FULL Settings must arrive via the acquire request.
  const coordinator = createDispatchCoordinator({
    pool,
    mcpEndpointManager: manager,
    settings: workerPoolOnlySettings(),
  });

  const fullSettings = fullSettingsWithServerPort(51_873);
  const result = await coordinator.acquireRunSlot({
    ...baseReq,
    issueId: "issue-real",
    slotIndex: 0,
    settings: fullSettings,
  });

  // The endpoint opened: a real RunSlot bound with the per-run endpoint attached.
  assert.equal(result.status, "bound");
  if (result.status !== "bound") return;
  assert.ok(result.slot.mcpEndpoint);

  // The REAL per-run manager forwarded the FULL Settings to acquireForRun: the
  // server.port the remote endpoint needs is present (NOT undefined, as it would be
  // if the coordinator had threaded its WorkerPoolSettings).
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.workerHost, "ssh://worker-0");
  assert.equal(calls[0]?.runKey !== undefined, true);
  assert.equal(calls[0]?.settings.server.port, 51_873);
  assert.equal(calls[0]?.settings.server.host, "127.0.0.1");
});

test("real per-run manager: threading the worker-pool-only settings WOULD fail at open (the original bug, caught here)", async () => {
  // This is the bug-detector: the worker-pool-only settings (no server.port) flowed to
  // the SAME real per-run manager throw `remote_acp_mcp_requires_server_port` from
  // the stub acquirer - exactly as the production acquireAgentMcpEndpointForRun
  // does. So a coordinator that threaded its WorkerPoolSettings would never open an
  // endpoint, and this assertion would have failed the buggy implementation.
  const calls: AcquireCall[] = [];
  const manager = createPerRunEndpointManager({ acquireForRun: makeStubAcquireForRun(calls) });

  let thrown: unknown;
  try {
    await manager.open({
      // The cast mirrors the OLD buggy coordinator forwarding WorkerPoolSettings as
      // Settings; the real manager + stub acquirer reject the missing server.port.
      settings: workerPoolOnlySettings() as unknown as Settings,
      workerHost: "ssh://worker-0",
      runKey: "issue-real#0",
    });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof Error);
  assert.equal((thrown as Error).message, "remote_acp_mcp_requires_server_port");
});

test("real per-run manager: a local (empty) host mints nothing even with full Settings (acp keeps its own endpoint)", async () => {
  const calls: AcquireCall[] = [];
  const manager = createPerRunEndpointManager({ acquireForRun: makeStubAcquireForRun(calls) });

  const lease = await manager.open({
    settings: fullSettingsWithServerPort(),
    workerHost: "",
    runKey: "issue/0",
  });

  // The local path returns null and never calls the acquirer (the byte-identical
  // single-tenant path), independent of the threaded Settings.
  assert.equal(lease, null);
  assert.equal(calls.length, 0);
});
