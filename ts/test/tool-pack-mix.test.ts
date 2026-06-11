import { test } from "vitest";
import { parseConfig, validateDispatchConfig } from "@symphony/config";
import type { Issue, Settings } from "@symphony/domain";
import { AgentExecutorRegistry, type AgentExecutorProvider } from "@symphony/agent-sdk";
import { executeTool, toolSpecs } from "@symphony/mcp";
import { registerJiraTrackers } from "@symphony/jira-tracker";
import { registerLinearTracker } from "@symphony/linear-tracker";
import { registerLocalTracker } from "@symphony/local-tracker";
import { ToolRegistry, type ToolProvider } from "@symphony/tool-sdk";
import { createTrackerToolProvider, TrackerRegistry } from "@symphony/tracker-sdk";
import { assert, tempDir } from "@symphony/test-utils";

/**
 * Mixed tool mounts are a user-facing contract: one tracker drives dispatch while the
 * `tools:` config list mounts any combination of packs on the MCP endpoint - e.g.
 * `tools: [tracker, linear, local]` on a Jira-dispatch deployment. Everything here runs
 * against private registries holding the jira, linear, and local extensions plus the
 * neutral tracker pack.
 */

// Stand-in for the composition root's executor registration; the default agent records
// select the "acp" executor, and this test only needs validation to pass.
const stubExecutorProvider: AgentExecutorProvider = {
  executor: "acp",
  createExecutor: () => {
    throw new Error("not under test");
  },
};

function executorRegistry(): AgentExecutorRegistry {
  const registry = new AgentExecutorRegistry();
  registry.register(stubExecutorProvider);
  return registry;
}

function builtinRegistries(): { trackers: TrackerRegistry; tools: ToolRegistry } {
  const trackers = new TrackerRegistry();
  const tools = new ToolRegistry();
  registerJiraTrackers({ trackers });
  registerLinearTracker({ trackers, tools });
  registerLocalTracker({ trackers, tools });
  tools.register(createTrackerToolProvider(trackers));
  return { trackers, tools };
}

function parseJiraWithPacks(packs: string[], trackers: TrackerRegistry): Settings {
  return parseConfig(
    {
      tracker: {
        kind: "jira",
        base_url: "https://example.atlassian.net",
        email: "bot@example.com",
        api_key: "jira-token",
        project_keys: ["ENG"],
        active_states: ["To Do"],
      },
      tools: packs,
    },
    {},
    {},
    trackers,
  );
}

test("a jira-dispatch workflow mounts the tracker, linear, and local packs side by side", async () => {
  const { trackers, tools } = builtinRegistries();
  const settings = parseJiraWithPacks(["tracker", "linear", "local"], trackers);
  validateDispatchConfig(settings, trackers, executorRegistry(), tools);

  assert.equal(settings.tracker.kind, "jira");
  assert.deepEqual(settings.tools, ["tracker", "linear", "local"]);

  const names = toolSpecs(settings, tools).map((spec) => spec.name);
  assert.deepEqual(names, [
    "tracker_read_issue",
    "tracker_query",
    "tracker_update_status",
    "tracker_comment",
    "tracker_create_issue",
    "linear_graphql",
    "local_update_status",
    "local_comment",
    "local_create_issue",
    "local_read_issue",
    "local_query",
  ]);
});

test("a linear tool call routes to the linear pack and uses its transport", async () => {
  const { trackers, tools } = builtinRegistries();
  const settings = parseJiraWithPacks(["tracker", "linear", "local"], trackers);

  // Stub transport: the assertion is the routing and the result envelope, not a live call.
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return new Response(JSON.stringify({ data: { viewer: { id: "user-1" } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await executeTool(
    "linear_graphql",
    { query: "query Me { viewer { id } }" },
    settings,
    fakeFetch,
    tools,
  );

  assert.deepEqual(result, { success: true, result: { data: { viewer: { id: "user-1" } } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.linear.app/graphql");
  // The pack runs on the workflow's shared tracker credential.
  assert.equal(calls[0]?.authorization, "jira-token");
});

test("local pack tools round-trip a real board directory while jira drives dispatch", async () => {
  const { trackers, tools } = builtinRegistries();
  const settings = parseJiraWithPacks(["tracker", "linear", "local"], trackers);
  const boardDir = await tempDir("symphony-ts-tool-pack-mix-board");
  // The local pack reads its board location from `tracker.path`, which a jira-dispatch
  // config cannot carry (jira rejects unknown tracker options); point it at a temp board
  // the way a local-dispatch deployment would.
  settings.tracker.options = { ...settings.tracker.options, path: boardDir };

  const created = await executeTool(
    "local_create_issue",
    { title: "Sweep the board", body: "Mixed-mount round trip." },
    settings,
    fetch,
    tools,
  );
  assert.equal(created.success, true);
  const issue = (created.result as { issue: Issue }).issue;

  const moved = await executeTool(
    "local_update_status",
    { issueId: issue.id, status: "In Progress" },
    settings,
    fetch,
    tools,
  );
  assert.equal(moved.success, true);

  const read = await executeTool("local_read_issue", { issueId: issue.id }, settings, fetch, tools);
  assert.equal(read.success, true);
  const readIssue = (read.result as { issue: { id: string; status: string; title: string } }).issue;
  assert.equal(readIssue.id, issue.id);
  assert.equal(readIssue.status, "In Progress");
  assert.equal(readIssue.title, "Sweep the board");

  // Dispatch config is untouched by the tool round trip.
  assert.equal(settings.tracker.kind, "jira");
});

test("an unknown pack name fails dispatch validation with the known pack list", () => {
  const { trackers, tools } = builtinRegistries();
  const settings = parseJiraWithPacks(["tracker", "gitlab"], trackers);
  assert.throws(
    () => validateDispatchConfig(settings, trackers, executorRegistry(), tools),
    /unsupported tool pack: gitlab \(known tool packs: linear, local, tracker\)/,
  );
});

test("a cross-pack tool-name collision fails loudly at mount time", () => {
  const { trackers, tools } = builtinRegistries();
  const collidingPack: ToolProvider = {
    name: "collider",
    toolSpecs: () => [
      { name: "linear_graphql", description: "Shadows the linear pack.", inputSchema: {} },
    ],
    executeTool: async () => ({ success: true }),
  };
  tools.register(collidingPack);

  const settings = parseJiraWithPacks(["linear", "collider"], trackers);
  assert.throws(
    () => toolSpecs(settings, tools),
    /tool name collision: linear_graphql is declared by both the "linear" and "collider" packs/,
  );
});
