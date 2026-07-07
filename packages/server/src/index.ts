import { chmod, readFile as fsReadFile, lstat, mkdir, rm as fsRm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getRequestListener, serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import {
  errorMessage,
  httpUrlHost,
  isRecord,
  normalizeHttpBindHost,
  type Settings,
} from "@lorenz/domain";
import {
  bearerToken,
  createMcpAuthScope,
  createOpaqueBearerToken,
  mcpAuthScopeForSettings,
  mountMcp,
} from "@lorenz/mcp";
import type { ToolRegistry } from "@lorenz/tool-sdk";
import {
  daemonPayload,
  issuePayload,
  runsPayload,
  statePayload,
  type PresenterParams,
} from "@lorenz/presenter";
import type { RuntimeSnapshot } from "@lorenz/runtime-events";
import type { TraceWatcher } from "@lorenz/traceviz-server";

import { createTraceRoutes } from "./trace-routes.js";
import { createWsHandler } from "./ws.js";
import { defaultIssueStorePath, IssueStore } from "./issue-store.js";
import { decodePathParam, invalidPathParameterError } from "./path-params.js";
import { snapshotWithDaemonStatus, type RuntimeServerSource } from "./source.js";

export { defaultIssueStorePath, IssueStore };
export { startMcpServer } from "@lorenz/mcp";
export type { IssueRecord } from "./issue-store.js";
export type { RuntimeServerSource } from "./source.js";

export interface ObservabilityServerOptions {
  host: string;
  port: number;
  traceDir?: string;
  staticDir?: string;
  issueStore?: IssueStore;
  /** Tool packs served on the MCP mount; defaults to the process-wide registry. */
  tools?: ToolRegistry;
  controlToken?: string | undefined;
  /**
   * Serve the app on a unix domain socket in addition to (or instead of) TCP. The daemon uses this
   * as an always-on control endpoint so `status/refresh/stop` self-discover even with no dashboard.
   */
  socketPath?: string | undefined;
  /** Skip the TCP listener entirely (socket-only control, e.g. `--no-dashboard`). */
  httpDisabled?: boolean | undefined;
}

export interface ObservabilityServerHandle {
  host: string;
  port: number;
  authScope: string;
  controlToken: string | null;
  socketPath: string | null;
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
  const controlToken = options.controlToken ?? createControlToken();
  const { app, watcher } = buildObservabilityApp(
    runtime,
    options,
    authScope,
    settings,
    controlToken,
  );
  const wsSetup = createWsHandler(app, runtime, watcher);

  try {
    return await startHonoServer(app, options, authScope, controlToken, {
      injectWebSocket: wsSetup.injectWebSocket,
      stop: wsSetup.stop,
    });
  } catch (error) {
    wsSetup.stop();
    throw error;
  }
}

interface HonoServerInternals {
  injectWebSocket: (server: unknown) => void;
  stop: () => void;
}

async function startHonoServer(
  app: Hono,
  options: ObservabilityServerOptions,
  authScope: string,
  controlToken: string | null,
  internals: HonoServerInternals,
): Promise<ObservabilityServerHandle> {
  const bindHost = normalizeHttpBindHost(options.host);
  let tcpServer: ServerType | null = null;
  let port = 0;
  if (!options.httpDisabled) {
    tcpServer = await listenTcp(app, bindHost, options.port);
    // Inject WebSocket support after the TCP server starts listening (browsers connect over TCP).
    internals.injectWebSocket(tcpServer);
    const address = tcpServer.address();
    port = typeof address === "object" && address !== null ? address.port : options.port;
  }

  let socketServer: HttpServer | null = null;
  const socketPath = options.socketPath ?? null;
  if (socketPath) socketServer = await listenSocket(app, socketPath);

  if (!tcpServer && !socketServer) {
    internals.stop();
    throw new Error("observability server requires an HTTP port or a socket path");
  }

  const tcp = tcpServer;
  return {
    host: bindHost,
    port,
    authScope,
    controlToken,
    socketPath,
    url(urlPath = "/"): string {
      if (!tcp) throw new Error("observability server has no HTTP endpoint");
      return `http://${httpUrlHost(bindHost)}:${port}${urlPath}`;
    },
    stop: async () => {
      internals.stop();
      if (tcp) await stopServer(tcp);
      if (socketServer) await stopSocketServer(socketServer, socketPath);
    },
  };
}

async function listenTcp(app: Hono, bindHost: string, port: number): Promise<ServerType> {
  const server = await new Promise<ServerType>((resolve, reject) => {
    const started = serve({ fetch: app.fetch, hostname: bindHost, port }, () => {
      started.off("error", reject);
      resolve(started);
    });
    started.once("error", reject);
  });
  return server;
}

async function listenSocket(app: Hono, socketPath: string): Promise<HttpServer> {
  // Bind paths over the OS sun_path limit (~104 bytes) are silently truncated by libuv: listen()
  // "succeeds" at a different path while the requested inode is never created. Fail loudly instead.
  if (Buffer.byteLength(socketPath) > 103) {
    throw new Error(`daemon control socket path too long (${Buffer.byteLength(socketPath)} bytes)`);
  }
  // Ensure the per-user runtime dir exists and is private to this user before binding inside it.
  await ensurePrivateDir(path.dirname(socketPath));
  // The daemon lease guarantees single-instance, so any socket file at this path is a leftover from
  // a crashed predecessor; remove it before listen() to avoid EADDRINUSE.
  await fsRm(socketPath, { force: true });
  // app.fetch is the async Hono FetchCallback that getRequestListener is designed to drive; the
  // adapter awaits it internally. This is the same handler `serve()` uses for the TCP listener.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const server = createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: socketPath }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // Best-effort owner-only perms; the 0700 parent dir is the primary boundary, so a chmod failure
  // must not crash the daemon.
  try {
    await chmod(socketPath, 0o600);
  } catch {
    // Parent dir perms still protect the socket.
  }
  return server;
}

async function stopSocketServer(server: HttpServer, socketPath: string | null): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (socketPath) await fsRm(socketPath, { force: true });
}

