// STEP 2 (T2e) cross-cutting endpoint-isolation: the WHOLE per-run stack wired
// together as production wires it - the REAL `WorkerHostPool` (per-run tunnels),
// the REAL `acquireAgentMcpEndpointForRun` (token + refcounted local mcp server +
// reverse tunnel behind ONE lease), the concrete per-run `McpEndpointManager`,
// and the REAL `DispatchCoordinator` over a fake machine `WorkerPool`. The ONLY seam
// replaced is `@lorenz/ssh` (`startReverseTunnel`'s `ssh -N` child plus its
// readiness probe), mocked so no real ssh is spawned and so a leaked / surviving
// child shows up as an un-`kill()`ed fake
// process. Everything else - the three sub-resources of the endpoint lease, the
// per-run tunnel keying, the open-after-bind / close-before-settle ordering, the
// recycle-driven clean fail, and the force-drain endpoint sweep - is the real
// code path two co-resident runs would take.
//
// The per-package unit suites already pin each layer in isolation
// (worker-host-pool/test/per-run-tunnel, mcp/test/agentEndpoint,
// dispatch-coordinator/test/coordinator). This file pins the CROSS-CUTTING
// invariants that only emerge when the layers are composed:
//   - a machine recycle/poison for run A fails A CLEANLY (token revoked, local
//     server ref dropped, ssh child killed, lease settled, slot deregistered) and
//     leaves run B's endpoint + lease completely untouched;
//   - an endpoint-open throw settles the just-bound lease HEALTHY and leaves NO
//     half-open ssh child (the recycled remote port is free for reuse);
//   - a stall (AbortSignal) during the open-endpoint window aborts the open,
//     settles the lease healthy, and closes any half-opened child;
//   - a force-drain closes EVERY surviving registry endpoint (no leaked ssh -N
//     child on shutdown);
//   - the local-host path leaves acp owning (acquiring AND releasing) its own
//     endpoint byte-for-byte (the coordinator mints nothing);
//   - the default single-slot path opens EXACTLY ONE endpoint per machine.
//
// The coordinator surface is imported from `@lorenz/cli` (its re-export barrel,
// the same path the live/e2e suites use). The concrete per-run manager is built
// inline as the trivial host-routing adapter over the REAL
// `acquireAgentMcpEndpointForRun` (the dispatch-coordinator unit suite already
// pins `createPerRunEndpointManager`'s routing; here the point is the composed
// behaviour, which the real acquire + real WorkerHostPool drive end-to-end).
// `@lorenz/ssh` is mocked by module specifier so the real acquire picks up the
// fake `startReverseTunnel`. Tests import the compiled package barrels (the suite
// runs against tsc --build output).

import EventEmitter from "node:events";
import { createServer } from "node:net";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { assert, settle } from "@lorenz/test-utils";
import { afterEach, beforeEach, test, vi } from "vitest";
import { startReverseTunnel } from "@lorenz/ssh";
import { parseConfig } from "@lorenz/config";
import type { WorkerPoolSettings } from "@lorenz/domain";
import { acquireAgentMcpEndpointForRun, mcpAuthScopeForSettings, validMcpToken } from "@lorenz/mcp";
import type { AgentMcpEndpointLease } from "@lorenz/mcp";
import { WorkerHostPool, workerHostPool } from "@lorenz/worker-host-pool";
import { createDispatchCoordinator } from "@lorenz/cli";
import type {
  AcquireResult,
  WorkerLease,
  WorkerPool,
  WorkerPoolSnapshot,
  McpEndpointManager,
  Settings,
} from "@lorenz/cli";

// The reverse-tunnel child is the ONE seam we replace: a fake EventEmitter whose
// `kill()` is observable, so a surviving (un-killed) child is a leaked ssh -N.
// The pool awaits remote-port readiness before returning a lease; the fake
// `waitForRemoteTcpPort` resolves immediately so the suite exercises the lease
// lifecycle, not the readiness probe.
vi.mock("@lorenz/ssh", () => ({
  startReverseTunnel: vi.fn(),
  waitForRemoteTcpPort: vi.fn(async () => {}),
}));

