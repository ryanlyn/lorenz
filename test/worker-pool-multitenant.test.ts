// STEP 3 (T3c): REAL N-per-machine multi-tenant co-residence.
//
// This is the cross-cutting proof that `slotsPerMachine > 1` actually works
// end-to-end through the REAL `DispatchCoordinator` over the REAL
// `@lorenz/worker-pool` (driver=fake, max=1, slotsPerMachine=2,
// coResidence=true). The ONLY seam replaced is the per-run MCP endpoint manager:
// a fake distinct-port manager (no real `ssh -N`, no real token/local-server)
// that hands out a unique reverse-tunnel port per (workerHost, runKey) so the
// test can prove per-run endpoint isolation WITHOUT spawning processes. The pool,
// its leasing/billing/recycle internals, the coordinator's per-issue RunSlot
// registry, the (issueId, slotIndex) collision guard, the recycle-driven clean
// fail, and the tunnel-exhaustion ceiling are all the real production code paths.
//
// What this pins that the unit suites cannot (they fake the pool):
//   - two SAME-issue and two CROSS-issue runs genuinely CO-RESIDE on ONE
//     `fake://worker` (the real pool's `slotsPerMachine=2` leasing), each binding a
//     distinct per-run endpoint (distinct remote port) and a distinct workspace
//     slot (distinct runKey), and all complete (release healthy);
//   - overlapping worker-second windows bill correctly for the N concurrent leases
//     via the pool's real `liveLeaseAcquiredMs` accounting (each lease accrues its
//     own window from its own acquire time);
//   - per-issue RunSlot accounting is an EXACT refcount of live coordinator slots
//     (incremented on bind, decremented only when the settling slot releases),
//     independent of the MACHINE-level `maxWorkersPerIssue` cap the pool enforces;
//   - one co-resident slot poisoning does NOT tear out a still-running sibling
//     (the pool recycles a co-resident worker only when its LAST lease returns), while
//     a TEARDOWN recycle of a co-resident worker (drain force-destroy) fails ALL its
//     live slots CLEANLY via `onMachineRecycling` - the documented correlated-
//     failure tradeoff of co-residence (one bad shared machine fails N runs, each
//     cleanly: endpoint closed, lease settled, slot deregistered);
//   - the tunnel-exhaustion ceiling surfaces as a TYPED `no_capacity`
//     ('tunnel_exhausted'), never an unhandled throw inside acquireRunSlot.
//
// The coordinator + pool are imported from `@lorenz/cli` (the re-export barrel
// the live/e2e suites use). Tests run against the live `.ts` source via vite's
// `.js`->`.ts` resolution.

import { test } from "vitest";
import {
  WorkerDriverRegistry,
  createWorkerPool,
  createDispatchCoordinator,
  registerFakeWorkerDriver,
} from "@lorenz/cli";
import type { WorkerPool, McpEndpointManager } from "@lorenz/cli";
import type { WorkerPoolSettings } from "@lorenz/domain";
import { withDerivedMaxInFlight } from "@lorenz/domain";
import type { AgentMcpEndpointLease } from "@lorenz/mcp";
import type { ClockPort, TimerHandle } from "@lorenz/domain";
import { assert, settle } from "@lorenz/test-utils";

// ---------------------------------------------------------------------------
// A controllable clock: `now`/`advance` drive the pool's spend/ttl/idle logical
// wall clock while setTimeout/clearTimeout use the REAL event loop so the pool's
// acquire-waiter timeouts and the drain deadline still fire. Mirrors the
// worker-pool unit suite's clock so billing math is deterministic.
// ---------------------------------------------------------------------------
function controllableClock(startMs: number): {
  clock: ClockPort;
  advance(ms: number): void;
} {
  let current = startMs;
  return {
    clock: {
      now: () => new Date(current),
      monotonicMs: () => current,
      setTimeout: (callback, delayMs): TimerHandle => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
    },
    advance(ms: number): void {
      current += ms;
    },
  };
}

