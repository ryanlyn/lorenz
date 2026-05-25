import { test } from "vitest";
import { executeTool, parseConfig } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

test("linear_graphql tool validates name, input, and API key before network", async () => {
  const settings = parseConfig({ tracker: { project_slug: "mono" } }, {});
  const calls: unknown[] = [];
  const fetchImpl = (async () => {
    calls.push("called");
    return jsonResponse({ data: {} });
  }) as typeof fetch;

  assert.deepEqual(await executeTool("unknown", {}, settings, fetchImpl), {
    success: false,
    error: "Unsupported tool.",
    result: {
      error: {
        message: "Unsupported tool.",
        supportedTools: ["linear_graphql"],
      },
    },
  });
  assert.deepEqual(await executeTool("linear_graphql", {}, settings, fetchImpl), {
    success: false,
    error: "`linear_graphql` requires a non-empty `query` string.",
    result: {
      error: {
        message: "`linear_graphql` requires a non-empty `query` string.",
      },
    },
  });
  assert.deepEqual(
    await executeTool("linear_graphql", "query { viewer { id } }", settings, fetchImpl),
    {
      success: false,
      error:
        "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
      result: {
        error: {
          message:
            "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
        },
      },
    },
  );
  assert.deepEqual(
    await executeTool("linear_graphql", { query: "query { viewer { id } }" }, settings, fetchImpl),
    {
      success: false,
      error:
        "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
      result: {
        error: {
          message:
            "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
        },
      },
    },
  );
  assert.equal(calls.length, 0);
});

test("linear_graphql tool rejects non-object variables instead of silently dropping them", async () => {
  assert.deepEqual(
    await executeTool(
      "linear_graphql",
      { query: "query { viewer { id } }", variables: [] },
      linearSettings(),
    ),
    {
      success: false,
      error: "`linear_graphql.variables` must be a JSON object when provided.",
      result: {
        error: {
          message: "`linear_graphql.variables` must be a JSON object when provided.",
        },
      },
    },
  );
});

test("linear_graphql tool accepts null variables and rejects blank queries", async () => {
  assert.deepEqual(
    await executeTool("linear_graphql", { query: "   ", variables: null }, linearSettings()),
    {
      success: false,
      error: "`linear_graphql` requires a non-empty `query` string.",
      result: {
        error: {
          message: "`linear_graphql` requires a non-empty `query` string.",
        },
      },
    },
  );

  const calls: Array<Record<string, unknown>> = [];
  const result = await executeTool(
    "linear_graphql",
    { query: "query { viewer { id } }", variables: null },
    linearSettings(),
    (async (_input, init) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return jsonResponse({ data: { viewer: { id: "viewer-1" } } });
    }) as typeof fetch,
  );

  assert.equal(result.success, true);
  assert.deepEqual(calls[0]?.variables, {});
});

test("linear_graphql tool treats GraphQL errors as failed operations on 200 and 400", async () => {
  const settings = linearSettings();

  assert.deepEqual(
    await executeTool(
      "linear_graphql",
      { query: "query Bad { nope }" },
      settings,
      fetchSequence(jsonResponse({ errors: [{ message: "bad query" }] })),
    ),
    {
      success: false,
      result: { errors: [{ message: "bad query" }] },
    },
  );
  assert.deepEqual(
    await executeTool(
      "linear_graphql",
      { query: "query Bad { nope }" },
      settings,
      fetchSequence(jsonResponse({ errors: [{ message: "bad query" }] }, 400)),
    ),
    {
      success: false,
      result: { errors: [{ message: "bad query" }] },
    },
  );
});

test("linear_graphql tool reports HTTP, invalid JSON, and network failures", async () => {
  const settings = linearSettings();

  assert.deepEqual(
    await executeTool(
      "linear_graphql",
      { query: "query { viewer { id } }" },
      settings,
      fetchSequence(
        jsonResponse({ message: "rate limited" }, 429, { "retry-after": "0" }),
        jsonResponse({ message: "rate limited" }, 429, { "retry-after": "0" }),
        jsonResponse({ message: "rate limited" }, 429, { "retry-after": "0" }),
        jsonResponse({ message: "rate limited" }, 429, { "retry-after": "0" }),
        jsonResponse({ message: "rate limited" }, 429, { "retry-after": "0" }),
      ),
    ),
    {
      success: false,
      error: "Linear GraphQL request failed with HTTP 429.",
      result: {
        error: {
          message: "Linear GraphQL request failed with HTTP 429.",
          status: 429,
        },
      },
    },
  );
  assert.match(
    (
      await executeTool(
        "linear_graphql",
        { query: "query { viewer { id } }" },
        settings,
        fetchSequence(new Response("not json", { status: 200 })),
      )
    ).error ?? "",
    /linear_invalid_json/,
  );
  assert.match(
    (
      await executeTool(
        "linear_graphql",
        { query: "query { viewer { id } }" },
        settings,
        (async () => {
          throw new Error("socket closed");
        }) as typeof fetch,
      )
    ).error ?? "",
    /Linear GraphQL request failed before receiving a successful response/,
  );
});

test("linear_graphql tool retries 429 responses like the Linear client", async () => {
  const calls: number[] = [];
  const result = await executeTool(
    "linear_graphql",
    { query: "query { viewer { id } }" },
    linearSettings(),
    (async () => {
      calls.push(Date.now());
      return calls.length === 1
        ? jsonResponse({ message: "rate limited" }, 429, { "retry-after": "0" })
        : jsonResponse({ data: { viewer: { id: "viewer-1" } } });
    }) as typeof fetch,
  );

  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
});

test("linear_graphql tool bounds HTTP requests with the Linear connect timeout", async () => {
  const signals: Array<boolean> = [];
  const result = await executeTool(
    "linear_graphql",
    { query: "query { viewer { id } }" },
    linearSettings(),
    (async (_input, init) => {
      signals.push(init?.signal instanceof AbortSignal);
      return jsonResponse({ data: { viewer: { id: "viewer-1" } } });
    }) as typeof fetch,
  );

  assert.equal(result.success, true);
  assert.deepEqual(signals, [true]);
});

test("linear_graphql tool sends variables through unchanged", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await executeTool(
    "linear_graphql",
    { query: "query Viewer($id: String!) { viewer { id } }", variables: { id: "viewer-1" } },
    linearSettings(),
    (async (_input, init) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return jsonResponse({ data: { viewer: { id: "viewer-1" } } });
    }) as typeof fetch,
  );

  assert.equal(result.success, true);
  assert.deepEqual(calls[0], {
    query: "query Viewer($id: String!) { viewer { id } }",
    variables: { id: "viewer-1" },
  });
});

function linearSettings() {
  return parseConfig({ tracker: { api_key: "linear-token", project_slug: "mono" } }, {});
}

function fetchSequence(...responses: Response[]): typeof fetch {
  return (async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch");
    return response;
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
