import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { match } from "ts-pattern";
import { z } from "zod";
import { httpUrlHost, isRecord, normalizeHttpBindHost, type Settings } from "@lorenz/domain";
import { defaultToolRegistry, type ToolRegistry } from "@lorenz/tool-sdk";

import {
  checkRunClaim,
  createMcpAuthScope,
  mcpAuthScopeForSettings,
  resolveRunClaim,
  validMcpToken,
} from "./auth.js";
import { executeTool, toolSpecs } from "./tools.js";

/**
 * Read-only liveness oracle injected from the composition root (daemon.ts).
 * Given a per-run claim's `(runKey, workerHost, generation)`, returns false once
 * the run is settled/recycled/superseded, pairing liveness with the generation
 * fence. The per-run claim-enforcing mount always injects the real
 * coordinator-backed oracle; {@link defaultIsRunLive} is the FAIL-CLOSED default
 * for any mount that resolves a Token B claim without one, so a wiring omission
 * denies rather than authorizes.
 */
export type IsRunLive = (runKey: string, workerHost: string, generation: number) => boolean;

const defaultIsRunLive: IsRunLive = () => false;

export interface ObservabilityServerOptions {
  host: string;
  port: number;
  authScope?: string | undefined;
  /** Tool packs available to this endpoint; defaults to the process-wide registry. */
  tools?: ToolRegistry | undefined;
  /**
   * Read-only liveness oracle for per-run (Token B) claims. Injected at the
   * composition root; absent on non-claim mounts, where the FAIL-CLOSED default
   * denies any Token B presented to them.
   */
  isRunLive?: IsRunLive | undefined;
}

export interface ObservabilityServerHandle {
  host: string;
  port: number;
  authScope: string;
  url(path?: string): string;
  stop(): Promise<void>;
}

export interface McpMountOptions {
  authScope?: string | undefined;
  /** Tool packs available to this endpoint; defaults to the process-wide registry. */
  tools?: ToolRegistry | undefined;
  /**
   * Read-only liveness oracle for per-run (Token B) claims. Injected at the
   * composition root; absent on non-claim mounts, where the FAIL-CLOSED default
   * denies any Token B presented to them.
   */
  isRunLive?: IsRunLive | undefined;
}

const mcpPath = "/mcp";

// The claim middleware stashes the request body it already parsed here, keyed by
// the underlying `Request`, so `handleMcp` reads it back instead of re-parsing -
// the JSON is parsed once per request. A WeakMap avoids typing the untyped Hono
// app's context store and lets the entry be collected with the request.
const parsedRequestBodies = new WeakMap<Request, Record<string, unknown>>();

export async function startMcpServer(
  settings: Settings,
  options: ObservabilityServerOptions,
): Promise<ObservabilityServerHandle> {
  const app = new Hono();
  const bindHost = normalizeHttpBindHost(options.host);
  const authScope =
    options.authScope ??
    (options.port > 0
      ? mcpAuthScopeForSettings(settings, bindHost, options.port)
      : createMcpAuthScope());
  mountMcp(app, settings, { authScope, tools: options.tools, isRunLive: options.isRunLive });
  app.notFound((c) =>
    c.req.method === "GET"
      ? errorResponse(404, "not_found", "Route not found")
      : errorResponse(405, "method_not_allowed", "Method not allowed"),
  );
  return startHonoServer(app, options, authScope);
}

/**
 * Mount the MCP endpoint. `settings` may be a thunk so a long-lived mount (the
 * observability server) serves the runtime's CURRENT workflow settings after a hot reload,
 * instead of the snapshot taken when the server was built.
 */
