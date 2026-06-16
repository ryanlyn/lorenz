import { readFile } from "node:fs/promises";
import path from "node:path";

import { executeSlackTool, InMemorySlackTransport } from "@lorenz/slack-tracker";
import { beforeAll, test } from "vitest";
import type { Issue } from "@lorenz/domain";
import { assert } from "@lorenz/test-utils";

import { registerBuiltinBackends } from "../src/daemon.js";

import { buildPrompt, parseConfig, parseWorkflowContent } from "@lorenz/cli";

// parseConfig resolves the slack tracker options through the process-default tracker
// registry, so populate it the same way the CLI entrypoints do.
beforeAll(() => {
  registerBuiltinBackends();
});

// Canonical Slack issue shape: `id` is the operative `<channel>:<ts>` tool id; `identifier`
// is a non-operative `SLK-<channel>-<ts>` display label that the slack tools reject.
const CHANNEL = "C0123456789";
const TS = "1717000000.000100";
const ISSUE_ID = `${CHANNEL}:${TS}`;
const IDENTIFIER = "SLK-C0123456789-1717000000-000100";

function slackIssue(): Issue {
  return {
    id: ISSUE_ID,
    identifier: IDENTIFIER,
    title: "Fix the deploy script",
    description: "<@U999> please fix the deploy script",
    state: "Todo",
    stateType: "unstarted",
    labels: [],
    blockers: [],
    assignedToWorker: true,
  };
}

function slackSettings() {
  return parseConfig(
    { tracker: { kind: "slack", channels: [CHANNEL], bot_user_id: "U999" } },
    { SLACK_BOT_TOKEN: "xoxb" },
  );
}

async function slackWorkflowBody(): Promise<string> {
  const raw = await readFile(path.join(import.meta.dirname, "../../../WORKFLOW.slack.md"), "utf8");
  return parseWorkflowContent(raw).body;
}

test("WORKFLOW.slack.md renders the canonical issue id (not the SLK identifier) as the issueId", async () => {
  const rendered = await buildPrompt(await slackWorkflowBody(), slackIssue());

  // The canonical `<channel>:<ts>` id is present and labelled as the issueId to pass to tools.
  assert.match(rendered, /Issue id \(pass this as issueId\): C0123456789:1717000000\.000100/);
  // The SLK display label must never be presented as the value to pass to tools.
  assert.notMatch(rendered, /SLK-C0123456789-1717000000-000100`?\s+you operate on/);
  assert.notMatch(rendered, /issueId you pass to tools[^]*SLK-C0123456789-1717000000-000100/);
});

test("the id rendered into WORKFLOW.slack.md is accepted by slack_update_status", async () => {
  const rendered = await buildPrompt(await slackWorkflowBody(), slackIssue());

  // Pull the exact id string out of the rendered prompt so the test exercises what an agent sees.
  const match = rendered.match(/Issue id \(pass this as issueId\): (\S+)/);
  assert.ok(match, "rendered prompt must expose an 'Issue id (pass this as issueId)' line");
  const renderedIssueId = match![1]!;
  assert.equal(renderedIssueId, ISSUE_ID);

  const transport = new InMemorySlackTransport({
    [CHANNEL]: [{ ts: TS, text: "<@U999> please fix the deploy script", reactions: ["eyes"] }],
  });

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: renderedIssueId, status: "Done" },
    slackSettings(),
    transport,
  );
  assert.equal(result.success, true);
  const msg = await transport.getMessage(CHANNEL, TS);
  assert.deepEqual(msg!.reactions, ["white_check_mark"]);
});

test("the SLK display label would be rejected by slack_update_status (regression guard)", async () => {
  const transport = new InMemorySlackTransport({
    [CHANNEL]: [{ ts: TS, text: "<@U999> please fix the deploy script", reactions: ["eyes"] }],
  });

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: IDENTIFIER, status: "Done" },
    slackSettings(),
    transport,
  );
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /<channel>:<ts>/);
});
