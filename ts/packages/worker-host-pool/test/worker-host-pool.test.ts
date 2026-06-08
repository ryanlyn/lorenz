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

function setupProcessTrackingMock(): Array<{
  kill: ReturnType<typeof vi.fn>;
  emitter: EventEmitter;
}> {
  const processes: Array<{ kill: ReturnType<typeof vi.fn>; emitter: EventEmitter }> = [];
  mockStartReverseTunnel.mockImplementation(() => {
    const emitter = new EventEmitter();
    const kill = vi.fn();
    (emitter as unknown as Record<string, unknown>).kill = kill;
    (emitter as unknown as Record<string, unknown>).pid = 12345;
    processes.push({ kill, emitter });
    return emitter as unknown as ChildProcessWithoutNullStreams;
  });
  return processes;
}

test("WorkerHostPool starts empty with no leases", () => {
  const pool = new WorkerHostPool();
  // Releasing a non-existent host should be a no-op (no error thrown)
  pool.releaseRemoteMcpTunnel({
    leaseId: "missing",
    workerHost: "nonexistent-host",
    remotePort: 46_000,
  });
});

test("acquireRemoteMcpTunnel creates a new MCP tunnel lease for a session", () => {
  setupMock();
  const pool = new WorkerHostPool();

  const lease = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);

  assert.equal(lease.workerHost, "worker-1");
  assert.equal(typeof lease.leaseId, "string");
  assert.equal(typeof lease.remotePort, "number");
  assert.ok(lease.remotePort >= 46_000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
  assert.equal(mockStartReverseTunnel.mock.calls[0]![0], "worker-1");
  assert.equal(mockStartReverseTunnel.mock.calls[0]![1], lease.remotePort);
  assert.equal(mockStartReverseTunnel.mock.calls[0]![2], "127.0.0.1");
  assert.equal(mockStartReverseTunnel.mock.calls[0]![3], 3000);
});

test("acquireRemoteMcpTunnel reuses existing tunnel for same worker host and endpoint", () => {
  setupMock();
  const pool = new WorkerHostPool();

  const lease1 = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  const lease2 = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);

  assert.equal(lease1.remotePort, lease2.remotePort);
  assert.notEqual(lease1.leaseId, lease2.leaseId);
  assert.equal(lease1.workerHost, lease2.workerHost);
  // Only one tunnel process should have been started
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
});

test("releaseRemoteMcpTunnel keeps shared endpoint tunnel alive until final lease release", () => {
  setupMock();
  const pool = new WorkerHostPool();

  const lease1 = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  const lease2 = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);

  pool.releaseRemoteMcpTunnel(lease1);

  // Tunnel should still be reusable
  const lease3 = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  // Still only 1 tunnel process started
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
  assert.ok(lease3.remotePort >= 46_000);

  // Release twice more to fully close
  pool.releaseRemoteMcpTunnel(lease2);
  pool.releaseRemoteMcpTunnel(lease3);

  // Now acquiring should start a new tunnel
  pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);
});

test("releaseRemoteMcpTunnel is idempotent (no-op for unknown session)", () => {
  const pool = new WorkerHostPool();

  // Should not throw for any unknown host
  pool.releaseRemoteMcpTunnel({
    leaseId: "unknown-1",
    workerHost: "unknown-host-1",
    remotePort: 46_000,
  });
  pool.releaseRemoteMcpTunnel({
    leaseId: "unknown-2",
    workerHost: "unknown-host-2",
    remotePort: 46_001,
  });
  pool.releaseRemoteMcpTunnel({ leaseId: "", workerHost: "", remotePort: 0 });
});

test("acquireRemoteMcpTunnel allocates sequential ports for different worker hosts", () => {
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

test("acquireRemoteMcpTunnel works correctly with a single worker host", () => {
  setupMock();
  const pool = new WorkerHostPool();

  const lease = pool.acquireRemoteMcpTunnel("only-host", "localhost", 8080);

  assert.equal(lease.workerHost, "only-host");
  assert.equal(lease.remotePort, 46_000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
});

test("acquireRemoteMcpTunnel starts another tunnel when local endpoint changes", () => {
  const processes = setupProcessTrackingMock();
  const pool = new WorkerHostPool();

  // First tunnel on port 3000
  const lease1 = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);

  // Acquire same host but different local port, which should coexist.
  const lease2 = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 4000);

  // Old tunnel process should remain alive until its lease is released.
  assert.equal(processes[0]!.kill.mock.calls.length, 0);
  // Two tunnel processes created total
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);
  // New endpoint gets its own remote port while the previous lease is active.
  assert.notEqual(lease2.remotePort, lease1.remotePort);
});