// Create the socket's runtime dir and verify it is genuinely private to this user before binding.
// On Linux the tmpdir fallback (/tmp) is world-writable, so a co-tenant could pre-create the
// deterministic path as a symlink or a dir they own and MITM the control socket; reject that and
// refuse to bind rather than leak the bearer control token a client sends.
async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) {
    throw new Error(`refusing to use a non-private daemon runtime directory: ${dir}`);
  }
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
  controlToken: string | null = null,
): BuildResult {
  const app = new Hono();
  // Resolve settings per request so the MCP endpoint reflects workflow settings the runtime
  // has hot-reloaded since the server was built.
  if (settings) {
    const initialSettings = settings;
    mountMcp(app, () => runtimeSettings(runtime) ?? initialSettings, {
      authScope,
      tools: options.tools,
    });
  }

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
    return jsonResponse(statePayload(snapshotWithDaemonStatus(runtime, snapshot.snapshot)));
  });
  app.all("/api/v1/state", () => errorResponse(405, "method_not_allowed", "Method not allowed"));

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

  app.post("/api/v1/refresh", (c) => {
    const unauthorized = unauthorizedControlResponse(c.req.header("authorization"), controlToken);
    if (unauthorized) return unauthorized;
    try {
      return jsonResponse(runtime.requestRefresh(), 202);
    } catch {
      return errorResponse(503, "orchestrator_unavailable", "Orchestrator is unavailable");
    }
  });
  app.all("/api/v1/refresh", () => errorResponse(405, "method_not_allowed", "Method not allowed"));

  app.get("/api/v1/daemon", () => {
    const daemon = runtime.daemonStatus?.() ?? daemonStatusFromSnapshot(runtime);
    if (!daemon)
      return errorResponse(503, "daemon_status_unavailable", "Daemon status unavailable");
    return jsonResponse(daemonPayload(daemon));
  });
  app.all("/api/v1/daemon", () => errorResponse(405, "method_not_allowed", "Method not allowed"));

  app.post("/api/v1/stop", (c) => {
    const unauthorized = unauthorizedControlResponse(c.req.header("authorization"), controlToken);
    if (unauthorized) return unauthorized;
    if (!runtime.requestStop)
      return errorResponse(503, "daemon_control_unavailable", "Daemon control unavailable");
    return jsonResponse(runtime.requestStop(), 202);
  });
  app.all("/api/v1/stop", () => errorResponse(405, "method_not_allowed", "Method not allowed"));

  // Mount trace routes BEFORE the :identifier catch-all
  let watcher: TraceWatcher | null = null;
  if (options.traceDir && options.issueStore) {
    const traceRoutes = createTraceRoutes(options.traceDir, options.issueStore);
    watcher = traceRoutes.watcher;
    app.route("/", traceRoutes.app);
  }

  app.get("/api/v1/:identifier", (c) => {
    const issueIdentifier = decodePathParam(c.req.param("identifier"));
    if (issueIdentifier === null) {
      return errorResponse(400, invalidPathParameterError.code, invalidPathParameterError.message);
    }
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

function createControlToken(): string {
  return createOpaqueBearerToken();
}

function unauthorizedControlResponse(
  authorization: string | undefined,
  controlToken: string | null,
): Response | null {
  if (controlToken === null) return null;
  if (bearerToken(authorization) === controlToken) return null;
  return errorResponse(401, "unauthorized", "Missing or invalid daemon control token");
}

function resolveStaticDir(): string {
  // Packaged releases ship the dashboard as a bundled `@lorenz/dashboard` package, so resolve it
  // through Node module resolution to stay correct regardless of install layout. In the dev
  // monorepo the package is not a dependency of the server, so fall back to the built assets.
  try {
    const require = createRequire(import.meta.url);
    return path.dirname(require.resolve("@lorenz/dashboard/dist/index.html"));
  } catch {
    const thisFile = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(thisFile), "../../../apps/web/dist");
  }
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

function daemonStatusFromSnapshot(runtime: RuntimeServerSource): RuntimeSnapshot["daemon"] | null {
  const snapshot = snapshotResult(runtime);
  return snapshot.status === "ok" ? (snapshot.snapshot.daemon ?? null) : null;
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
