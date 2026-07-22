import EventEmitter from "node:events";

import { beforeEach, test, vi } from "vitest";
import { registerDiagnosticSecret } from "@lorenz/domain";
import { startReverseTunnel, waitForRemoteTcpPort } from "@lorenz/ssh";
import type { ReverseTunnelProcess } from "@lorenz/ssh";
import { assert } from "@lorenz/test-utils";

import { WorkerHostPool } from "@lorenz/worker-host-pool";

vi.mock("@lorenz/ssh", () => ({
  startReverseTunnel: vi.fn(),
  waitForRemoteTcpPort: vi.fn(),
}));

const mockStartReverseTunnel = vi.mocked(startReverseTunnel);
const mockWaitForRemoteTcpPort = vi.mocked(waitForRemoteTcpPort);

function makeFakeProcess(): ReverseTunnelProcess {
  const emitter = new EventEmitter();
  (emitter as unknown as Record<string, unknown>).kill = vi.fn();
  (emitter as unknown as Record<string, unknown>).pid = 12345;
  (emitter as unknown as Record<string, unknown>).readStderrTail = vi.fn(() => "");
  (emitter as unknown as Record<string, unknown>).waitForStderr = vi.fn(async () => {});
  return emitter as unknown as ReverseTunnelProcess;
}

beforeEach(() => {
  mockStartReverseTunnel.mockReset();
  mockWaitForRemoteTcpPort.mockReset();
  mockWaitForRemoteTcpPort.mockResolvedValue(undefined);
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
    const emitter = makeFakeProcess() as ReverseTunnelProcess & EventEmitter;
    const kill = vi.fn();
    (emitter as unknown as Record<string, unknown>).kill = kill;
    processes.push({ kill, emitter });
    return emitter;
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

test("acquireRemoteMcpTunnel creates a new MCP tunnel lease for a session", async () => {
  setupMock();
  const pool = new WorkerHostPool();

  const lease = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);

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

test("acquireRemoteMcpTunnel rejects when reverse tunnel closes before readiness", async () => {
  const fakeProcess = makeFakeProcess() as ReverseTunnelProcess & EventEmitter;
  mockStartReverseTunnel.mockReturnValue(fakeProcess);
  vi.mocked(fakeProcess.readStderrTail).mockReturnValue("Host key verification failed.");
  mockWaitForRemoteTcpPort.mockImplementation(() => new Promise(() => {}));
  const pool = new WorkerHostPool();

  const acquisition = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  fakeProcess.emit("close", 255, null);

  await assert.rejects(
    () => acquisition,
    /remote_mcp_tunnel_setup_failed: worker-1 46000 reason="reverse_tunnel_closed: 255 null" stderr_tail="Host key verification failed\."/,
  );

  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess());
  mockWaitForRemoteTcpPort.mockResolvedValue(undefined);
  const nextLease = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  assert.equal(nextLease.remotePort, 46_000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);
});

test("acquireRemoteMcpTunnel waits for close before reporting stderr written after exit", async () => {
  const fakeProcess = makeFakeProcess() as ReverseTunnelProcess & EventEmitter;
  let stderrTail = "";
  mockStartReverseTunnel.mockReturnValue(fakeProcess);
  vi.mocked(fakeProcess.readStderrTail).mockImplementation(() => stderrTail);
  mockWaitForRemoteTcpPort.mockImplementation(() => new Promise(() => {}));
  const pool = new WorkerHostPool();

  let settled = false;
  const acquisition = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000).finally(() => {
    settled = true;
  });

  fakeProcess.emit("exit", 255, null);
  await Promise.resolve();
  assert.equal(settled, false);

  stderrTail = "late host-key diagnostic";
  fakeProcess.emit("close", 255, null);

  await assert.rejects(
    () => acquisition,
    /reason="reverse_tunnel_closed: 255 null" stderr_tail="late host-key diagnostic"/,
  );
});

test("acquireRemoteMcpTunnel bounds stderr draining when exit races with readiness", async () => {
  const fakeProcess = makeFakeProcess() as ReverseTunnelProcess & EventEmitter;
  const ready = deferred<void>();
  const stderrClosed = deferred<void>();
  let stderrTail = "";
  mockStartReverseTunnel.mockReturnValue(fakeProcess);
  vi.mocked(fakeProcess.readStderrTail).mockImplementation(() => stderrTail);
  mockWaitForRemoteTcpPort.mockReturnValue(ready.promise);
  vi.mocked(fakeProcess.waitForStderr).mockReturnValue(stderrClosed.promise);
  const pool = new WorkerHostPool();

  let settled = false;
  const acquisition = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000).finally(() => {
    settled = true;
  });

  fakeProcess.emit("exit", 255, null);
  ready.resolve();
  await vi.waitFor(() => {
    assert.equal(vi.mocked(fakeProcess.waitForStderr).mock.calls.length, 1);
  });
  assert.equal(settled, false);

  stderrTail = "delayed authentication diagnostic";
  stderrClosed.resolve();

  await assert.rejects(
    () => acquisition,
    /reason="reverse_tunnel_process_ended" stderr_tail="delayed authentication diagnostic"/,
  );
});