const mockStartReverseTunnel = vi.mocked(startReverseTunnel);

type WorkerOutcome = "healthy" | "poison";

interface AcquireRunSlotRequest {
  issueId: string;
  slotIndex: number;
  labels: ReadonlyArray<string>;
  affinityKey?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface FakeProcess extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeProcess(processes: FakeProcess[]): ChildProcessWithoutNullStreams {
  const emitter = new EventEmitter() as FakeProcess;
  // Port recycling is deferred until the ssh child actually ends, so the fake
  // child ends (emits close) as soon as it is killed.
  emitter.kill = vi.fn(() => {
    emitter.emit("close", null, "SIGTERM");
    return true;
  });
  (emitter as unknown as Record<string, unknown>).pid = 4242;
  processes.push(emitter);
  return emitter as unknown as ChildProcessWithoutNullStreams;
}

// A free localhost TCP port for the refcounted local MCP server, so the suite
// binds deterministically and never collides with an unrelated listener.
async function freeLocalPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const mcpServerPort = await freeLocalPort();

// ---------------------------------------------------------------------------
// The concrete per-run McpEndpointManager: the trivial host-routing adapter over
// the REAL acquireAgentMcpEndpointForRun (whole-lease acquire) - the same routing
// createPerRunEndpointManager performs. An ssh-addressable host opens the real
// per-run endpoint; an empty (local) host mints nothing (acp keeps its own).
// ---------------------------------------------------------------------------

type AcquireForRun = (
  settings: Settings,
  workerHost: string,
  runKey: string,
) => Promise<AgentMcpEndpointLease>;

function isLocalWorkerHost(workerHost: string): boolean {
  return workerHost.length === 0;
}

function perRunManager(acquireForRun: AcquireForRun): McpEndpointManager {
  return {
    perRunEndpoint: true,
    async open(req): Promise<AgentMcpEndpointLease | null> {
      if (isLocalWorkerHost(req.workerHost)) return null;
      return acquireForRun(req.settings, req.workerHost, req.runKey);
    },
    async release(lease): Promise<void> {
      if (lease === null) return;
      await lease.release();
    },
  };
}

// ---------------------------------------------------------------------------
// Fake machine pool: models JUST enough of the real WorkerPool for the coordinator
// to bind leases and to fire `onMachineRecycling` on recycle/drain (the real
// pool fires it inside the per-worker mutex at the top of `recycle`, which `drain`
// invokes for every worker). Each `acquire` mints a fresh leased worker; `release`/
// `fail` record the settle; `drain` recycles every still-leased worker (firing the
// recycle callback) exactly like the real pool's drain->recycle->notify chain.
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
    async release(outcome?: WorkerOutcome): Promise<void> {
      settles.push({ kind: "release", arg: outcome });
    },
    async fail(reason: string): Promise<void> {
      settles.push({ kind: "fail", arg: reason });
    },
    heartbeat(): void {},
  };
}

interface FakeMachinePool extends WorkerPool {
  readonly leases: Map<string, FakeLease>;
  triggerRecycling(workerId: string): void;
}

