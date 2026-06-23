import EventEmitter from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { beforeEach, test, vi } from "vitest";
import { startReverseTunnel } from "@lorenz/ssh";
import { assert } from "@lorenz/test-utils";

import { WorkerHostPool } from "@lorenz/worker-host-pool";

vi.mock("@lorenz/ssh", () => ({
  startReverseTunnel: vi.fn(),
  // The pool awaits remote-port readiness before returning a lease; the fake
  // resolves immediately so these tests exercise allocation and lifecycle,
  // not the readiness probe.
  waitForRemoteTcpPort: vi.fn(async () => {}),
}));

const mockStartReverseTunnel = vi.mocked(startReverseTunnel);

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
  (emitter as unknown as Record<string, unknown>).pid = 12345;
  processes.push(emitter);
  return emitter as unknown as ChildProcessWithoutNullStreams;
}

beforeEach(() => {
  mockStartReverseTunnel.mockReset();
});

// ---------------------------------------------------------------------------
// Per-HOST tunnel collapse: one `ssh -R` reverse tunnel per worker host,
// SHARED by every co-resident run on that host. Runs are kept apart by their
// per-run Token B claim - NOT by the tunnel or its remote port - so two runs on
// one host coalesce onto ONE tunnel (refcounted), rather than each owning a
// distinct remote port. The host tunnel opens on the first run and closes only
// at the last `closeForRun`.
// ---------------------------------------------------------------------------

test("openForRun coalesces two runs on ONE host onto a SINGLE shared tunnel/port", async () => {
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  const pool = new WorkerHostPool();

  const a = await pool.openForRun("worker-1", "0", "127.0.0.1", 3000);
  const b = await pool.openForRun("worker-1", "1", "127.0.0.1", 3000);

  assert.equal(a.workerHost, "worker-1");
  assert.equal(b.workerHost, "worker-1");
  // Both runs share the SAME per-host tunnel and remote port (no distinct port
  // per run anymore - the per-run claim distinguishes them).
  assert.equal(a.remotePort, b.remotePort);
  assert.equal(a.remotePort, 46_000);
  // ONE ssh -R child for the host, NOT one per run.
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
  // Distinct refcount leases on the one shared entry.
  assert.ok(a.leaseId !== b.leaseId);
});

test("openForRun is per-run hold keyed: re-opening the SAME run reuses its hold (no extra refcount)", async () => {
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  const pool = new WorkerHostPool();

  const a1 = await pool.openForRun("worker-1", "0", "127.0.0.1", 3000);
  const a2 = await pool.openForRun("worker-1", "0", "127.0.0.1", 3000);

  // Same run + same local endpoint reuses its existing hold (same lease, same
  // shared tunnel) - a single co-resident run never takes two refcounts.
  assert.equal(a1.remotePort, a2.remotePort);
  assert.equal(a1.leaseId, a2.leaseId);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);

  // One closeForRun drops the run's single hold and tears the (only) tunnel down.
  pool.closeForRun("worker-1", "0");
  assert.equal(processes[0]!.kill.mock.calls.length, 1);
});

test("closeForRun(A) keeps the SHARED host tunnel alive while run B still holds it", async () => {
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  const pool = new WorkerHostPool();

  await pool.openForRun("worker-1", "A", "127.0.0.1", 3000);
  const b = await pool.openForRun("worker-1", "B", "127.0.0.1", 3000);

  // Closing A drops one ref but B still holds the shared tunnel: the ssh child
  // is NOT killed (refcount stays > 0).
  pool.closeForRun("worker-1", "A");
  assert.equal(processes[0]!.kill.mock.calls.length, 0);

  // Re-opening run B reuses the still-live shared entry (no new process).
  const b2 = await pool.openForRun("worker-1", "B", "127.0.0.1", 3000);
  assert.equal(b2.remotePort, b.remotePort);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);

  // Closing the LAST holder (B) finally tears the shared tunnel down.
  pool.closeForRun("worker-1", "B");
  assert.equal(processes[0]!.kill.mock.calls.length, 1);
});