test("acquireRemoteMcpTunnel redacts secrets from operator diagnostics", async () => {
  const fakeProcess = makeFakeProcess() as ReverseTunnelProcess & EventEmitter;
  const secret = "mono-471-tunnel-secret";
  registerDiagnosticSecret(secret);
  mockStartReverseTunnel.mockReturnValue(fakeProcess);
  vi.mocked(fakeProcess.readStderrTail).mockReturnValue(`token=${secret}`);
  mockWaitForRemoteTcpPort.mockImplementation(() => new Promise(() => {}));
  const pool = new WorkerHostPool();

  const acquisition = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  fakeProcess.emit("close", 255, null);

  await assert.rejects(
    () => acquisition,
    (error: Error) =>
      !error.message.includes(secret) && error.message.includes("[REDACTED]"),
  );
});

test("acquireRemoteMcpTunnel rejects when reverse tunnel errors before readiness", async () => {
  const fakeProcess = makeFakeProcess() as ReverseTunnelProcess & EventEmitter;
  mockStartReverseTunnel.mockReturnValue(fakeProcess);
  mockWaitForRemoteTcpPort.mockImplementation(() => new Promise(() => {}));
  const pool = new WorkerHostPool();

  const acquisition = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  fakeProcess.emit("error", new Error("auth rejected"));

  await assert.rejects(() => acquisition, /remote_mcp_tunnel_setup_failed/);

  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess());
  mockWaitForRemoteTcpPort.mockResolvedValue(undefined);
  const nextLease = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  assert.equal(nextLease.remotePort, 46_000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);
});

test("acquireRemoteMcpTunnel waits for reverse tunnel readiness before returning lease", async () => {
  setupMock();
  const ready = deferred<void>();
  mockWaitForRemoteTcpPort.mockReturnValue(ready.promise);
  const pool = new WorkerHostPool();

  let returned = false;
  const acquisition = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000).then((lease) => {
    returned = true;
    return lease;
  });
  await Promise.resolve();

  assert.equal(returned, false);

  ready.resolve();
  const lease = await acquisition;
  assert.equal(returned, true);
  assert.equal(lease.remotePort, 46_000);
});

test("acquireRemoteMcpTunnel kills pending tunnel when readiness probe fails", async () => {
  const processes = setupProcessTrackingMock();
  mockWaitForRemoteTcpPort.mockRejectedValue(new Error("probe failed"));
  const pool = new WorkerHostPool();

  await assert.rejects(
    () => pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000),
    /remote_mcp_tunnel_setup_failed/,
  );

  assert.equal(processes[0]!.kill.mock.calls.length, 1);
});

