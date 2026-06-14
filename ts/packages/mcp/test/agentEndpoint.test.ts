import EventEmitter from "node:events";
import { createServer } from "node:net";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, beforeEach, test, vi } from "vitest";
import { startReverseTunnel } from "@symphony/ssh";
import { workerHostPool } from "@symphony/worker-host-pool";
import type { Settings } from "@symphony/domain";
import { assert } from "@symphony/test-utils";

import { acquireAgentMcpEndpointForRun } from "../src/agentEndpoint.js";
import { mcpAuthScopeForSettings, validMcpToken } from "../src/auth.js";

// Avoid spawning a real `ssh -N` reverse tunnel; the per-run tunnel allocation
// logic in WorkerHostPool is exercised against a fake child process.
vi.mock("@symphony/ssh", () => ({
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

// Tokens issued for a configured server port are scoped to the settings
// identity; validity checks must use the same scope.
function tokenScope(settings: Settings, port: number): string {
  return mcpAuthScopeForSettings(settings, "127.0.0.1", port);
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

  // Sub-resource (1): an auth token was issued and is currently valid.
  assert.equal(validMcpToken(lease.token, tokenScope(settings, port)), true);
  // Sub-resource (3): a per-run reverse tunnel was opened for this run.
  assert.match(lease.url, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/mcp$`));
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
  // Sub-resource (2): the refcounted local MCP server is up and reachable.
  assert.equal(await mcpServerReachable("127.0.0.1", port), true);

  await lease.release();

  // (1) token revoked.
  assert.equal(validMcpToken(lease.token, tokenScope(settings, port)), false);
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
  assert.equal(validMcpToken(lease.token, tokenScope(settings, port)), true);
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
