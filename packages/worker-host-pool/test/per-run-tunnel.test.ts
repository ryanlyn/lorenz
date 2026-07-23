import { beforeEach, test, vi } from "vitest";
import { startReverseTunnel, type ReverseTunnelHandle } from "@lorenz/ssh";
import { assert, settle } from "@lorenz/test-utils";

import { WorkerHostPool } from "@lorenz/worker-host-pool";

vi.mock("@lorenz/ssh", () => ({
  startReverseTunnel: vi.fn(),
  waitForRemoteTcpPortClosed: vi.fn(async () => {}),
}));

const mockStartReverseTunnel = vi.mocked(startReverseTunnel);

interface FakeTunnel {
  handle: ReverseTunnelHandle;
  end(): void;
}

function makeFakeTunnel(tunnels: FakeTunnel[]): ReverseTunnelHandle {
  let resolveEnded: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  const handle: ReverseTunnelHandle = {
    ended,
    check: vi.fn(async () => {}),
    close: vi.fn(async () => {
      resolveEnded();
    }),
  };
  tunnels.push({
    handle,
    end: resolveEnded,
  });
  return handle;
}

beforeEach(() => {
  mockStartReverseTunnel.mockReset();
});

// Every co-resident run on one host shares one ref-counted logical tunnel. The
// per-run Token B claim, not a distinct remote port, isolates those runs.

test("openForRun coalesces two runs on one host onto one shared tunnel and port", async () => {
  const tunnels: FakeTunnel[] = [];
  mockStartReverseTunnel.mockImplementation(async () => makeFakeTunnel(tunnels));
  const pool = new WorkerHostPool();

  const a = await pool.openForRun("worker-1", "0", "127.0.0.1", 3000);
  const b = await pool.openForRun("worker-1", "1", "127.0.0.1", 3000);

  assert.equal(a.workerHost, "worker-1");
  assert.equal(b.workerHost, "worker-1");
  assert.equal(a.remotePort, b.remotePort);
  assert.equal(a.remotePort, 46_000);
  assert.notEqual(a.leaseId, b.leaseId);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
});

test("re-opening the same run reuses its existing hold", async () => {
  const tunnels: FakeTunnel[] = [];
  mockStartReverseTunnel.mockImplementation(async () => makeFakeTunnel(tunnels));
  const pool = new WorkerHostPool();

  const first = await pool.openForRun("worker-1", "0", "127.0.0.1", 3000);
  const second = await pool.openForRun("worker-1", "0", "127.0.0.1", 3000);

  assert.equal(first.remotePort, second.remotePort);
  assert.equal(first.leaseId, second.leaseId);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);

  await pool.closeForRun("worker-1", "0");
  assert.equal(vi.mocked(tunnels[0]!.handle.close).mock.calls.length, 1);
});

test("concurrent opens for the same run create one hold and one final close", async () => {
  const tunnels: FakeTunnel[] = [];
  mockStartReverseTunnel.mockImplementation(async () => makeFakeTunnel(tunnels));
  const pool = new WorkerHostPool();

  const [first, second] = await Promise.all([
    pool.openForRun("worker-1", "run-1", "127.0.0.1", 3000),
    pool.openForRun("worker-1", "run-1", "127.0.0.1", 3000),
  ]);

  assert.equal(first.leaseId, second.leaseId);
  assert.equal(first.remotePort, second.remotePort);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);

  await pool.closeForRun("worker-1", "run-1");
  assert.equal(vi.mocked(tunnels[0]!.handle.close).mock.calls.length, 1);
});

test("closing one run keeps the shared host tunnel alive for another run", async () => {
  const tunnels: FakeTunnel[] = [];
  mockStartReverseTunnel.mockImplementation(async () => makeFakeTunnel(tunnels));
  const pool = new WorkerHostPool();

  await pool.openForRun("worker-1", "A", "127.0.0.1", 3000);
  const b = await pool.openForRun("worker-1", "B", "127.0.0.1", 3000);

  await pool.closeForRun("worker-1", "A");
  assert.equal(vi.mocked(tunnels[0]!.handle.close).mock.calls.length, 0);

  const resumedB = await pool.openForRun("worker-1", "B", "127.0.0.1", 3000);
  assert.equal(resumedB.remotePort, b.remotePort);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);

  await pool.closeForRun("worker-1", "B");
  assert.equal(vi.mocked(tunnels[0]!.handle.close).mock.calls.length, 1);
});

test("different worker hosts get distinct logical tunnels in separate port namespaces", async () => {
  const tunnels: FakeTunnel[] = [];
  mockStartReverseTunnel.mockImplementation(async () => makeFakeTunnel(tunnels));
  const pool = new WorkerHostPool();

  const a = await pool.openForRun("worker-1", "R", "127.0.0.1", 3000);
  const b = await pool.openForRun("worker-2", "R", "127.0.0.1", 3000);

  assert.equal(a.remotePort, 46_000);
  assert.equal(b.remotePort, 46_000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);
});

test("different issues at slot zero share the same host tunnel", async () => {
  const tunnels: FakeTunnel[] = [];
  mockStartReverseTunnel.mockImplementation(async () => makeFakeTunnel(tunnels));
  const pool = new WorkerHostPool();

  const a = await pool.openForRun("worker-1", "issue-a#0", "127.0.0.1", 3000);
  const b = await pool.openForRun("worker-1", "issue-b#0", "127.0.0.1", 3000);

  assert.equal(a.remotePort, b.remotePort);
  assert.notEqual(a.leaseId, b.leaseId);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);

  await pool.closeForRun("worker-1", "issue-a#0");
  assert.equal(vi.mocked(tunnels[0]!.handle.close).mock.calls.length, 0);
  await pool.closeForRun("worker-1", "issue-b#0");
  assert.equal(vi.mocked(tunnels[0]!.handle.close).mock.calls.length, 1);
});

test("per-run and whole-endpoint leases share one host endpoint tunnel", async () => {
  const tunnels: FakeTunnel[] = [];
  mockStartReverseTunnel.mockImplementation(async () => makeFakeTunnel(tunnels));
  const pool = new WorkerHostPool();

  const host = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  const run = await pool.openForRun("worker-1", "R", "127.0.0.1", 3000);

  assert.equal(host.remotePort, run.remotePort);
  assert.equal(host.remotePort, 46_000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
});

test("closeForRun is a no-op for unknown run keys", async () => {
  const pool = new WorkerHostPool();

  await pool.closeForRun("worker-1", "missing");
  await pool.closeForRun("", "");
});

test("a stale close cannot tear down a fresh tunnel generation", async () => {
  const tunnels: FakeTunnel[] = [];
  mockStartReverseTunnel.mockImplementation(async () => makeFakeTunnel(tunnels));
  const pool = new WorkerHostPool();

  const a = await pool.openForRun("worker-1", "A", "127.0.0.1", 3000);
  assert.equal(a.remotePort, 46_000);

  tunnels[0]!.end();
  await settle(0);

  await pool.openForRun("worker-1", "B", "127.0.0.1", 3000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);

  await pool.closeForRun("worker-1", "A");
  assert.equal(vi.mocked(tunnels[1]!.handle.close).mock.calls.length, 0);

  await pool.closeForRun("worker-1", "B");
  assert.equal(vi.mocked(tunnels[1]!.handle.close).mock.calls.length, 1);
});