test("two DIFFERENT hosts get DISTINCT tunnels and remote ports", async () => {
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  const pool = new WorkerHostPool();

  const a = await pool.openForRun("worker-1", "R", "127.0.0.1", 3000);
  const b = await pool.openForRun("worker-2", "R", "127.0.0.1", 3000);

  // Per-HOST keying: distinct hosts never share a tunnel/port.
  assert.ok(a.remotePort !== b.remotePort);
  assert.equal(a.remotePort, 46_000);
  assert.equal(b.remotePort, 46_001);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);
});

test("two DIFFERENT issues at slotIndex 0 on the SAME host SHARE one host tunnel (claim-distinguished, not port-distinguished)", async () => {
  // The coordinator runKey is ISSUE-SCOPED (`${issueId}#${slotIndex}`). Under the
  // per-HOST collapse both co-resident issues route onto ONE shared `ssh -R`
  // tunnel; they are kept apart by their per-run Token B claim at the gateway,
  // not by a distinct remote port. Each takes its own refcount lease.
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  const pool = new WorkerHostPool();

  const a = await pool.openForRun("worker-1", "issue-a#0", "127.0.0.1", 3000);
  const b = await pool.openForRun("worker-1", "issue-b#0", "127.0.0.1", 3000);

  // ONE shared tunnel: same remote port, ONE ssh child, distinct refcount leases.
  assert.equal(a.remotePort, b.remotePort);
  assert.equal(a.remotePort, 46_000);
  assert.ok(a.leaseId !== b.leaseId);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);

  // Closing issue-a leaves issue-b's hold (and the shared tunnel) untouched.
  pool.closeForRun("worker-1", "issue-a#0");
  assert.equal(processes[0]!.kill.mock.calls.length, 0);
  pool.closeForRun("worker-1", "issue-b#0");
  assert.equal(processes[0]!.kill.mock.calls.length, 1);
});

test("openForRun and acquireRemoteMcpTunnel SHARE one host:port tunnel (single ssh child)", async () => {
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  const pool = new WorkerHostPool();

  // Both the whole-endpoint host path and the per-run path target the same
  // host:port, so they coalesce onto ONE shared reverse tunnel.
  const host = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  const run = await pool.openForRun("worker-1", "R", "127.0.0.1", 3000);

  assert.equal(host.remotePort, run.remotePort);
  assert.equal(host.remotePort, 46_000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
});

test("closeForRun is a no-op for an unknown run key", () => {
  const pool = new WorkerHostPool();
  pool.closeForRun("worker-1", "missing");
  pool.closeForRun("", "");
});

test("generation fence: a stale closeForRun after a host:port recycle never tears down the FRESH tunnel (CAS late-close reject)", async () => {
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  const pool = new WorkerHostPool();

  // Run A opens the host:port tunnel (generation 1) and holds it.
  const a = await pool.openForRun("worker-1", "A", "127.0.0.1", 3000);
  assert.equal(a.remotePort, 46_000);

  // The ssh child dies unexpectedly: the process-end handler tears the
  // generation-1 entry down (clearing A's lease bookkeeping) WITHOUT removing
  // A's per-run hold record. A's hold is now stale (recorded against generation 1).
  processes[0]!.emit("close", null, "SIGKILL");

  // A DIFFERENT run B opens the SAME host:port: a brand-new entry replaces the
  // torn-down one under a STRICTLY higher generation (2).
  await pool.openForRun("worker-1", "B", "127.0.0.1", 3000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2); // a brand-new ssh child
  assert.equal(processes.length, 2);

  // Run A's now-stale closeForRun fires. Its hold was recorded at generation 1,
  // but the live entry is generation 2: the CAS late-close reject must drop A's
  // stale bookkeeping WITHOUT decrementing B's fresh generation-2 refcount. B's
  // tunnel must stay alive.
  pool.closeForRun("worker-1", "A");
  assert.equal(processes[1]!.kill.mock.calls.length, 0); // fresh tunnel untouched

  // Only B (the real, current holder) closing tears the fresh tunnel down.
  pool.closeForRun("worker-1", "B");
  assert.equal(processes[1]!.kill.mock.calls.length, 1);
});