export function mountMcp(
  app: Hono,
  settings: Settings | (() => Settings),
  options: McpMountOptions = {},
): void {
  const currentSettings = typeof settings === "function" ? settings : () => settings;
  const authScope = options.authScope ?? createMcpAuthScope();
  const isRunLive = options.isRunLive ?? defaultIsRunLive;
  // A mount handed a real `isRunLive` oracle IS the per-run claim-enforcing
  // (co-residence) MCP server: it accepts ONLY Token B and never falls back to
  // the settings-wide Token A path, so a settings-wide token can never authorize
  // a co-resident run's MCP calls. Non-claim mounts (the observability server,
  // the legacy acp/local endpoint) inject no oracle and keep the Token A path.
  const enforcePerRunClaim = options.isRunLive !== undefined;
  app.use(mcpPath, async (c, next) => {
    if (c.req.method !== "POST") {
      await next();
      return;
    }
    const bearer = bearerToken(c.req.header("authorization"));
    // Token B (per-run scoped claim) is the only source of a request's runKey:
    // resolve it server-side from the opaque token and re-check the owner on
    // EVERY request. A self-reported runKey header is never trusted.
    const claim = resolveRunClaim(bearer);
    if (claim) {
      // Parse the body ONCE here for the allowlist re-check and stash a record
      // body for `handleMcp` to reuse (a malformed/non-record body is left
      // unstashed so `handleMcp` re-parses and reports the JSON-RPC parse error).
      const parsedBody = parseRequestBody(await c.req.text());
      if (isRecord(parsedBody)) parsedRequestBodies.set(c.req.raw, parsedBody);
      const decision = checkRunClaim(claim, { toolName: requestToolName(parsedBody), isRunLive });
      if (!decision.ok) return unauthorizedMcpResponse();
      await next();
      return;
    }
    // Claim-enforcing mount: NO Token A fallback. A bearer that is not a live
    // Token B is refused outright (fail closed), closing the settings-wide
    // bypass on the shared per-run server.
    if (enforcePerRunClaim) {
      return unauthorizedMcpResponse();
    }
    // Non-claim mount: the settings-wide Token A path (observability server,
    // legacy acp/local endpoint).
    if (!validMcpToken(bearer, authScope)) {
      return unauthorizedMcpResponse();
    }
    await next();
  });
  app.post(mcpPath, async (c) => handleMcp(currentSettings(), c, options.tools));
  app.all(mcpPath, () => errorResponse(405, "method_not_allowed", "Method not allowed"));
}

async function startHonoServer(
  app: Hono,
  options: ObservabilityServerOptions,
  authScope: string,
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
  const address = activeServer.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    host: bindHost,
    port,
    authScope,
    url(path = "/"): string {
      return `http://${httpUrlHost(bindHost)}:${port}${path}`;
    },
    stop: async () => stopServer(activeServer),
  };
}

async function handleMcp(settings: Settings, c: Context, tools?: ToolRegistry): Promise<Response> {
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

  const response = await mcpResponse(settings, body, tools);
  if (response === null) return new Response("", { status: 204 });
  return jsonResponse(response);
}

async function requestJson(c: Context): Promise<Record<string, unknown>> {
  // Reuse the record body the claim middleware already parsed, if present, so the
  // per-request MCP path parses the JSON exactly once.
  const cached = getRequestBody(c);
  if (cached) return cached;
  const parsed = JSON.parse(await c.req.text()) as unknown;
  if (!isRecord(parsed)) throw new Error("request body must be an object");
  return parsed;
}

function getRequestBody(c: Context): Record<string, unknown> | undefined {
  return parsedRequestBodies.get(c.req.raw);
}

/** Parse a raw JSON body, returning `undefined` for unparseable input. */
function parseRequestBody(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
}

function bearerToken(authorization: string | undefined): string | undefined {
  return /^Bearer\s+(.+)$/.exec(authorization ?? "")?.[1];
}

function unauthorizedMcpResponse(): Response {
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

/**
 * Best-effort `tools/call` name for the per-run allowlist re-check, read from the
 * already-parsed request body. Returns null for non-tool requests or
 * unparseable/non-record bodies; the allowlist only narrows tool calls, so a null
 * name simply skips the allowlist (the rest of the claim still gates the request).
 */
function requestToolName(body: unknown): string | null {
  if (!isRecord(body) || body.method !== "tools/call") return null;
  const params = body.params;
  if (!isRecord(params)) return null;
  const name = params.name;
  return typeof name === "string" ? name.trim() || null : null;
}

export async function mcpResponse(
  settings: Settings,
  body: Record<string, unknown>,
  tools: ToolRegistry = defaultToolRegistry,
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
          serverInfo: { name: "mcp", version: "0.1.0" },
        },
      };
    })
    .with("tools/list", () => ({
      jsonrpc: "2.0",
      id,
      result: { tools: toolSpecs(settings, tools) },
    }))
    .with("tools/call", async () => {
      const parsed = mcpToolsCallParamsSchema.safeParse(body.params);
      if (!parsed.success) return jsonRpcError(id, -32602, "Invalid params");
      const result = await executeTool(
        parsed.data.name,
        parsed.data.arguments,
        settings,
        fetch,
        tools,
      );
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
  (value) => (Array.isArray(value) ? value : isRecord(value) ? value : {}),
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

async function stopServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
