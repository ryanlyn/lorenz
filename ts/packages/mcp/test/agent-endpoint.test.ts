import { parseConfig } from "@symphony/config";
import type { Settings } from "@symphony/domain";
import { afterEach, test, vi } from "vitest";

import { assert } from "../../../test/assert.js";

const mockAcquireRemoteMcpTunnel = vi.fn();
const mockReleaseRemoteMcpTunnel = vi.fn();
const mockStartClaudeMcpServer = vi.fn();

vi.mock("@symphony/worker-host-pool", () => ({
  workerHostPool: {
    acquireRemoteMcpTunnel: mockAcquireRemoteMcpTunnel,
    releaseRemoteMcpTunnel: mockReleaseRemoteMcpTunnel,
  },
}));

vi.mock("../src/server.js", () => ({
  startClaudeMcpServer: mockStartClaudeMcpServer,
}));

const { acquireAgentMcpEndpoint } = await import("../src/agentEndpoint.js");

afterEach(() => {
  mockAcquireRemoteMcpTunnel.mockReset();
  mockReleaseRemoteMcpTunnel.mockReset();
  mockStartClaudeMcpServer.mockReset();
});

test("remote endpoint acquisition releases a newly-started local MCP server when tunnel acquisition fails", async () => {
  const handle = fakeServerHandle(39_001);
  mockStartClaudeMcpServer.mockResolvedValue(handle);
  mockAcquireRemoteMcpTunnel.mockImplementation(() => {
    throw new Error("tunnel failed");
  });

  await assert.rejects(
    () => acquireAgentMcpEndpoint(settingsWithServerPort(39_001), "worker-1"),
    /tunnel failed/,
  );

  assert.equal(handle.stop.mock.calls.length, 1);
});

test("concurrent local MCP endpoint acquisition starts one configured-port server", async () => {
  const handle = fakeServerHandle(39_002);
  mockStartClaudeMcpServer.mockResolvedValue(handle);

  const settings = settingsWithServerPort(39_002);
  const first = acquireAgentMcpEndpoint(settings);
  const second = acquireAgentMcpEndpoint(settings);
  const leases = await Promise.all([first, second]);

  try {
    assert.equal(mockStartClaudeMcpServer.mock.calls.length, 1);
    assert.equal(leases[0]!.url, "http://127.0.0.1:39002/claude-mcp");
    assert.equal(leases[1]!.url, "http://127.0.0.1:39002/claude-mcp");
  } finally {
    await Promise.all(leases.map((lease) => lease.release()));
  }

  assert.equal(handle.stop.mock.calls.length, 1);
});

test("configured-port local MCP endpoint rejects different tracker settings", async () => {
  const handle = fakeServerHandle(39_003);
  mockStartClaudeMcpServer.mockResolvedValue(handle);

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

  assert.equal(mockStartClaudeMcpServer.mock.calls.length, 1);
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
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("", { status: 405 }));

  try {
    const lease = await acquireAgentMcpEndpoint(settings);
    try {
      assert.equal(lease.url, "http://127.0.0.1:43210/claude-mcp");
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
