import { test, vi } from "vitest";
import { parseConfig as parseWorkflowConfig } from "@symphony/cli";
import { TrackerRegistry } from "@symphony/tracker-sdk";
import { assert } from "@symphony/test-utils";

import { LinearClient, linearTrackerProvider } from "@symphony/linear-tracker";

// Parse config against a private registry so the linear provider's aliases and option
// validation apply without mutating the process-wide default registry.
const trackers = new TrackerRegistry();
trackers.register(linearTrackerProvider);

function parseConfig(raw: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  return parseWorkflowConfig(raw, env, {}, trackers);
}

interface FetchCall {
  url: string;
  body: { query?: string; variables?: Record<string, unknown> };
}

test("Linear client refuses requests without an API key", async () => {
  const calls: FetchCall[] = [];
  const client = new LinearClient(
    parseConfig({ tracker: { kind: "linear", project_slug: "mono" } }, {}),
    (async (input, init) => {
      calls.push(fetchCall(input, init));
      return jsonResponse({ data: { viewer: { id: "viewer-1" } } });
    }) as typeof fetch,
  );

  await assert.rejects(() => client.viewer(), /missing Linear API key/);
  assert.equal(calls.length, 0);
});

test("Linear client classifies GraphQL, HTTP, and payload failures", async () => {
  await assert.rejects(
    () =>
      new LinearClient(
        settings(),
        fetchSequence(jsonResponse({ errors: [{ message: "bad query" }] })),
      ).viewer(),
    /linear_graphql_errors/,
  );
  await assert.rejects(
    () =>
      new LinearClient(
        settings(),
        fetchSequence(jsonResponse({ errors: [{ message: "bad query" }] }, 400)),
      ).viewer(),
    /linear_graphql_errors/,
  );
  await assert.rejects(
    () =>
      new LinearClient(settings(), fetchSequence(jsonResponse({ message: "rate limited" }, 429)), {
        maxRetries: 0,
      }).viewer(),
    /linear api status 429/,
  );
  await assert.rejects(
    () => new LinearClient(settings(), fetchSequence(jsonResponse({ data: null }))).viewer(),
    /linear_unknown_payload/,
  );
  await assert.rejects(
    () =>
      new LinearClient(
        settings(),
        fetchSequence(new Response("not json", { status: 200 })),
      ).viewer(),
    /linear_invalid_json/,
  );
  await assert.rejects(
    () =>
      new LinearClient(settings(), (async () => {
        throw new Error("network down");
      }) as typeof fetch).viewer(),
    /network down/,
  );
});

test("Linear project lookup reports missing project slug results", async () => {
  const client = new LinearClient(
    settings(),
    fetchSequence(jsonResponse({ data: { projects: { nodes: [] } } })),
  );

  await assert.rejects(() => client.projectBySlug("missing"), /linear project not found: missing/);
});

test("Linear client retries 429 responses using Retry-After before succeeding", async () => {
  const delays: number[] = [];
  const warnings: string[] = [];
  const warnSpy = viSpyOnConsoleWarn(warnings);
  const client = new LinearClient(
    settings(),
    fetchSequence(
      jsonResponse({ errors: [{ message: "rate limited" }] }, 429, { "retry-after": "2" }),
      jsonResponse({ data: { viewer: { id: "viewer-1" } } }),
    ),
    {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      baseDelayMs: 50,
    },
  );

  try {
    assert.deepEqual(await client.viewer(), { id: "viewer-1" });
    assert.deepEqual(delays, [2000]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /status=429 retry=1\/4 delay_ms=2000/);
    assert.match(warnings[0] ?? "", /operation=SymphonyTsViewer/);
    assert.match(warnings[0] ?? "", /rate limited/);
  } finally {
    warnSpy.mockRestore();
  }
});

test("Linear client bounds HTTP requests with the configured connect timeout", async () => {
  const signals: Array<boolean> = [];
  const client = new LinearClient(settings(), (async (_input, init) => {
    signals.push(init?.signal instanceof AbortSignal);
    return jsonResponse({ data: { viewer: { id: "viewer-1" } } });
  }) as typeof fetch);

  assert.deepEqual(await client.viewer(), { id: "viewer-1" });
  assert.deepEqual(signals, [true]);
});

