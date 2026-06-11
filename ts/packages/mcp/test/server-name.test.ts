import { test } from "vitest";
import { assert } from "@symphony/test-utils";

import { trackerMcpServerName } from "@symphony/mcp";

test("tracker MCP server name is derived per kind, defaulting to the neutral tracker name", () => {
  assert.equal(trackerMcpServerName("linear"), "symphony_linear");
  assert.equal(trackerMcpServerName("memory"), "symphony_memory");
  assert.equal(trackerMcpServerName("local"), "symphony_local");
  assert.equal(trackerMcpServerName(undefined), "symphony_tracker");
});
