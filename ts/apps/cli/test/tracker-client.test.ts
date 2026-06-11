import { readFile } from "node:fs/promises";
import path from "node:path";

import { LocalTrackerClient } from "@symphony/local-tracker";
import { SlackTrackerClient, slackTrackerOptions } from "@symphony/slack-tracker";
import { beforeAll, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { assert } from "@symphony/test-utils";

import { registerBuiltinBackends } from "../src/daemon.js";

import {
  createTrackerClient,
  JiraClient,
  JiraMcpClient,
  memoryIssuesFromEnv,
  MemoryTrackerClient,
  parseConfig,
} from "@symphony/cli";

// createTrackerClient resolves the configured kind through the process-default tracker
// registry, so populate it the same way the CLI entrypoints do.
beforeAll(() => {
  registerBuiltinBackends();
});

function frontmatter(raw: string): Record<string, unknown> {
  const end = raw.indexOf("\n---", 3);
  return parseYaml(raw.slice(raw.indexOf("\n") + 1, end)) as Record<string, unknown>;
}

function body(raw: string): string {
  const end = raw.indexOf("\n---", 3);
  return raw.slice(raw.indexOf("\n", end + 1) + 1).trim();
}

test("memory tracker adapter returns configured issues and filters by id", async () => {
  const client = new MemoryTrackerClient([
    {
      id: "one",
      identifier: "MT-1",
      title: "One",
      state: "Todo",
      stateType: "unstarted",
      labels: ["Symphony:Backend"],
    },
    { id: "two", identifier: "MT-2", title: "Two", state: "Done", stateType: "completed" },
  ]);

  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(
    candidates.map((issue) => issue.identifier),
    ["MT-1", "MT-2"],
  );
  assert.deepEqual(candidates[0]?.labels, ["symphony:backend"]);

  candidates[0]!.labels.push("mutated");
  const byId = await client.fetchIssuesByIds(["two", "missing", "one"]);
  assert.deepEqual(
    byId.map((issue) => issue.identifier),
    ["MT-1", "MT-2"],
  );
  assert.deepEqual((await client.fetchCandidateIssues())[0]?.labels, ["symphony:backend"]);
});

test("tracker factory selects memory adapter from workflow settings and JSON env", async () => {
  const settings = parseConfig({ tracker: { kind: "memory" } }, {});
  const client = createTrackerClient(settings, {
    SYMPHONY_MEMORY_TRACKER_ISSUES_JSON: JSON.stringify([
      { id: "env", identifier: "MT-ENV", title: "Env", state: "Todo", stateType: "unstarted" },
    ]),
  });

  assert.ok(client instanceof MemoryTrackerClient);
  assert.deepEqual(
    (await client.fetchCandidateIssues()).map((issue) => issue.identifier),
    ["MT-ENV"],
  );
  assert.deepEqual(memoryIssuesFromEnv({ SYMPHONY_MEMORY_TRACKER_ISSUES_JSON: "[]" }), []);
  assert.throws(
    () => memoryIssuesFromEnv({ SYMPHONY_MEMORY_TRACKER_ISSUES_JSON: "{}" }),
    /must be a JSON array/,
  );
});

test("tracker factory selects Jira adapters from workflow settings", () => {
  const jira = parseConfig(
    {
      tracker: {
        kind: "jira",
        base_url: "https://example.atlassian.net",
        email: "bot@example.com",
        api_key: "jira-token",
        project_keys: ["ENG"],
      },
    },
    {},
  );
  assert.ok(createTrackerClient(jira) instanceof JiraClient);

  const jiraMcp = parseConfig(
    {
      tracker: {
        kind: "jira-mcp",
        project_keys: ["ENG"],
        mcp: { url: "http://127.0.0.1:5123/mcp" },
      },
    },
    {},
  );
  assert.ok(createTrackerClient(jiraMcp) instanceof JiraMcpClient);
});

test("tracker factory rejects unregistered tracker kinds with the known kinds", () => {
  const settings = parseConfig({ tracker: { kind: "github" } }, {});
  assert.throws(
    () => createTrackerClient(settings),
    /unsupported tracker\.kind: github \(known kinds: jira, jira-mcp, linear, local, memory, slack\)/,
  );
});

test("tracker factory selects local adapter from the workflow-local fixture", async () => {
  const raw = await readFile(
    path.join(import.meta.dirname, "../../../test/fixtures/workflow-local.md"),
    "utf8",
  );
  const settings = parseConfig(frontmatter(raw), {});
  assert.equal(settings.tracker.kind, "local");
  assert.ok(createTrackerClient(settings) instanceof LocalTrackerClient);
});

test("shipped WORKFLOW.local.md selects a local tracker client with a real playbook body", async () => {
  const raw = await readFile(path.join(import.meta.dirname, "../../../WORKFLOW.local.md"), "utf8");
  const settings = parseConfig(frontmatter(raw), {});
  assert.equal(settings.tracker.kind, "local");
  assert.equal(settings.tracker.options.path, ".symphony/local/symphony");
  assert.ok(createTrackerClient(settings) instanceof LocalTrackerClient);

  const prose = body(raw);
  assert.ok(prose.split("\n").length > 20, "local playbook body should be a real playbook");
  assert.match(prose, /local_update_status/);
  assert.match(prose, /local_comment/);
  assert.match(prose, /local_create_issue/);
  assert.notMatch(prose, /stop and ask the user to configure Linear/i);

  // A worker only has its cloned repo workspace + the rendered issue context, not the
  // daemon's board directory, so the playbook must NOT instruct reading the board file for
  // state. State comes from the rendered `Current status` line instead. (A passing
  // "BOARD-<n>.md" reference is fine; an instruction to READ it for state is not.)
  assert.notMatch(prose, /read the issue file/i);
  assert.notMatch(prose, /read .*BOARD-<n>\.md/i);
  assert.match(prose, /Current status/);
});

test("tracker factory selects slack adapter from the workflow-slack fixture", async () => {
  const raw = await readFile(
    path.join(import.meta.dirname, "../../../test/fixtures/workflow-slack.md"),
    "utf8",
  );
  const settings = parseConfig(frontmatter(raw), {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_BOT_USER_ID: "U999",
  });
  assert.equal(settings.tracker.kind, "slack");
  assert.deepEqual(slackTrackerOptions(settings).channels, ["C0123456789"]);
  assert.equal(slackTrackerOptions(settings).botUserId, "U999");
  assert.ok(createTrackerClient(settings) instanceof SlackTrackerClient);
});

test("shipped WORKFLOW.slack.md selects a slack tracker client with a real playbook body", async () => {
  const raw = await readFile(path.join(import.meta.dirname, "../../../WORKFLOW.slack.md"), "utf8");
  const settings = parseConfig(frontmatter(raw), {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_BOT_USER_ID: "U999",
  });
  assert.equal(settings.tracker.kind, "slack");
  assert.deepEqual(slackTrackerOptions(settings).channels, ["C0123456789"]);
  assert.equal(slackTrackerOptions(settings).botUserId, "U999");
  assert.deepEqual(slackTrackerOptions(settings).emojiStates, {
    eyes: "In Progress",
    white_check_mark: "Done",
    x: "Cancelled",
  });
  assert.ok(createTrackerClient(settings) instanceof SlackTrackerClient);

  const prose = body(raw);
  assert.ok(prose.split("\n").length > 20, "slack playbook body should be a real playbook");
  assert.match(prose, /slack_update_status/);
  assert.match(prose, /slack_comment/);
  assert.notMatch(prose, /stop and ask the user to configure Linear/i);
});