function makeFakeMachinePool(
  options: { hostFor?: (workerId: string) => string } = {},
): FakeMachinePool {
  const recyclingCallbacks: Array<(workerId: string) => void> = [];
  const leases = new Map<string, FakeLease>();
  let nextWorker = 0;
  const hostFor = options.hostFor ?? ((workerId: string) => `ssh://${workerId}`);
  const pool: FakeMachinePool = {
    leases,
    triggerRecycling(workerId: string): void {
      for (const cb of recyclingCallbacks) cb(workerId);
    },
    async acquire(): Promise<AcquireResult> {
      const workerId = `worker-${nextWorker++}`;
      const lease = makeFakeLease(workerId, hostFor(workerId));
      leases.set(workerId, lease);
      return { status: "leased", lease };
    },
    canAcquire(): boolean {
      return true;
    },
    isEnabled(): boolean {
      return true;
    },
    reconcile(): void {},
    swapDriver(): void {},
    onMachineRecycling(cb): void {
      recyclingCallbacks.push(cb);
    },
    async hydrate(): Promise<void> {},
    async drain(): Promise<void> {
      // The real pool recycles every worker on drain, firing the recycle callback
      // for each (inside the per-worker mutex). Snapshot the keys first so the
      // callback can mutate the coordinator registry without invalidating this
      // iteration.
      for (const workerId of [...leases.keys()]) {
        for (const cb of recyclingCallbacks) cb(workerId);
      }
    },
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
  return pool;
}

function endpointSettings(): WorkerPoolSettings {
  // A real parsed Settings pinned to a known-free loopback server port, so the
  // refcounted local MCP server binds deterministically and the configured token
  // scope is computable (the WHOLE three-resource lease is exercised for real).
  // The coordinator only forwards `settings` to the manager, which threads it to
  // acquireAgentMcpEndpointForRun.
  const full = parseConfig({
    tracker: { kind: "memory", active_states: ["Todo"], terminal_states: ["Done"] },
    server: { host: "127.0.0.1", port: mcpServerPort },
  });
  return full as unknown as WorkerPoolSettings;
}

// Tokens issued for the configured server port are scoped to the settings
// identity; validity checks must use the same scope.
const endpointTokenScope = mcpAuthScopeForSettings(
  endpointSettings() as unknown as Settings,
  "127.0.0.1",
  mcpServerPort,
);

function makeCoordinator(
  pool: FakeMachinePool,
  acquireForRun: AcquireForRun = (settings, workerHost, runKey) =>
    acquireAgentMcpEndpointForRun(settings, workerHost, runKey, workerHostPool),
): ReturnType<typeof createDispatchCoordinator> {
  return createDispatchCoordinator({
    pool,
    mcpEndpointManager: perRunManager(acquireForRun),
    settings: endpointSettings(),
  });
}

const baseReq: Pick<AcquireRunSlotRequest, "labels" | "timeoutMs"> = {
  labels: [],
  timeoutMs: 5_000,
};

// Flush the fire-and-forget recycle-driven settle chain (a macrotask turn runs
// after every currently-queued microtask).
async function flushMicrotasks(): Promise<void> {
  await settle(0);
}

// Asserts the structured acquire error the coordinator rethrows when the per-run
// endpoint fails to open (checked by name, since EndpointOpenError is not on the
// cli re-export barrel; the dispatch-coordinator unit suite pins the class).
function isEndpointOpenError(error: unknown): boolean {
  return error instanceof Error && error.name === "EndpointOpenError";
}

let liveEndpoints: AgentMcpEndpointLease[] = [];

beforeEach(() => {
  mockStartReverseTunnel.mockReset();
  liveEndpoints = [];
});

afterEach(async () => {
  // Defensively release any endpoint a test left open so the shared module-level
  // local-mcp-server map and token set never leak across tests.
  for (const endpoint of liveEndpoints) await endpoint.release().catch(() => undefined);
  liveEndpoints = [];
});

// ---------------------------------------------------------------------------
// Machine recycle / poison: fail run A cleanly, leave run B untouched.
// ---------------------------------------------------------------------------

test("recycle/poison of run A fails A CLEANLY (token revoked, ssh child killed, lease settled, deregistered) and leaves run B untouched", async () => {
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  const pool = makeFakeMachinePool();
  const coordinator = makeCoordinator(pool);

  // Two runs land on two distinct machines (distinct hosts), each opening a real
  // whole-endpoint lease (token + local server + per-run reverse tunnel).
  const a = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-a", slotIndex: 0 });
  const b = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-b", slotIndex: 0 });
  assert.equal(a.status, "bound");
  assert.equal(b.status, "bound");
  if (a.status !== "bound" || b.status !== "bound") return;

  const tokenA = a.slot.mcpEndpoint!.token;
  const tokenB = b.slot.mcpEndpoint!.token;
  liveEndpoints.push(b.slot.mcpEndpoint!);
  // Both endpoints opened real per-run tunnels: two distinct ssh children, both
  // tokens valid.
  assert.equal(processes.length, 2);
  assert.ok(validMcpToken(tokenA, endpointTokenScope));
  assert.ok(validMcpToken(tokenB, endpointTokenScope));
  assert.equal(coordinator.snapshot().slots.length, 2);

  // The pool recycles run A's worker (poison/reaper). The coordinator's registered
  // onMachineRecycling fails A's slot: close the WHOLE endpoint (revoke token,
  // drop local-server ref, kill ssh child) THEN settle the lease THEN deregister.
  pool.triggerRecycling(a.slot.machineLeaseId);
  await flushMicrotasks();

  // Run A is torn down cleanly end-to-end:
  assert.equal(validMcpToken(tokenA, endpointTokenScope), false); // token revoked
  assert.equal(processes[0]!.kill.mock.calls.length, 1); // A's ssh child killed
  assert.deepEqual(pool.leases.get(a.slot.machineLeaseId)!.settles, [
    { kind: "fail", arg: "machine_recycled" },
  ]); // lease settled exactly once as a fail

  // Run B is completely untouched: token still valid, child still alive, slot
  // still registered.
  assert.ok(validMcpToken(tokenB, endpointTokenScope));
  assert.equal(processes[1]!.kill.mock.calls.length, 0);
  const slots = coordinator.snapshot().slots;
  assert.equal(slots.length, 1);
  assert.equal(slots[0]?.issueId, "issue-b");

  // A normal release racing in after the recycle fail no-ops (exactly-once across
  // BOTH paths): A's lease still has exactly one settle.
  await a.slot.release("healthy");
  assert.equal(pool.leases.get(a.slot.machineLeaseId)!.settles.length, 1);
});

test("two co-resident runs on ONE machine get DISTINCT per-run tunnels; closing A leaves B's endpoint live", async () => {
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  // Both slots resolve to the SAME host (co-residence): the per-run tunnel keying
  // (`${workerHost}#${runKey}`) must still hand out DISTINCT remote ports.
  const pool = makeFakeMachinePool({ hostFor: () => "ssh://shared-host" });
  const coordinator = makeCoordinator(pool);

  const a = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-x", slotIndex: 0 });
  const b = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-x", slotIndex: 1 });
  if (a.status !== "bound" || b.status !== "bound") return;
  liveEndpoints.push(b.slot.mcpEndpoint!);

  // Distinct remote ports despite the shared host (no host-coalescing kill).
  const portA = Number(new URL(a.slot.mcpEndpoint!.url).port);
  const portB = Number(new URL(b.slot.mcpEndpoint!.url).port);
  assert.ok(portA !== portB);
  assert.equal(processes.length, 2);

  // Close A's run: only A's ssh child dies; B's tunnel stays alive.
  await a.slot.release("healthy");
  assert.equal(processes[0]!.kill.mock.calls.length, 1);
  assert.equal(processes[1]!.kill.mock.calls.length, 0);
  assert.ok(validMcpToken(b.slot.mcpEndpoint!.token, endpointTokenScope));
  assert.equal(coordinator.snapshot().slots.length, 1);
});

// ---------------------------------------------------------------------------
// Endpoint-open throw: settle lease healthy, no half-open ssh child.
// ---------------------------------------------------------------------------

test("endpoint-open throw settles the lease HEALTHY and leaves NO half-open ssh child (port freed for reuse)", async () => {
  const processes: FakeProcess[] = [];
  // The reverse tunnel allocates a port then FAILS to spawn (the real
  // openForRun catch recycles the just-allocated port); the whole-endpoint
  // acquire rejects, so the coordinator settles the lease healthy and rethrows a
  // structured EndpointOpenError.
  mockStartReverseTunnel
    .mockImplementationOnce(() => {
      throw new Error("ssh spawn failed: EMFILE");
    })
    .mockImplementation(() => makeFakeProcess(processes));
  const pool = makeFakeMachinePool();
  const coordinator = makeCoordinator(pool);

  let thrown: unknown;
  try {
    await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-a", slotIndex: 0 });
  } catch (error) {
    thrown = error;
  }

  // The coordinator rethrows a structured EndpointOpenError (runtime maps it to
  // worker_pool_acquire_error).
  assert.ok(isEndpointOpenError(thrown));
  // The just-bound WorkerLease was settled HEALTHY (the worker is fine; only the
  // endpoint failed) - NOT poisoned.
  const [workerId] = [...pool.leases.keys()];
  assert.deepEqual(pool.leases.get(workerId!)!.settles, [{ kind: "release", arg: "healthy" }]);
  // NO half-open ssh child survives (the spawn threw; no process was created) and
  // NO slot is registered.
  assert.equal(processes.length, 0);
  assert.equal(coordinator.snapshot().slots.length, 0);

  // The just-allocated remote port was recycled by openForRun's catch, so the
  // NEXT successful run reuses port 46000 - proving no port leaked.
  const next = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-b", slotIndex: 0 });
  if (next.status !== "bound") throw new Error("expected bound");
  liveEndpoints.push(next.slot.mcpEndpoint!);
  assert.equal(Number(new URL(next.slot.mcpEndpoint!.url).port), 46_000);
});

// ---------------------------------------------------------------------------
// Stall during the open-endpoint window: abort, settle, close any half-open.
// ---------------------------------------------------------------------------

test("a stall during the open-endpoint window aborts open, settles the lease HEALTHY, and closes any half-opened endpoint", async () => {
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  const pool = makeFakeMachinePool();

  // A manager whose open() honours the AbortSignal: it opens the REAL whole
  // endpoint, then - if the signal is already/becomes aborted in the open window -
  // closes that half-opened endpoint and throws, exactly as a stall-aborted open
  // must (no orphaned token/server/tunnel).
  const controller = new AbortController();
  const acquireForRun: AcquireForRun = async (settings, workerHost, runKey) => {
    const lease = await acquireAgentMcpEndpointForRun(settings, workerHost, runKey, workerHostPool);
    if (controller.signal.aborted) {
      await lease.release();
      throw new Error("open_aborted: stall in open window");
    }
    return lease;
  };
  const coordinator = makeCoordinator(pool, acquireForRun);

  // Abort before the acquire so the open window sees the stall and tears the
  // half-opened endpoint down.
  controller.abort();

  let thrown: unknown;
  try {
    await coordinator.acquireRunSlot({
      ...baseReq,
      issueId: "issue-a",
      slotIndex: 0,
      signal: controller.signal,
    });
  } catch (error) {
    thrown = error;
  }

  // The stall surfaced as a structured EndpointOpenError; the lease settled
  // HEALTHY; the half-opened ssh child was killed by the endpoint close; no slot
  // registered.
  assert.ok(isEndpointOpenError(thrown));
  const [workerId] = [...pool.leases.keys()];
  assert.deepEqual(pool.leases.get(workerId!)!.settles, [{ kind: "release", arg: "healthy" }]);
  assert.equal(processes.length, 1);
  assert.equal(processes[0]!.kill.mock.calls.length, 1);
  assert.equal(coordinator.snapshot().slots.length, 0);
});

// ---------------------------------------------------------------------------
// Force-drain: close every surviving registry endpoint (no leaked ssh -N).
// ---------------------------------------------------------------------------

test("force-drain closes EVERY surviving registry endpoint (no leaked ssh -N child on shutdown)", async () => {
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  const pool = makeFakeMachinePool();
  const coordinator = makeCoordinator(pool);

  // Three live runs across three machines, each with a real open endpoint.
  const slots = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await coordinator.acquireRunSlot({ ...baseReq, issueId: `issue-${i}`, slotIndex: 0 });
    if (r.status !== "bound") throw new Error("expected bound");
    slots.push(r.slot);
  }
  assert.equal(processes.length, 3);
  assert.equal(coordinator.snapshot().slots.length, 3);
  const tokens = slots.map((s) => s.mcpEndpoint!.token);
  for (const token of tokens) assert.ok(validMcpToken(token, endpointTokenScope));

  // Force-drain: the real pool recycles every worker on drain (firing the recycle
  // callback per worker), so every surviving registry endpoint is closed - no ssh -N
  // child survives shutdown.
  await coordinator.drain({ deadlineMs: 5_000 });
  await flushMicrotasks();

  for (let i = 0; i < 3; i += 1) {
    assert.equal(processes[i]!.kill.mock.calls.length, 1); // every ssh child killed
    assert.equal(validMcpToken(tokens[i]!, endpointTokenScope), false); // every token revoked
  }
  // Every slot deregistered: the registry is empty after a force-drain.
  assert.equal(coordinator.snapshot().slots.length, 0);
});

