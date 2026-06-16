import path from "node:path";
import { fileURLToPath } from "node:url";

import { errorMessage, isRecord, type Settings } from "@lorenz/domain";
import {
  toolFailure,
  toolSuccess,
  unsupportedToolFailure,
  type ToolProvider,
  type ToolResult,
  type ToolSpec,
} from "@lorenz/tool-sdk";

import { linearToolPackOptions, validateLinearToolOptions } from "./options.js";

/**
 * The `lorenz-linear` skill ships inside this extension (`skills/lorenz-linear`, a sibling
 * of `src`/`dist`) so mounting the Linear pack also overlays the doc that teaches the agent to
 * call `linear_graphql`. Resolved from this module so it works from both `src` and `dist`.
 */
const lorenzLinearSkillDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "lorenz-linear",
);

const LINEAR_MAX_RETRIES = 4;
const MAX_ERROR_BODY_LOG_BYTES = 1000;

interface LinearToolLogger {
  warn(message: string): void;
  error(message: string): void;
}

const defaultLinearToolLogger: LinearToolLogger = {
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export function linearToolSpecs(): ToolSpec[] {
  return [
    {
      name: "linear_graphql",
      description: "Run a Linear GraphQL operation using Lorenz's configured Linear credentials.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "GraphQL query or mutation document to execute against Linear.",
          },
          variables: {
            type: ["object", "null"],
            description: "Optional GraphQL variables object.",
            additionalProperties: true,
          },
        },
        required: ["query"],
      },
    },
  ];
}

