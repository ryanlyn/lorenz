import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { test, vi } from "vitest";
import {
  issueMcpToken,
  Orchestrator,
  parseConfig,
  revokeMcpToken,
  SymphonyRuntime,
} from "@symphony/cli";
import { normalizeIssue } from "@symphony/issue";
import type { WorkflowDefinition } from "@symphony/domain";
import { assert } from "@symphony/test-utils";

import { IssueStore, startObservabilityServer } from "@symphony/server";
import { startClaudeMcpServer } from "@symphony/server";

test("observability HTTP API exposes state, issue, runs, refresh, and errors", async () => {
  const workflow = workflowFixture();
  const orchestrator = new Orchestrator(workflow.settings);
  const issue = normalizeIssue({
    id: "issue-http",
    identifier: "MT-HTTP",
    title: "HTTP visibility",
    state: { name: "In Progress", type: "started" },
    labels: [],
    blockers: [],
  });
  const claimed = orchestrator.claim(issue);
  assert.ok(claimed);
  orchestrator.applyUpdate(issue.id, 0, {
    type: "session_notification",
    sessionId: "thread-http",
    resumeId: "thread-http",
    message: { sessionId: "thread-http", update: { sessionUpdate: "agent_message_chunk" } },
    usage: { inputTokens: 4, outputTokens: 8, totalTokens: 12 },
    timestamp: new Date("2026-05-05T00:00:01.000Z"),
  });

  const runtime = new SymphonyRuntime({
    workflow,
    orchestrator,
    client: {
      fetchCandidateIssues: async () => [],
      fetchIssuesByIds: async () => [],
    },
  });
  const server = await startObservabilityServer(runtime, {
    host: "127.0.0.1",
    port: 0,
    staticDir: "/tmp/nonexistent-dashboard-dist",
  });

  try {
    const state = await getJson(server.url("/api/v1/state"));
    assert.equal(state.counts.running, 1);
    assert.equal(state.running[0].issue_identifier, "MT-HTTP");
    assert.equal(state.running[0].tokens.total_tokens, 12);

    const issuePayload = await getJson(server.url("/api/v1/MT-HTTP"));
    assert.equal(issuePayload.status, "running");
    assert.equal(issuePayload.running.session_id, "thread-http");

    const encodedIssuePayload = await getJson(server.url("/api/v1/MT%2DHTTP"));
    assert.equal(encodedIssuePayload.status, "running");
    assert.equal(encodedIssuePayload.running.session_id, "thread-http");

    const runs = await getJson(server.url("/api/v1/runs"));
    assert.equal(runs.view, "runs");
    assert.equal(runs.summary.running, 1);
    assert.equal(runs.runs[0].issue_identifier, "MT-HTTP");
    assert.equal(runs.runs[0].outcome, "running");

    const dashboard = await getJson(server.url("/"), 503);
    assert.deepEqual(dashboard, {
      error: {
        code: "dashboard_not_built",
        message: "Dashboard assets not found. Run: pnpm build",
      },
    });

    const refresh = await postJson(server.url("/api/v1/refresh"));
    assert.equal(refresh.queued, true);
    assert.deepEqual(refresh.operations, ["poll", "reconcile"]);

    const methodNotAllowed = await postJson(server.url("/api/v1/runs"), 405);
    assert.deepEqual(methodNotAllowed, {
      error: { code: "method_not_allowed", message: "Method not allowed" },
    });

    const notFound = await getJson(server.url("/unknown"), 404);
    assert.deepEqual(notFound, { error: { code: "not_found", message: "Route not found" } });
  } finally {
    await server.stop();
  }
});

test("standalone Claude MCP server preserves route and JSON-RPC error contracts", async () => {
  const workflow = workflowFixture();
  const server = await startClaudeMcpServer(workflow.settings, { host: "127.0.0.1", port: 0 });
  const token = issueMcpToken(server.authScope);
  try {
    const missing = await getJson(server.url("/missing"), 404);
    assert.deepEqual(missing, { error: { code: "not_found", message: "Route not found" } });

    const wrongMethod = await getJson(server.url("/claude-mcp"), 405);
    assert.deepEqual(wrongMethod, {
      error: { code: "method_not_allowed", message: "Method not allowed" },
    });

    const badJson = await postRawMcp(server.url("/claude-mcp"), "{", 400, token);
    assert.deepEqual(badJson, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });

    const arrayBody = await postRawMcp(server.url("/claude-mcp"), "[]", 400, token);
    assert.deepEqual(arrayBody, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });

    const unknownMethod = await postMcp(
      server.url("/claude-mcp"),
      { jsonrpc: "2.0", id: 10, method: "tools/missing" },
      200,
      token,
    );
    assert.deepEqual(unknownMethod, {
      jsonrpc: "2.0",
      id: 10,
      error: { code: -32601, message: "Method not found: tools/missing" },
    });

    const invalidParams = await postMcp(
      server.url("/claude-mcp"),
      { jsonrpc: "2.0", id: 11, method: "tools/call", params: { arguments: {} } },
      200,
      token,
    );
    assert.deepEqual(invalidParams, {
      jsonrpc: "2.0",
      id: 11,
      error: { code: -32602, message: "Invalid params" },
    });
  } finally {
    revokeMcpToken(token);
    await server.stop();
  }
});