test("acquireRemoteMcpTunnel reuses existing tunnel for same worker host and endpoint", async () => {
  setupMock();
  const pool = new WorkerHostPool();

  const lease1 = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  const lease2 = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);

  assert.equal(lease1.remotePort, lease2.remotePort);
  assert.notEqual(lease1.leaseId, lease2.leaseId);
  assert.equal(lease1.workerHost, lease2.workerHost);
  // Only one tunnel process should have been started
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
});

test("releaseRemoteMcpTunnel keeps shared endpoint tunnel alive until final lease release", async () => {
  setupMock();
  const pool = new WorkerHostPool();

  const lease1 = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  const lease2 = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);

  pool.releaseRemoteMcpTunnel(lease1);

  // Tunnel should still be reusable
  const lease3 = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  // Still only 1 tunnel process started
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
  assert.ok(lease3.remotePort >= 46_000);

  // Release twice more to fully close
  pool.releaseRemoteMcpTunnel(lease2);
  pool.releaseRemoteMcpTunnel(lease3);

  // Now acquiring should start a new tunnel
  await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
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

test("acquireRemoteMcpTunnel allocates sequential ports for different worker hosts", async () => {
  setupMock();
  const pool = new WorkerHostPool();

  // Acquire tunnels for multiple hosts — each gets a unique port
  const lease1 = await pool.acquireRemoteMcpTunnel("worker-a", "127.0.0.1", 3000);
  const lease2 = await pool.acquireRemoteMcpTunnel("worker-b", "127.0.0.1", 3000);
  const lease3 = await pool.acquireRemoteMcpTunnel("worker-c", "127.0.0.1", 3000);

  // Ports should be allocated sequentially
  assert.equal(lease1.remotePort, 46_000);
  assert.equal(lease2.remotePort, 46_001);
  assert.equal(lease3.remotePort, 46_002);

  // All different hosts
  assert.equal(lease1.workerHost, "worker-a");
  assert.equal(lease2.workerHost, "worker-b");
  assert.equal(lease3.workerHost, "worker-c");
});

test("acquireRemoteMcpTunnel works correctly with a single worker host", async () => {
  setupMock();
  const pool = new WorkerHostPool();

  const lease = await pool.acquireRemoteMcpTunnel("only-host", "localhost", 8080);

  assert.equal(lease.workerHost, "only-host");
  assert.equal(lease.remotePort, 46_000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
});

test("acquireRemoteMcpTunnel starts another tunnel when local endpoint changes", async () => {
  const processes = setupProcessTrackingMock();
  const pool = new WorkerHostPool();

  // First tunnel on port 3000
  const lease1 = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);

  // Acquire same host but different local port, which should coexist.
  const lease2 = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 4000);

  // Old tunnel process should remain alive until its lease is released.
  assert.equal(processes[0]!.kill.mock.calls.length, 0);
  // Two tunnel processes created total
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);
  // New endpoint gets its own remote port while the previous lease is active.
  assert.notEqual(lease2.remotePort, lease1.remotePort);
});

test("acquireRemoteMcpTunnel keeps different local endpoints isolated until lease release", async () => {
  const processes = setupProcessTrackingMock();
  const pool = new WorkerHostPool();

  const firstLease = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  const secondLease = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 4000);

  assert.notEqual(secondLease.remotePort, firstLease.remotePort);
  assert.equal(processes[0]!.kill.mock.calls.length, 0);

  pool.releaseRemoteMcpTunnel(firstLease);

  assert.equal(processes[0]!.kill.mock.calls.length, 1);
  assert.equal(processes[1]!.kill.mock.calls.length, 0);

  const sharedSecondLease = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 4000);
  assert.equal(sharedSecondLease.remotePort, secondLease.remotePort);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);

  pool.releaseRemoteMcpTunnel(secondLease);
  assert.equal(processes[1]!.kill.mock.calls.length, 0);

  pool.releaseRemoteMcpTunnel(sharedSecondLease);
  assert.equal(processes[1]!.kill.mock.calls.length, 1);
});

