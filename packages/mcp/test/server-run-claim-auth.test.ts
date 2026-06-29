import { parseConfig as parseWorkflowConfig } from "@lorenz/config";
import type { Settings } from "@lorenz/domain";
import { registerJiraTrackers } from "@lorenz/jira-tracker";
import { ToolRegistry } from "@lorenz/tool-sdk";
import { TrackerRegistry } from "@lorenz/tracker-sdk";
import { Hono } from "hono";
import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import {
  createMcpAuthScope,
  issueMcpToken,
  issueRunMcpToken,
  mountMcp,
  revokeMcpToken,
  revokeRunClaim,
  type RunClaim,
} from "@lorenz/mcp";

// Private registries so the mount is exercised without mutating process defaults. These tests
// drive `jira_*` tool NAMES through the per-run claim/allowlist middleware, which authorizes
// by name before the tool is resolved, so the outcome is independent of which pack is mounted.
const trackers = new TrackerRegistry();
const tools = new ToolRegistry();
registerJiraTrackers({ trackers, tools });

function jiraSettings(): Settings {
  return parseWorkflowConfig(
    {
      tracker: {
        kind: "jira",
        base_url: "https://jira.example.com",
        email: "agent@example.com",
        api_key: "jira-token",
        project_keys: ["ENG"],
      },
    },
    {},
    {},
    trackers,
  );
}

const baseClaim = (overrides: Partial<RunClaim> = {}): RunClaim => ({
  runKey: "run-1",
  workerHost: "host-a",
  issueId: "ISSUE-1",
  generation: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
  settingsScope: "mcp:scope-a",
  ...overrides,
});

function mountWith(options: Parameters<typeof mountMcp>[2]): { app: Hono; authScope: string } {
  const app = new Hono();
  const authScope = createMcpAuthScope();
  mountMcp(app, jiraSettings(), { authScope, tools, ...options });
  return { app, authScope };
}

async function toolsListStatus(app: Hono, token: string): Promise<number> {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return response.status;
}

async function toolsCall(app: Hono, token: string, name: string): Promise<number> {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });
  return response.status;
}

test("Token B: a resolved, live, allowed claim authorizes the request", async () => {
  const { app } = mountWith({ isRunLive: () => true });
  const token = issueRunMcpToken(baseClaim({ allowedTools: ["jira_query"] }));
  try {
    assert.equal(await toolsCall(app, token, "jira_query"), 200);
  } finally {
    revokeRunClaim(token);
  }
});

test("Token B: a non-tool request (tools/list) is gated by the claim, not the allowlist", async () => {
  const { app } = mountWith({ isRunLive: () => true });
  const token = issueRunMcpToken(baseClaim({ allowedTools: ["jira_query"] }));
  try {
    assert.equal(await toolsListStatus(app, token), 200);
  } finally {
    revokeRunClaim(token);
  }
});

test("Token B: a disallowed tool/call is denied 401", async () => {
  const { app } = mountWith({ isRunLive: () => true });
  const token = issueRunMcpToken(baseClaim({ allowedTools: ["jira_query"] }));
  try {
    assert.equal(await toolsCall(app, token, "jira_update_status"), 401);
  } finally {
    revokeRunClaim(token);
  }
});

test("Token B: an expired claim is denied 401 even for a live, allowed tool", async () => {
  const { app } = mountWith({ isRunLive: () => true });
  const token = issueRunMcpToken(baseClaim({ expiresAt: 1_000, allowedTools: ["jira_query"] }));
  try {
    assert.equal(await toolsCall(app, token, "jira_query"), 401);
  } finally {
    revokeRunClaim(token);
  }
});

test("Token B: a non-live run is denied 401", async () => {
  const { app } = mountWith({ isRunLive: () => false });
  const token = issueRunMcpToken(baseClaim());
  try {
    assert.equal(await toolsListStatus(app, token), 401);
  } finally {
    revokeRunClaim(token);
  }
});

test("Token B: a stale generation is denied 401 via the injected liveness fence", async () => {
  // The injected oracle accepts only the current generation (2); the claim is stale (1).
  const { app } = mountWith({ isRunLive: (_run, _host, generation) => generation === 2 });
  const token = issueRunMcpToken(baseClaim({ generation: 1 }));
  try {
    assert.equal(await toolsListStatus(app, token), 401);
  } finally {
    revokeRunClaim(token);
  }
});

test("Token B: the injected oracle receives runKey, workerHost, and generation from the claim", async () => {
  let seen: [string, string, number] | null = null;
  const { app } = mountWith({
    isRunLive: (runKey, workerHost, generation) => {
      seen = [runKey, workerHost, generation];
      return true;
    },
  });
  const token = issueRunMcpToken(
    baseClaim({ runKey: "run-9", workerHost: "host-z", generation: 7 }),
  );
  try {
    await toolsListStatus(app, token);
    assert.deepEqual(seen, ["run-9", "host-z", 7]);
  } finally {
    revokeRunClaim(token);
  }
});

test("Token A authorizes on a NON-claim mount (observability / legacy acp endpoint)", async () => {
  // A mount with no injected oracle is not claim-enforcing: the settings-wide
  // Token A path stays available for the observability server and the legacy
  // acp/local endpoint, which never co-reside runs on a shared server.
  const { app, authScope } = mountWith({});
  const token = issueMcpToken(authScope);
  try {
    assert.equal(await toolsListStatus(app, token), 200);
  } finally {
    revokeMcpToken(token);
  }
});

test("A claim-enforcing mount REJECTS a valid Token A (no settings-wide bypass)", async () => {
  // A mount handed a real isRunLive oracle is the per-run claim-enforcing
  // (co-residence) server: it accepts ONLY Token B and refuses the Token A path
  // outright, so a settings-wide token can never authorize a co-resident run's
  // MCP calls.
  const { app, authScope } = mountWith({ isRunLive: () => true });
  const token = issueMcpToken(authScope);
  try {
    assert.equal(await toolsListStatus(app, token), 401);
  } finally {
    revokeMcpToken(token);
  }
});

test("Claim-enforcing mount: an unknown bearer (neither Token B nor Token A) is denied 401", async () => {
  const { app } = mountWith({ isRunLive: () => true });
  assert.equal(await toolsListStatus(app, "not-a-real-token"), 401);
});
