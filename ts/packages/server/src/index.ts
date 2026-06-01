import { readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { match } from "ts-pattern";
import { z } from "zod";
import { validMcpToken } from "@symphony/mcp";
import { issuePayload, runsPayload, statePayload, type PresenterParams } from "@symphony/presenter";
import { executeTool, toolSpecs } from "@symphony/mcp";
import type { RuntimeSnapshot } from "@symphony/runtime-events";
import type { Settings } from "@symphony/domain";
import type { TraceWatcher } from "@symphony/traceviz-server";

import { createTraceRoutes } from "./trace-routes.js";
import { createWsHandler } from "./ws.js";

export interface RuntimeServerSource {
  workflow?: { settings?: Settings } | undefined;
  snapshot(): RuntimeSnapshot;
  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void;
  requestRefresh(): Record<string, unknown>;
}

export interface ObservabilityServerOptions {
  host: string;
  port: number;
  traceDir?: string;
  staticDir?: string;
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
  const { app, watcher } = buildObservabilityApp(runtime, options);
  let internals: HonoServerInternals | undefined;

  if (watcher) {
    const wsSetup = createWsHandler(app, watcher);
    internals = {
      injectWebSocket: wsSetup.injectWebSocket,
      stopWatcher: () => watcher.stop(),
    };
  }

  return startHonoServer(app, options, internals);
}

export async function startClaudeMcpServer(
  settings: Settings,
  options: ObservabilityServerOptions,
): Promise<ObservabilityServerHandle> {
  return startHonoServer(buildClaudeMcpApp(settings), options);
}

interface HonoServerInternals {
  injectWebSocket?: (server: unknown) => void;
  stopWatcher?: () => void;
}

async function startHonoServer(
  app: Hono,
  options: ObservabilityServerOptions,
  internals?: HonoServerInternals,
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

  // Inject WebSocket support after server starts listening
  if (internals?.injectWebSocket) {
    internals.injectWebSocket(activeServer);
  }

  const address = activeServer.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    host: options.host,
    port,
    url(urlPath = "/"): string {
      return `http://${urlHost(options.host)}:${port}${urlPath}`;
    },
    stop: async () => {
      internals?.stopWatcher?.();
      await stopServer(activeServer);
    },
  };
}

interface BuildResult {
  app: Hono;
  watcher: TraceWatcher | null;
}

function buildObservabilityApp(
  runtime: RuntimeServerSource,
  options: ObservabilityServerOptions,
): BuildResult {
  const app = new Hono();
  const settings = runtimeSettings(runtime);
  if (settings) mountClaudeMcp(app, settings);

  // Health endpoint
  app.get("/health", () => jsonResponse({ status: "ok" }));

  // SPA serving
  const staticDir = options.staticDir ?? resolveStaticDir();
  app.get("/", async () => {
    const indexPath = path.join(staticDir, "index.html");
    try {
      const content = await fsReadFile(indexPath, "utf-8");
      return htmlResponse(content);
    } catch {
      return jsonResponse(
        {
          error: {
            code: "dashboard_not_built",
            message: "Dashboard assets not found. Run: pnpm dashboard:build",
          },
        },
        503,
      );
    }
  });
  app.use("/assets/*", serveStatic({ root: staticDir }));
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

  // Mount trace routes BEFORE the :identifier catch-all
  let watcher: TraceWatcher | null = null;
  if (options.traceDir) {
    const traceRoutes = createTraceRoutes(options.traceDir);
    watcher = traceRoutes.watcher;
    app.route("/", traceRoutes.app);
  }

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
  return { app, watcher };
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
  app.post("/claude-mcp", async (c) => handleClaudeMcp(settings, c));
  app.all("/claude-mcp", () => errorResponse(405, "method_not_allowed", "Method not allowed"));
}

function resolveStaticDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), "../../../apps/symphony-dashboard/dist");
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
    .with("tools/list", () => ({ jsonrpc: "2.0", id, result: { tools: toolSpecs(settings) } }))
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

async function stopServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