// Full WorkerPoolSettings with co-residence defaults overridable per-test. The N-per
// machine knobs (slotsPerMachine=2, coResidence=true) are the multi-tenant focus.
function poolSettings(overrides: Partial<WorkerPoolSettings> = {}): WorkerPoolSettings {
  const { maxInFlight, slotsPerMachine, ...rest } = overrides;
  return withDerivedMaxInFlight({
    enabled: true,
    driver: "fake",
    min: 0,
    max: 1,
    warm: 0,
    slotsPerMachine: slotsPerMachine ?? maxInFlight ?? 2,
    coResidence: true,
    ttlMs: 3_600_000,
    idleReapMs: 300_000,
    acquireTimeoutMs: 1_000,
    reapIntervalMs: 3_600_000,
    staleHeartbeatMs: 600_000,
    drainDeadlineMs: 5_000,
    ...rest,
  });
}

// A fresh per-test registry carrying the SDK's fake driver under the `fake` kind
// so createWorkerPool resolves it through `deps.drivers` (no process-wide state to
// reset between tests). The driver yields `fake://worker-<workerId>` worker hosts (a
// real ssh-addressable shape) so the per-run endpoint manager treats them as
// remote and mints a tunnel.
function fakeDriverRegistry(): WorkerDriverRegistry {
  const drivers = new WorkerDriverRegistry();
  registerFakeWorkerDriver({ workerDrivers: drivers });
  return drivers;
}

// ---------------------------------------------------------------------------
// The fake per-run McpEndpointManager. perRunClaimEnforcement=true (so the
// coordinator opens one endpoint per remote run and the per-HOST tunnel-exhaustion
// ceiling is in force). It models the REAL post-collapse contract: each run gets a
// DISTINCT per-run lease (distinct claim KEY + distinct Token B), but co-resident
// runs on ONE host SHARE a single reverse tunnel / remote PORT (one `ssh -R` per
// host, runs distinguished by their claim, not by the port). `release()` is
// observable so a test can prove each per-run lease is closed exactly once and a
// SHARED port per host proves the tunnel collapse while DISTINCT keys/tokens prove
// per-run claim isolation.
// ---------------------------------------------------------------------------
interface FakeEndpoint extends AgentMcpEndpointLease {
  readonly remotePort: number;
  readonly workerHost: string;
  readonly runKey: string;
  readonly key: string;
  readonly released: { count: number };
}

interface RecordingEndpointManager extends McpEndpointManager {
  readonly opened: FakeEndpoint[];
  /** Live endpoints (opened minus released). */
  liveCount(): number;
  /** Distinct LIVE per-host tunnels (shared remote ports still open). */
  liveTunnelCount(): number;
}

function makeDistinctPortManager(
  options: { isLocal?: (workerHost: string) => boolean } = {},
): RecordingEndpointManager {
  const opened: FakeEndpoint[] = [];
  let nextPort = 46_000;
  // One shared reverse tunnel (remote port) per worker host: the per-HOST collapse.
  const portByHost = new Map<string, number>();
  const isLocal = options.isLocal ?? ((workerHost: string) => workerHost.length === 0);
  return {
    opened,
    perRunClaimEnforcement: true,
    liveCount(): number {
      return opened.filter((endpoint) => endpoint.released.count === 0).length;
    },
    liveTunnelCount(): number {
      const hosts = new Set<string>();
      for (const endpoint of opened) {
        if (endpoint.released.count === 0) hosts.add(endpoint.workerHost);
      }
      return hosts.size;
    },
    async open(req): Promise<AgentMcpEndpointLease | null> {
      // Local host mints nothing (acp keeps its own endpoint), exactly like the
      // concrete per-run manager's host routing.
      if (isLocal(req.workerHost)) return null;
      // Each run gets a DISTINCT claim key (`${workerHost}#${runKey}`) and token,
      // but co-resident runs on one host SHARE the single per-host reverse tunnel /
      // remote port (the C7 collapse) - the port is the HOST's tunnel identity, the
      // key/token is the RUN's claim identity.
      const key = `${req.workerHost}#${req.runKey}`;
      let remotePort = portByHost.get(req.workerHost);
      if (remotePort === undefined) {
        remotePort = nextPort;
        nextPort += 1;
        portByHost.set(req.workerHost, remotePort);
      }
      const released = { count: 0 };
      const endpoint: FakeEndpoint = {
        url: `http://127.0.0.1:${remotePort}/mcp`,
        token: `tok-${key}`,
        generation: 1,
        acpServer: () => ({ type: "http", name: "lorenz_linear", url: "", headers: [] }),
        remotePort,
        workerHost: req.workerHost,
        runKey: req.runKey,
        key,
        released,
        async release(): Promise<void> {
          released.count += 1;
        },
      };
      opened.push(endpoint);
      return endpoint;
    },
    async release(lease): Promise<void> {
      if (lease === null) return;
      await lease.release();
    },
  };
}

