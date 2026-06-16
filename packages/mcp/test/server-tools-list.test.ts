import { mkdtemp, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseConfig as parseWorkflowConfig } from "@lorenz/config";
import type { Settings } from "@lorenz/domain";
import { registerLinearTracker } from "@lorenz/linear-tracker";
import { registerLocalTracker } from "@lorenz/local-tracker";
import { ToolRegistry } from "@lorenz/tool-sdk";
import { createTrackerToolProvider, TrackerRegistry } from "@lorenz/tracker-sdk";
import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import {
  issueMcpToken,
  mcpAuthScopeForSettings,
  revokeMcpToken,
  startMcpServer,
  type ObservabilityServerHandle,
} from "@lorenz/mcp";

// Private registries holding the providers this suite exercises (linear and local
// dispatch, plus the neutral tracker pack), so the server is exercised without mutating
// the process-default registries.
const trackers = new TrackerRegistry();
const tools = new ToolRegistry();
registerLinearTracker({ trackers, tools });
registerLocalTracker({ trackers, tools });
tools.register(createTrackerToolProvider(trackers));

function parseConfig(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): Settings {
  return parseWorkflowConfig(raw, env, {}, trackers);
}

async function localSettings(): Promise<Settings> {
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-tools-list-local-"));
  await mkdir(dir, { recursive: true });
  return parseConfig({ tracker: { kind: "local", path: dir } }, {});
}

async function toolsListNames(settings: Settings): Promise<string[]> {
  let token: string | undefined;
  let handle: ObservabilityServerHandle | undefined;
  try {
    handle = await startMcpServer(settings, { host: "127.0.0.1", port: 0, tools });
    token = issueMcpToken(handle.authScope);
    const response = await fetch(handle.url("/mcp"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      result?: { tools?: Array<{ name?: string }> };
    };
    return (body.result?.tools ?? []).map((tool) => tool.name ?? "");
  } finally {
    revokeMcpToken(token);
    await handle?.stop();
  }
}

test("MCP tools/list advertises the local board tools for a local tracker", async () => {
  assert.deepEqual(await toolsListNames(await localSettings()), [
    "tracker_read_issue",
    "tracker_query",
    "tracker_update_status",
    "tracker_list_comments",
    "tracker_comment",
    "tracker_update_comment",
    "tracker_create_issue",
    "local_update_status",
    "local_comment",
    "local_create_issue",
    "local_read_issue",
    "local_query",
  ]);
});

test("MCP tools/list advertises common and legacy tools for a linear tracker", async () => {
  const settings = parseConfig({ tracker: { kind: "linear", project_slug: "mono" } }, {});
  assert.deepEqual(await toolsListNames(settings), [
    "tracker_read_issue",
    "tracker_query",
    "tracker_update_status",
    "tracker_list_comments",
    "tracker_comment",
    "tracker_update_comment",
    "tracker_create_issue",
    "linear_graphql",
  ]);
});

test("MCP server rejects bearer tokens issued for another server instance", async () => {
  let localHandle: ObservabilityServerHandle | undefined;
  let linearHandle: ObservabilityServerHandle | undefined;
  let localToken: string | undefined;
  let linearToken: string | undefined;
  try {
    localHandle = await startMcpServer(await localSettings(), {
      host: "127.0.0.1",
      port: 0,
      tools,
    });
    linearHandle = await startMcpServer(
      parseConfig({ tracker: { kind: "linear", project_slug: "mono" } }, {}),
      { host: "127.0.0.1", port: 0, tools },
    );
    localToken = issueMcpToken(localHandle.authScope);
    linearToken = issueMcpToken(linearHandle.authScope);

    assert.equal(await toolsListStatus(localHandle, localToken), 200);
    assert.equal(await toolsListStatus(linearHandle, localToken), 401);
    assert.equal(await toolsListStatus(linearHandle, linearToken), 200);
  } finally {
    revokeMcpToken(localToken);
    revokeMcpToken(linearToken);
    await localHandle?.stop();
    await linearHandle?.stop();
  }
});

test("fixed-port MCP server accepts deterministic settings-scoped tokens", async () => {
  const settings = parseConfig({ tracker: { kind: "linear", project_slug: "mono" } }, {});
  const port = await reserveTcpPort();
  let handle: ObservabilityServerHandle | undefined;
  let token: string | undefined;
  try {
    handle = await startMcpServer(settings, { host: "127.0.0.1", port, tools });
    token = issueMcpToken(mcpAuthScopeForSettings(settings, "127.0.0.1", port));

    assert.equal(handle.authScope, mcpAuthScopeForSettings(settings, "127.0.0.1", port));
    assert.equal(await toolsListStatus(handle, token), 200);
  } finally {
    revokeMcpToken(token);
    await handle?.stop();
  }
});

test("MCP rejects array request bodies as parse errors", async () => {
  let token: string | undefined;
  let handle: ObservabilityServerHandle | undefined;
  try {
    handle = await startMcpServer(await localSettings(), {
      host: "127.0.0.1",
      port: 0,
      tools,
    });
    token = issueMcpToken(handle.authScope);
    const response = await fetch(handle.url("/mcp"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify([]),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  } finally {
    revokeMcpToken(token);
    await handle?.stop();
  }
});

async function toolsListStatus(
  handle: ObservabilityServerHandle,
  token: string | undefined,
): Promise<number> {
  const response = await fetch(handle.url("/mcp"), {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return response.status;
}

async function reserveTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("failed to reserve TCP port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}
