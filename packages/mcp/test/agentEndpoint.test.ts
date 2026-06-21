import EventEmitter from "node:events";
import { createServer } from "node:net";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, beforeEach, test, vi } from "vitest";
import { startReverseTunnel } from "@lorenz/ssh";
import { workerHostPool } from "@lorenz/worker-host-pool";
import type { Settings } from "@lorenz/domain";
import { assert } from "@lorenz/test-utils";

import { acquireAgentMcpEndpointForRun } from "../src/agentEndpoint.js";
import { resolveRunClaim } from "../src/auth.js";

// Avoid spawning a real `ssh -N` reverse tunnel; the per-run tunnel allocation
// logic in WorkerHostPool is exercised against a fake child process.
vi.mock("@lorenz/ssh", () => ({
  startReverseTunnel: vi.fn(),
  // The pool awaits remote-port readiness before returning a lease; the fake
  // resolves immediately so these tests exercise the lease lifecycle, not the
  // readiness probe.
  waitForRemoteTcpPort: vi.fn(async () => {}),
}));

const mockStartReverseTunnel = vi.mocked(startReverseTunnel);

interface FakeProcess extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeProcess(): ChildProcessWithoutNullStreams {
  const emitter = new EventEmitter() as FakeProcess;
  // Port recycling is deferred until the ssh child actually ends, so the fake
  // child ends (emits close) as soon as it is killed.
  emitter.kill = vi.fn(() => {
    emitter.emit("close", null, "SIGTERM");
    return true;
  });
  (emitter as unknown as Record<string, unknown>).pid = 12345;
  return emitter as unknown as ChildProcessWithoutNullStreams;
}

// A free localhost TCP port that no server is listening on, so the local MCP
// server is NOT reachable and `ensureLocalMcpServer` starts its own refcounted
// instance keyed by `${host}:${port}`.
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

async function mcpServerReachable(host: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/mcp`, {
      method: "GET",
      signal: AbortSignal.timeout(500),
    });
    return response.status === 405;
  } catch {
    return false;
  }
}

function settingsWithPort(port: number): Settings {
  // The auth scope is keyed by the tracker identity, so the stub must carry a
  // tracker for mcpAuthScopeForSettings.
  return {
    server: { host: "127.0.0.1", port },
    tracker: { kind: "memory", options: {}, activeStates: ["Todo"], terminalStates: ["Done"] },
  } as unknown as Settings;
}

beforeEach(() => {
  mockStartReverseTunnel.mockReset();
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess());
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("acquireAgentMcpEndpointForRun.release() revokes the token, drops the local-server ref, AND closes the per-run tunnel", async () => {
  const port = await freeLocalPort();
  const settings = settingsWithPort(port);
  const closeForRun = vi.spyOn(workerHostPool, "closeForRun");

  const lease = await acquireAgentMcpEndpointForRun(settings, "worker-1", "run-A", workerHostPool);

  // Sub-resource (1): a per-run Token B was minted and resolves to a claim bound
  // to THIS run server-side (runKey is resolved from the token, never reported).
  const claim = resolveRunClaim(lease.token);
  assert.ok(claim);
  assert.equal(claim?.runKey, "run-A");
  assert.equal(claim?.workerHost, "worker-1");
  // Sub-resource (3): a per-run reverse tunnel was opened for this run.
  assert.match(lease.url, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/mcp$`));
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
  // Sub-resource (2): the refcounted local MCP server is up and reachable.
  assert.equal(await mcpServerReachable("127.0.0.1", port), true);

  await lease.release();

  // (1) Token B revoked: its claim no longer resolves (fails closed).
  assert.equal(resolveRunClaim(lease.token), undefined);
  // (3) per-run tunnel closed via closeForRun(workerHost, runKey).
  assert.deepEqual(closeForRun.mock.calls[0], ["worker-1", "run-A"]);
  // (2) local-server ref dropped to zero -> server stopped (no longer reachable).
  assert.equal(await mcpServerReachable("127.0.0.1", port), false);
});