test("standalone Claude MCP server rejects top-level JSON arrays as parse errors", async () => {
  const workflow = workflowFixture();
  const server = await startClaudeMcpServer(workflow.settings, { host: "127.0.0.1", port: 0 });
  const token = issueMcpToken(server.authScope);
  try {
    const topLevelArray = await postRawMcp(server.url("/claude-mcp"), "[]", 400, token);
    assert.deepEqual(topLevelArray, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  } finally {
    revokeMcpToken(token);
    await server.stop();
  }
});

test("standalone Claude MCP server emits connectable URLs for wildcard and empty hosts", async () => {
  const workflow = workflowFixture();
  for (const host of ["0.0.0.0", ""] as const) {
    const server = await startClaudeMcpServer(workflow.settings, { host, port: 0 });
    try {
      assert.match(server.url("/claude-mcp"), /^http:\/\/127\.0\.0\.1:\d+\/claude-mcp$/);
    } finally {
      await server.stop();
    }
  }
});

test("observability HTTP API serves trace routes when issueStore is provided", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-http-issue-store-"));
  const traceDir = path.join(root, "traces");
  await mkdir(traceDir, { recursive: true });
  const issueStore = new IssueStore(path.join(root, "issues.db"));
  let server: Awaited<ReturnType<typeof startObservabilityServer>> | null = null;

  try {
    server = await startObservabilityServer(fakeRuntime("snapshot_unavailable"), {
      host: "127.0.0.1",
      port: 0,
      traceDir,
      issueStore,
      staticDir: "/tmp/nonexistent-dashboard-dist",
    });

    const response = await fetch(server.url("/api/v1/tickets"));
    assert.equal(response.status, 200);
    const tickets = await response.json();
    assert.deepEqual(tickets, { tickets: [] });
  } finally {
    await server?.stop();
    issueStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("observability HTTP API returns structured 400 for malformed issue identifiers", async () => {
  const server = await startObservabilityServer(fakeRuntime("snapshot_unavailable"), {
    host: "127.0.0.1",
    port: 0,
    staticDir: "/tmp/nonexistent-dashboard-dist",
  });
  try {
    const malformed = await getJson(server.url("/api/v1/%E0%A4%A"), 400);
    assert.deepEqual(malformed, {
      error: {
        code: "invalid_path_parameter",
        message: "Malformed percent encoding in path parameter",
      },
    });
  } finally {
    await server.stop();
  }
});

test("observability HTTP API matches snapshot timeout and unavailable branches", async () => {
  const unavailable = await startObservabilityServer(fakeRuntime("snapshot_unavailable"), {
    host: "127.0.0.1",
    port: 0,
    staticDir: "/tmp/nonexistent-dashboard-dist",
  });
  try {
    const state = await getJson(unavailable.url("/api/v1/state"));
    assert.equal(state.error.code, "snapshot_unavailable");
    assert.equal(state.error.message, "Snapshot unavailable");

    const runs = await getJson(unavailable.url("/api/v1/runs"), 503);
    assert.deepEqual(runs, {
      error: { code: "snapshot_unavailable", message: "Snapshot unavailable" },
    });

    const issue = await getJson(unavailable.url("/api/v1/MT-HTTP"), 404);
    assert.deepEqual(issue, { error: { code: "issue_not_found", message: "Issue not found" } });

    const refresh = await postJson(unavailable.url("/api/v1/refresh"), 503);
    assert.deepEqual(refresh, {
      error: { code: "orchestrator_unavailable", message: "Orchestrator is unavailable" },
    });

    const dashboard = await getJson(unavailable.url("/"), 503);
    assert.deepEqual(dashboard, {
      error: {
        code: "dashboard_not_built",
        message: "Dashboard assets not found. Run: pnpm build",
      },
    });
  } finally {
    await unavailable.stop();
  }

  const timeout = await startObservabilityServer(fakeRuntime("snapshot_timeout"), {
    host: "127.0.0.1",
    port: 0,
  });
  try {
    const state = await getJson(timeout.url("/api/v1/state"));
    assert.equal(state.error.code, "snapshot_timeout");
    assert.equal(state.error.message, "Snapshot timed out");

    const runs = await getJson(timeout.url("/api/v1/runs"), 503);
    assert.deepEqual(runs, { error: { code: "snapshot_timeout", message: "Snapshot timed out" } });
  } finally {
    await timeout.stop();
  }
});

test("Claude MCP endpoint authorizes bearer tokens and executes Linear tools", async () => {
  const workflow = workflowFixture();
  const runtime = new SymphonyRuntime({
    workflow,
    client: {
      fetchCandidateIssues: async () => [],
      fetchIssuesByIds: async () => [],
    },
  });
  const server = await startObservabilityServer(runtime, { host: "127.0.0.1", port: 0 });
  const token = issueMcpToken(server.authScope);
  const originalFetch = globalThis.fetch;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const target = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (!target.includes("api.linear.app")) return originalFetch(url, init);
    const body = JSON.parse(String(init?.body)) as { query: string };
    assert.match(body.query, /viewer/);
    return new Response(JSON.stringify({ data: { viewer: { id: "viewer-1" } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);

  try {
    const initialize = await postMcp(
      server.url("/claude-mcp"),
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      },
      200,
      token,
    );
    assert.equal(initialize.result.serverInfo.name, "symphony-claude-mcp");

    const tools = await postMcp(
      server.url("/claude-mcp"),
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      200,
      token,
    );
    assert.deepEqual(
      tools.result.tools.map((tool: { name: string }) => tool.name),
      [
        "tracker_read_issue",
        "tracker_query",
        "tracker_update_status",
        "tracker_comment",
        "tracker_create_issue",
        "linear_graphql",
      ],
    );

    const toolCall = await postMcp(
      server.url("/claude-mcp"),
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "linear_graphql", arguments: { query: "query { viewer { id } }" } },
      },
      200,
      token,
    );
    assert.equal(toolCall.result.isError, false);
    assert.match(toolCall.result.content[0].text, /viewer-1/);

    const badToolCall = await postMcp(
      server.url("/claude-mcp"),
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "linear_graphql", arguments: {} },
      },
      200,
      token,
    );
    assert.equal(badToolCall.result.isError, true);
    assert.deepEqual(JSON.parse(badToolCall.result.content[0].text), {
      error: {
        message: "`linear_graphql` requires a non-empty `query` string.",
      },
    });

    const unauthorized = await postMcp(
      server.url("/claude-mcp"),
      { jsonrpc: "2.0", id: 5, method: "tools/list" },
      401,
      null,
    );
    assert.equal(unauthorized.error.code, "unauthorized");
    revokeMcpToken(token);
    const revoked = await postMcp(
      server.url("/claude-mcp"),
      { jsonrpc: "2.0", id: 6, method: "tools/list" },
      401,
      token,
    );
    assert.equal(revoked.error.code, "unauthorized");
  } finally {
    revokeMcpToken(token);
    fetchSpy.mockRestore();
    await server.stop();
  }
});

function workflowFixture(): WorkflowDefinition {
  const settings = parseConfig({
    tracker: {
      api_key: "linear-token",
      project_slug: "mono",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
    },
    polling: { interval_ms: 5 },
    workspace: { root: "/tmp/symphony-ts-http-test" },
  });
  return {
    path: "/tmp/WORKFLOW.md",
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };
}

async function getJson(url: string, expectedStatus = 200): Promise<any> {
  const response = await fetch(url);
  assert.equal(response.status, expectedStatus);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  return response.json();
}

async function postJson(url: string, expectedStatus = 202): Promise<any> {
  const response = await fetch(url, { method: "POST" });
  assert.equal(response.status, expectedStatus);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  return response.json();
}

async function postMcp(
  url: string,
  body: Record<string, unknown>,
  expectedStatus = 200,
  token: string | null,
): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(response.status, expectedStatus);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  return response.json();
}

async function postRawMcp(
  url: string,
  body: string,
  expectedStatus = 200,
  token: string | null,
): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { method: "POST", headers, body });
  assert.equal(response.status, expectedStatus);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  return response.json();
}

function fakeRuntime(code: "snapshot_timeout" | "snapshot_unavailable"): SymphonyRuntime {
  return {
    snapshot() {
      const error = new Error(code) as Error & { code: string };
      error.code = code;
      throw error;
    },
    requestRefresh() {
      const error = new Error("orchestrator_unavailable") as Error & { code: string };
      error.code = "orchestrator_unavailable";
      throw error;
    },
  } as unknown as SymphonyRuntime;
}