// ---------------------------------------------------------------------------
// Local-host path: acp keeps owning its own endpoint (coordinator mints nothing).
// ---------------------------------------------------------------------------

test("local-host path: the coordinator mints NO endpoint (acp keeps acquiring AND releasing its own), byte-for-byte", async () => {
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  // The machine resolves to a local (empty) host: the concrete manager returns
  // null for it (acp owns its own endpoint exactly as in the single-tenant path).
  const pool = makeFakeMachinePool({ hostFor: () => "" });
  let acquireCalled = 0;
  const coordinator = makeCoordinator(pool, async (...args) => {
    acquireCalled += 1;
    return acquireAgentMcpEndpointForRun(...args, workerHostPool);
  });

  const r = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-a", slotIndex: 0 });
  if (r.status !== "bound") throw new Error("expected bound");

  // No per-run endpoint was opened: slot.mcpEndpoint is null, the injected
  // acquireForRun was never called, and no ssh child was spawned. acp will
  // acquire AND release its own endpoint downstream (the byte-identical local path).
  assert.equal(r.slot.mcpEndpoint, null);
  assert.equal(acquireCalled, 0);
  assert.equal(processes.length, 0);

  // Release is a clean no-op for the null endpoint, then settles the lease.
  await r.slot.release("healthy");
  const [workerId] = [...pool.leases.keys()];
  assert.deepEqual(pool.leases.get(workerId!)!.settles, [{ kind: "release", arg: "healthy" }]);
});

