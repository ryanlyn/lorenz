import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { test } from "vitest";
import { parseConfig } from "@lorenz/config";
import type { Settings } from "@lorenz/domain";
import { registerJiraTrackers } from "@lorenz/jira-tracker";
import { registerLinearTracker } from "@lorenz/linear-tracker";
import { registerLocalTracker } from "@lorenz/local-tracker";
import { registerMemoryTracker } from "@lorenz/memory-tracker";
import { ToolRegistry } from "@lorenz/tool-sdk";
import { TrackerRegistry } from "@lorenz/tracker-sdk";
import { assert } from "@lorenz/test-utils";

import { executeTool, toolSpecs } from "@lorenz/mcp";

// Private registries holding the providers this contract exercises, so the mount contract
// is exercised exactly as composed in production without mutating the process-default
// registries.
const trackers = new TrackerRegistry();
const tools = new ToolRegistry();
registerLinearTracker({ trackers, tools });
registerLocalTracker({ trackers, tools });
registerMemoryTracker({ trackers });
registerJiraTrackers({ trackers, tools });

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

function settingsFor(
  provider: string,
  options: Record<string, unknown> = {},
  rest: Record<string, unknown> = {},
): Settings {
  return parseConfig(
    { tracker: { kind: "dispatch" }, trackers: { dispatch: { provider, ...options } }, ...rest },
    {},
    {},
    trackers,
  );
}

function linearSettings(rest: Record<string, unknown> = {}): Settings {
  return settingsFor("linear", { api_key: "linear-token", project_slug: "mono" }, rest);
}

async function localSettings(): Promise<Settings> {
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-tools-contract-"));
  await mkdir(dir, { recursive: true });
  return settingsFor("local", { path: dir });
}

function specNames(settings: Settings): string[] {
  return toolSpecs(settings, tools, trackers).map((spec) => spec.name);
}

test("default mount advertises only the dispatch tracker's own pack", async () => {
  // Linear and local own bespoke packs; only those mount (no provider-neutral pack).
  assert.deepEqual(specNames(linearSettings()), ["linear_graphql"]);
  assert.deepEqual(specNames(await localSettings()), [...LOCAL_TOOL_NAMES]);

  // Jira backends own the `jira_*` pack and mount it via defaultToolPacks.
  assert.deepEqual(
    specNames(settingsFor("jira", { base_url: "https://jira.example.com" })),
    JIRA_TOOL_NAMES,
  );
  assert.deepEqual(
    specNames(settingsFor("jira-mcp", { base_url: "https://jira.example.com" })),
    JIRA_TOOL_NAMES,
  );

  // Memory ships no pack, so nothing mounts.
  assert.deepEqual(specNames(settingsFor("memory")), []);
});

test("explicit tools map adds extra mounted packs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-tools-extra-"));
  await mkdir(dir, { recursive: true });
  assert.deepEqual(specNames(linearSettings({ tools: { local: { path: dir } } })), [
    "linear_graphql",
    ...LOCAL_TOOL_NAMES,
  ]);
});

test("unknown tool names fail listing every mounted tool", async () => {
  assert.deepEqual(await executeTool("unknown", {}, linearSettings(), fetch, tools), {
    success: false,
    error: 'Unsupported tool: "unknown".',
    result: {
      error: {
        message: 'Unsupported tool: "unknown".',
        supportedTools: ["linear_graphql"],
      },
    },
  });

  // Memory mounts no pack, so it advertises nothing.
  assert.deepEqual(await executeTool("memory_bogus", {}, settingsFor("memory"), fetch, tools), {
    success: false,
    error: 'Unsupported tool: "memory_bogus".',
    result: {
      error: {
        message: 'Unsupported tool: "memory_bogus".',
        supportedTools: [],
      },
    },
  });
});

test("the jira pack advertises the jira_* tools", () => {
  assert.deepEqual(
    specNames(settingsFor("jira", { base_url: "https://jira.example.com" })),
    JIRA_TOOL_NAMES,
  );
});

test("a throwing pack surfaces as a failed tool result, not a thrown error", async () => {
  const boomTools = new ToolRegistry();
  boomTools.register({
    name: "boom",
    toolSpecs: () => [
      { name: "boom_tool", description: "always throws", inputSchema: { type: "object" } },
    ],
    executeTool: async () => {
      throw new Error("pack exploded");
    },
  });

  const settings = settingsFor("boom");
  const result = await executeTool("boom_tool", {}, settings, fetch, boomTools);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /pack exploded/);
});