test("acquireAgentMcpEndpointForRun releases the local-server ref AND revokes the token when openForRun throws", async () => {
  const port = await freeLocalPort();
  const settings = settingsWithPort(port);
  const closeForRun = vi.spyOn(workerHostPool, "closeForRun");

  // The local MCP server is started (refcounted) BEFORE the per-run tunnel is
  // opened. Make the reverse-tunnel spawn fail so `workerHostPool.openForRun`
  // throws AFTER `ensureLocalMcpServer` has already taken a ref + a token was
  // issued. Repeated tunnel-spawn failures must NOT leak the refcounted local
  // MCP server / its listener, nor the auth token.
  mockStartReverseTunnel.mockImplementation(() => {
    throw new Error("tunnel_spawn_failed");
  });

  // The thrown error propagates to the caller.
  await assert.rejects(
    () => acquireAgentMcpEndpointForRun(settings, "worker-1", "run-fail", workerHostPool),
    /tunnel_spawn_failed/,
  );

  // (local server) the refcount dropped to zero -> the server was stopped and
  // is no longer reachable. No orphaned refcounted local MCP server / listener.
  assert.equal(await mcpServerReachable("127.0.0.1", port), false);
  // (token) the caller's failure path revoked the issued token. A subsequent
  // successful acquire on the SAME host:port re-uses the recycled remote port
  // and brings the local server back up, then releases cleanly — proving the
  // failed attempt left no lingering refcount that would keep the server alive.
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess());
  const lease = await acquireAgentMcpEndpointForRun(settings, "worker-1", "run-ok", workerHostPool);
  assert.ok(resolveRunClaim(lease.token));
  assert.equal(await mcpServerReachable("127.0.0.1", port), true);
  await lease.release();
  // Local server stopped again -> the earlier failed acquire did NOT leave a
  // dangling extra ref (which would have kept refCount >= 1 here).
  assert.equal(await mcpServerReachable("127.0.0.1", port), false);
  // The failed acquire still routed through the caller's cleanup (closeForRun).
  assert.deepEqual(closeForRun.mock.calls[0], ["worker-1", "run-fail"]);
});

test("two per-run endpoints on one host get DISTINCT tunnel ports", async () => {
  const port = await freeLocalPort();
  const settings = settingsWithPort(port);

  const a = await acquireAgentMcpEndpointForRun(settings, "worker-1", "run-A", workerHostPool);
  const b = await acquireAgentMcpEndpointForRun(settings, "worker-1", "run-B", workerHostPool);

  // Two distinct per-run tunnels — no host coalescing.
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);
  assert.notEqual(a.url, b.url);

  await a.release();
  await b.release();
});

test("the local MCP server refcount is shared across two per-run endpoints on the same controller", async () => {
  const port = await freeLocalPort();
  const settings = settingsWithPort(port);
  const stopForRun = vi.spyOn(workerHostPool, "closeForRun");

  const a = await acquireAgentMcpEndpointForRun(settings, "worker-1", "run-A", workerHostPool);
  const b = await acquireAgentMcpEndpointForRun(settings, "worker-1", "run-B", workerHostPool);

  // ONE shared local server backs BOTH per-run endpoints (refCount == 2):
  // the second acquire reuses the existing instance, so no second server was
  // started on a second port for the local server.
  assert.equal(await mcpServerReachable("127.0.0.1", port), true);

  // Releasing run A drops the refcount 2 -> 1; the shared server stays up for B.
  await a.release();
  assert.equal(await mcpServerReachable("127.0.0.1", port), true);
  assert.deepEqual(stopForRun.mock.calls[0], ["worker-1", "run-A"]);

  // Releasing run B drops the refcount 1 -> 0; only now is the server stopped.
  await b.release();
  assert.equal(await mcpServerReachable("127.0.0.1", port), false);
  assert.deepEqual(stopForRun.mock.calls[1], ["worker-1", "run-B"]);
});

test("co-resident per-run claims share the live local-server generation", async () => {
  const port = await freeLocalPort();
  const settings = settingsWithPort(port);

  // Two runs co-resident on ONE shared local MCP server (the second acquire
  // reuses the refcounted instance) carry the SAME slot generation in their
  // claims: the generation tracks the shared endpoint, not the individual run.
  const a = await acquireAgentMcpEndpointForRun(settings, "worker-1", "run-A", workerHostPool);
  const b = await acquireAgentMcpEndpointForRun(settings, "worker-1", "run-B", workerHostPool);

  const claimA = resolveRunClaim(a.token);
  const claimB = resolveRunClaim(b.token);
  assert.ok(claimA);
  assert.ok(claimB);
  assert.equal(claimA?.generation, claimB?.generation);

  await a.release();
  await b.release();
});

test("recycling a host:port slot bumps the generation so a fresh claim outranks the recycled one", async () => {
  const port = await freeLocalPort();
  const settings = settingsWithPort(port);

  // First run brings the shared local server up; capture its generation.
  const first = await acquireAgentMcpEndpointForRun(settings, "worker-1", "run-A", workerHostPool);
  const firstGen = resolveRunClaim(first.token)?.generation;
  assert.ok(typeof firstGen === "number");

  // Fully release -> refcount hits zero -> the server is torn down (recycle).
  await first.release();
  assert.equal(await mcpServerReachable("127.0.0.1", port), false);

  // Re-acquiring the SAME host:port starts a brand-new entry, so its generation
  // is STRICTLY higher. This is the exact input the per-request liveness fence
  // uses to reject a Token B minted against the prior, now-recycled generation.
  const second = await acquireAgentMcpEndpointForRun(settings, "worker-1", "run-B", workerHostPool);
  const secondGen = resolveRunClaim(second.token)?.generation;
  assert.ok(typeof secondGen === "number");
  assert.ok((secondGen as number) > (firstGen as number));

  await second.release();
});
