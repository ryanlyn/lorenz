import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { match } from "ts-pattern";
import { z } from "zod";
import { validMcpToken } from "@symphony/mcp";
import { issuePayload, runsPayload, statePayload, type PresenterParams } from "@symphony/presenter";
import { executeTool, toolSpecs } from "@symphony/mcp";
import type { RuntimeSnapshot } from "@symphony/runtime-events";
import type { Settings } from "@symphony/domain";

export interface RuntimeServerSource {
  workflow?: { settings?: Settings } | undefined;
  snapshot(): RuntimeSnapshot;
  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void;
  requestRefresh(): Record<string, unknown>;
}

export interface ObservabilityServerOptions {
  host: string;
  port: number;
}

export interface ObservabilityServerHandle {
  host: string;
  port: number;
  url(path?: string): string;
  stop(): Promise<void>;
}

export async function startObservabilityServer(
  runtime: RuntimeServerSource,
  options: ObservabilityServerOptions,
): Promise<ObservabilityServerHandle> {
  return startHonoServer(buildObservabilityApp(runtime), options);
}

export async function startClaudeMcpServer(
  settings: Settings,
  options: ObservabilityServerOptions,
): Promise<ObservabilityServerHandle> {
  return startHonoServer(buildClaudeMcpApp(settings), options);
}

async function startHonoServer(
  app: Hono,
  options: ObservabilityServerOptions,
): Promise<ObservabilityServerHandle> {
  let server!: ServerType;
  await new Promise<void>((resolve, reject) => {
    server = serve({ fetch: app.fetch, hostname: options.host, port: options.port }, () => {
      server.off("error", reject);
      resolve();
    });
    server.once("error", reject);
  });
  const activeServer = server;
  const address = activeServer.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    host: options.host,
    port,
    url(path = "/"): string {
      return `http://${urlHost(options.host)}:${port}${path}`;
    },
    stop: () => stopServer(activeServer),
  };
}

function buildObservabilityApp(runtime: RuntimeServerSource): Hono {
  const app = new Hono();
  const settings = runtimeSettings(runtime);
  if (settings) mountClaudeMcp(app, settings);

  app.get("/", () => htmlResponse(dashboardHtml(runtime)));
  app.all("/", () => errorResponse(405, "method_not_allowed", "Method not allowed"));

  app.get("/api/v1/state", () => {
    const snapshot = snapshotResult(runtime);
    if (snapshot.status !== "ok") {
      return jsonResponse({
        generated_at: new Date().toISOString(),
        error: observabilityErrorBody(snapshot.status),
      });
    }
    return jsonResponse(statePayload(snapshot.snapshot));
  });
  app.all("/api/v1/state", () => errorResponse(405, "method_not_allowed", "Method not allowed"));

  app.get("/api/v1/events", (c) => stateEventsResponse(c, runtime));
  app.all("/api/v1/events", () => errorResponse(405, "method_not_allowed", "Method not allowed"));

  app.get("/api/v1/runs", (c) => {
    const snapshot = snapshotResult(runtime);
    if (snapshot.status !== "ok") {
      return errorResponse(503, snapshot.status, observabilityErrorBody(snapshot.status).message);
    }
    const result = runsPayload(
      snapshot.snapshot,
      paramsFromSearch(new URL(c.req.url).searchParams),
    );
    if (result.status === "run_not_found") {
      return errorResponse(404, "run_not_found", "Run not found");
    }
    return jsonResponse(result.payload);
  });
  app.all("/api/v1/runs", () => errorResponse(405, "method_not_allowed", "Method not allowed"));

  app.post("/api/v1/refresh", () => {
    try {
      return jsonResponse(runtime.requestRefresh(), 202);
    } catch {
      return errorResponse(503, "orchestrator_unavailable", "Orchestrator is unavailable");
    }
  });
  app.all("/api/v1/refresh", () => errorResponse(405, "method_not_allowed", "Method not allowed"));

  app.get("/api/v1/:identifier", (c) => {
    const issueIdentifier = decodeURIComponent(c.req.param("identifier"));
    const snapshot = snapshotResult(runtime);
    if (snapshot.status !== "ok") {
      return errorResponse(404, "issue_not_found", "Issue not found");
    }
    const result = issuePayload(snapshot.snapshot, issueIdentifier);
    if (result.status === "issue_not_found") {
      return errorResponse(404, "issue_not_found", "Issue not found");
    }
    return jsonResponse(result.payload);
  });
  app.all("/api/v1/:identifier", () =>
    errorResponse(405, "method_not_allowed", "Method not allowed"),
  );

  app.notFound(() => errorResponse(404, "not_found", "Route not found"));
  return app;
}

