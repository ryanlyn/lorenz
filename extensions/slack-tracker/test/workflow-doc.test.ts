import fs from "node:fs/promises";
import path from "node:path";

import { parseWorkflowContent } from "@lorenz/workflow";
import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { parseSlackConfig } from "./helpers.js";

const tsRoot = path.join(import.meta.dirname, "../../..");

async function chatWorkflowWithSlackSelected() {
  const raw = await fs.readFile(path.join(tsRoot, "WORKFLOW.chat.md"), "utf8");
  const config = parseWorkflowContent(raw).config;
  config.tracker = { kind: "slack" };
  return parseSlackConfig(config, {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_CHANNEL_ID: "C0123456789",
    SLACK_BOT_USER_ID: "U999",
  });
}

test("WORKFLOW.chat.md Slack bundle uses route- as the dispatch route_label_prefix", async () => {
  const settings = await chatWorkflowWithSlackSelected();

  assert.equal(settings.tracker.dispatch.routeLabelPrefix, "route-");
});

// conversations.history is tightly rate-limited (newer apps can be ~1 req/min) and each poll
// re-scans recent history, so the shipped Slack workflow keeps a conservative one-minute poll
// interval to avoid 429 storms on busy channels. Guard the concrete value.
test("WORKFLOW.chat.md polls at a conservative 60s interval for Slack", async () => {
  const settings = await chatWorkflowWithSlackSelected();

  assert.equal(settings.polling.intervalMs, 60000);
});
