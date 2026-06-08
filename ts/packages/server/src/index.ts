import { readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  errorMessage,
  httpUrlHost,
  isRecord,
  normalizeHttpBindHost,
  type Settings,
} from "@symphony/domain";
import { createMcpAuthScope, mcpAuthScopeForSettings, mountClaudeMcp } from "@symphony/mcp";
import { issuePayload, runsPayload, statePayload, type PresenterParams } from "@symphony/presenter";
import type { RuntimeSnapshot } from "@symphony/runtime-events";
import type { TraceWatcher } from "@symphony/traceviz-server";

import { createTraceRoutes } from "./trace-routes.js";
import { createWsHandler } from "./ws.js";
import { defaultIssueStorePath, IssueStore } from "./issue-store.js";

export { defaultIssueStorePath, IssueStore };
export { startClaudeMcpServer } from "@symphony/mcp";
export type { IssueRecord } from "./issue-store.js";

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
  issueStore?: IssueStore;
}

export interface ObservabilityServerHandle {
  host: string;
  port: number;
  authScope: string;
  url(path?: string): string;
  stop(): Promise<void>;
}

export async function startObservabilityServer(
  runtime: RuntimeServerSource,
  options: ObservabilityServerOptions,
): Promise<ObservabilityServerHandle> {
  const settings = runtimeSettings(runtime);
  const bindHost = normalizeHttpBindHost(options.host);
  const authScope =
    settings && options.port > 0
      ? mcpAuthScopeForSettings(settings, bindHost, options.port)
      : createMcpAuthScope();
  const { app, watcher } = buildObservabilityApp(runtime, options, authScope, settings);
  const internals: HonoServerInternals = {};

  try {
    if (watcher) {
      const wsSetup = createWsHandler(app, watcher);
      internals.injectWebSocket = wsSetup.injectWebSocket;
      internals.stopWatcher = () => {
        watcher.stop();
      };
    }

    return await startHonoServer(
      app,
      options,
      authScope,
      hasInternals(internals) ? internals : undefined,
    );
  } catch (error) {
    internals.stopWatcher?.();
    throw error;
  }
}

interface HonoServerInternals {
  injectWebSocket?: (server: unknown) => void;
  stopWatcher?: () => void;
}

async function startHonoServer(
  app: Hono,
  options: ObservabilityServerOptions,
  authScope: string,
  internals?: HonoServerInternals,
): Promise<ObservabilityServerHandle> {
  let server!: ServerType;
  const bindHost = normalizeHttpBindHost(options.host);
  await new Promise<void>((resolve, reject) => {
    server = serve({ fetch: app.fetch, hostname: bindHost, port: options.port }, () => {
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
    host: bindHost,
    port,
    authScope,
    url(urlPath = "/"): string {
      return `http://${httpUrlHost(bindHost)}:${port}${urlPath}`;
    },
    stop: async () => {
      internals?.stopWatcher?.();
      await stopServer(activeServer);
    },
  };
}

function hasInternals(internals: HonoServerInternals): boolean {
  return internals.injectWebSocket !== undefined || internals.stopWatcher !== undefined;
}

interface BuildResult {
  app: Hono;
  watcher: TraceWatcher | null;
}

function buildObservabilityApp(
  runtime: RuntimeServerSource,
  options: ObservabilityServerOptions,
  authScope: string,
  settings = runtimeSettings(runtime),
): BuildResult {
  const app = new Hono();
  if (settings) mountClaudeMcp(app, settings, { authScope });

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
            message: "Dashboard assets not found. Run: pnpm build",
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
  if (options.traceDir && options.issueStore) {
    const traceRoutes = createTraceRoutes(options.traceDir, options.issueStore);
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
  const message = errorMessage(error);
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
