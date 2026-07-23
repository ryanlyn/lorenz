import { beforeEach, test, vi } from "vitest";
import {
  startReverseTunnel,
  waitForRemoteTcpPortClosed,
  type ReverseTunnelHandle,
} from "@lorenz/ssh";
import { assert, settle } from "@lorenz/test-utils";

import { WorkerHostPool } from "@lorenz/worker-host-pool";

vi.mock("@lorenz/ssh", () => ({
  startReverseTunnel: vi.fn(),
  waitForRemoteTcpPortClosed: vi.fn(),
}));

const mockStartReverseTunnel = vi.mocked(startReverseTunnel);
const mockWaitForRemoteTcpPortClosed = vi.mocked(waitForRemoteTcpPortClosed);

interface FakeTunnel {
  handle: ReverseTunnelHandle;
  end(): void;
}

interface FakeTunnelOptions {
  check?: (() => Promise<void>) | undefined;
  close?: (() => Promise<void>) | undefined;
}

function makeFakeTunnel(options: FakeTunnelOptions = {}): FakeTunnel {
  const ended = deferred<void>();
  const check = vi.fn(options.check ?? (async () => {}));
  const close = vi.fn(async () => {
    await options.close?.();
    ended.resolve();
  });
  return {
    handle: {
      ended: ended.promise,
      check,
      close,
    },
    end: () => ended.resolve(),
  };
}

function setupTunnelTracking(
  optionsForIndex: (index: number) => FakeTunnelOptions = () => ({}),
): FakeTunnel[] {
  const tunnels: FakeTunnel[] = [];
  mockStartReverseTunnel.mockImplementation(async () => {
    const tunnel = makeFakeTunnel(optionsForIndex(tunnels.length));
    tunnels.push(tunnel);
    return tunnel.handle;
  });
  return tunnels;
}

beforeEach(() => {
  mockStartReverseTunnel.mockReset();
  mockWaitForRemoteTcpPortClosed.mockReset();
  mockWaitForRemoteTcpPortClosed.mockResolvedValue();
});

test("WorkerHostPool starts empty with no leases", async () => {
  const pool = new WorkerHostPool();

  await pool.releaseRemoteMcpTunnel({
    leaseId: "missing",
    workerHost: "nonexistent-host",
    remotePort: 46_000,
  });
});

test("acquireRemoteMcpTunnel creates and checks a logical tunnel", async () => {
  const tunnels = setupTunnelTracking();
  const pool = new WorkerHostPool();

  const lease = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);

  assert.equal(lease.workerHost, "worker-1");
  assert.equal(typeof lease.leaseId, "string");
  assert.equal(lease.remotePort, 46_000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
  assert.deepEqual(mockStartReverseTunnel.mock.calls[0], ["worker-1", 46_000, "127.0.0.1", 3000]);
  assert.equal(vi.mocked(tunnels[0]!.handle.check).mock.calls.length, 1);
});

test("acquireRemoteMcpTunnel waits for the logical tunnel readiness check", async () => {
  const ready = deferred<void>();
  setupTunnelTracking(() => ({ check: async () => ready.promise }));
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

test("acquireRemoteMcpTunnel closes a tunnel whose readiness check fails", async () => {
  const tunnels = setupTunnelTracking((index) =>
    index === 0
      ? {
          check: async () => {
            throw new Error("probe failed");
          },
        }
      : {},
  );
  const pool = new WorkerHostPool();

  await assert.rejects(
    () => pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000),
    /remote_mcp_tunnel_setup_failed/,
  );

  assert.equal(vi.mocked(tunnels[0]!.handle.close).mock.calls.length, 1);

  const nextLease = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  assert.equal(nextLease.remotePort, 46_000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);
});

test("a tunnel start failure recycles its port only after proving the port is closed", async () => {
  const tunnels = setupTunnelTracking();
  mockStartReverseTunnel.mockRejectedValueOnce(new Error("ssh unavailable"));
  const pool = new WorkerHostPool();

  await assert.rejects(
    () => pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000),
    /ssh unavailable/,
  );

  const nextLease = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  assert.equal(nextLease.remotePort, 46_000);
  assert.deepEqual(mockWaitForRemoteTcpPortClosed.mock.calls, [["worker-1", 46_000]]);
  assert.deepEqual(
    mockStartReverseTunnel.mock.calls.map((call) => call[1]),
    [46_000, 46_000],
  );
  assert.equal(tunnels.length, 1);
});

