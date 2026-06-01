import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseConfig } from "@symphony/config";
import type { Settings } from "@symphony/domain";
import { test } from "vitest";

import { assert } from "../../../test/assert.js";

import {
  issueMcpToken,
  revokeMcpToken,
  startClaudeMcpServer,
  type ObservabilityServerHandle,
} from "@symphony/mcp";

async function localSettings(): Promise<Settings> {
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-tools-list-local-"));
  await mkdir(dir, { recursive: true });
  return parseConfig({ tracker: { kind: "local", path: dir } }, {});
}

async function toolsListNames(settings: Settings): Promise<string[]> {
  const token = issueMcpToken();
  let handle: ObservabilityServerHandle | undefined;
  try {
    handle = await startClaudeMcpServer(settings, { host: "127.0.0.1", port: 0 });
    const response = await fetch(handle.url("/claude-mcp"), {
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
    "local_update_status",
    "local_comment",
    "local_create_issue",
    "local_read_issue",
    "local_query",
  ]);
});

test("MCP tools/list still advertises only linear_graphql for a linear tracker", async () => {
  const settings = parseConfig({ tracker: { kind: "linear", project_slug: "mono" } }, {});
  assert.deepEqual(await toolsListNames(settings), ["linear_graphql"]);
});
