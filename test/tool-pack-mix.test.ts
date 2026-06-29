import fs from "node:fs/promises";
import path from "node:path";

import { test } from "vitest";
import { parseConfig, validateDispatchConfig } from "@lorenz/config";
import type { Issue, Settings } from "@lorenz/domain";
import { AgentExecutorRegistry, type AgentExecutorProvider } from "@lorenz/agent-sdk";
import { executeTool, mountedSkillSources, toolSpecs } from "@lorenz/mcp";
import { registerJiraTrackers } from "@lorenz/jira-tracker";
import { registerLinearTracker } from "@lorenz/linear-tracker";
import { registerLocalTracker } from "@lorenz/local-tracker";
import { ToolRegistry, type ToolProvider } from "@lorenz/tool-sdk";
import { TrackerRegistry } from "@lorenz/tracker-sdk";
import { assert, tempDir } from "@lorenz/test-utils";

/**
 * Tool mounting is tracker-aligned: a dispatch tracker gets the default packs declared by its
 * provider (jira owns the `jira_*` pack; linear owns `linear_graphql`; local owns the board
 * tools). A workflow can still explicitly mount additional registered packs with its `tools:` map.
 */

// Stand-in for the composition root's executor registration; the default agent records
// select the "acp" executor, and this test only needs validation to pass.
const stubExecutorProvider: AgentExecutorProvider = {
  executor: "acp",
  createExecutor: () => {
    throw new Error("not under test");
  },
};

const JIRA_TOOL_NAMES = [
  "jira_read_issue",
  "jira_query",
  "jira_update_status",
  "jira_list_comments",
  "jira_comment",
  "jira_update_comment",
  "jira_create_issue",
];

const LOCAL_TOOL_NAMES = [
  "local_update_status",
  "local_comment",
  "local_create_issue",
  "local_read_issue",
  "local_query",
];

function executorRegistry(): AgentExecutorRegistry {
  const registry = new AgentExecutorRegistry();
  registry.register(stubExecutorProvider);
  return registry;
}

function builtinRegistries(): { trackers: TrackerRegistry; tools: ToolRegistry } {
  const trackers = new TrackerRegistry();
  const tools = new ToolRegistry();
  registerJiraTrackers({ trackers, tools });
  registerLinearTracker({ trackers, tools });
  registerLocalTracker({ trackers, tools });
  return { trackers, tools };
}

function parseWorkflow(trackers: TrackerRegistry, raw: Record<string, unknown>): Settings {
  return parseConfig(raw, {}, {}, trackers);
}

function parseJira(trackers: TrackerRegistry, extraConfig: Record<string, unknown> = {}): Settings {
  return parseWorkflow(trackers, {
    tracker: { kind: "dispatch" },
    trackers: {
      dispatch: {
        provider: "jira",
        base_url: "https://example.atlassian.net",
        email: "bot@example.com",
        api_key: "jira-token",
        project_keys: ["ENG"],
        active_states: ["To Do"],
      },
    },
    ...extraConfig,
  });
}

function parseLinear(
  trackers: TrackerRegistry,
  extraConfig: Record<string, unknown> = {},
): Settings {
  return parseWorkflow(trackers, {
    tracker: { kind: "dispatch" },
    trackers: {
      dispatch: { provider: "linear", api_key: "dispatch-linear-token", project_slug: "mono" },
    },
    ...extraConfig,
  });
}

function specNames(settings: Settings, tools: ToolRegistry, trackers: TrackerRegistry): string[] {
  return toolSpecs(settings, tools, trackers).map((spec) => spec.name);
}

test("mounting the linear pack contributes its bundled lorenz-linear skill", async () => {
  const { trackers, tools } = builtinRegistries();
  const settings = parseJira(trackers, { tools: { linear: { api_key: "linear-token" } } });

  const skills = mountedSkillSources(settings, tools, trackers);
  const linearSkill = skills.find((dir) => path.basename(dir) === "lorenz-linear");
  assert.ok(linearSkill, "linear pack should bundle the lorenz-linear skill");
  assert.equal((await fs.stat(path.join(linearSkill, "SKILL.md"))).isFile(), true);
});

test("a workflow without the linear pack contributes no bundled skills", () => {
  const { trackers, tools } = builtinRegistries();
  const settings = parseJira(trackers);
  assert.deepEqual(mountedSkillSources(settings, tools, trackers), []);
});

test("a jira-dispatch workflow mounts the jira pack", () => {
  const { trackers, tools } = builtinRegistries();
  const settings = parseJira(trackers);
  validateDispatchConfig(settings, trackers, executorRegistry(), tools);

  assert.equal(settings.tracker.kind, "jira");
  assert.deepEqual(specNames(settings, tools, trackers), JIRA_TOOL_NAMES);
});

test("explicit tools map can mount packs outside the dispatch tracker", () => {
  const { trackers, tools } = builtinRegistries();
  const settings = parseJira(trackers, {
    tools: { linear: { api_key: "linear-token" }, local: { path: "/tmp/board" } },
  });
  validateDispatchConfig(settings, trackers, executorRegistry(), tools);

  assert.deepEqual(specNames(settings, tools, trackers), [
    ...JIRA_TOOL_NAMES,
    "linear_graphql",
    ...LOCAL_TOOL_NAMES,
  ]);
});

