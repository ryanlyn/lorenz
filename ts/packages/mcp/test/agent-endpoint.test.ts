import { parseConfig } from "@symphony/config";
import type { Settings } from "@symphony/domain";
import { afterEach, test, vi } from "vitest";
import { assert } from "@symphony/test-utils";

const mockAcquireRemoteMcpTunnel = vi.fn();
const mockReleaseRemoteMcpTunnel = vi.fn();
const mockStartMcpServer = vi.fn();

vi.mock("@symphony/worker-host-pool", () => ({
  workerHostPool: {
    acquireRemoteMcpTunnel: mockAcquireRemoteMcpTunnel,
    releaseRemoteMcpTunnel: mockReleaseRemoteMcpTunnel,
  },
}));

vi.mock("../src/server.js", () => ({
  startMcpServer: mockStartMcpServer,
}));

const { acquireAgentMcpEndpoint } = await import("../src/agentEndpoint.js");

afterEach(() => {
  mockAcquireRemoteMcpTunnel.mockReset();
  mockReleaseRemoteMcpTunnel.mockReset();
  mockStartMcpServer.mockReset();
});

test("remote endpoint acquisition releases a newly-started local MCP server when tunnel acquisition fails", async () => {
  const handle = fakeServerHandle(39_001);
  mockStartMcpServer.mockResolvedValue(handle);
  mockAcquireRemoteMcpTunnel.mockImplementation(() => {
    throw new Error("tunnel failed");
  });

  await assert.rejects(
    () => acquireAgentMcpEndpoint(settingsWithServerPort(39_001), "worker-1"),
    /tunnel failed/,
  );

  assert.equal(handle.stop.mock.calls.length, 1);
});

test("remote endpoint release returns the acquired tunnel lease", async () => {
  const handle = fakeServerHandle(39_004);
  const tunnelLease = { leaseId: "lease-1", workerHost: "worker-1", remotePort: 46_000 };
  mockStartMcpServer.mockResolvedValue(handle);
  mockAcquireRemoteMcpTunnel.mockReturnValue(tunnelLease);

  const lease = await acquireAgentMcpEndpoint(settingsWithServerPort(39_004), "worker-1");

  await lease.release();

  assert.deepEqual(mockReleaseRemoteMcpTunnel.mock.calls[0], [tunnelLease]);
  assert.equal(handle.stop.mock.calls.length, 1);
});

test("concurrent local MCP endpoint acquisition starts one configured-port server", async () => {
  const handle = fakeServerHandle(39_002);
  mockStartMcpServer.mockResolvedValue(handle);

  const settings = settingsWithServerPort(39_002);
  const first = acquireAgentMcpEndpoint(settings);
  const second = acquireAgentMcpEndpoint(settings);
  const leases = await Promise.all([first, second]);

  try {
    assert.equal(mockStartMcpServer.mock.calls.length, 1);
    assert.equal(leases[0]!.url, "http://127.0.0.1:39002/mcp");
    assert.equal(leases[1]!.url, "http://127.0.0.1:39002/mcp");
  } finally {
    await Promise.all(leases.map((lease) => lease.release()));
  }

  assert.equal(handle.stop.mock.calls.length, 1);
});

test("configured-port local MCP endpoint rejects different tracker settings", async () => {
  const handle = fakeServerHandle(39_003);
  mockStartMcpServer.mockResolvedValue(handle);

  const firstLease = await acquireAgentMcpEndpoint(localSettingsWithServerPort(39_003, "board-a"));
  let secondLease: Awaited<ReturnType<typeof acquireAgentMcpEndpoint>> | undefined;
  try {
    try {
      secondLease = await acquireAgentMcpEndpoint(localSettingsWithServerPort(39_003, "board-b"));
    } catch (error) {
      assert.match(String(error), /configured_mcp_server_conflict/);
      return;
    }
    throw new Error("expected conflicting tracker settings to be rejected");
  } finally {
    await secondLease?.release();
    await firstLease.release();
  }

  assert.equal(mockStartMcpServer.mock.calls.length, 1);
  assert.equal(handle.stop.mock.calls.length, 1);
});

