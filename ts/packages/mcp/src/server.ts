import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { match } from "ts-pattern";
import { z } from "zod";
import type { Settings } from "@symphony/domain";

import { validMcpToken } from "./auth.js";
import { executeTool, toolSpecs } from "./tools.js";

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

export async function startClaudeMcpServer(
  settings: Settings,
  options: ObservabilityServerOptions,
): Promise<ObservabilityServerHandle> {
  const app = new Hono();
  mountClaudeMcp(app, settings);
  app.notFound((c) =>
    c.req.method === "GET"
      ? errorResponse(404, "not_found", "Route not found")
      : errorResponse(405, "method_not_allowed", "Method not allowed"),
  );
  return startHonoServer(app, options);
}

export function mountClaudeMcp(app: Hono, settings: Settings): void {
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
    stop: async () => stopServer(activeServer),
  };
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
  if (mcpResponse === null) return new Response("", { status: 204 });
  return jsonResponse(mcpResponse);
}

async function requestJson(c: Context): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await c.req.text()) as unknown;
  if (!isRecord(parsed)) throw new Error("request body must be an object");
  return parsed;
}

function authorizedMcpHeader(authorization: string | undefined): boolean {
  const bearer = /^Bearer\s+(.+)$/.exec(authorization ?? "")?.[1];
  return validMcpToken(bearer);
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function urlHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

async function stopServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