test("port recycling returns freed ports in sorted order", async () => {
  const processes = setupProcessTrackingMock();
  const pool = new WorkerHostPool();

  // Acquire three hosts
  const lease1 = await pool.acquireRemoteMcpTunnel("host-a", "127.0.0.1", 3000);
  const lease2 = await pool.acquireRemoteMcpTunnel("host-b", "127.0.0.1", 3000);
  await pool.acquireRemoteMcpTunnel("host-c", "127.0.0.1", 3000);

  assert.equal(lease1.remotePort, 46_000);
  assert.equal(lease2.remotePort, 46_001);

  // Release host-b (port 46001) then host-a (port 46000)
  pool.releaseRemoteMcpTunnel(lease2);
  processes[1]!.emitter.emit("close");
  pool.releaseRemoteMcpTunnel(lease1);
  processes[0]!.emitter.emit("close");

  // Next acquire should reuse 46000 (lowest available recycled port)
  const lease4 = await pool.acquireRemoteMcpTunnel("host-d", "127.0.0.1", 3000);
  assert.equal(lease4.remotePort, 46_000);

  // Then 46001
  const lease5 = await pool.acquireRemoteMcpTunnel("host-e", "127.0.0.1", 3000);
  assert.equal(lease5.remotePort, 46_001);
});

test("releaseRemoteMcpTunnel waits for process close before recycling the remote port", async () => {
  const processes = setupProcessTrackingMock();
  const pool = new WorkerHostPool();

  const firstLease = await pool.acquireRemoteMcpTunnel("host-a", "127.0.0.1", 3000);
  assert.equal(firstLease.remotePort, 46_000);

  pool.releaseRemoteMcpTunnel(firstLease);

  assert.equal(processes[0]!.kill.mock.calls.length, 1);

  const secondLease = await pool.acquireRemoteMcpTunnel("host-b", "127.0.0.1", 3000);
  assert.equal(secondLease.remotePort, 46_001);

  processes[0]!.emitter.emit("close");

  const thirdLease = await pool.acquireRemoteMcpTunnel("host-c", "127.0.0.1", 3000);
  assert.equal(thirdLease.remotePort, 46_000);
});

test("rapid concurrent acquire/release of many workers maintains consistent port allocation", async () => {
  const processes = setupProcessTrackingMock();
  const pool = new WorkerHostPool();

  // Acquire 10 different workers concurrently.
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      pool.acquireRemoteMcpTunnel(`worker-${i}`, "127.0.0.1", 3000),
    ),
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
  const newLease = await pool.acquireRemoteMcpTunnel("new-worker", "127.0.0.1", 3000);
  assert.equal(newLease.remotePort, 46_000);

  // Verify a second acquire gets the next recycled port (46001), not a fresh one
  const newLease2 = await pool.acquireRemoteMcpTunnel("new-worker-2", "127.0.0.1", 3000);
  assert.equal(newLease2.remotePort, 46_001);
});

test("tunnel close event triggers cleanup and port recycling", async () => {
  let fakeProcess: ReverseTunnelProcess & EventEmitter & { kill: ReturnType<typeof vi.fn> };
  mockStartReverseTunnel.mockImplementation(() => {
    fakeProcess = makeFakeProcess() as ReverseTunnelProcess &
      EventEmitter & { kill: ReturnType<typeof vi.fn> };
    fakeProcess.kill = vi.fn();
    (fakeProcess as unknown as Record<string, unknown>).pid = 99;
    return fakeProcess;
  });

  const pool = new WorkerHostPool();
  const lease = await pool.acquireRemoteMcpTunnel("worker-x", "127.0.0.1", 5000);
  assert.equal(lease.remotePort, 46_000);

  // Simulate process closing unexpectedly
  fakeProcess!.emit("close");

  // After close, acquiring should create a new tunnel with recycled port
  const lease2 = await pool.acquireRemoteMcpTunnel("worker-x", "127.0.0.1", 5000);
  assert.equal(lease2.remotePort, 46_000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