test("configured-port acquisition waits for final release stop before replacing local MCP server", async () => {
  const firstHandle = fakeServerHandle(39_004);
  const secondHandle = fakeServerHandle(39_004);
  const stopGate = deferred<void>();
  firstHandle.stop.mockImplementation(() => stopGate.promise);
  mockStartMcpServer.mockResolvedValueOnce(firstHandle).mockResolvedValueOnce(secondHandle);
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("", { status: 404 }));

  const settings = settingsWithServerPort(39_004);
  const firstLease = await acquireAgentMcpEndpoint(settings);
  const releasePromise = firstLease.release();
  let acquiredBeforeStop = false;
  let secondLease: { release(): Promise<void> } | undefined;
  const secondAcquire = acquireAgentMcpEndpoint(settings).then((lease) => {
    acquiredBeforeStop = true;
    secondLease = lease;
    return lease;
  });

  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(acquiredBeforeStop, false);

    stopGate.resolve();
    await releasePromise;
    secondLease = await secondAcquire;

    assert.equal(mockStartMcpServer.mock.calls.length, 2);
    assert.equal(secondLease.url, "http://127.0.0.1:39004/mcp");
  } finally {
    stopGate.resolve();
    await releasePromise;
    if (secondLease) await secondLease.release();
    fetchSpy.mockRestore();
  }

  assert.equal(firstHandle.stop.mock.calls.length, 1);
  assert.equal(secondHandle.stop.mock.calls.length, 1);
});

test("configured-port local MCP endpoint does not reuse an unauthenticated 405 server", async () => {
  const handle = fakeServerHandle(39_005);
  mockStartMcpServer.mockResolvedValue(handle);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    if (init?.method === "POST") {
      return new Response(
        JSON.stringify({
          error: {
            code: "unauthorized",
            message: "Missing or invalid MCP bearer token",
          },
        }),
        { status: 401 },
      );
    }
    return new Response("", { status: 405 });
  });

  let lease: Awaited<ReturnType<typeof acquireAgentMcpEndpoint>> | undefined;
  try {
    lease = await acquireAgentMcpEndpoint(settingsWithServerPort(39_005));

    assert.equal(mockStartMcpServer.mock.calls.length, 1);
    const postCall = fetchSpy.mock.calls.find(([, init]) => init?.method === "POST");
    assert.ok(postCall, "expected an authenticated POST probe");
    assert.match(
      String((postCall[1]?.headers as Record<string, string>).authorization),
      /^Bearer /,
    );
  } finally {
    await lease?.release();
    fetchSpy.mockRestore();
  }

  assert.equal(handle.stop.mock.calls.length, 1);
});

function settingsWithServerPort(port: number): Settings {
  return parseConfig({ server: { host: "127.0.0.1", port } }, {});
}

function localSettingsWithServerPort(port: number, boardPath: string): Settings {
  return parseConfig(
    { tracker: { kind: "local", path: boardPath }, server: { host: "127.0.0.1", port } },
    {},
  );
}

test("local MCP endpoint reports a connectable URL when configured server binds wildcard", async () => {
  const settings = parseConfig({
    tracker: { kind: "linear", project_slug: "mono" },
    server: { host: "0.0.0.0", port: 43210 },
  });
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { id?: unknown };
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [] },
      }),
      { status: 200 },
    );
  });

  try {
    const lease = await acquireAgentMcpEndpoint(settings);
    try {
      assert.equal(lease.url, "http://127.0.0.1:43210/mcp");
      assert.equal(mockStartMcpServer.mock.calls.length, 0);
    } finally {
      await lease.release();
    }
  } finally {
    fetchSpy.mockRestore();
  }
});

function fakeServerHandle(port: number): {
  host: string;
  port: number;
  authScope: string;
  url(path?: string): string;
  stop: ReturnType<typeof vi.fn>;
} {
  return {
    host: "127.0.0.1",
    port,
    authScope: `test:${port}`,
    url(path = "/") {
      return `http://127.0.0.1:${port}${path}`;
    },
    stop: vi.fn(async () => {}),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
