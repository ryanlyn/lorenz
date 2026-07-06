import { test, vi } from "vitest";
import { parseConfig as parseWorkflowConfig } from "@lorenz/cli";
import { TrackerRegistry } from "@lorenz/tracker-sdk";
import { assert } from "@lorenz/test-utils";

import {
  executeLinearTool,
  linearToolProvider,
  linearToolSpecs,
  linearTrackerProvider,
} from "@lorenz/linear-tracker";

// Parse config against a private registry so the linear provider's aliases and option
// validation apply without mutating the process-wide default registry.
const trackers = new TrackerRegistry();
trackers.register(linearTrackerProvider);

function parseConfig(raw: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  return parseWorkflowConfig(raw, env, {}, trackers);
}

test("linear_graphql tool validates name, input, and API key before network", async () => {
  const settings = parseConfig({ tracker: { kind: "linear", project_slug: "mono" } }, {});
  const calls: unknown[] = [];
  const fetchImpl = (async () => {
    calls.push("called");
    return jsonResponse({ data: {} });
  }) as typeof fetch;

  assert.deepEqual(await executeLinearTool("unknown", {}, settings, fetchImpl), {
    success: false,
    error: 'Unsupported tool: "unknown".',
    result: {
      error: {
        message: 'Unsupported tool: "unknown".',
        supportedTools: ["linear_graphql"],
      },
    },
  });
  assert.deepEqual(await executeLinearTool("linear_graphql", {}, settings, fetchImpl), {
    success: false,
    error: "`linear_graphql` requires a non-empty `query` string.",
    result: {
      error: {
        message: "`linear_graphql` requires a non-empty `query` string.",
      },
    },
  });
  assert.deepEqual(
    await executeLinearTool("linear_graphql", "query { viewer { id } }", settings, fetchImpl),
    {
      success: false,
      error:
        "Lorenz is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
      result: {
        error: {
          message:
            "Lorenz is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
        },
      },
    },
  );
  assert.deepEqual(
    await executeLinearTool(
      "linear_graphql",
      { query: "query { viewer { id } }" },
      settings,
      fetchImpl,
    ),
    {
      success: false,
      error:
        "Lorenz is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
      result: {
        error: {
          message:
            "Lorenz is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
        },
      },
    },
  );
  assert.equal(calls.length, 0);
});

