import { parseConfig } from "@symphony/config";
import { test } from "vitest";

import { assert } from "../../../test/assert.js";

import { claudeMcpResponse } from "@symphony/mcp";

const settings = parseConfig({ tracker: { kind: "linear", project_slug: "mono" } }, {});

test("MCP initialize accepts omitted params and uses the default protocol version", async () => {
  const response = await claudeMcpResponse(settings, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
  });

  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "symphony-claude-mcp", version: "0.1.0" },
    },
  });
});

test("MCP initialize rejects array-shaped params instead of treating them as omitted", async () => {
  const response = await claudeMcpResponse(settings, {
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: [],
  });

  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: 2,
    error: { code: -32602, message: "Invalid params" },
  });
});