test("a linear-dispatch workflow mounts only linear_graphql", async () => {
  const { trackers, tools } = builtinRegistries();
  const settings = parseLinear(trackers, {
    tools: { linear: { api_key: "pack-linear-token" } },
  });
  validateDispatchConfig(settings, trackers, executorRegistry(), tools);

  assert.deepEqual(specNames(settings, tools, trackers), ["linear_graphql"]);

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
  assert.equal(calls[0]?.authorization, "pack-linear-token");
});

test("linear_graphql falls back to tracker auth only when Linear drives dispatch", async () => {
  const { trackers, tools } = builtinRegistries();
  const settings = parseLinear(trackers);
  validateDispatchConfig(settings, trackers, executorRegistry(), tools);

  const authorizations: Array<string | null> = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    authorizations.push(new Headers(init?.headers).get("authorization"));
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

  assert.equal(result.success, true);
  assert.deepEqual(authorizations, ["dispatch-linear-token"]);
});

test("a linear tool call on a foreign dispatch tracker is unsupported, not borrowed", async () => {
  const { trackers, tools } = builtinRegistries();
  const settings = parseJira(trackers);

  const calls: string[] = [];
  const fakeFetch: typeof fetch = async () => {
    calls.push("called");
    return new Response("{}", { status: 200 });
  };

  const result = await executeTool(
    "linear_graphql",
    { query: "query Me { viewer { id } }" },
    settings,
    fakeFetch,
    tools,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Unsupported tool: "linear_graphql"/);
  assert.equal(calls.length, 0);
});

test("an explicitly mounted linear pack on a foreign tracker uses only pack auth", async () => {
  const { trackers, tools } = builtinRegistries();
  const missingAuth = parseJira(trackers, { tools: { linear: {} } });
  validateDispatchConfig(missingAuth, trackers, executorRegistry(), tools);

  const callsWithoutAuth: string[] = [];
  const noAuthResult = await executeTool(
    "linear_graphql",
    { query: "query Me { viewer { id } }" },
    missingAuth,
    async () => {
      callsWithoutAuth.push("called");
      return new Response("{}", { status: 200 });
    },
    tools,
    trackers,
  );
  assert.equal(noAuthResult.success, false);
  assert.match(noAuthResult.error ?? "", /missing Linear auth/);
  assert.equal(callsWithoutAuth.length, 0);

  const withAuth = parseJira(trackers, { tools: { linear: { api_key: "pack-token" } } });
  validateDispatchConfig(withAuth, trackers, executorRegistry(), tools);
  const authorizations: Array<string | null> = [];
  const ok = await executeTool(
    "linear_graphql",
    { query: "query Me { viewer { id } }" },
    withAuth,
    async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({ data: { viewer: { id: "user-1" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    tools,
    trackers,
  );
  assert.equal(ok.success, true);
  assert.deepEqual(authorizations, ["pack-token"]);
});

test("the linear pack rejects unknown option keys and wrong types", () => {
  const { trackers, tools } = builtinRegistries();

  const unknownKey = parseLinear(trackers, {
    tools: { linear: { surprise: true } },
  });
  assert.throws(
    () => validateDispatchConfig(unknownKey, trackers, executorRegistry(), tools),
    /tools\.linear\.surprise is not supported \(known keys: apiKey, api_key, endpoint\)/,
  );

  const wrongType = parseLinear(trackers, {
    tools: { linear: { api_key: 5 } },
  });
  assert.throws(
    () => validateDispatchConfig(wrongType, trackers, executorRegistry(), tools),
    /tools\.linear\.api_key must be a string/,
  );
});

test("local dispatch mounts only local board tools", async () => {
  const { trackers, tools } = builtinRegistries();
  const boardDir = await tempDir("lorenz-tool-pack-mix-board");
  const settings = parseWorkflow(trackers, {
    tracker: { kind: "dispatch" },
    trackers: { dispatch: { provider: "local" } },
    tools: { local: { path: boardDir } },
  });
  validateDispatchConfig(settings, trackers, executorRegistry(), tools);

  assert.deepEqual(specNames(settings, tools, trackers), [...LOCAL_TOOL_NAMES]);

  const created = await executeTool(
    "local_create_issue",
    { title: "Sweep the board", body: "Tracker-aligned round trip." },
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
});

test("a tracker-aligned tool-name collision fails loudly at mount time", () => {
  const trackers = new TrackerRegistry();
  const tools = new ToolRegistry();
  // Jira owns the `jira_*` pack (registered under the name "jira").
  registerJiraTrackers({ trackers, tools });

  const collidingPack: ToolProvider = {
    name: "linear",
    toolSpecs: () => [
      { name: "jira_read_issue", description: "Shadows the jira pack.", inputSchema: {} },
    ],
    executeTool: async () => ({ success: true }),
  };
  tools.register(collidingPack);

  // Dispatch on jira (mounts the "jira" pack) and also mount the colliding "linear" pack
  // via the tools map, so both declare jira_read_issue.
  const settings = parseJira(trackers, { tools: { linear: {} } });
  assert.throws(
    () => toolSpecs(settings, tools, trackers),
    /tool name collision: jira_read_issue is declared by both the "jira" and "linear" packs/,
  );
});
