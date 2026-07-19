import { readFile } from "node:fs/promises";
import path from "node:path";

import { discordTrackerOptions } from "@lorenz/discord-tracker";
import { LocalTrackerClient } from "@lorenz/local-tracker";
import { SlackTrackerClient, slackTrackerOptions } from "@lorenz/slack-tracker";
import { beforeAll, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { assert } from "@lorenz/test-utils";
import {
  MULTI_TRACKER_KIND,
  scopedTrackerIssueId,
  type Issue,
  type RuntimeTrackerClient,
  type TrackerSettings,
} from "@lorenz/domain";
import { TrackerRegistry, type TrackerProvider } from "@lorenz/tracker-sdk";
import { toolSpecs } from "@lorenz/mcp";

import { registerBuiltinBackends } from "../src/daemon.js";

import {
  createTrackerClient,
  defaultSettings,
  JiraClient,
  JiraMcpClient,
  memoryIssuesFromEnv,
  MemoryTrackerClient,
  MultiTrackerClient,
  parseConfig,
  settingsForTrackerIssue,
} from "@lorenz/cli";

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
      labels: ["Lorenz:Backend"],
    },
    { id: "two", identifier: "MT-2", title: "Two", state: "Done", stateType: "completed" },
  ]);

  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(
    candidates.map((issue) => issue.identifier),
    ["MT-1", "MT-2"],
  );
  assert.deepEqual(candidates[0]?.labels, ["lorenz:backend"]);

  candidates[0]!.labels.push("mutated");
  const byId = await client.fetchIssuesByIds(["two", "missing", "one"]);
  assert.deepEqual(
    byId.map((issue) => issue.identifier),
    ["MT-1", "MT-2"],
  );
  assert.deepEqual((await client.fetchCandidateIssues())[0]?.labels, ["lorenz:backend"]);
});

test("multi-tracker adapter scopes ids, routes reads and acknowledgements, and composes watches", async () => {
  const registry = new TrackerRegistry();
  const acknowledged: string[] = [];
  const fetched: Record<string, string[][]> = { first: [], second: [] };
  const closed: string[] = [];
  let notify: (() => void) | undefined;

  const clientFor = (source: "first" | "second"): RuntimeTrackerClient => {
    const issue: Issue = {
      id: "same-id",
      identifier: `${source.toUpperCase()}-1`,
      title: source,
      state: source === "first" ? "Queued" : "Ready",
      stateType: "unstarted",
      labels: [],
      blockers: [],
    };
    return {
      fetchCandidateIssues: async () => [issue],
      fetchIssuesByIds: async (ids) => {
        fetched[source].push(ids);
        return ids.includes(issue.id) ? [issue] : [];
      },
      fetchIssuesByStates: async () => [issue],
      acknowledgeIssue: async (input) => {
        acknowledged.push(`${source}:${input.id}`);
        return true;
      },
      watch: async (onChange) => {
        notify = onChange;
        return { close: () => void closed.push(source) };
      },
    };
  };
  for (const source of ["first", "second"] as const) {
    registry.register({
      kind: source,
      createClient: () => clientFor(source),
    } satisfies TrackerProvider);
  }

  const settings = defaultSettings();
  const sourceSettings = (kind: string, activeStates: string[]): TrackerSettings => ({
    ...settings.tracker,
    kind,
    activeStates,
    terminalStates: ["Done"],
    dispatch: { ...settings.tracker.dispatch },
    options: {},
  });
  settings.tracker = {
    ...settings.tracker,
    kind: MULTI_TRACKER_KIND,
    options: { sources: ["first", "second"] },
  };
  settings.trackers = {
    first: sourceSettings("first", ["Queued"]),
    second: sourceSettings("second", ["Ready"]),
  };

  const client = new MultiTrackerClient(settings, {}, registry);
  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(
    candidates.map((issue) => issue.id),
    [scopedTrackerIssueId("first", "same-id"), scopedTrackerIssueId("second", "same-id")],
  );

  const secondId = scopedTrackerIssueId("second", "same-id");
  const firstId = scopedTrackerIssueId("first", "same-id");
  const byId = await client.fetchIssuesByIds([secondId, firstId]);
  assert.deepEqual(
    byId.map((issue) => issue.id),
    [secondId, firstId],
  );
  assert.deepEqual(fetched.first, [["same-id"]]);
  assert.deepEqual(fetched.second, [["same-id"]]);

  assert.equal(await client.acknowledgeIssue(candidates[1]!), true);
  assert.deepEqual(acknowledged, ["second:same-id"]);
  const stream = await client.watch(() => void acknowledged.push("push"));
  assert.ok(stream);
  notify?.();
  assert.equal(acknowledged.at(-1), "push");
  await stream!.close();
  assert.deepEqual(closed, ["first", "second"]);
  await assert.rejects(() => client.fetchIssuesByIds(["same-id"]), /issue id is not scoped/);
});