test("linear_graphql tool rejects non-object variables instead of silently dropping them", async () => {
  assert.deepEqual(
    await executeLinearTool(
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
    await executeLinearTool("linear_graphql", { query: "   ", variables: null }, linearSettings()),
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
  const result = await executeLinearTool(
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

test("linear_graphql tool advertises the expected input schema", () => {
  assert.deepEqual(linearToolSpecs()[0]?.inputSchema, {
    type: "object",
    additionalProperties: false,
    required: ["query"],
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
  });
});

test("linear_graphql tool treats GraphQL errors as failed operations on 200 and preserves HTTP failures", async () => {
  const settings = linearSettings();

  assert.deepEqual(
    await executeLinearTool(
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
    await executeLinearTool(
      "linear_graphql",
      { query: "query Bad { nope }" },
      settings,
      fetchSequence(jsonResponse({ errors: [{ message: "bad query" }] }, 400)),
    ),
    {
      success: false,
      error: "Linear GraphQL request failed with HTTP 400.",
      result: {
        error: {
          message: "Linear GraphQL request failed with HTTP 400.",
          status: 400,
          body: '{"errors":[{"message":"bad query"}]}',
        },
      },
    },
  );
});

test("linear_graphql tool reports HTTP, invalid JSON, and network failures", async () => {
  const settings = linearSettings();

  assert.deepEqual(
    await executeLinearTool(
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
          body: '{"message":"rate limited"}',
        },
      },
    },
  );
  assert.match(
    (
      await executeLinearTool(
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
      await executeLinearTool(
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

test("linear_graphql tool logs 429 retries with operation and bounded body", async () => {
  const warnings: string[] = [];
  const warnSpy = viSpyOnConsoleWarn(warnings);

  try {
    const result = await executeLinearTool(
      "linear_graphql",
      { query: "query LorenzTsViewer { viewer { id } }" },
      linearSettings(),
      fetchSequence(
        jsonResponse({ errors: [{ message: "rate limited" }] }, 429, { "retry-after": "0" }),
        jsonResponse({ data: { viewer: { id: "viewer-1" } } }),
      ),
    );

    assert.equal(result.success, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /status=429 retry=1\/4 delay_ms=0/);
    assert.match(warnings[0] ?? "", /operation=LorenzTsViewer/);
    assert.match(warnings[0] ?? "", /rate limited/);
  } finally {
    warnSpy.mockRestore();
  }
});

test("linear_graphql tool logs non-200 and transport failures with context", async () => {
  const errors: string[] = [];
  const errorSpy = viSpyOnConsoleError(errors);
  const body = { message: `BAD_USER_INPUT ${"x".repeat(1200)}` };
  const bodySummary = `${JSON.stringify(body).slice(0, 1000)}...<truncated>`;

  try {
    assert.deepEqual(
      await executeLinearTool(
        "linear_graphql",
        { query: "query LorenzTsViewer { viewer { id } }" },
        linearSettings(),
        fetchSequence(jsonResponse(body, 500)),
      ),
      {
        success: false,
        error: "Linear GraphQL request failed with HTTP 500.",
        result: {
          error: {
            message: "Linear GraphQL request failed with HTTP 500.",
            status: 500,
            body: bodySummary,
          },
        },
      },
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /Linear GraphQL request failed status=500/);
    assert.match(errors[0] ?? "", /operation=LorenzTsViewer/);
    assert.match(errors[0] ?? "", /BAD_USER_INPUT/);
    assert.match(errors[0] ?? "", /truncated/);

    assert.match(
      (
        await executeLinearTool(
          "linear_graphql",
          { query: "query LorenzTsViewer { viewer { id } }" },
          linearSettings(),
          (async () => {
            throw new Error("socket closed");
          }) as typeof fetch,
        )
      ).error ?? "",
      /Linear GraphQL request failed before receiving a successful response/,
    );
    assert.equal(errors.length, 2);
    assert.match(errors[1] ?? "", /Linear GraphQL request failed: socket closed/);
    assert.match(errors[1] ?? "", /operation=LorenzTsViewer/);
  } finally {
    errorSpy.mockRestore();
  }
});

test("linear_graphql tool redacts secrets in diagnostic logs", async () => {
  const secret = "resolved-env-secret-linear-tool-sentinel";
  const ref = "op://vault/item/linear-tool";
  const errors: string[] = [];
  const errorSpy = viSpyOnConsoleError(errors);
  const settings = parseConfig(
    {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_API_KEY",
        project_slug: "mono",
      },
    },
    { LINEAR_API_KEY: secret },
  );

  try {
    const result = await executeLinearTool(
      "linear_graphql",
      { query: "query LorenzTsViewer { viewer { id } }" },
      settings,
      fetchSequence(
        jsonResponse(
          {
            errors: [
              {
                message: `bad request api_key=${secret} Bearer ${secret} ${ref}`,
              },
            ],
          },
          500,
        ),
      ),
    );
    const serializedResult = JSON.stringify(result);

    assert.equal(errors.length, 1);
    assert.notMatch(errors[0] ?? "", new RegExp(secret));
    assert.notMatch(errors[0] ?? "", /op:\/\/vault\/item\/linear-tool/);
    assert.notMatch(errors[0] ?? "", /Bearer resolved-env-secret-linear-tool-sentinel/);
    assert.match(errors[0] ?? "", /\[REDACTED\]/);
    assert.notMatch(serializedResult, new RegExp(secret));
    assert.notMatch(serializedResult, /op:\/\/vault\/item\/linear-tool/);
    assert.notMatch(serializedResult, /Bearer resolved-env-secret-linear-tool-sentinel/);
    assert.match(serializedResult, /\[REDACTED\]/);
  } finally {
    errorSpy.mockRestore();
  }
});

test("linear_graphql tool retries 429 responses like the Linear client", async () => {
  const calls: number[] = [];
  const result = await executeLinearTool(
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
  const result = await executeLinearTool(
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

test("linear tool pack routes calls through the package tools", async () => {
  assert.equal(linearToolProvider.name, "linear");
  assert.deepEqual(
    linearToolProvider.toolSpecs(linearSettings()).map((spec) => spec.name),
    ["linear_graphql"],
  );

  const result = await linearToolProvider.executeTool(
    "linear_graphql",
    { query: "query { viewer { id } }" },
    {
      settings: linearSettings(),
      fetchImpl: fetchSequence(jsonResponse({ data: { viewer: { id: "viewer-1" } } })),
      env: {},
    },
  );
  assert.equal(result.success, true);
});

test("linear_graphql resolves pack credentials from tools map at parse time", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return jsonResponse({ data: {} });
  }) as typeof fetch;

  // The pack's own tools.linear slice wins over the dispatch tracker credential;
  // whole-value $VAR references resolve against the parse-time environment, so the
  // effective credential is fixed in the parsed settings (and in the MCP scope hash).
  const packSettings = parseConfig(
    {
      tracker: { kind: "dispatch" },
      trackers: {
        dispatch: { provider: "linear", api_key: "tracker-token", project_slug: "mono" },
      },
      tools: {
        linear: { api_key: "$PACK_LINEAR_KEY", endpoint: "https://linear.example/graphql" },
      },
    },
    { PACK_LINEAR_KEY: "pack-token" },
  );
  const packResult = await executeLinearTool(
    "linear_graphql",
    { query: "query { viewer { id } }" },
    packSettings,
    recordingFetch,
  );
  assert.equal(packResult.success, true);
  assert.deepEqual(requests[0], {
    url: "https://linear.example/graphql",
    authorization: "pack-token",
  });

  // Without pack options on a non-linear dispatch tracker there is no credential at all:
  // the dispatch tracker's token must never be sent to Linear.
  const foreignResult = await executeLinearTool(
    "linear_graphql",
    { query: "query { viewer { id } }" },
    parseConfig({ tracker: { kind: "memory", api_key: "foreign-token" } }, {}),
    recordingFetch,
  );
  assert.equal(foreignResult.success, false);
  assert.equal(requests.length, 1);
});

test("linear_graphql tool sends variables through unchanged", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await executeLinearTool(
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
  return parseConfig(
    {
      tracker: { kind: "dispatch" },
      trackers: { dispatch: { provider: "linear", api_key: "linear-token", project_slug: "mono" } },
    },
    {},
  );
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

function viSpyOnConsoleWarn(messages: string[]) {
  return vi.spyOn(console, "warn").mockImplementation((message) => {
    messages.push(String(message));
  });
}

function viSpyOnConsoleError(messages: string[]) {
  return vi.spyOn(console, "error").mockImplementation((message) => {
    messages.push(String(message));
  });
}