test("Linear client retries 429 responses using exponential backoff without Retry-After", async () => {
  const delays: number[] = [];
  const client = new LinearClient(
    settings(),
    fetchSequence(
      jsonResponse({ errors: [{ message: "burst limit" }] }, 429),
      jsonResponse({ errors: [{ message: "burst limit" }] }, 429),
      jsonResponse({ data: { viewer: { id: "viewer-1" } } }),
    ),
    {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      baseDelayMs: 50,
      maxDelayMs: 1000,
    },
  );

  assert.deepEqual(await client.viewer(), { id: "viewer-1" });
  assert.deepEqual(delays, [50, 100]);
});

test("Linear client treats blank Retry-After as missing and backs off", async () => {
  const delays: number[] = [];
  const client = new LinearClient(
    settings(),
    fetchSequence(
      jsonResponse({ errors: [{ message: "blank retry hint" }] }, 429, { "retry-after": " \t " }),
      jsonResponse({ data: { viewer: { id: "viewer-1" } } }),
    ),
    {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      baseDelayMs: 50,
      maxDelayMs: 1000,
    },
  );

  assert.deepEqual(await client.viewer(), { id: "viewer-1" });
  assert.deepEqual(delays, [50]);
});

test("Linear client stops retrying 429 responses after retry budget is exhausted", async () => {
  const delays: number[] = [];
  const client = new LinearClient(
    settings(),
    fetchSequence(
      jsonResponse({ errors: [{ message: "still rate limited" }] }, 429, {
        "retry-after": "Mon, 06 Apr 2026 03:00:02 GMT",
      }),
      jsonResponse({ errors: [{ message: "still rate limited" }] }, 429, {
        "retry-after": "Mon, 06 Apr 2026 03:00:02 GMT",
      }),
    ),
    {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      now: () => new Date("2026-04-06T03:00:00.000Z"),
      maxRetries: 1,
      baseDelayMs: 50,
    },
  );

  await assert.rejects(() => client.viewer(), /linear api status 429/);
  assert.deepEqual(delays, [2000]);
});

test("Linear client logs non-200 failures with operation and bounded body", async () => {
  const errors: string[] = [];
  const errorSpy = viSpyOnConsoleError(errors);
  const body = {
    message: `BAD_USER_INPUT ${"x".repeat(1200)}`,
  };
  const client = new LinearClient(settings(), fetchSequence(jsonResponse(body, 500)));

  try {
    await assert.rejects(() => client.viewer(), /linear api status 500/);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /Linear GraphQL request failed status=500/);
    assert.match(errors[0] ?? "", /operation=SymphonyTsViewer/);
    assert.match(errors[0] ?? "", /BAD_USER_INPUT/);
    assert.match(errors[0] ?? "", /truncated/);
  } finally {
    errorSpy.mockRestore();
  }
});

