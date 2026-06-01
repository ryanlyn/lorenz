import type { Settings } from "@symphony/domain";

import type { ToolResult, ToolSpec } from "../tools.js";

export function linearToolSpecs(): ToolSpec[] {
  return [
    {
      name: "linear_graphql",
      description: "Run a Linear GraphQL operation using Symphony tracker credentials.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          variables: { type: "object" },
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
    return toolFailure("Unsupported tool.", { supportedTools: ["linear_graphql"] });
  }
  const normalizedInput = normalizeLinearGraphqlInput(input);
  if (!normalizedInput.ok) {
    return toolFailure(normalizedInput.error);
  }
  if (!settings.tracker.apiKey)
    return toolFailure(
      "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
    );
  if (
    normalizedInput.variables !== undefined &&
    normalizedInput.variables !== null &&
    !isRecord(normalizedInput.variables)
  ) {
    return toolFailure("`linear_graphql.variables` must be a JSON object when provided.");
  }

  try {
    const response = await fetchWithRateLimitRetry(
      fetchImpl,
      settings,
      normalizedInput.query,
      normalizedInput.variables ?? {},
    );
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (!response.ok)
        return toolFailure(`Linear GraphQL request failed with HTTP ${response.status}.`, {
          status: response.status,
        });
      return toolFailure(`linear_invalid_json: ${(error as Error).message}`);
    }
    if (isRecord(body) && Array.isArray(body.errors) && body.errors.length > 0) {
      return { success: false, result: body };
    }
    if (!response.ok)
      return toolFailure(`Linear GraphQL request failed with HTTP ${response.status}.`, {
        status: response.status,
      });
    return { success: true, result: body };
  } catch (error) {
    return toolFailure("Linear GraphQL request failed before receiving a successful response.", {
      reason: (error as Error).message,
    });
  }
}

function toolFailure(message: string, details: Record<string, unknown> = {}): ToolResult {
  return {
    success: false,
    error: message,
    result: { error: { message, ...details } },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  settings: Settings,
  query: string,
  variables: Record<string, unknown>,
): Promise<Response> {
  for (let retryCount = 0; ; retryCount += 1) {
    const response = await fetchImpl(settings.tracker.endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "content-type": "application/json",
        authorization: settings.tracker.apiKey ?? "",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (response.status !== 429 || retryCount >= 4) return response;
    await sleep(retryDelayMs(response.headers, retryCount));
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