test("tracker factory selects memory adapter from workflow settings and JSON env", async () => {
  const settings = parseConfig({ tracker: { kind: "memory" } }, {});
  const client = createTrackerClient(settings, {
    LORENZ_MEMORY_TRACKER_ISSUES_JSON: JSON.stringify([
      { id: "env", identifier: "MT-ENV", title: "Env", state: "Todo", stateType: "unstarted" },
    ]),
  });

  assert.ok(client instanceof MemoryTrackerClient);
  assert.deepEqual(
    (await client.fetchCandidateIssues()).map((issue) => issue.identifier),
    ["MT-ENV"],
  );
  assert.deepEqual(memoryIssuesFromEnv({ LORENZ_MEMORY_TRACKER_ISSUES_JSON: "[]" }), []);
  assert.throws(
    () => memoryIssuesFromEnv({ LORENZ_MEMORY_TRACKER_ISSUES_JSON: "{}" }),
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
    /unsupported tracker\.kind: github \(known kinds: discord, jira, jira-mcp, linear, local, memory, slack\)/,
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
  assert.equal(settings.tracker.options.path, ".lorenz/local/lorenz");
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

test("shipped WORKFLOW.chat.md composes Discord and Slack tracker clients", async () => {
  const raw = await readFile(path.join(import.meta.dirname, "../../../WORKFLOW.chat.md"), "utf8");
  const config = frontmatter(raw);
  const discordSettings = parseConfig(config, {
    DISCORD_BOT_TOKEN: "discord-token",
    DISCORD_GUILD_ID: "123456789012345678",
    DISCORD_CHANNEL_ID: "223456789012345678",
    DISCORD_BOT_USER_ID: "323456789012345678",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_CHANNEL_ID: "C0123456789",
    SLACK_BOT_USER_ID: "U999",
  });

  assert.equal(discordSettings.tracker.kind, "dispatch");
  const discordSource = { ...discordSettings, tracker: discordSettings.trackers.discord! };
  const slackSource = { ...discordSettings, tracker: discordSettings.trackers.slack! };
  assert.deepEqual(discordTrackerOptions(discordSource).channels, ["223456789012345678"]);
  assert.deepEqual(slackTrackerOptions(slackSource).channels, ["C0123456789"]);
  assert.ok(createTrackerClient(discordSettings) instanceof MultiTrackerClient);
  const discordTools = toolSpecs(
    settingsForTrackerIssue(
      discordSettings,
      scopedTrackerIssueId("discord", "223456789012345678:423456789012345678"),
    ),
  ).map((tool) => tool.name);
  const slackTools = toolSpecs(
    settingsForTrackerIssue(
      discordSettings,
      scopedTrackerIssueId("slack", "C0123456789:1717000000.000100"),
    ),
  ).map((tool) => tool.name);
  assert.ok(discordTools.includes("discord_read_thread"));
  assert.equal(discordTools.includes("slack_read_thread"), false);
  assert.ok(slackTools.includes("slack_read_thread"));
  assert.equal(slackTools.includes("discord_read_thread"), false);
  assert.equal(
    discordSettings.agents.codex?.options.bridgeCommand,
    'env CODEX_PATH="$(command -v codex)" codex-acp',
  );
  assert.deepEqual(discordSettings.agents.codex?.options.providerConfig, {
    shell_environment_policy: { inherit: "all" },
    model_reasoning_effort: "xhigh",
    service_tier: "flex",
    model: "gpt-5.6-sol",
  });
  assert.equal(discordSettings.agents.claude?.executor, "acp");
  assert.equal(
    discordSettings.agents.claude?.options.bridgeCommand,
    'env CLAUDE_CODE_EXECUTABLE="$(command -v claude)" claude-agent-acp',
  );

  const prose = body(raw);
  assert.match(prose, /discord_read_thread/);
  assert.match(prose, /slack_read_thread/);
  assert.notMatch(prose, /stop and ask the user to configure Linear/i);
});
