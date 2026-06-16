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
import { createTrackerToolProvider, TrackerRegistry } from "@lorenz/tracker-sdk";
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
registerJiraTrackers({ trackers });
tools.register(createTrackerToolProvider(trackers));

const TRACKER_TOOL_NAMES = [
  "tracker_read_issue",
  "tracker_query",
  "tracker_update_status",
  "tracker_list_comments",
  "tracker_comment",
  "tracker_update_comment",
  "tracker_create_issue",
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
  return toolSpecs(settings, tools).map((spec) => spec.name);
}

test("default mount advertises the tracker pack plus the dispatch tracker's own pack", async () => {
  assert.deepEqual(specNames(linearSettings()), [...TRACKER_TOOL_NAMES, "linear_graphql"]);
  assert.deepEqual(specNames(await localSettings()), [...TRACKER_TOOL_NAMES, ...LOCAL_TOOL_NAMES]);

  // Jira backends have no pack of their own; only the neutral tracker pack is mounted.
  assert.deepEqual(
    specNames(settingsFor("jira", { base_url: "https://jira.example.com" })),
    TRACKER_TOOL_NAMES,
  );
  assert.deepEqual(
    specNames(settingsFor("jira-mcp", { base_url: "https://jira.example.com" })),
    TRACKER_TOOL_NAMES,
  );

  // The neutral pack still mounts for memory, but the backend exposes no tool ops.
  assert.deepEqual(specNames(settingsFor("memory")), []);
});

test("explicit tools map adds extra mounted packs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-tools-extra-"));
  await mkdir(dir, { recursive: true });
  assert.deepEqual(specNames(linearSettings({ tools: { local: { path: dir } } })), [
    ...TRACKER_TOOL_NAMES,
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
        supportedTools: [...TRACKER_TOOL_NAMES, "linear_graphql"],
      },
    },
  });

  // Memory mounts only the neutral pack, which advertises nothing.
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

test("common tracker tools work against the local board provider", async () => {
  const settings = await localSettings();
  const run = (name: string, input: unknown) => executeTool(name, input, settings, fetch, tools);

  const created = await run("tracker_create_issue", {
    title: "Common",
    body: "details",
    status: "Todo",
  });
  assert.equal(created.success, true);

  const moved = await run("tracker_update_status", { issueId: "BOARD-1", status: "In Progress" });
  assert.equal(moved.success, true);

  const commented = await run("tracker_comment", {
    issueId: "BOARD-1",
    body: "using common tools",
  });
  assert.equal(commented.success, true);

  const read = await run("tracker_read_issue", { issueId: "BOARD-1" });
  assert.equal(read.success, true);
  assert.equal((read.result as { issue: { state: string } }).issue.state, "In Progress");

  const queried = await run("tracker_query", { select: ["id", "state"] });
  assert.equal(queried.success, true);
  assert.deepEqual((queried.result as { rows: Array<{ id: string }> }).rows[0], {
    id: "BOARD-1",
    state: "In Progress",
  });
});

test("common tracker comment tools work against the Linear provider", async () => {
  const settings = linearSettings();
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  let commentListCalls = 0;
  const fakeFetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    calls.push({ query: body.query ?? "", variables: body.variables ?? {} });

    if (body.query?.includes("commentCreate")) {
      return jsonResponse({
        data: {
          commentCreate: {
            success: true,
            comment: {
              id: "comment-created",
              body: "New workpad",
              createdAt: "2026-06-01T00:00:00Z",
              updatedAt: "2026-06-01T00:00:00Z",
              url: "https://linear.app/team/issue/ENG-1#comment-comment-created",
              user: { id: "user-1", name: "Worker", email: "worker@example.com" },
            },
          },
        },
      });
    }

    if (body.query?.includes("LorenzTrackerLinearComments")) {
      commentListCalls += 1;
      return jsonResponse({
        data: {
          issue: {
            comments:
              commentListCalls === 1
                ? {
                    nodes: [
                      {
                        id: "comment-old",
                        body: "Older comment",
                        createdAt: "2026-05-01T00:00:00Z",
                        updatedAt: "2026-05-01T00:00:00Z",
                        url: "https://linear.app/team/issue/ENG-1#comment-comment-old",
                        user: { id: "user-1", name: "Worker", email: "worker@example.com" },
                      },
                    ],
                    pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                  }
                : {
                    nodes: [
                      {
                        id: "comment-1",
                        body: "## Codex Workpad",
                        createdAt: "2026-06-01T00:00:00Z",
                        updatedAt: "2026-06-01T00:00:00Z",
                        url: "https://linear.app/team/issue/ENG-1#comment-comment-1",
                        user: { id: "user-1", name: "Worker", email: "worker@example.com" },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
          },
        },
      });
    }

    return jsonResponse({
      data: {
        commentUpdate: {
          success: true,
          comment: {
            id: "comment-1",
            body: "Updated workpad",
            createdAt: "2026-06-01T00:00:00Z",
            updatedAt: "2026-06-02T00:00:00Z",
            url: "https://linear.app/team/issue/ENG-1#comment-comment-1",
            user: { id: "user-1", name: "Worker", email: "worker@example.com" },
          },
        },
      },
    });
  };

  const created = await executeTool(
    "tracker_comment",
    { issueId: "issue-1", body: "New workpad" },
    settings,
    fakeFetch,
    tools,
  );
  assert.equal(created.success, true);
  assert.equal(
    (created.result as { comment: { id: string; body: string } }).comment.id,
    "comment-created",
  );

  const listed = await executeTool(
    "tracker_list_comments",
    { issueId: "issue-1" },
    settings,
    fakeFetch,
    tools,
  );
  assert.equal(listed.success, true);
  const comments = (listed.result as { comments: Array<{ id: string; body: string }> }).comments;
  assert.deepEqual(
    comments.map((comment) => comment.id),
    ["comment-old", "comment-1"],
  );
  assert.equal(comments[1]?.body, "## Codex Workpad");

  const updated = await executeTool(
    "tracker_update_comment",
    { issueId: "issue-1", commentId: "comment-1", body: "Updated workpad" },
    settings,
    fakeFetch,
    tools,
  );
  assert.equal(updated.success, true);
  const comment = (updated.result as { comment: { id: string; body: string } }).comment;
  assert.equal(comment.id, "comment-1");
  assert.equal(comment.body, "Updated workpad");
  assert.deepEqual(
    calls.map((call) => call.variables),
    [
      { input: { issueId: "issue-1", body: "New workpad" } },
      { id: "issue-1", after: null },
      { id: "issue-1", after: "cursor-1" },
      { id: "comment-1", input: { body: "Updated workpad" } },
    ],
  );
});

test("a throwing pack surfaces as a failed tool result, not a thrown error", async () => {
  const boomTools = new ToolRegistry();
  boomTools.register({
    name: "tracker",
    toolSpecs: () => [],
    executeTool: async () => ({ success: false }),
  });
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