test("a tunnel start failure does not recycle a port that cannot be proven closed", async () => {
  const tunnels = setupTunnelTracking();
  mockStartReverseTunnel.mockRejectedValueOnce(new Error("forward failed"));
  mockWaitForRemoteTcpPortClosed.mockRejectedValueOnce(new Error("port still open"));
  const pool = new WorkerHostPool();

  await assert.rejects(
    () => pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000),
    /forward failed/,
  );

  const nextLease = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  assert.equal(nextLease.remotePort, 46_001);
  assert.deepEqual(mockWaitForRemoteTcpPortClosed.mock.calls, [["worker-1", 46_000]]);
  assert.deepEqual(
    mockStartReverseTunnel.mock.calls.map((call) => call[1]),
    [46_000, 46_001],
  );
  assert.equal(tunnels.length, 1);
});

test("acquireRemoteMcpTunnel reuses a healthy tunnel for the same endpoint", async () => {
  const tunnels = setupTunnelTracking();
  const pool = new WorkerHostPool();

  const lease1 = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  const lease2 = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);

  assert.equal(lease1.remotePort, lease2.remotePort);
  assert.notEqual(lease1.leaseId, lease2.leaseId);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
  assert.equal(vi.mocked(tunnels[0]!.handle.check).mock.calls.length, 2);
});

test("releaseRemoteMcpTunnel closes a shared endpoint only after its final lease", async () => {
  const tunnels = setupTunnelTracking();
  const pool = new WorkerHostPool();

  const lease1 = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  const lease2 = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);

  await pool.releaseRemoteMcpTunnel(lease1);
  assert.equal(vi.mocked(tunnels[0]!.handle.close).mock.calls.length, 0);

  const lease3 = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);

  await pool.releaseRemoteMcpTunnel(lease2);
  assert.equal(vi.mocked(tunnels[0]!.handle.close).mock.calls.length, 0);
  await pool.releaseRemoteMcpTunnel(lease3);
  assert.equal(vi.mocked(tunnels[0]!.handle.close).mock.calls.length, 1);

  const nextLease = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  assert.equal(nextLease.remotePort, 46_000);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);
});

test("a concurrent acquire cannot return a lease on an entry being closed by final release", async () => {
  const reacquireCheck = deferred<void>();
  let firstTunnelChecks = 0;
  const tunnels = setupTunnelTracking((index) =>
    index === 0
      ? {
          check: async () => {
            firstTunnelChecks += 1;
            if (firstTunnelChecks === 2) await reacquireCheck.promise;
          },
        }
      : {},
  );
  const pool = new WorkerHostPool();

  const firstLease = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  const concurrentAcquire = pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  assert.equal(vi.mocked(tunnels[0]!.handle.check).mock.calls.length, 2);

  await pool.releaseRemoteMcpTunnel(firstLease);
  assert.equal(vi.mocked(tunnels[0]!.handle.close).mock.calls.length, 1);

  reacquireCheck.resolve();
  const nextLease = await concurrentAcquire;

  assert.equal(tunnels.length, 2);
  assert.notEqual(nextLease.leaseId, firstLease.leaseId);
  assert.equal(nextLease.remotePort, 46_000);
  assert.equal(vi.mocked(tunnels[1]!.handle.close).mock.calls.length, 0);

  await pool.releaseRemoteMcpTunnel(nextLease);
  assert.equal(vi.mocked(tunnels[0]!.handle.close).mock.calls.length, 1);
  assert.equal(vi.mocked(tunnels[1]!.handle.close).mock.calls.length, 1);
});

test("releaseRemoteMcpTunnel is idempotent for unknown leases", async () => {
  const pool = new WorkerHostPool();

  await pool.releaseRemoteMcpTunnel({
    leaseId: "unknown-1",
    workerHost: "unknown-host-1",
    remotePort: 46_000,
  });
  await pool.releaseRemoteMcpTunnel({
    leaseId: "unknown-2",
    workerHost: "unknown-host-2",
    remotePort: 46_001,
  });
  await pool.releaseRemoteMcpTunnel({ leaseId: "", workerHost: "", remotePort: 0 });
});