test("acquireRemoteMcpTunnel keeps different local endpoints isolated until lease release", () => {
  const processes = setupProcessTrackingMock();
  const pool = new WorkerHostPool();

  const firstLease = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  const secondLease = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 4000);

  assert.notEqual(secondLease.remotePort, firstLease.remotePort);
  assert.equal(processes[0]!.kill.mock.calls.length, 0);

  pool.releaseRemoteMcpTunnel(firstLease);

  assert.equal(processes[0]!.kill.mock.calls.length, 1);
  assert.equal(processes[1]!.kill.mock.calls.length, 0);

  const sharedSecondLease = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 4000);
  assert.equal(sharedSecondLease.remotePort, secondLease.remotePort);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);

  pool.releaseRemoteMcpTunnel(secondLease);
  assert.equal(processes[1]!.kill.mock.calls.length, 0);

  pool.releaseRemoteMcpTunnel(sharedSecondLease);
  assert.equal(processes[1]!.kill.mock.calls.length, 1);
});

test("port recycling returns freed ports in sorted order", () => {
  const processes = setupProcessTrackingMock();
  const pool = new WorkerHostPool();

  // Acquire three hosts
  const lease1 = pool.acquireRemoteMcpTunnel("host-a", "127.0.0.1", 3000);
  const lease2 = pool.acquireRemoteMcpTunnel("host-b", "127.0.0.1", 3000);
  pool.acquireRemoteMcpTunnel("host-c", "127.0.0.1", 3000);

  assert.equal(lease1.remotePort, 46_000);
  assert.equal(lease2.remotePort, 46_001);

  // Release host-b (port 46001) then host-a (port 46000)
  pool.releaseRemoteMcpTunnel(lease2);
  processes[1]!.emitter.emit("close");
  pool.releaseRemoteMcpTunnel(lease1);
  processes[0]!.emitter.emit("close");

  // Next acquire should reuse 46000 (lowest available recycled port)
  const lease4 = pool.acquireRemoteMcpTunnel("host-d", "127.0.0.1", 3000);
  assert.equal(lease4.remotePort, 46_000);

  // Then 46001
  const lease5 = pool.acquireRemoteMcpTunnel("host-e", "127.0.0.1", 3000);
  assert.equal(lease5.remotePort, 46_001);
});

test("releaseRemoteMcpTunnel waits for process close before recycling the remote port", () => {
  const processes = setupProcessTrackingMock();
  const pool = new WorkerHostPool();

  const firstLease = pool.acquireRemoteMcpTunnel("host-a", "127.0.0.1", 3000);
  assert.equal(firstLease.remotePort, 46_000);

  pool.releaseRemoteMcpTunnel(firstLease);

  assert.equal(processes[0]!.kill.mock.calls.length, 1);

  const secondLease = pool.acquireRemoteMcpTunnel("host-b", "127.0.0.1", 3000);
  assert.equal(secondLease.remotePort, 46_001);

  processes[0]!.emitter.emit("close");

  const thirdLease = pool.acquireRemoteMcpTunnel("host-c", "127.0.0.1", 3000);
  assert.equal(thirdLease.remotePort, 46_000);
});

test("rapid sequential acquire/release of many workers maintains consistent port allocation", () => {
  const processes = setupProcessTrackingMock();
  const pool = new WorkerHostPool();

  // Acquire 10 different workers in quick succession
  const results = Array.from({ length: 10 }, (_, i) =>
    pool.acquireRemoteMcpTunnel(`worker-${i}`, "127.0.0.1", 3000),
  );

  // Each should get a unique, sequentially-allocated port
  const ports = results.map((r) => r.remotePort);
  const uniquePorts = new Set(ports);
  assert.equal(uniquePorts.size, 10);
  for (let i = 0; i < 10; i++) {
    assert.equal(results[i]!.remotePort, 46_000 + i);
    assert.equal(results[i]!.workerHost, `worker-${i}`);
  }

  // Release all workers and let the fake child processes finish.
  for (const [index, r] of results.entries()) {
    pool.releaseRemoteMcpTunnel(r);
    processes[index]!.emitter.emit("close");
  }

  // All ports recycled — next acquire should get lowest recycled port
  const newLease = pool.acquireRemoteMcpTunnel("new-worker", "127.0.0.1", 3000);
  assert.equal(newLease.remotePort, 46_000);

  // Verify a second acquire gets the next recycled port (46001), not a fresh one
  const newLease2 = pool.acquireRemoteMcpTunnel("new-worker-2", "127.0.0.1", 3000);
  assert.equal(newLease2.remotePort, 46_001);
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