export async function executeLinearTool(
  name: string,
  input: unknown,
  settings: Settings,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult> {
  if (name !== "linear_graphql") {
    return unsupportedToolFailure(name, ["linear_graphql"]);
  }
  const normalizedInput = normalizeLinearGraphqlInput(input);
  if (!normalizedInput.ok) {
    return toolFailure(normalizedInput.error);
  }
  const { apiKey, endpoint } = linearToolPackOptions(settings);
  if (!apiKey)
    return toolFailure(
      "Lorenz is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
    );
  if (
    normalizedInput.variables !== undefined &&
    normalizedInput.variables !== null &&
    !isRecord(normalizedInput.variables)
  ) {
    return toolFailure("`linear_graphql.variables` must be a JSON object when provided.");
  }

  try {
    const logger = defaultLinearToolLogger;
    const response = await fetchWithRateLimitRetry(
      fetchImpl,
      { apiKey, endpoint },
      normalizedInput.query,
      normalizedInput.variables ?? {},
      logger,
    );
    const bodyResult = await readResponseJson(response);
    if (!bodyResult.ok) {
      if (!response.ok) {
        logStatusError(logger, normalizedInput.query, response.status, bodyResult.rawBody);
        return toolFailure(`Linear GraphQL request failed with HTTP ${response.status}.`, {
          status: response.status,
        });
      }
      return toolFailure(`linear_invalid_json: ${errorMessage(bodyResult.error)}`);
    }
    const body = bodyResult.body;
    if (!response.ok) {
      logStatusError(logger, normalizedInput.query, response.status, body);
      return toolFailure(`Linear GraphQL request failed with HTTP ${response.status}.`, {
        status: response.status,
      });
    }
    if (isRecord(body) && Array.isArray(body.errors) && body.errors.length > 0) {
      return { success: false, result: body };
    }
    return toolSuccess(body);
  } catch (error) {
    defaultLinearToolLogger.error(
      `Linear GraphQL request failed: ${errorMessage(error)}${linearErrorContext(normalizedInput.query)}`,
    );
    return toolFailure("Linear GraphQL request failed before receiving a successful response.", {
      reason: errorMessage(error),
    });
  }
}

/** The Linear tool pack: raw GraphQL access using the pack's own Linear credentials. */
export const linearToolProvider: ToolProvider = {
  name: "linear",
  skills: [lorenzLinearSkillDir],
  validateOptions: validateLinearToolOptions,
  toolSpecs: () => linearToolSpecs(),
  executeTool: async (name, input, context) =>
    executeLinearTool(name, input, context.settings, context.fetchImpl),
};

function normalizeLinearGraphqlInput(
  input: unknown,
):
  | { ok: true; query: string; variables?: Record<string, unknown> | null | undefined }
  | { ok: false; error: string } {
  if (typeof input === "string") {
    if (input.trim() === "")
      return { ok: false, error: "`linear_graphql` requires a non-empty `query` string." };
    return { ok: true, query: input };
  }
  if (!isRecord(input) || typeof input.query !== "string") {
    return { ok: false, error: "`linear_graphql` requires a non-empty `query` string." };
  }
  if (input.query.trim() === "")
    return { ok: false, error: "`linear_graphql` requires a non-empty `query` string." };
  if (input.variables !== undefined && input.variables !== null && !isRecord(input.variables)) {
    return { ok: false, error: "`linear_graphql.variables` must be a JSON object when provided." };
  }
  return {
    ok: true,
    query: input.query,
    variables: input.variables as Record<string, unknown> | null,
  };
}

async function fetchWithRateLimitRetry(
  fetchImpl: typeof fetch,
  auth: { apiKey: string; endpoint: string },
  query: string,
  variables: Record<string, unknown>,
  logger: LinearToolLogger,
): Promise<Response> {
  for (let retryCount = 0; ; retryCount += 1) {
    const response = await fetchImpl(auth.endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "content-type": "application/json",
        authorization: auth.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (response.status !== 429 || retryCount >= LINEAR_MAX_RETRIES) return response;
    const delayMs = retryDelayMs(response.headers, retryCount);
    logger.warn(
      `Linear GraphQL request rate limited status=429 retry=${retryCount + 1}/${LINEAR_MAX_RETRIES} delay_ms=${delayMs}${linearErrorContext(query, await responseBodyForLog(response))}`,
    );
    await sleep(delayMs);
  }
}

function retryDelayMs(headers: Headers, retryCount: number): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter.trim());
    if (Number.isInteger(seconds) && seconds >= 0) return seconds * 1000;
    const dateMs = Date.parse(retryAfter.trim());
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  return Math.min(1_000 * 2 ** retryCount, 30_000);
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function readResponseJson(
  response: Response,
): Promise<{ ok: true; body: unknown } | { ok: false; error: unknown; rawBody?: string }> {
  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch (error) {
    return { ok: false, error };
  }
  try {
    return { ok: true, body: JSON.parse(rawBody) as unknown };
  } catch (error) {
    return { ok: false, error, rawBody };
  }
}

async function responseBodyForLog(response: Response): Promise<unknown> {
  try {
    const rawBody = await response.clone().text();
    try {
      return JSON.parse(rawBody) as unknown;
    } catch {
      return rawBody;
    }
  } catch {
    return undefined;
  }
}

function logStatusError(
  logger: LinearToolLogger,
  query: string,
  status: number,
  body: unknown,
): void {
  logger.error(`Linear GraphQL request failed status=${status}${linearErrorContext(query, body)}`);
}

function linearErrorContext(query: string, body?: unknown): string {
  const parts: string[] = [];
  const operation = operationName(query);
  if (operation) parts.push(`operation=${operation}`);
  if (body !== undefined) parts.push(`body=${summarizeErrorBody(body)}`);
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

function operationName(query: string): string | null {
  return /\b(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query)?.[1] ?? null;
}

function summarizeErrorBody(body: unknown): string {
  const text = typeof body === "string" ? body : stringifyErrorBody(body);
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_ERROR_BODY_LOG_BYTES) return compact;
  return `${compact.slice(0, MAX_ERROR_BODY_LOG_BYTES)}...<truncated>`;
}

function stringifyErrorBody(body: unknown): string {
  try {
    return JSON.stringify(body) ?? String(body);
  } catch {
    return String(body);
  }
}