test("Linear candidate polling follows every page in order", async () => {
  const calls: FetchCall[] = [];
  const client = new LinearClient(
    settings(),
    fetchSequence(
      jsonResponse({
        data: {
          issues: {
            nodes: [linearIssue("id-1", "MT-1")],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
        },
      }),
      jsonResponse({
        data: {
          issues: {
            nodes: [linearIssue("id-2", "MT-2")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      calls,
    ),
  );

  const issues = await client.fetchCandidateIssues();

  assert.deepEqual(
    issues.map((issue) => issue.identifier),
    ["MT-1", "MT-2"],
  );
  assert.equal(calls[0]?.body.variables?.after, null);
  assert.match(String(calls[0]?.body.query), /inverseRelations\(first: 50\)/);
  assert.equal(calls[1]?.body.variables?.after, "cursor-1");
});

test("Linear candidate polling drops malformed issue nodes and keeps healthy nodes", async () => {
  const client = new LinearClient(
    settings(),
    fetchSequence(
      jsonResponse({
        data: {
          issues: {
            nodes: [
              linearIssue("id-1", "MT-1"),
              { ...linearIssue("id-bad", "MT-BAD"), state: { name: "Todo", type: "unknown" } },
              linearIssue("id-2", "MT-2"),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    ),
  );

  const issues = await client.fetchCandidateIssues();

  assert.deepEqual(
    issues.map((issue) => issue.identifier),
    ["MT-1", "MT-2"],
  );
});

test("Linear fetchIssuesByStates drops malformed nodes without losing other pages", async () => {
  const client = new LinearClient(
    settings(),
    fetchSequence(
      jsonResponse({
        data: {
          issues: {
            nodes: [linearIssue("id-1", "MT-1")],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
        },
      }),
      jsonResponse({
        data: {
          issues: {
            nodes: [{ ...linearIssue("id-bad", "MT-BAD"), title: "" }, linearIssue("id-2", "MT-2")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    ),
  );

  const issues = await client.fetchIssuesByStates(["Todo"]);

  assert.deepEqual(
    issues.map((issue) => issue.identifier),
    ["MT-1", "MT-2"],
  );
});

test("Linear assignee me resolves through viewer before normalizing issues", async () => {
  const calls: FetchCall[] = [];
  const client = new LinearClient(
    parseConfig(
      {
        tracker: {
          kind: "linear",
          api_key: "linear-token",
          project_slug: "mono",
          active_states: ["Todo"],
          assignee: "me",
        },
      },
      {},
    ),
    fetchSequence(
      jsonResponse({ data: { viewer: { id: "viewer-1", email: "worker@example.com" } } }),
      jsonResponse({
        data: {
          issues: {
            nodes: [{ ...linearIssue("id-1", "MT-1"), assignee: { id: "viewer-1" } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      calls,
    ),
  );

  const issues = await client.fetchCandidateIssues();

  assert.match(String(calls[0]?.body.query), /viewer/);
  assert.equal(issues[0]?.assignedToWorker, true);
});

test("Linear candidate polling rejects a continued page without a cursor", async () => {
  const client = new LinearClient(
    settings(),
    fetchSequence(
      jsonResponse({
        data: {
          issues: {
            nodes: [linearIssue("id-1", "MT-1")],
            pageInfo: { hasNextPage: true, endCursor: null },
          },
        },
      }),
    ),
  );

  await assert.rejects(() => client.fetchCandidateIssues(), /linear_missing_end_cursor/);
});

test("Linear candidate polling rejects truncated inverse relation pages", async () => {
  const client = new LinearClient(
    settings(),
    fetchSequence(
      jsonResponse({
        data: {
          issues: {
            nodes: [
              {
                ...linearIssue("id-1", "MT-1"),
                inverseRelations: {
                  nodes: [],
                  pageInfo: { hasNextPage: true, endCursor: "relation-cursor-1" },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    ),
  );

  await assert.rejects(
    () => client.fetchCandidateIssues(),
    /linear_truncated_connection: issue.inverseRelations/,
  );
});

test("Linear project lookup rejects truncated teams and states", async () => {
  await assert.rejects(
    () =>
      new LinearClient(
        settings(),
        fetchSequence(
          jsonResponse({
            data: {
              projects: {
                nodes: [
                  {
                    id: "proj-1",
                    name: "My Project",
                    slugId: "my-proj",
                    teams: {
                      nodes: [],
                      pageInfo: { hasNextPage: true, endCursor: "team-cursor-1" },
                    },
                  },
                ],
              },
            },
          }),
        ),
      ).projectBySlug("my-proj"),
    /linear_truncated_connection: project.teams/,
  );

  await assert.rejects(
    () =>
      new LinearClient(
        settings(),
        fetchSequence(
          jsonResponse({
            data: {
              projects: {
                nodes: [
                  {
                    id: "proj-1",
                    name: "My Project",
                    slugId: "my-proj",
                    teams: {
                      nodes: [
                        {
                          id: "team-1",
                          key: "MP",
                          name: "My Team",
                          states: {
                            nodes: [],
                            pageInfo: { hasNextPage: true, endCursor: "state-cursor-1" },
                          },
                        },
                      ],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                ],
              },
            },
          }),
        ),
      ).projectBySlug("my-proj"),
    /linear_truncated_connection: project.team.states/,
  );
});

test("Linear fetchIssuesByIds dedupes, batches, and restores requested order", async () => {
  const uniqueIds = Array.from({ length: 51 }, (_, index) => `id-${index}`);
  const requestedIds = [uniqueIds[0] ?? "", ...uniqueIds];
  const calls: FetchCall[] = [];
  const firstBatch = uniqueIds.slice(0, 50);
  const secondBatch = uniqueIds.slice(50);
  const client = new LinearClient(
    settings(),
    fetchSequence(
      jsonResponse({
        data: {
          issues: {
            nodes: firstBatch.toReversed().map((id, index) => linearIssue(id, `MT-${49 - index}`)),
          },
        },
      }),
      jsonResponse({
        data: {
          issues: { nodes: secondBatch.map((id, index) => linearIssue(id, `MT-${50 + index}`)) },
        },
      }),
      calls,
    ),
  );

  const issues = await client.fetchIssuesByIds(requestedIds);

  assert.deepEqual(calls[0]?.body.variables?.ids, firstBatch);
  assert.equal(calls[0]?.body.variables?.first, 50);
  assert.deepEqual(calls[1]?.body.variables?.ids, secondBatch);
  assert.deepEqual(
    issues.map((issue) => issue.id),
    uniqueIds,
  );
});

test("Linear fetchIssuesByIds returns empty without touching the network", async () => {
  const calls: FetchCall[] = [];
  const client = new LinearClient(settings(), (async (input, init) => {
    calls.push(fetchCall(input, init));
    return jsonResponse({ data: { issues: { nodes: [] } } });
  }) as typeof fetch);

  assert.deepEqual(await client.fetchIssuesByIds([]), []);
  assert.equal(calls.length, 0);
});

test("Linear fetchIssuesByStates returns empty without touching the network", async () => {
  const calls: FetchCall[] = [];
  const client = new LinearClient(settings(), (async (input, init) => {
    calls.push(fetchCall(input, init));
    return jsonResponse({ data: { issues: { nodes: [] } } });
  }) as typeof fetch);

  assert.deepEqual(await client.fetchIssuesByStates([]), []);
  assert.equal(calls.length, 0);
});

test("Linear fetchIssuesByStates stringifies and deduplicates state names", async () => {
  const calls: FetchCall[] = [];
  const client = new LinearClient(
    settings(),
    fetchSequence(
      jsonResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      calls,
    ),
  );

  await client.fetchIssuesByStates(["Todo", "Todo", 42] as unknown as string[]);

  assert.deepEqual(calls[0]?.body.variables?.stateNames, ["Todo", "42"]);
});

test("Linear archiveIssue archives by id and reports failed payloads", async () => {
  const calls: FetchCall[] = [];
  await new LinearClient(
    settings(),
    fetchSequence(jsonResponse({ data: { issueArchive: { success: true } } }), calls),
  ).archiveIssue("issue-1");

  assert.match(String(calls[0]?.body.query), /issueArchive/);
  assert.deepEqual(calls[0]?.body.variables, { id: "issue-1" });

  await assert.rejects(
    () =>
      new LinearClient(
        settings(),
        fetchSequence(jsonResponse({ data: { issueArchive: { success: false } } })),
      ).archiveIssue("issue-2"),
    /linear issueArchive failed/,
  );
});

function settings() {
  return parseConfig(
    {
      tracker: {
        kind: "linear",
        api_key: "linear-token",
        project_slug: "mono",
        active_states: ["Todo"],
      },
    },
    {},
  );
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

function fetchSequence(...items: Array<Response | FetchCall[]>): typeof fetch {
  const maybeCalls = items[items.length - 1];
  const calls = Array.isArray(maybeCalls) ? maybeCalls : [];
  const responses = (Array.isArray(maybeCalls) ? items.slice(0, -1) : items) as Response[];
  return (async (input, init) => {
    calls.push(fetchCall(input, init));
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch");
    return response;
  }) as typeof fetch;
}

function fetchCall(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): FetchCall {
  return {
    url: String(input),
    body: JSON.parse(String(init?.body ?? "{}")) as FetchCall["body"],
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function linearIssue(id: string, identifier: string): Record<string, unknown> {
  return {
    id,
    identifier,
    title: `Issue ${identifier}`,
    description: `Description ${identifier}`,
    priority: 2,
    state: { name: "Todo", type: "unstarted" },
    branchName: `${identifier.toLowerCase()}-branch`,
    url: `https://linear.app/test/issue/${identifier}`,
    assignee: { id: "user-1", email: "worker@example.com" },
    labels: { nodes: [{ name: "Symphony:Backend" }] },
    inverseRelations: {
      nodes: [
        { type: "blocks", issue: { id: "blocker-1", identifier: "MT-0", state: { name: "Done" } } },
      ],
    },
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:01:00.000Z",
  };
}
