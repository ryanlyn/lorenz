import path from "node:path";

import { loadWorkflow } from "@symphony/workflow";
import { test } from "vitest";
import { assert } from "@symphony/test-utils";

import { slackTrackers } from "./helpers.js";

const tsRoot = path.join(import.meta.dirname, "../../..");

test("WORKFLOW.slack.md uses route- as the dispatch route_label_prefix", async () => {
  const workflowFile = path.join(tsRoot, "WORKFLOW.slack.md");
  const workflow = await loadWorkflow(workflowFile, {}, { cwd: tsRoot, trackers: slackTrackers });

  assert.equal(workflow.settings.tracker.dispatch.routeLabelPrefix, "route-");
});

// conversations.history is tightly rate-limited (newer apps can be ~1 req/min) and each poll
// re-scans recent history, so the shipped Slack workflow keeps a conservative one-minute poll
// interval to avoid 429 storms on busy channels. Guard the concrete value.
test("WORKFLOW.slack.md polls at a conservative 60s interval to respect Slack rate limits", async () => {
  const workflowFile = path.join(tsRoot, "WORKFLOW.slack.md");
  const workflow = await loadWorkflow(workflowFile, {}, { cwd: tsRoot, trackers: slackTrackers });

  assert.equal(workflow.settings.polling.intervalMs, 60000);
});
