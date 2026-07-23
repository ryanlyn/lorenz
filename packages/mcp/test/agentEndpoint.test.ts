import EventEmitter from "node:events";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, beforeEach, test, vi } from "vitest";
import { startReverseTunnel } from "@lorenz/ssh";
import { workerHostPool } from "@lorenz/worker-host-pool";
import type { Settings } from "@lorenz/domain";
import { assert } from "@lorenz/test-utils";

import { acquireAgentMcpEndpoint, acquireAgentMcpEndpointForRun } from "../src/agentEndpoint.js";
import { resolveRunClaim } from "../src/auth.js";
import { startMcpServer } from "../src/server.js";

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

async function freeLocalPortOtherThan(excludedPort: number): Promise<number> {
  const port = await freeLocalPort();
  return port === excludedPort ? freeLocalPortOtherThan(excludedPort) : port;
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

// POST a non-tool MCP request (`tools/list`, so the per-tool allowlist is
// skipped and ONLY the injected owner re-check + generation fence gates it) to the
// live local MCP server with the per-run Token B and return the HTTP status. A
// denied owner re-check fails closed as 401.
async function mcpListStatus(host: string, port: number, token: string): Promise<number> {
  const response = await fetch(`http://${host}:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    signal: AbortSignal.timeout(500),
  });
  return response.status;
}

test("the per-run server enforces the INJECTED isRunLive on every Token B request (fail closed when not live)", async () => {
  const port = await freeLocalPort();
  const settings = settingsWithPort(port);
  // The composition root injects this oracle; flip it between requests to prove the
  // per-run server re-checks liveness on EVERY request rather than only at mint.
  let live = true;
  const seen: Array<[string, string, number]> = [];
  const isRunLive = (runKey: string, workerHost: string, generation: number): boolean => {
    seen.push([runKey, workerHost, generation]);
    return live;
  };

  const lease = await acquireAgentMcpEndpointForRun(
    settings,
    "worker-1",
    "run-live",
    workerHostPool,
    isRunLive,
  );
  const claim = resolveRunClaim(lease.token);
  assert.ok(claim);

  // Live: the owner re-check passes, so the request is NOT 401 (it reaches the
  // handler). The oracle was consulted with the claim's resolved identity.
  const okStatus = await mcpListStatus("127.0.0.1", port, lease.token);
  assert.notEqual(okStatus, 401);
  assert.deepEqual(seen.at(-1), ["run-live", "worker-1", claim?.generation]);

  // Not live (run settled/recycled/superseded): the SAME token now fails closed
  // with 401, proving the re-check runs per request, not just at mint.
  live = false;
  const deniedStatus = await mcpListStatus("127.0.0.1", port, lease.token);
  assert.equal(deniedStatus, 401);

  await lease.release();
});

test("a local agent keeps sharing server.port when server.mcp_port is configured", async () => {
  const dashboardPort = await freeLocalPort();
  const mcpPort = await freeLocalPortOtherThan(dashboardPort);
  const settings = settingsWithPort(dashboardPort);
  settings.server.mcpPort = mcpPort;

  const lease = await acquireAgentMcpEndpoint(settings);
  try {
    assert.match(lease.url, new RegExp(`:${dashboardPort}/mcp$`));
    assert.equal(await mcpServerReachable("127.0.0.1", dashboardPort), true);
    assert.equal(await mcpServerReachable("127.0.0.1", mcpPort), false);
  } finally {
    await lease.release();
  }
});

test("a per-run claim server does not reuse a live local Token-A listener", async () => {
  const port = await freeLocalPort();
  const settings = settingsWithPort(port);
  const localLease = await acquireAgentMcpEndpoint(settings);
  try {
    await assert.rejects(
      () =>
        acquireAgentMcpEndpointForRun(
          settings,
          "worker-1",
          "run-mixed-auth",
          workerHostPool,
          () => true,
        ),
      /configured_mcp_server_conflict/,
    );
    assert.equal(mockStartReverseTunnel.mock.calls.length, 0);
  } finally {
    await localLease.release();
  }
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

test("two per-run endpoints on one host SHARE one reverse tunnel / URL (per-host collapse), kept apart by distinct Token B claims", async () => {
  const port = await freeLocalPort();
  const settings = settingsWithPort(port);

  const a = await acquireAgentMcpEndpointForRun(settings, "worker-1", "run-A", workerHostPool);
  const b = await acquireAgentMcpEndpointForRun(settings, "worker-1", "run-B", workerHostPool);

  // ONE shared per-host reverse tunnel: a single ssh child and the SAME tunnel URL
  // (remote port) for both co-resident runs (host coalescing).
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
  assert.equal(a.url, b.url);
  // Runs are distinguished by their distinct per-run Token B claims, NOT the port.
  assert.notEqual(a.token, b.token);
  assert.ok(resolveRunClaim(a.token));
  assert.ok(resolveRunClaim(b.token));

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

// ---------------------------------------------------------------------------
// Bypass closure: the per-run claim path can NEVER mint an unenforceable token.
// ---------------------------------------------------------------------------

test("acquireAgentMcpEndpointForRun REFUSES an empty (local) worker host (no Token B minted for a local run)", async () => {
  const port = await freeLocalPort();
  const settings = settingsWithPort(port);

  // An empty workerHost denotes a LOCAL/acp run, which the per-run manager routes
  // through its own null/local path - it must never reach this minting path. If it
  // does (a wiring bug), minting a Token B claim stamped `workerHost: ""` would let
  // isRunLive match it against any other local slot, so the path fails loud instead.
  await assert.rejects(
    () => acquireAgentMcpEndpointForRun(settings, "", "run-local", workerHostPool),
    /per_run_mcp_endpoint_requires_remote_worker_host/,
  );

  // No server, tunnel, or token was minted for the refused run: the local server
  // never came up (an empty host short-circuits before ensureLocalMcpServer).
  assert.equal(await mcpServerReachable("127.0.0.1", port), false);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 0);
});

// The reachability probe echoes the request's jsonrpc `id` back; a foreign server
// must mirror it so `configuredMcpServerReachable` accepts the response as a real
// MCP server (it checks `body.id === <probeId>`).
function parseJsonRpcId(body: string): unknown {
  try {
    return (JSON.parse(body) as { id?: unknown }).id ?? null;
  } catch {
    return null;
  }
}

test("per-run MCP requires server.mcp_port when the dashboard owns the shared port", async () => {
  const port = await freeLocalPort();
  const foreign = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const id = parseJsonRpcId(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [] } }));
    });
  });
  await new Promise<void>((resolve) => foreign.listen(port, "127.0.0.1", resolve));
  try {
    const settings = settingsWithPort(port);
    await assert.rejects(
      () =>
        acquireAgentMcpEndpointForRun(
          settings,
          "worker-1",
          "run-external",
          workerHostPool,
          () => true,
        ),
      /per_run_mcp_endpoint_requires_server_mcp_port/,
    );
    assert.equal(mockStartReverseTunnel.mock.calls.length, 0);
  } finally {
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
  }
});

test("an equal MCP/dashboard port on a wildcard host reports the dedicated-port error", async () => {
  const port = await freeLocalPort();
  const settings = settingsWithPort(port);
  settings.server.host = "0.0.0.0";
  settings.server.mcpPort = port;
  const dashboardMcp = await startMcpServer(settings, { host: "0.0.0.0", port });
  try {
    await assert.rejects(
      () =>
        acquireAgentMcpEndpointForRun(
          settings,
          "worker-1",
          "run-shared",
          workerHostPool,
          () => true,
        ),
      /per_run_mcp_endpoint_requires_server_mcp_port/,
    );
    assert.equal(mockStartReverseTunnel.mock.calls.length, 0);
  } finally {
    await dashboardMcp.stop();
  }
});

test("server.mcp_port gives co-resident remote runs one dedicated MCP server and tunnel", async () => {
  const dashboardPort = await freeLocalPort();
  const foreign = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const id = parseJsonRpcId(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [] } }));
    });
  });
  await new Promise<void>((resolve) => foreign.listen(dashboardPort, "127.0.0.1", resolve));
  try {
    const mcpPort = await freeLocalPort();
    const settings = settingsWithPort(dashboardPort);
    settings.server.host = "0.0.0.0";
    settings.server.mcpPort = mcpPort;
    const first = await acquireAgentMcpEndpointForRun(
      settings,
      "worker-1",
      "issue-1#0",
      workerHostPool,
      () => true,
    );
    const second = await acquireAgentMcpEndpointForRun(
      settings,
      "worker-1",
      "issue-2#0",
      workerHostPool,
      () => true,
    );
    try {
      assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
      assert.equal(mockStartReverseTunnel.mock.calls[0]?.[2], "127.0.0.1");
      assert.equal(mockStartReverseTunnel.mock.calls[0]?.[3], mcpPort);
      assert.notEqual(first.token, second.token);
      assert.equal(first.generation, second.generation);
      assert.notEqual(await mcpListStatus("127.0.0.1", mcpPort, first.token), 401);
      assert.notEqual(await mcpListStatus("127.0.0.1", mcpPort, second.token), 401);

      await second.release();
      assert.notEqual(await mcpListStatus("127.0.0.1", mcpPort, first.token), 401);
    } finally {
      await second.release();
      await first.release();
    }
    assert.equal(await mcpServerReachable("127.0.0.1", mcpPort), false);
  } finally {
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
  }
});
