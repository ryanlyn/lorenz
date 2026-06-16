import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { trackerMcpServerName } from "@lorenz/mcp";

test("tracker MCP server name is derived per kind, defaulting to the neutral tracker name", () => {
  assert.equal(trackerMcpServerName("linear"), "lorenz_linear");
  assert.equal(trackerMcpServerName("memory"), "lorenz_memory");
  assert.equal(trackerMcpServerName("local"), "lorenz_local");
  assert.equal(trackerMcpServerName(undefined), "lorenz_tracker");
});
