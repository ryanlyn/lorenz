import EventEmitter from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { beforeEach, test, vi } from "vitest";
import { startReverseTunnel } from "@symphony/ssh";

import { assert } from "../../../test/assert.js";

import { WorkerHostPool } from "@symphony/worker-host-pool";

vi.mock("@symphony/ssh", () => ({
  startReverseTunnel: vi.fn(),
}));

const mockStartReverseTunnel = vi.mocked(startReverseTunnel);

function makeFakeProcess(): ChildProcessWithoutNullStreams {
  const emitter = new EventEmitter();
  (emitter as unknown as Record<string, unknown>).kill = vi.fn();
  (emitter as unknown as Record<string, unknown>).pid = 12345;
  return emitter as unknown as ChildProcessWithoutNullStreams;
}

beforeEach(() => {
  mockStartReverseTunnel.mockReset();
});

function setupMock(): void {
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess());
}

test("WorkerHostPool starts empty with no leases", () => {
  const pool = new WorkerHostPool();
  // Releasing a non-existent host should be a no-op (no error thrown)
  pool.releaseRemoteMcpTunnel("nonexistent-host");
});

test("acquireRemoteMcpTunnel creates a new MCP tunnel lease for a session", () => {
  setupMock();
  const pool = new WorkerHostPool();

  const lease = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);

  assert.equal(lease.workerHost, "worker-1");
  assert.equal(typeof lease.remotePort, "number");
  assert.ok(lease.remotePort >= 46_000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
  assert.equal(mockStartReverseTunnel.mock.calls[0]![0], "worker-1");
  assert.equal(mockStartReverseTunnel.mock.calls[0]![1], lease.remotePort);
  assert.equal(mockStartReverseTunnel.mock.calls[0]![2], "127.0.0.1");
  assert.equal(mockStartReverseTunnel.mock.calls[0]![3], 3000);
});

test("acquireRemoteMcpTunnel reuses existing tunnel for same worker host", () => {
  setupMock();
  const pool = new WorkerHostPool();

  const lease1 = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  const lease2 = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);

  assert.equal(lease1.remotePort, lease2.remotePort);
  assert.equal(lease1.workerHost, lease2.workerHost);
  // Only one tunnel process should have been started
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
});

test("releaseRemoteMcpTunnel removes lease and decrements count", () => {
  setupMock();
  const pool = new WorkerHostPool();

  // Acquire twice to get refCount=2
  pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);

  // First release decrements refCount from 2 to 1 (tunnel stays alive)
  pool.releaseRemoteMcpTunnel("worker-1");

  // Tunnel should still be reusable
  const lease3 = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  // Still only 1 tunnel process started
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
  assert.ok(lease3.remotePort >= 46_000);

  // Release twice more to fully close
  pool.releaseRemoteMcpTunnel("worker-1");
  pool.releaseRemoteMcpTunnel("worker-1");

  // Now acquiring should start a new tunnel
  pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);
});

test("releaseRemoteMcpTunnel is idempotent (no-op for unknown session)", () => {
  const pool = new WorkerHostPool();

  // Should not throw for any unknown host
  pool.releaseRemoteMcpTunnel("unknown-host-1");
  pool.releaseRemoteMcpTunnel("unknown-host-2");
  pool.releaseRemoteMcpTunnel("");
});

test("selectHost picks least-loaded host from pool via port allocation", () => {
  setupMock();
  const pool = new WorkerHostPool();

  // Acquire tunnels for multiple hosts — each gets a unique port
  const lease1 = pool.acquireRemoteMcpTunnel("worker-a", "127.0.0.1", 3000);
  const lease2 = pool.acquireRemoteMcpTunnel("worker-b", "127.0.0.1", 3000);
  const lease3 = pool.acquireRemoteMcpTunnel("worker-c", "127.0.0.1", 3000);

  // Ports should be allocated sequentially
  assert.equal(lease1.remotePort, 46_000);
  assert.equal(lease2.remotePort, 46_001);
  assert.equal(lease3.remotePort, 46_002);

  // All different hosts
  assert.equal(lease1.workerHost, "worker-a");
  assert.equal(lease2.workerHost, "worker-b");
  assert.equal(lease3.workerHost, "worker-c");
});

