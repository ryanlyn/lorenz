import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeAll, test, vi } from "vitest";
import {
  issueMcpToken,
  Orchestrator,
  parseConfig,
  revokeMcpToken,
  LorenzRuntime,
} from "@lorenz/cli";
import { acpExecutorProvider } from "@lorenz/acp";
import { defaultAgentExecutorRegistry } from "@lorenz/agent-sdk";
import { normalizeIssue } from "@lorenz/issue";
import type { WorkflowDefinition } from "@lorenz/domain";
import { registerLinearTracker } from "@lorenz/linear-tracker";
import { registerLocalTracker } from "@lorenz/local-tracker";
import { assert } from "@lorenz/test-utils";
import type { RuntimeDaemonStatus, RuntimeSnapshot } from "@lorenz/runtime-events";

import {
  IssueStore,
  startMcpServer,
  startObservabilityServer,
  type RuntimeServerSource,
} from "@lorenz/server";

// The observability server resolves tool packs and tracker ops through the process-default
// registries (it offers no injection point), so populate them the same way the CLI
// composition root does before serving (in a hook rather than at module scope). This suite
// dispatches on the linear tracker and mounts linear's own pack; the hot-reload test below
// switches dispatch to the local tracker and expects the local board pack.
beforeAll(() => {
  registerLinearTracker();
  registerLocalTracker();
  if (defaultAgentExecutorRegistry.get(acpExecutorProvider.executor) === undefined) {
    defaultAgentExecutorRegistry.register(acpExecutorProvider);
  }
});

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
    message: { sessionId: "thread-http", update: { sessionUpdate: "agent_message_chunk" } },
    usage: { inputTokens: 4, outputTokens: 8, totalTokens: 12 },
    timestamp: new Date("2026-05-05T00:00:01.000Z"),
  });

  const runtime = new LorenzRuntime({
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

    const unauthorizedRefresh = await postJson(server.url("/api/v1/refresh"), 401);
    assert.deepEqual(unauthorizedRefresh, {
      error: { code: "unauthorized", message: "Missing or invalid daemon control token" },
    });

    const refresh = await postJson(server.url("/api/v1/refresh"), 202, server.controlToken);
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

test("observability HTTP API exposes daemon status and stop control", async () => {
  const workflow = workflowFixture();
  const daemonStatus = daemonStatusFixture(workflow);
  const requestStop = vi.fn(() => ({ requested_at: "2026-01-01T00:00:00.000Z", stopping: true }));
  const runtime: RuntimeServerSource = {
    workflow,
    snapshot: () => emptySnapshot(workflow),
    subscribe: () => () => {},
    requestRefresh: () => ({ queued: true }),
    requestStop,
    daemonStatus: () => daemonStatus,
  };
  const server = await startObservabilityServer(runtime, {
    host: "127.0.0.1",
    port: 0,
    staticDir: "/tmp/nonexistent-dashboard-dist",
  });

  try {
    const state = await getJson(server.url("/api/v1/state"));
    assert.equal(state.daemon.owner_id, "owner-daemon");
    assert.equal(state.daemon.leadership_store_kind, "local-file");

    const daemon = await getJson(server.url("/api/v1/daemon"));
    assert.equal(daemon.owner_id, "owner-daemon");
    assert.equal(daemon.endpoint.address, "http://127.0.0.1:4040/");

    const unauthorized = await postJson(server.url("/api/v1/stop"), 401);
    assert.deepEqual(unauthorized, {
      error: { code: "unauthorized", message: "Missing or invalid daemon control token" },
    });
    assert.equal(requestStop.mock.calls.length, 0);

    const wrongToken = await postJson(
      server.url("/api/v1/stop"),
      401,
      `${server.controlToken}-nope`,
    );
    assert.equal(wrongToken.error.code, "unauthorized");
    assert.equal(requestStop.mock.calls.length, 0);

    const stop = await postJson(server.url("/api/v1/stop"), 202, server.controlToken);
    assert.equal(stop.stopping, true);
    assert.equal(requestStop.mock.calls.length, 1);
  } finally {
    await server.stop();
  }
});

test("observability server serves daemon control over a unix socket", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lz-ctl-"));
  const socketPath = path.join(dir, "c.sock");
  const workflow = workflowFixture();
  const daemonStatus = daemonStatusFixture(workflow);
  const requestStop = vi.fn(() => ({ requested_at: "2026-01-01T00:00:00.000Z", stopping: true }));
  const runtime: RuntimeServerSource = {
    workflow,
    snapshot: () => emptySnapshot(workflow),
    subscribe: () => () => {},
    requestRefresh: () => ({ queued: true }),
    requestStop,
    daemonStatus: () => daemonStatus,
  };
  const server = await startObservabilityServer(runtime, {
    host: "127.0.0.1",
    port: 0,
    socketPath,
    httpDisabled: true,
    staticDir: "/tmp/nonexistent-dashboard-dist",
  });

  try {
    assert.equal(server.socketPath, socketPath);

    const daemon = await socketJson(socketPath, "/api/v1/daemon", "GET");
    assert.equal(daemon.status, 200);
    assert.equal(daemon.body.owner_id, "owner-daemon");

    const unauthorized = await socketJson(socketPath, "/api/v1/stop", "POST");
    assert.equal(unauthorized.status, 401);
    assert.equal(requestStop.mock.calls.length, 0);

    const wrongToken = await socketJson(
      socketPath,
      "/api/v1/stop",
      "POST",
      `${server.controlToken}-x`,
    );
    assert.equal(wrongToken.status, 401);
    assert.equal(requestStop.mock.calls.length, 0);

    const stop = await socketJson(socketPath, "/api/v1/stop", "POST", server.controlToken);
    assert.equal(stop.status, 202);
    assert.equal(requestStop.mock.calls.length, 1);
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("observability server refuses a world-accessible control socket directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lz-bad-"));
  const runtimeDir = path.join(dir, "rt");
  await mkdir(runtimeDir, { recursive: true });
  await chmod(runtimeDir, 0o777); // a co-tenant could write here -> must be refused
  const socketPath = path.join(runtimeDir, "c.sock");
  const workflow = workflowFixture();
  const runtime: RuntimeServerSource = {
    workflow,
    snapshot: () => emptySnapshot(workflow),
    subscribe: () => () => {},
    requestRefresh: () => ({ queued: true }),
  };

  try {
    await assert.rejects(
      () =>
        startObservabilityServer(runtime, {
          host: "127.0.0.1",
          port: 0,
          socketPath,
          httpDisabled: true,
          staticDir: "/tmp/nonexistent-dashboard-dist",
        }),
      /non-private daemon runtime directory/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function socketJson(
  socketPath: string,
  requestPath: string,
  method: "GET" | "POST",
  token: string | null = null,
): Promise<{ status: number; body: any }> {
  const result = await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const headers: Record<string, string> = { host: "lorenz.local" };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = httpRequest({ socketPath, path: requestPath, method, headers }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} });
      });
    });
    req.on("error", reject);
    req.end();
  });
  return result;
}

