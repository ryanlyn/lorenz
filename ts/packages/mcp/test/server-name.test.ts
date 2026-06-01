import { test } from "vitest";

import { assert } from "../../../test/assert.js";

import { trackerMcpServerName } from "@symphony/mcp";

test("tracker MCP server name is derived per kind, default linear", () => {
  assert.equal(trackerMcpServerName("linear"), "symphony_linear");
  assert.equal(trackerMcpServerName("memory"), "symphony_memory");
  assert.equal(trackerMcpServerName("local"), "symphony_local");
  assert.equal(trackerMcpServerName(undefined), "symphony_linear");
});