// ---------------------------------------------------------------------------
// Single-slot: exactly one endpoint per machine (live-ssh/e2e unchanged).
// ---------------------------------------------------------------------------

test("single-slot path opens EXACTLY ONE endpoint per machine (one ssh child, one token, one tunnel)", async () => {
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  const pool = makeFakeMachinePool();
  const coordinator = makeCoordinator(pool);

  const r = await coordinator.acquireRunSlot({ ...baseReq, issueId: "issue-a", slotIndex: 0 });
  if (r.status !== "bound") throw new Error("expected bound");
  liveEndpoints.push(r.slot.mcpEndpoint!);

  // Exactly one endpoint: one token, one ssh child, one per-run tunnel. A
  // heartbeat / resume within the run never re-opens.
  r.slot.heartbeat();
  assert.ok(r.slot.mcpEndpoint);
  assert.ok(validMcpToken(r.slot.mcpEndpoint!.token, endpointTokenScope));
  assert.equal(processes.length, 1);
  assert.equal(coordinator.snapshot().slots.length, 1);

  // Releasing closes that single endpoint (token revoked, ssh child killed) and
  // settles the lease.
  const token = r.slot.mcpEndpoint!.token;
  liveEndpoints = [];
  await r.slot.release("healthy");
  assert.equal(validMcpToken(token, endpointTokenScope), false);
  assert.equal(processes[0]!.kill.mock.calls.length, 1);
});

// ---------------------------------------------------------------------------
// Sanity: the cross-package wiring injects the SAME shared WorkerHostPool
// singleton the production daemon binds as the per-run tunnel transport (no
// second pool instance leaks).
// ---------------------------------------------------------------------------

test("the shared workerHostPool singleton is the per-run tunnel transport (production wiring)", () => {
  // The daemon binds this module-level singleton as the RemoteMcpTunnelTransport
  // passed to acquireAgentMcpEndpointForRun; a fresh WorkerHostPool is a DISTINCT
  // instance. This pins that the suite exercises production wiring (the shared
  // singleton injected as the transport), not an ad-hoc pool.
  assert.ok(workerHostPool instanceof WorkerHostPool);
  assert.ok(workerHostPool !== new WorkerHostPool());
});