test("remote ports are namespaced per worker and remain distinct between one worker's endpoints", async () => {
  setupTunnelTracking();
  const pool = new WorkerHostPool();

  const workerAFirst = await pool.acquireRemoteMcpTunnel("worker-a", "127.0.0.1", 3000);
  const workerBFirst = await pool.acquireRemoteMcpTunnel("worker-b", "127.0.0.1", 3000);
  const workerASecond = await pool.acquireRemoteMcpTunnel("worker-a", "127.0.0.1", 4000);

  assert.equal(workerAFirst.remotePort, 46_000);
  assert.equal(workerBFirst.remotePort, 46_000);
  assert.equal(workerASecond.remotePort, 46_001);
});

test("different local endpoints keep independent logical tunnels", async () => {
  const tunnels = setupTunnelTracking();
  const pool = new WorkerHostPool();

  const firstLease = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  const secondLease = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 4000);

  assert.notEqual(secondLease.remotePort, firstLease.remotePort);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);

  await pool.releaseRemoteMcpTunnel(firstLease);
  assert.equal(vi.mocked(tunnels[0]!.handle.close).mock.calls.length, 1);
  assert.equal(vi.mocked(tunnels[1]!.handle.close).mock.calls.length, 0);

  const sharedSecondLease = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 4000);
  assert.equal(sharedSecondLease.remotePort, secondLease.remotePort);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);

  await pool.releaseRemoteMcpTunnel(secondLease);
  assert.equal(vi.mocked(tunnels[1]!.handle.close).mock.calls.length, 0);
  await pool.releaseRemoteMcpTunnel(sharedSecondLease);
  assert.equal(vi.mocked(tunnels[1]!.handle.close).mock.calls.length, 1);
});

test("port recycling returns closed tunnel ports in sorted order", async () => {
  setupTunnelTracking();
  const pool = new WorkerHostPool();

  const lease1 = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  const lease2 = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 4000);
  await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 5000);

  await pool.releaseRemoteMcpTunnel(lease2);
  await pool.releaseRemoteMcpTunnel(lease1);

  const lease4 = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 6000);
  const lease5 = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 7000);
  assert.equal(lease4.remotePort, 46_000);
  assert.equal(lease5.remotePort, 46_001);
});

test("release waits for logical close before recycling the remote port", async () => {
  const closeFinished = deferred<void>();
  const tunnels = setupTunnelTracking((index) =>
    index === 0 ? { close: async () => closeFinished.promise } : {},
  );
  const pool = new WorkerHostPool();

  const firstLease = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  const release = pool.releaseRemoteMcpTunnel(firstLease);
  await Promise.resolve();

  assert.equal(vi.mocked(tunnels[0]!.handle.close).mock.calls.length, 1);

  const secondLease = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 4000);
  assert.equal(secondLease.remotePort, 46_001);

  closeFinished.resolve();
  await release;

  const thirdLease = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 5000);
  assert.equal(thirdLease.remotePort, 46_000);
});

test("rapid concurrent release recycles every port safely", async () => {
  setupTunnelTracking();
  const pool = new WorkerHostPool();

  const leases = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000 + index),
    ),
  );
  assert.deepEqual(
    leases.map((lease) => lease.remotePort),
    Array.from({ length: 10 }, (_, index) => 46_000 + index),
  );

  await Promise.all(leases.map((lease) => pool.releaseRemoteMcpTunnel(lease)));

  const first = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 4000);
  const second = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 4001);
  assert.equal(first.remotePort, 46_000);
  assert.equal(second.remotePort, 46_001);
});

test("an unexpectedly ended logical tunnel is closed and its port is recycled", async () => {
  const tunnels = setupTunnelTracking();
  const pool = new WorkerHostPool();

  const lease = await pool.acquireRemoteMcpTunnel("worker-x", "127.0.0.1", 5000);
  assert.equal(lease.remotePort, 46_000);

  tunnels[0]!.end();
  await settle(0);

  assert.equal(vi.mocked(tunnels[0]!.handle.close).mock.calls.length, 1);

  const nextLease = await pool.acquireRemoteMcpTunnel("worker-x", "127.0.0.1", 5000);
  assert.equal(nextLease.remotePort, 46_000);
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