function runtimeSettings(runtime: RuntimeServerSource): Settings | null {
  return runtime.workflow?.settings ?? null;
}

function buildClaudeMcpApp(settings: Settings): Hono {
  const app = new Hono();
  mountClaudeMcp(app, settings);
  app.notFound((c) =>
    c.req.method === "GET"
      ? errorResponse(404, "not_found", "Route not found")
      : errorResponse(405, "method_not_allowed", "Method not allowed"),
  );
  return app;
}

function mountClaudeMcp(app: Hono, settings: Settings): void {
  app.use("/claude-mcp", async (c, next) => {
    if (c.req.method !== "POST") {
      await next();
      return;
    }
    if (!authorizedMcpHeader(c.req.header("authorization"))) {
      return jsonResponse(
        {
          error: {
            code: "unauthorized",
            message: "Missing or invalid MCP bearer token",
          },
        },
        401,
      );
    }
    await next();
  });
  app.post("/claude-mcp", (c) => handleClaudeMcp(settings, c));
  app.all("/claude-mcp", () => errorResponse(405, "method_not_allowed", "Method not allowed"));
}

function dashboardHtml(runtime: RuntimeServerSource): string {
  const snapshot = snapshotResult(runtime);
  if (snapshot.status !== "ok") {
    const error = observabilityErrorBody(snapshot.status);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Symphony Operations Dashboard</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem; background: #0f172a; color: #e2e8f0; }
    h1 { font-size: 1.4rem; }
  </style>
</head>
<body>
  <h1>Operations Dashboard</h1>
  <p>${escapeHtml(error.code)}: ${escapeHtml(error.message)}</p>
</body>
</html>`;
  }
  const state = statePayload(snapshot.snapshot);
  const running = Array.isArray(state.running) ? state.running : [];
  const retrying = Array.isArray(state.retrying) ? state.retrying : [];
  const blocked = Array.isArray(state.blocked) ? state.blocked : [];
  const usage = isRecord(state.usage_totals) ? state.usage_totals : {};
  const counts = isRecord(state.counts) ? state.counts : {};
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Symphony Operations Dashboard</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; background: #101418; color: #e8edf2; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
    h1 { font-size: 1.3rem; margin: 0 0 4px; }
    .subtle { color: #91a1b2; }
    .badge { color: #0f1720; background: #6ee7b7; padding: 2px 8px; border-radius: 4px; font-weight: 700; }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 22px 0; }
    .metric { border: 1px solid #2d3742; padding: 12px; background: #161d24; border-radius: 6px; }
    .metric span { display: block; color: #91a1b2; font-size: .78rem; }
    .metric strong { display: block; font-size: 1.25rem; margin-top: 6px; }
    section { margin-top: 22px; }
    h2 { font-size: .92rem; text-transform: uppercase; letter-spacing: 0; color: #cbd5df; }
    table { width: 100%; border-collapse: collapse; background: #141a21; border: 1px solid #2d3742; }
    th, td { padding: 8px 10px; border-bottom: 1px solid #24303a; text-align: left; vertical-align: top; }
    th { color: #91a1b2; font-size: .78rem; }
    td { font-size: .84rem; }
    .empty { color: #91a1b2; border: 1px dashed #34414f; padding: 12px; background: #141a21; }
    code { color: #bae6fd; }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Symphony Operations Dashboard</h1>
        <div class="subtle">workflow=${escapeHtml(snapshot.snapshot.workflowPath)} status=${snapshot.snapshot.appStatus}</div>
      </div>
      <span class="badge" id="connection">live</span>
    </header>

    <div class="metrics">
      ${metricCard("Running", counts.running)}
      ${metricCard("Retrying", counts.retrying)}
      ${metricCard("Blocked", counts.blocked)}
      ${metricCard("Tokens", usage.total_tokens)}
    </div>

    <section>
      <h2>Running Sessions</h2>
      ${running.length === 0 ? emptyState("No running sessions") : runningTable(running)}
    </section>

    <section>
      <h2>Retry Queue</h2>
      ${retrying.length === 0 ? emptyState("No queued retries") : retryTable(retrying)}
    </section>

    <section>
      <h2>Dispatch Blocks</h2>
      ${blocked.length === 0 ? emptyState("No capacity-blocked issues") : blockedTable(blocked)}
    </section>
  </main>
  <script>
    async function refreshState() {
      try {
        const response = await fetch('/api/v1/state', { cache: 'no-store' });
        document.getElementById('connection').textContent = response.ok ? 'live' : 'offline';
      } catch (_error) {
        document.getElementById('connection').textContent = 'offline';
      }
    }
    if ('EventSource' in window) {
      const events = new EventSource('/api/v1/events');
      events.addEventListener('state', () => {
        document.getElementById('connection').textContent = 'live';
      });
      events.onerror = () => {
        document.getElementById('connection').textContent = 'offline';
      };
    } else {
      setInterval(refreshState, ${Math.max(250, snapshot.snapshot.poll.nextPollAt ? 1000 : 1000)});
    }
  </script>
</body>
</html>`;
}

function stateEventsResponse(c: Context, runtime: RuntimeServerSource): Response {
  const response = streamSSE(
    c,
    async (stream) => {
      await stream.write(": connected\n\n");
      let unsubscribe: (() => void) | null = null;
      const aborted = new Promise<void>((resolve) => stream.onAbort(resolve));
      try {
        unsubscribe = runtime.subscribe((snapshot) => {
          void stream
            .writeSSE({ event: "state", data: JSON.stringify(statePayload(snapshot)) })
            .catch(() => stream.abort());
        });
      } catch (error) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify(observabilityErrorBody(observabilityErrorCode(error))),
        });
      }
      await aborted;
      unsubscribe?.();
    },
    async (error, stream) => {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify(observabilityErrorBody(observabilityErrorCode(error))),
      });
    },
  );
  response.headers.set("content-type", "text/event-stream; charset=utf-8");
  response.headers.set("cache-control", "no-cache, no-transform");
  return response;
}

