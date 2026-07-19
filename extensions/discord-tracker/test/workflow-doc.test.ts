import path from "node:path";

import { loadWorkflow } from "@lorenz/workflow";
import { assert } from "@lorenz/test-utils";
import { test } from "vitest";

import { BOT_ID, CHANNEL_ID, GUILD_ID, discordTrackers } from "./helpers.js";

const root = path.join(import.meta.dirname, "../../..");

test("WORKFLOW.chat.md watches Discord and documents the canonical issue id", async () => {
  const workflow = await loadWorkflow(
    path.join(root, "WORKFLOW.chat.md"),
    {
      DISCORD_BOT_TOKEN: "token",
      DISCORD_GUILD_ID: GUILD_ID,
      DISCORD_CHANNEL_ID: CHANNEL_ID,
      DISCORD_BOT_USER_ID: BOT_ID,
    },
    { cwd: root, trackers: discordTrackers },
  );

  assert.equal(workflow.settings.tracker.kind, "dispatch");
  assert.equal(workflow.settings.trackers.discord?.kind, "discord");
  assert.equal(workflow.settings.polling.intervalMs, 60000);
  assert.equal(workflow.settings.hooks.afterCreate, null);
  assert.match(workflow.promptTemplate, /<channel-id>:<message-id>/);
  assert.match(workflow.promptTemplate, /discord_read_thread/);
  assert.match(workflow.promptTemplate, /discord_workpad/);
  assert.match(workflow.promptTemplate, /slash commands/);
  assert.match(workflow.promptTemplate, /workspace starts empty/);
});
