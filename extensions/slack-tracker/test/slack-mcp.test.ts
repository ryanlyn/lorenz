import { test } from "vitest";
import { toolSpecs, trackerMcpServerName } from "@lorenz/mcp";
import { ToolRegistry } from "@lorenz/tool-sdk";
import { TrackerRegistry } from "@lorenz/tracker-sdk";
import { assert } from "@lorenz/test-utils";

import { parseSlackConfig } from "./helpers.js";

import { registerSlackTracker } from "@lorenz/slack-tracker";

function settings() {
  return parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
    { SLACK_BOT_TOKEN: "xoxb" },
  );
}

test("slack dispatch mounts the slack pack by default", () => {
  // Compose private registries exactly as the CLI composition root does.
  const trackers = new TrackerRegistry();
  const tools = new ToolRegistry();
  registerSlackTracker({ trackers, tools });

  assert.deepEqual(
    toolSpecs(settings(), tools).map((tool) => tool.name),
    [
      "slack_update_status",
      "slack_comment",
      "slack_workpad",
      "slack_read_thread",
      "slack_query",
      "slack_user_info",
      "slack_channel_context",
    ],
  );
});

test("the agent MCP server is named for the slack tracker kind", () => {
  assert.equal(trackerMcpServerName("slack"), "lorenz_slack");
});