test("selectHost returns sole host when pool has one entry", () => {
  setupMock();
  const pool = new WorkerHostPool();

  const lease = pool.acquireRemoteMcpTunnel("only-host", "localhost", 8080);

  assert.equal(lease.workerHost, "only-host");
  assert.equal(lease.remotePort, 46_000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
});

test("acquireRemoteMcpTunnel replaces tunnel when local endpoint changes", () => {
  const processes: Array<{ kill: ReturnType<typeof vi.fn>; emitter: EventEmitter }> = [];
  mockStartReverseTunnel.mockImplementation(() => {
    const emitter = new EventEmitter();
    const kill = vi.fn();
    (emitter as unknown as Record<string, unknown>).kill = kill;
    (emitter as unknown as Record<string, unknown>).pid = 12345;
    processes.push({ kill, emitter });
    return emitter as unknown as ChildProcessWithoutNullStreams;
  });

  const pool = new WorkerHostPool();

  // First tunnel on port 3000
  const lease1 = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);

  // Acquire same host but different local port — should replace
  const lease2 = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 4000);

  // Old tunnel process should have been killed
  assert.equal(processes[0]!.kill.mock.calls.length, 1);
  // Two tunnel processes created total
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);
  // Port recycled — new lease gets the same remote port
  assert.equal(lease2.remotePort, lease1.remotePort);
});

test("port recycling returns freed ports in sorted order", () => {
  setupMock();
  const pool = new WorkerHostPool();

  // Acquire three hosts
  const lease1 = pool.acquireRemoteMcpTunnel("host-a", "127.0.0.1", 3000);
  const lease2 = pool.acquireRemoteMcpTunnel("host-b", "127.0.0.1", 3000);
  pool.acquireRemoteMcpTunnel("host-c", "127.0.0.1", 3000);

  assert.equal(lease1.remotePort, 46_000);
  assert.equal(lease2.remotePort, 46_001);

  // Release host-b (port 46001) then host-a (port 46000)
  pool.releaseRemoteMcpTunnel("host-b");
  pool.releaseRemoteMcpTunnel("host-a");

  // Next acquire should reuse 46000 (lowest available recycled port)
  const lease4 = pool.acquireRemoteMcpTunnel("host-d", "127.0.0.1", 3000);
  assert.equal(lease4.remotePort, 46_000);

  // Then 46001
  const lease5 = pool.acquireRemoteMcpTunnel("host-e", "127.0.0.1", 3000);
  assert.equal(lease5.remotePort, 46_001);
});

test("concurrent acquire/release maintains consistent count", async () => {
  setupMock();
  const pool = new WorkerHostPool();

  // Simulate concurrent acquire operations for the same host
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      Promise.resolve().then(() => pool.acquireRemoteMcpTunnel(`worker-${i}`, "127.0.0.1", 3000)),
    ),
  );

  // Each should get a unique port
  const ports = results.map((r) => r.remotePort);
  const uniquePorts = new Set(ports);
  assert.equal(uniquePorts.size, 10);

  // Release all
  await Promise.all(
    results.map((r) => Promise.resolve().then(() => pool.releaseRemoteMcpTunnel(r.workerHost))),
  );

  // All ports recycled — next acquire should get lowest recycled port
  const newLease = pool.acquireRemoteMcpTunnel("new-worker", "127.0.0.1", 3000);
  assert.equal(newLease.remotePort, 46_000);
});

test("tunnel close event triggers cleanup and port recycling", () => {
  let fakeProcess: EventEmitter & { kill: ReturnType<typeof vi.fn> };
  mockStartReverseTunnel.mockImplementation(() => {
    fakeProcess = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    fakeProcess.kill = vi.fn();
    (fakeProcess as unknown as Record<string, unknown>).pid = 99;
    return fakeProcess as unknown as ChildProcessWithoutNullStreams;
  });

  const pool = new WorkerHostPool();
  const lease = pool.acquireRemoteMcpTunnel("worker-x", "127.0.0.1", 5000);
  assert.equal(lease.remotePort, 46_000);

  // Simulate process closing unexpectedly
  fakeProcess!.emit("close");

  // After close, acquiring should create a new tunnel with recycled port
  const lease2 = pool.acquireRemoteMcpTunnel("worker-x", "127.0.0.1", 5000);
  assert.equal(lease2.remotePort, 46_000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);
});