// A coordinator over the REAL pool + the fake distinct-port manager. Returns both
// so a test can inspect the pool's billing snapshot AND the manager's endpoints.
function makeStack(
  settings: WorkerPoolSettings,
  manager: RecordingEndpointManager,
): {
  pool: WorkerPool;
  coordinator: ReturnType<typeof createDispatchCoordinator>;
  advance(ms: number): void;
} {
  const { clock, advance } = controllableClock(0);
  const pool = createWorkerPool(settings, {
    clock,
    logEvent: () => undefined,
    drivers: fakeDriverRegistry(),
  });
  const coordinator = createDispatchCoordinator({
    pool,
    mcpEndpointManager: manager,
    settings,
  });
  return { pool, coordinator, advance };
}

const baseReq = {
  labels: [] as ReadonlyArray<string>,
  timeoutMs: 1_000,
};

// Drains the pool so no warm/leased worker leaks between tests (the drain
// force-destroys any survivors and fires the recycle path for still-leased workers).
async function teardown(pool: WorkerPool): Promise<void> {
  await pool.drain({ deadlineMs: 1_000 }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Two SAME-issue runs co-reside on one worker, each with a distinct endpoint + slot.
// ---------------------------------------------------------------------------

test("two SAME-issue runs co-reside on ONE fake worker, each with a distinct per-run endpoint + workspace, both complete", async () => {
  const manager = makeDistinctPortManager();
  const { pool, coordinator } = makeStack(poolSettings({ max: 1, slotsPerMachine: 2 }), manager);

  const a = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-a", slotIndex: 0 });
  const b = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-a", slotIndex: 1 });
  assert.equal(a.status, "bound");
  assert.equal(b.status, "bound");
  if (a.status !== "bound" || b.status !== "bound") return;

  // Both slots landed on the SAME machine (real co-residence; max=1, slotsPerMachine=2).
  assert.equal(a.slot.machineLeaseId, b.slot.machineLeaseId);
  assert.match(a.slot.workerHost, /^fake:\/\/worker-/);
  assert.equal(a.slot.workerHost, b.slot.workerHost);
  // The pool counts two concurrent leases on the one worker.
  assert.equal(pool.snapshot().inFlight, 2);
  assert.equal(pool.snapshot().total, 1);

  // Per-HOST tunnel collapse: the two co-resident slots SHARE one reverse tunnel /
  // remote port, but each holds a DISTINCT per-run claim (distinct key + token) and a
  // distinct issue-scoped runKey (`${issueId}#${slotIndex}`). Runs are kept apart by
  // their Token B claim, not by a per-run port; the workspace slot stays distinct.
  const epA = a.slot.mcpEndpoint as FakeEndpoint | null;
  const epB = b.slot.mcpEndpoint as FakeEndpoint | null;
  assert.ok(epA);
  assert.ok(epB);
  assert.notEqual(epA?.key, epB?.key);
  assert.notEqual(epA?.token, epB?.token);
  assert.equal(epA?.remotePort, epB?.remotePort);
  assert.notEqual(a.slot.runKey, b.slot.runKey);
  assert.equal(a.slot.runKey, "issue-a#0");
  assert.equal(b.slot.runKey, "issue-a#1");

  // The coordinator's snapshot reflects both live slots with their distinct ports.
  const slots = coordinator.snapshot().slots;
  assert.equal(slots.length, 2);

  // Both runs complete: release healthy closes each endpoint exactly once, then the
  // worker returns to warm (never destroyed).
  await a.slot.release("healthy");
  await b.slot.release("healthy");
  assert.equal(epA?.released.count, 1);
  assert.equal(epB?.released.count, 1);
  assert.equal(manager.liveCount(), 0);
  assert.equal(coordinator.snapshot().slots.length, 0);

  const snap = pool.snapshot();
  assert.equal(snap.inFlight, 0);
  assert.equal(snap.warmIdle, 1);
  assert.equal(snap.leased, 0);

  await teardown(pool);
});

// ---------------------------------------------------------------------------
// Two CROSS-issue runs co-reside on one worker (multi-tenant), each isolated.
// ---------------------------------------------------------------------------

test("two CROSS-issue runs co-reside on ONE fake worker (multi-tenant), each with a distinct per-run endpoint key, both complete", async () => {
  const manager = makeDistinctPortManager();
  const { pool, coordinator } = makeStack(poolSettings({ max: 1, slotsPerMachine: 2 }), manager);

  // Two DIFFERENT issues co-reside on one worker, each with an ISSUE-SCOPED runKey
  // (`${issueId}#${slotIndex}`), so their per-run claim KEYS (`${workerHost}#${runKey}`)
  // are distinct - the per-run Token B isolation the real per-run claim model provides.
  // Because the runKey is issue-scoped, even two cross-issue runs that BOTH chose
  // slotIndex 0 get DISTINCT claim keys; here distinct slot indices also exercise
  // distinct workspace slot suffixes.
  const a = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-a", slotIndex: 0 });
  const b = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-b", slotIndex: 1 });
  assert.equal(a.status, "bound");
  assert.equal(b.status, "bound");
  if (a.status !== "bound" || b.status !== "bound") return;

  // Two DIFFERENT issues co-reside on the SAME worker.
  assert.equal(a.slot.machineLeaseId, b.slot.machineLeaseId);
  assert.notEqual(a.slot.issueId, b.slot.issueId);
  assert.equal(pool.snapshot().inFlight, 2);

  // Per-HOST tunnel collapse: distinct per-run claim KEYS + tokens
  // (`${workerHost}#${runKey}`) but a SHARED reverse tunnel / remote port across the
  // two co-resident tenants. The claim, not the port, isolates the runs.
  const epA = a.slot.mcpEndpoint as FakeEndpoint | null;
  const epB = b.slot.mcpEndpoint as FakeEndpoint | null;
  assert.ok(epA);
  assert.ok(epB);
  assert.notEqual(epA?.key, epB?.key);
  assert.notEqual(epA?.token, epB?.token);
  assert.equal(epA?.remotePort, epB?.remotePort);

  // Per-issue accounting: each issue holds exactly one live slot.
  assert.equal(liveSlotsForIssue(coordinator, "issue-a"), 1);
  assert.equal(liveSlotsForIssue(coordinator, "issue-b"), 1);

  await a.slot.release("healthy");
  await b.slot.release("healthy");
  assert.equal(manager.liveCount(), 0);
  assert.equal(coordinator.snapshot().slots.length, 0);

  await teardown(pool);
});

// ---------------------------------------------------------------------------
// Overlapping worker-second windows bill correctly for N concurrent leases.
// ---------------------------------------------------------------------------

test("overlapping worker-second windows bill each of the N co-resident leases from its OWN acquire time", async () => {
  const manager = makeDistinctPortManager();
  const settings = poolSettings({ max: 1, slotsPerMachine: 2 });
  const { pool, coordinator, advance } = makeStack(settings, manager);

  // Lease A acquires at t=0.
  const a = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-a", slotIndex: 0 });
  assert.equal(a.status, "bound");
  if (a.status !== "bound") return;

  // 100s later lease B co-acquires the SAME worker (overlapping window).
  advance(100_000);
  const b = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-a", slotIndex: 1 });
  assert.equal(b.status, "bound");
  if (b.status !== "bound") return;
  assert.equal(a.slot.machineLeaseId, b.slot.machineLeaseId);

  // Both heartbeat, then both settle at t=300s. A's window is 300s, B's is 200s;
  // billing each from its OWN acquire time yields 300 + 200 = 500 worker-seconds
  // (the pool's real liveLeaseAcquiredMs per-lease accrual, not a single window).
  advance(200_000);
  a.slot.heartbeat();
  b.slot.heartbeat();
  await a.slot.release("healthy");
  await b.slot.release("healthy");

  const snap = pool.snapshot();
  assert.equal(snap.spend.workerSecondsUsed >= 500, true);

  await teardown(pool);
});

// ---------------------------------------------------------------------------
// Per-issue RunSlot accounting is an EXACT live-slot refcount (vs the machine cap).
// ---------------------------------------------------------------------------

function liveSlotsForIssue(
  coordinator: ReturnType<typeof createDispatchCoordinator>,
  issueId: string,
): number {
  return coordinator.snapshot().slots.filter((slot) => slot.issueId === issueId).length;
}

test("per-issue RunSlot accounting is an exact live-slot refcount; maxWorkersPerIssue stays the MACHINE-level cap", async () => {
  const manager = makeDistinctPortManager();
  // maxWorkersPerIssue=1 caps issue-a to ONE machine; slotsPerMachine=2 lets the two
  // co-resident slots of issue-a share that single capped worker. The per-issue RunSlot
  // refcount (2 live slots) is therefore DISTINCT from the machine cap (1 worker).
  const settings = poolSettings({ max: 1, slotsPerMachine: 2, maxWorkersPerIssue: 1 });
  const { pool, coordinator } = makeStack(settings, manager);

  const a0 = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-a", slotIndex: 0 });
  const a1 = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-a", slotIndex: 1 });
  assert.equal(a0.status, "bound");
  assert.equal(a1.status, "bound");
  if (a0.status !== "bound" || a1.status !== "bound") return;

  // The MACHINE-level cap is satisfied: issue-a touches exactly ONE worker...
  assert.equal(pool.snapshot().total, 1);
  assert.equal(a0.slot.machineLeaseId, a1.slot.machineLeaseId);
  // ...yet the per-issue RunSlot refcount is the precise count of LIVE slots: TWO.
  assert.equal(liveSlotsForIssue(coordinator, "issue-a"), 2);

  // Settling ONE slot decrements the per-issue refcount by exactly one (only the
  // settling slot is removed), independent of the still-leased machine.
  await a0.slot.release("healthy");
  assert.equal(liveSlotsForIssue(coordinator, "issue-a"), 1);
  // The worker is still leased by the surviving slot (the machine is NOT yet freed).
  assert.equal(pool.snapshot().inFlight, 1);

  await a1.slot.release("healthy");
  assert.equal(liveSlotsForIssue(coordinator, "issue-a"), 0);

  await teardown(pool);
});

// ---------------------------------------------------------------------------
// A poisoned co-resident worker fails ALL its slots CLEANLY (correlated-failure
// tradeoff of co-residence, documented at the gate).
// ---------------------------------------------------------------------------

// Drains the pending microtask/macrotask queue so the recycle-driven fire-and-
// forget slot.fail chain (close endpoint -> settle lease -> deregister) completes.
async function flush(): Promise<void> {
  await settle(0);
}

test("one co-resident slot poisoning does NOT tear out its still-running sibling (poison is isolated while a sibling holds the worker)", async () => {
  // The shared-machine-poison correlation is NOT immediate: a poison from ONE
  // co-resident lease while a sibling is STILL in flight only settles the poisoning
  // run (closes its own endpoint, removes its own lease). The worker stays LEASED for
  // the sibling - the pool recycles it ONLY when its LAST lease returns (or a
  // teardown recycles it, the next test). This is the correct isolation property:
  // co-residence does not let one run's failure nuke a sibling's live endpoint.
  const manager = makeDistinctPortManager();
  const { pool, coordinator } = makeStack(poolSettings({ max: 1, slotsPerMachine: 2 }), manager);

  const a = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-a", slotIndex: 0 });
  const b = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-b", slotIndex: 0 });
  assert.equal(a.status, "bound");
  assert.equal(b.status, "bound");
  if (a.status !== "bound" || b.status !== "bound") return;
  assert.equal(a.slot.machineLeaseId, b.slot.machineLeaseId);

  const epA = a.slot.mcpEndpoint as FakeEndpoint;
  const epB = b.slot.mcpEndpoint as FakeEndpoint;

  // Run A poisons the shared worker. With sibling B still in flight, A's settle only
  // closes A's OWN endpoint and removes A's lease; the worker is NOT recycled yet.
  await a.slot.fail("ssh_timeout: host fake unreachable");
  await flush();

  // A's endpoint closed exactly once; B's endpoint is UNTOUCHED (still live).
  assert.equal(epA.released.count, 1);
  assert.equal(epB.released.count, 0);
  assert.equal(manager.liveCount(), 1);
  // Only A deregistered; B is still the live slot holding the still-LEASED worker.
  assert.equal(coordinator.snapshot().slots.length, 1);
  assert.equal(liveSlotsForIssue(coordinator, "issue-a"), 0);
  assert.equal(liveSlotsForIssue(coordinator, "issue-b"), 1);
  assert.equal(pool.snapshot().inFlight, 1);

  // B completes normally; the worker is recycled on its poison-deferred settle.
  await b.slot.release("healthy");
  assert.equal(epB.released.count, 1);
  assert.equal(coordinator.snapshot().slots.length, 0);

  await teardown(pool);
});

test("a teardown recycle of a co-resident worker fails ALL its live slots CLEANLY (documented correlated-failure tradeoff)", async () => {
  // The actual correlated-failure mode of co-residence: when the SHARED machine
  // itself goes away while N runs are live (the host died and the drain/reaper
  // force-destroys it), the single `recycle` chokepoint fires `onMachineRecycling`,
  // which the coordinator turns into a CLEAN per-run fail of EVERY co-resident slot
  // on that worker - each endpoint closed, each lease settled, each slot deregistered,
  // no hung tunnel to the dead host. One bad worker fails every co-resident run, but
  // each failure is clean and isolated. This is the blast-radius tradeoff the
  // co-residence opt-in gate documents (slotsPerMachine>1 widens it from 1 to N).
  const manager = makeDistinctPortManager();
  const { pool, coordinator } = makeStack(poolSettings({ max: 1, slotsPerMachine: 2 }), manager);

  const a = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-a", slotIndex: 0 });
  const b = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-b", slotIndex: 0 });
  assert.equal(a.status, "bound");
  assert.equal(b.status, "bound");
  if (a.status !== "bound" || b.status !== "bound") return;
  assert.equal(a.slot.machineLeaseId, b.slot.machineLeaseId);
  assert.equal(coordinator.snapshot().slots.length, 2);

  const epA = a.slot.mcpEndpoint as FakeEndpoint;
  const epB = b.slot.mcpEndpoint as FakeEndpoint;

  // The shared worker is torn down WHILE both runs are live (the drain force-destroy
  // path - the only path that recycles a still-leased worker). It fires
  // onMachineRecycling(workerId), which fails BOTH co-resident slots cleanly.
  await pool.drain({ deadlineMs: 50 });
  await flush();

  // BOTH endpoints were closed exactly once (no orphaned tunnel for either run).
  assert.equal(epA.released.count, 1);
  assert.equal(epB.released.count, 1);
  assert.equal(manager.liveCount(), 0);
  // BOTH slots deregistered: the recycled worker left no slot behind.
  assert.equal(coordinator.snapshot().slots.length, 0);
  assert.equal(liveSlotsForIssue(coordinator, "issue-a"), 0);
  assert.equal(liveSlotsForIssue(coordinator, "issue-b"), 0);

  // The worker was destroyed (removed from inventory), not returned to warm.
  const snap = pool.snapshot();
  assert.equal(snap.total, 0);
  assert.equal(snap.inFlight, 0);
  assert.equal(snap.warmIdle, 0);
});

// ---------------------------------------------------------------------------
// The per-HOST tunnel-exhaustion ceiling surfaces as a TYPED no_capacity (never a
// throw). After the per-HOST collapse the ceiling counts DISTINCT HOSTS that hold a
// reverse tunnel, NOT per-run endpoints - so a NEW host trips it while a co-resident
// run on an already-tunneled host is exempt.
// ---------------------------------------------------------------------------

test("per-host tunnel ceiling: opening a tunnel on a NEW host past maxConcurrentTunnels returns TYPED no_capacity ('tunnel_exhausted'), never a throw", async () => {
  const manager = makeDistinctPortManager();
  // slotsPerMachine=1 so each run lands on its OWN host (one tunnel per run here);
  // a host ceiling of 2 caps concurrent per-host tunnels - the 3rd HOST is over it.
  const settings = poolSettings({ max: 3, slotsPerMachine: 1, maxConcurrentTunnels: 2 });
  const { pool, coordinator } = makeStack(settings, manager);

  const a = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-a", slotIndex: 0 });
  const b = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-b", slotIndex: 0 });
  assert.equal(a.status, "bound");
  assert.equal(b.status, "bound");
  if (a.status !== "bound" || b.status !== "bound") return;
  // Two distinct hosts hold two distinct reverse tunnels (the ceiling).
  assert.notEqual(a.slot.workerHost, b.slot.workerHost);
  assert.equal(manager.liveTunnelCount(), 2);

  // A 3rd run on a 3rd host would open a 3rd tunnel, exceeding the host ceiling. It
  // must surface as a TYPED no_capacity reason - NOT a throw out of acquireRunSlot.
  const c = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-c", slotIndex: 0 });
  assert.equal(c.status, "no_capacity");
  if (c.status !== "no_capacity") return;
  assert.equal(c.reason, "tunnel_exhausted");
  // No 3rd endpoint was opened (the ceiling short-circuits BEFORE the open).
  assert.equal(manager.opened.length, 2);

  // Freeing one host's tunnel drops the live host count below the ceiling so a new
  // remote run on a fresh host binds again.
  await a.slot.release("healthy");
  assert.equal(manager.liveTunnelCount(), 1);
  const d = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-d", slotIndex: 0 });
  assert.equal(d.status, "bound");

  await teardown(pool);
});

test("per-host tunnel ceiling: a CO-RESIDENT run on an already-tunneled host is EXEMPT (the shared host tunnel is one budget unit)", async () => {
  const manager = makeDistinctPortManager();
  // slotsPerMachine=2 so two runs co-reside on one host SHARING its single tunnel.
  // A host ceiling of 1 still admits BOTH co-resident runs (they consume ONE host
  // tunnel) - the per-HOST collapse means the budget is one unit per host, not per run.
  const settings = poolSettings({ max: 2, slotsPerMachine: 2, maxConcurrentTunnels: 1 });
  const { pool, coordinator } = makeStack(settings, manager);

  const a = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-a", slotIndex: 0 });
  const b = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-a", slotIndex: 1 });
  assert.equal(a.status, "bound");
  assert.equal(b.status, "bound");
  if (a.status !== "bound" || b.status !== "bound") return;
  // Both co-resided on ONE host sharing its single reverse tunnel: TWO per-run
  // endpoints (claims) but ONE host tunnel - so the ceiling of 1 is NOT tripped.
  assert.equal(a.slot.workerHost, b.slot.workerHost);
  assert.equal(manager.liveCount(), 2);
  assert.equal(manager.liveTunnelCount(), 1);

  // A run that needs a tunnel on a SECOND host is over the host ceiling of 1.
  const c = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-b", slotIndex: 0 });
  assert.equal(c.status, "no_capacity");
  if (c.status !== "no_capacity") return;
  assert.equal(c.reason, "tunnel_exhausted");

  await teardown(pool);
});