function metricCard(label: string, value: unknown): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(formatValue(value))}</strong></div>`;
}

function runningTable(rows: unknown[]): string {
  return table(
    ["Issue", "Agent", "Worker", "Turns", "Tokens", "Session", "Event"],
    rows.map((row) => {
      const item = isRecord(row) ? row : {};
      const tokens = isRecord(item.tokens)
        ? item.tokens.total_tokens
        : isRecord(item.usage_totals)
          ? item.usage_totals.total_tokens
          : "";
      return [
        item.issue_identifier,
        item.agent_kind,
        item.worker_host ?? "local",
        item.turn_count,
        tokens,
        item.session_id ?? "n/a",
        item.last_event ?? "n/a",
      ];
    }),
  );
}

function retryTable(rows: unknown[]): string {
  return table(
    ["Issue", "Attempt", "Due", "Worker", "Workspace", "Error"],
    rows.map((row) => {
      const item = isRecord(row) ? row : {};
      return [
        item.issue_identifier,
        item.attempt,
        item.due_at,
        item.worker_host ?? "local",
        item.workspace_path ?? "n/a",
        item.error ?? "n/a",
      ];
    }),
  );
}

function blockedTable(rows: unknown[]): string {
  return table(
    ["Issue", "Reason", "Worker"],
    rows.map((row) => {
      const item = isRecord(row) ? row : {};
      return [item.issue_identifier, item.reason ?? "unknown", item.worker_host ?? "n/a"];
    }),
  );
}

function table(headers: string[], rows: unknown[][]): string {
  return `<table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr>${row.map((value) => `<td>${escapeHtml(formatValue(value))}</td>`).join("")}</tr>`,
    )
    .join("")}</tbody></table>`;
}

