import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseConfig as parseWorkflowConfig } from "@symphony/config";
import type { Settings } from "@symphony/domain";
import { registerLinearTracker } from "@symphony/linear-tracker";
import { registerLocalTracker } from "@symphony/local-tracker";
import { ToolRegistry } from "@symphony/tool-sdk";
import { createTrackerToolProvider, TrackerRegistry } from "@symphony/tracker-sdk";
import { Hono } from "hono";
import { test } from "vitest";
import { assert } from "@symphony/test-utils";

import { createMcpAuthScope, issueMcpToken, mountMcp, revokeMcpToken } from "@symphony/mcp";

// Private registries so the mount is exercised without mutating the process defaults.
const trackers = new TrackerRegistry();
const tools = new ToolRegistry();
registerLinearTracker({ trackers, tools });
registerLocalTracker({ trackers, tools });
tools.register(createTrackerToolProvider(trackers));

const NEUTRAL_TOOLS = [
  "tracker_read_issue",
  "tracker_query",
  "tracker_update_status",
  "tracker_comment",
  "tracker_create_issue",
];

function linearSettings(): Settings {
  return parseWorkflowConfig(
    { tracker: { kind: "linear", api_key: "linear-token", project_slug: "mono" } },
    {},
    {},
    trackers,
  );
}

async function localSettings(): Promise<Settings> {
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-mount-thunk-local-"));
  await mkdir(dir, { recursive: true });
  return parseWorkflowConfig({ tracker: { kind: "local", path: dir } }, {}, {}, trackers);
}

async function toolsListNames(app: Hono, token: string): Promise<string[]> {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { result?: { tools?: Array<{ name?: string }> } };
  return (body.result?.tools ?? []).map((tool) => tool.name ?? "");
}

test("mountMcp resolves a settings thunk on every request", async () => {
  // A long-lived mount (the observability server) must serve the workflow settings the
  // runtime has CURRENTLY loaded, not the snapshot taken when the app was built: agent
  // sessions are routed to that mount whenever the configured server port is already
  // serving, so a stale snapshot would freeze the advertised tool packs across hot reloads.
  let current = linearSettings();
  const app = new Hono();
  const authScope = createMcpAuthScope();
  mountMcp(app, () => current, { authScope, tools });
  const token = issueMcpToken(authScope);

  try {
    assert.deepEqual(await toolsListNames(app, token), [...NEUTRAL_TOOLS, "linear_graphql"]);

    current = await localSettings();
    assert.deepEqual(await toolsListNames(app, token), [
      ...NEUTRAL_TOOLS,
      "local_update_status",
      "local_comment",
      "local_create_issue",
      "local_read_issue",
      "local_query",
    ]);
  } finally {
    revokeMcpToken(token);
  }
});

test("mountMcp serves plain settings unchanged", async () => {
  const app = new Hono();
  const authScope = createMcpAuthScope();
  mountMcp(app, linearSettings(), { authScope, tools });
  const token = issueMcpToken(authScope);

  try {
    assert.deepEqual(await toolsListNames(app, token), [...NEUTRAL_TOOLS, "linear_graphql"]);
  } finally {
    revokeMcpToken(token);
  }
});