function daemonStatusFixture(workflow: WorkflowDefinition): RuntimeDaemonStatus {
  return {
    ownerId: "owner-daemon",
    pid: 123,
    hostname: "host-a",
    startedAt: "2026-01-01T00:00:00.000Z",
    workflowPath: workflow.path,
    workspaceRoot: workflow.settings.workspace.root,
    lockPath: "/tmp/lorenz.lock",
    endpoint: { kind: "http", address: "http://127.0.0.1:4040/" },
    heartbeatAt: "2026-01-01T00:00:05.000Z",
    heartbeatAgeMs: 1000,
    stale: false,
    leadershipStoreKind: "local-file",
  };
}

test("standalone MCP server preserves route and JSON-RPC error contracts", async () => {
  const workflow = workflowFixture();
  const server = await startMcpServer(workflow.settings, { host: "127.0.0.1", port: 0 });
  const token = issueMcpToken(server.authScope);
  try {
    const missing = await getJson(server.url("/missing"), 404);
    assert.deepEqual(missing, { error: { code: "not_found", message: "Route not found" } });

    const wrongMethod = await getJson(server.url("/mcp"), 405);
    assert.deepEqual(wrongMethod, {
      error: { code: "method_not_allowed", message: "Method not allowed" },
    });

    const badJson = await postRawMcp(server.url("/mcp"), "{", 400, token);
    assert.deepEqual(badJson, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });

    const arrayBody = await postRawMcp(server.url("/mcp"), "[]", 400, token);
    assert.deepEqual(arrayBody, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });

    const unknownMethod = await postMcp(
      server.url("/mcp"),
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
      server.url("/mcp"),
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

test("standalone MCP server rejects top-level JSON arrays as parse errors", async () => {
  const workflow = workflowFixture();
  const server = await startMcpServer(workflow.settings, { host: "127.0.0.1", port: 0 });
  const token = issueMcpToken(server.authScope);
  try {
    const topLevelArray = await postRawMcp(server.url("/mcp"), "[]", 400, token);
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

test("standalone MCP server emits connectable URLs for wildcard and empty hosts", async () => {
  const workflow = workflowFixture();
  for (const host of ["0.0.0.0", ""] as const) {
    const server = await startMcpServer(workflow.settings, { host, port: 0 });
    try {
      assert.match(server.url("/mcp"), /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    } finally {
      await server.stop();
    }
  }
});

test("observability HTTP API serves trace routes when issueStore is provided", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lorenz-http-issue-store-"));
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

    const unauthorizedRefresh = await postJson(unavailable.url("/api/v1/refresh"), 401);
    assert.deepEqual(unauthorizedRefresh, {
      error: { code: "unauthorized", message: "Missing or invalid daemon control token" },
    });

    const refresh = await postJson(
      unavailable.url("/api/v1/refresh"),
      503,
      unavailable.controlToken,
    );
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

test("MCP endpoint authorizes bearer tokens and executes Linear tools", async () => {
  const workflow = workflowFixture();
  const runtime = new LorenzRuntime({
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
      server.url("/mcp"),
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      },
      200,
      token,
    );
    assert.equal(initialize.result.serverInfo.name, "mcp");

    const tools = await postMcp(
      server.url("/mcp"),
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      200,
      token,
    );
    assert.deepEqual(
      tools.result.tools.map((tool: { name: string }) => tool.name),
      ["linear_graphql"],
    );

    const toolCall = await postMcp(
      server.url("/mcp"),
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
      server.url("/mcp"),
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
      server.url("/mcp"),
      { jsonrpc: "2.0", id: 5, method: "tools/list" },
      401,
      null,
    );
    assert.equal(unauthorized.error.code, "unauthorized");
    revokeMcpToken(token);
    const revoked = await postMcp(
      server.url("/mcp"),
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

test("observability MCP endpoint uses workflow settings reloaded by the runtime", async () => {
  const initialWorkflow = workflowFixture();
  let currentWorkflow = initialWorkflow;
  const runtime = new LorenzRuntime({
    workflow: initialWorkflow,
    reloadWorkflow: async () => currentWorkflow,
    client: {
      fetchCandidateIssues: async () => [],
      fetchIssuesByIds: async () => [],
    },
  });
  const server = await startObservabilityServer(runtime, { host: "127.0.0.1", port: 0 });
  const token = issueMcpToken(server.authScope);

  try {
    const initialTools = await postMcp(
      server.url("/mcp"),
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      200,
      token,
    );
    assert.deepEqual(
      initialTools.result.tools.map((tool: { name: string }) => tool.name),
      ["linear_graphql"],
    );

    const boardDir = await mkdtemp(path.join(tmpdir(), "http-server-reload-local-"));
    currentWorkflow = {
      ...initialWorkflow,
      settings: parseConfig({
        tracker: { kind: "local", path: boardDir },
        polling: { interval_ms: 5 },
        workspace: { root: "/tmp/lorenz-http-test" },
      }),
    };
    await runtime.pollOnce({ dryRun: true });

    const reloadedTools = await postMcp(
      server.url("/mcp"),
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      200,
      token,
    );
    assert.deepEqual(
      reloadedTools.result.tools.map((tool: { name: string }) => tool.name),
      [
        "local_update_status",
        "local_comment",
        "local_create_issue",
        "local_read_issue",
        "local_query",
      ],
    );
  } finally {
    revokeMcpToken(token);
    await server.stop();
  }
});

function workflowFixture(): WorkflowDefinition {
  const settings = parseConfig({
    tracker: {
      kind: "linear",
      api_key: "linear-token",
      project_slug: "mono",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
    },
    polling: { interval_ms: 5 },
    workspace: { root: "/tmp/lorenz-http-test" },
  });
  return {
    path: "/tmp/WORKFLOW.md",
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };
}

function emptySnapshot(workflow: WorkflowDefinition): RuntimeSnapshot {
  return {
    appStatus: "idle",
    workflowPath: workflow.path,
    poll: {
      status: "idle",
      candidates: 0,
      eligible: 0,
      lastPollAt: null,
      nextPollAt: null,
      lastError: null,
    },
    running: [],
    reserving: [],
    retrying: [],
    blocked: [],
    runHistory: [],
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    rateLimits: null,
    logFile: null,
    recentEvents: [],
  };
}

async function getJson(url: string, expectedStatus = 200): Promise<any> {
  const response = await fetch(url);
  assert.equal(response.status, expectedStatus);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  return response.json();
}

async function postJson(
  url: string,
  expectedStatus = 202,
  token: string | null = null,
): Promise<any> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { method: "POST", headers });
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

function fakeRuntime(code: "snapshot_timeout" | "snapshot_unavailable"): LorenzRuntime {
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
  } as unknown as LorenzRuntime;
}