function emptyState(message: string): string {
  return `<div class="empty">${escapeHtml(message)}</div>`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "0";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(1);
  return String(value);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

async function handleClaudeMcp(settings: Settings, c: Context): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await requestJson(c);
  } catch {
    return jsonResponse(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
      400,
    );
  }

  const mcpResponse = await claudeMcpResponse(settings, body);
  if (mcpResponse === null) {
    return new Response("", { status: 204 });
  }
  return jsonResponse(mcpResponse);
}

async function requestJson(c: Context): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await c.req.text()) as unknown;
  if (!isRecord(parsed)) throw new Error("request body must be an object");
  return parsed;
}

function authorizedMcpHeader(authorization: string | undefined): boolean {
  const match = /^Bearer\s+(.+)$/.exec(authorization ?? "");
  return validMcpToken(match?.[1]);
}

async function claudeMcpResponse(
  settings: Settings,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const method = typeof body.method === "string" ? body.method : "";
  const id = body.id ?? null;
  return match(method)
    .with("notifications/initialized", () => null)
    .with("initialize", () => {
      const parsed = mcpInitializeParamsSchema.safeParse(body.params);
      if (!parsed.success) return jsonRpcError(id, -32602, "Invalid params");
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: parsed.data.protocolVersion ?? "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "symphony-claude-mcp", version: "0.1.0" },
        },
      };
    })
    .with("tools/list", () => ({ jsonrpc: "2.0", id, result: { tools: toolSpecs() } }))
    .with("tools/call", async () => {
      const parsed = mcpToolsCallParamsSchema.safeParse(body.params);
      if (!parsed.success) return jsonRpcError(id, -32602, "Invalid params");
      const result = await executeTool(parsed.data.name, parsed.data.arguments, settings);
      const payload = result.success
        ? (result.result ?? {})
        : (result.result ?? { error: { message: result.error ?? "dynamic tool failed" } });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          isError: !result.success,
        },
      };
    })
    .otherwise(() => jsonRpcError(id, -32601, `Method not found: ${method}`));
}

const mcpParamsSchema = z.record(z.string(), z.unknown());

const mcpInitializeParamsSchema = z.preprocess(
  (value) => (isRecord(value) ? value : {}),
  z
    .object({
      protocolVersion: z.string().optional(),
    })
    .passthrough(),
);

const mcpToolsCallParamsSchema = z.preprocess(
  (value) => (isRecord(value) ? value : {}),
  z
    .object({
      name: z.string().trim().min(1),
      arguments: z.preprocess((value) => (isRecord(value) ? value : {}), mcpParamsSchema),
    })
    .passthrough()
    .transform((params) => ({
      ...params,
      name: params.name.trim(),
      arguments: params.arguments ?? {},
    })),
);

function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function snapshotResult(
  runtime: RuntimeServerSource,
):
  | { status: "ok"; snapshot: RuntimeSnapshot }
  | { status: "snapshot_timeout" | "snapshot_unavailable" } {
  try {
    return { status: "ok", snapshot: runtime.snapshot() };
  } catch (error) {
    return { status: observabilityErrorCode(error) };
  }
}

function observabilityErrorCode(error: unknown): "snapshot_timeout" | "snapshot_unavailable" {
  if (isRecord(error)) {
    const code = error.code;
    if (code === "snapshot_timeout" || code === "timeout") return "snapshot_timeout";
    if (code === "snapshot_unavailable" || code === "unavailable") return "snapshot_unavailable";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message === "snapshot_timeout" || message === "timeout") return "snapshot_timeout";
  return "snapshot_unavailable";
}

function observabilityErrorBody(code: "snapshot_timeout" | "snapshot_unavailable"): {
  code: string;
  message: string;
} {
  return {
    code,
    message: code === "snapshot_timeout" ? "Snapshot timed out" : "Snapshot unavailable",
  };
}

function paramsFromSearch(searchParams: URLSearchParams): PresenterParams {
  const params: PresenterParams = {};
  for (const [key, value] of searchParams.entries()) params[key] = value;
  return params;
}

function stopServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
