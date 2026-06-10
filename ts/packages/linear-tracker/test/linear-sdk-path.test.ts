import { test, vi } from "vitest";
import { LinearClient, parseConfig } from "@symphony/cli";
import type { LinearGraphQLClient } from "@linear/sdk";

import { assert } from "../../../test/assert.js";

function mockGraphqlClient(
  requestFn: (...args: unknown[]) => Promise<unknown>,
): LinearGraphQLClient {
  return { request: requestFn } as unknown as LinearGraphQLClient;
}

test("SDK path is used when no custom fetch is provided and apiKey is set", () => {
  const settings = parseConfig(
    {
      tracker: { api_key: "lin_api_test", project_slug: "mono", active_states: ["Todo"] },
    },
    {},
  );
  const client = new LinearClient(settings, {
    graphqlClient: mockGraphqlClient(async () => ({})),
  });
  assert.ok(client, "client should be created with injected graphqlClient");
});

test("SDK path graphql method throws when no apiKey", async () => {
  const client = new LinearClient(
    parseConfig({ tracker: { project_slug: "mono", active_states: ["Todo"] } }, {}),
    { graphqlClient: mockGraphqlClient(async () => ({})) },
  );

  await assert.rejects(() => client.graphql("query { viewer { id } }"), /missing Linear API key/);
});

test("SDK path routes through injected graphqlClient.request", async () => {
  const mockRequest = vi.fn(async () => ({
    viewer: { id: "viewer-1", name: "Test", email: "test@example.com" },
  }));

  const settings = parseConfig(
    {
      tracker: { api_key: "lin_api_test", project_slug: "mono", active_states: ["Todo"] },
    },
    {},
  );
  const client = new LinearClient(settings, { graphqlClient: mockGraphqlClient(mockRequest) });

  const result = await client.viewer();
  assert.deepEqual(result, { id: "viewer-1", name: "Test", email: "test@example.com" });
  assert.equal(mockRequest.mock.calls.length, 1);
  const [query] = mockRequest.mock.calls[0]!;
  assert.match(query as string, /viewer/);
});

test("SDK path retries rate limit errors with exponential backoff", async () => {
  const delays: number[] = [];
  let callCount = 0;

  const mockRequest = vi.fn(async () => {
    callCount += 1;
    if (callCount <= 2) {
      const error = new Error("Request failed with status code 429");
      (error as unknown as { status: number }).status = 429;
      throw error;
    }
    return { viewer: { id: "viewer-1", name: "Test", email: "test@example.com" } };
  });

  const settings = parseConfig(
    {
      tracker: { api_key: "lin_api_test", project_slug: "mono", active_states: ["Todo"] },
    },
    {},
  );
  const client = new LinearClient(
    settings,
    { graphqlClient: mockGraphqlClient(mockRequest) },
    {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      baseDelayMs: 100,
      maxDelayMs: 5000,
    },
  );

  const result = await client.viewer();
  assert.deepEqual(result, { id: "viewer-1", name: "Test", email: "test@example.com" });
  assert.equal(callCount, 3);
  assert.deepEqual(delays, [100, 200]);
});

test("SDK path honors Retry-After headers from rate limit errors", async () => {
  const delays: number[] = [];
  let callCount = 0;

  const mockRequest = vi.fn(async () => {
    callCount += 1;
    if (callCount === 1) {
      const error = new Error("Request failed with status code 429");
      (error as unknown as { status: number }).status = 429;
      (error as unknown as { response: { status: number; headers: Headers } }).response = {
        status: 429,
        headers: new Headers({ "retry-after": "3" }),
      };
      throw error;
    }
    return { viewer: { id: "viewer-1", name: "Test", email: "test@example.com" } };
  });

  const settings = parseConfig(
    {
      tracker: { api_key: "lin_api_test", project_slug: "mono", active_states: ["Todo"] },
    },
    {},
  );
  const client = new LinearClient(
    settings,
    { graphqlClient: mockGraphqlClient(mockRequest) },
    {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      baseDelayMs: 100,
      maxDelayMs: 5000,
    },
  );

  const result = await client.viewer();
  assert.deepEqual(result, { id: "viewer-1", name: "Test", email: "test@example.com" });
  assert.equal(callCount, 2);
  assert.deepEqual(delays, [3000]);
});

test("SDK path rejects requests that exceed the Linear timeout", async () => {
  vi.useFakeTimers();
  let rejection: string | null = null;
  const mockRequest = vi.fn(async () => new Promise<unknown>(() => {}));

  const settings = parseConfig(
    {
      tracker: { api_key: "lin_api_test", project_slug: "mono", active_states: ["Todo"] },
    },
    {},
  );
  const client = new LinearClient(settings, { graphqlClient: mockGraphqlClient(mockRequest) });
  void client.viewer().catch((error: unknown) => {
    rejection = error instanceof Error ? error.message : String(error);
  });

  await vi.advanceTimersByTimeAsync(30_000);
  await Promise.resolve();

  try {
    assert.equal(rejection, "linear api timeout after 30000ms");
  } finally {
    vi.useRealTimers();
  }
});

test("SDK path stops retrying after max retries exceeded", async () => {
  const delays: number[] = [];

  const mockRequest = vi.fn(async () => {
    const error = new Error("Request failed with status code 429");
    (error as unknown as { status: number }).status = 429;
    throw error;
  });

  const settings = parseConfig(
    {
      tracker: { api_key: "lin_api_test", project_slug: "mono", active_states: ["Todo"] },
    },
    {},
  );
  const client = new LinearClient(
    settings,
    { graphqlClient: mockGraphqlClient(mockRequest) },
    {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      baseDelayMs: 50,
      maxDelayMs: 1000,
      maxRetries: 2,
    },
  );

  await assert.rejects(() => client.viewer(), /429/);
  assert.deepEqual(delays, [50, 100]);
});

test("SDK path reclassifies GraphQL errors", async () => {
  const mockRequest = vi.fn(async () => {
    throw new Error("GraphQL error: field not found");
  });

  const settings = parseConfig(
    {
      tracker: { api_key: "lin_api_test", project_slug: "mono", active_states: ["Todo"] },
    },
    {},
  );
  const client = new LinearClient(
    settings,
    { graphqlClient: mockGraphqlClient(mockRequest) },
    { maxRetries: 0 },
  );

  await assert.rejects(() => client.graphql("query { bad }"), /linear_graphql_errors/);
});

test("SDK path passes non-rate-limit errors through without retrying", async () => {
  const errors: string[] = [];
  const errorSpy = vi.spyOn(console, "error").mockImplementation((message) => {
    errors.push(String(message));
  });
  const mockRequest = vi.fn(async () => {
    throw new Error("network down");
  });

  const settings = parseConfig(
    {
      tracker: { api_key: "lin_api_test", project_slug: "mono", active_states: ["Todo"] },
    },
    {},
  );
  const client = new LinearClient(
    settings,
    { graphqlClient: mockGraphqlClient(mockRequest) },
    { maxRetries: 2 },
  );

  try {
    await assert.rejects(() => client.viewer(), /network down/);
    assert.equal(mockRequest.mock.calls.length, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /Linear GraphQL request failed: network down/);
    assert.match(errors[0] ?? "", /operation=SymphonyTsViewer/);
  } finally {
    errorSpy.mockRestore();
  }
});

test("SDK path fetchCandidateIssues resolves viewer and paginates", async () => {
  let requestIndex = 0;
  const mockRequest = vi.fn(async () => {
    requestIndex += 1;
    if (requestIndex === 1) {
      return { viewer: { id: "user-1", name: "Worker", email: "w@x.com" } };
    }
    return {
      issues: {
        nodes: [
          {
            id: "issue-1",
            identifier: "MT-1",
            title: "Test issue",
            description: "Test desc",
            priority: 2,
            state: { id: "state-1", name: "Todo", type: "unstarted" },
            branchName: "mt-1-branch",
            url: "https://linear.app/test/issue/MT-1",
            assignee: { id: "user-1" },
            labels: { nodes: [{ name: "Symphony:Backend" }] },
            inverseRelations: { nodes: [] },
            createdAt: "2026-05-04T00:00:00.000Z",
            updatedAt: "2026-05-04T00:01:00.000Z",
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
  });

  const settings = parseConfig(
    {
      tracker: {
        api_key: "lin_api_test",
        project_slug: "mono",
        active_states: ["Todo"],
        assignee: "me",
      },
    },
    {},
  );
  const client = new LinearClient(settings, { graphqlClient: mockGraphqlClient(mockRequest) });

  const issues = await client.fetchCandidateIssues();
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.identifier, "MT-1");
  assert.equal(issues[0]?.state, "Todo");
  assert.equal(issues[0]?.stateType, "unstarted");
  assert.equal(issues[0]?.assignedToWorker, true);
  assert.deepEqual(issues[0]?.labels, ["symphony:backend"]);
});

test("SDK path retries assignee viewer lookup after transient failure", async () => {
  let requestIndex = 0;
  const mockRequest = vi.fn(async (query: unknown) => {
    requestIndex += 1;
    if (requestIndex === 1) {
      throw new Error("network down");
    }
    if (String(query).includes("viewer")) {
      return { viewer: { id: "user-1", name: "Worker", email: "w@x.com" } };
    }
    return {
      issues: {
        nodes: [
          {
            id: "issue-1",
            identifier: "MT-1",
            title: "Test issue",
            description: "Test desc",
            priority: 2,
            state: { id: "state-1", name: "Todo", type: "unstarted" },
            branchName: "mt-1-branch",
            url: "https://linear.app/test/issue/MT-1",
            assignee: { id: "user-1" },
            labels: { nodes: [{ name: "Symphony:Backend" }] },
            inverseRelations: { nodes: [] },
            createdAt: "2026-05-04T00:00:00.000Z",
            updatedAt: "2026-05-04T00:01:00.000Z",
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
  });

  const settings = parseConfig(
    {
      tracker: {
        api_key: "lin_api_test",
        project_slug: "mono",
        active_states: ["Todo"],
        assignee: "me",
      },
    },
    {},
  );
  const client = new LinearClient(
    settings,
    { graphqlClient: mockGraphqlClient(mockRequest) },
    { maxRetries: 0 },
  );

  await assert.rejects(() => client.fetchCandidateIssues(), /network down/);

  const issues = await client.fetchCandidateIssues();

  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.assignedToWorker, true);
  const viewerQueries = mockRequest.mock.calls.filter(([query]) =>
    String(query).includes("viewer"),
  );
  assert.equal(viewerQueries.length, 2);
});

test("SDK path createIssue sends mutation and normalizes response", async () => {
  const mockRequest = vi.fn(async () => ({
    issueCreate: {
      success: true,
      issue: {
        id: "new-1",
        identifier: "MT-99",
        title: "New issue",
        description: "Created via SDK path",
        priority: 1,
        state: { id: "state-1", name: "Todo", type: "unstarted" },
        branchName: "mt-99-branch",
        url: "https://linear.app/test/issue/MT-99",
        assignee: null,
        labels: { nodes: [] },
        inverseRelations: { nodes: [] },
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
    },
  }));

  const settings = parseConfig(
    {
      tracker: { api_key: "lin_api_test", project_slug: "mono", active_states: ["Todo"] },
    },
    {},
  );
  const client = new LinearClient(settings, { graphqlClient: mockGraphqlClient(mockRequest) });

  const issue = await client.createIssue({
    teamId: "team-1",
    projectId: "proj-1",
    stateId: "state-1",
    title: "New issue",
    description: "Created via SDK path",
  });

  assert.equal(issue.id, "new-1");
  assert.equal(issue.identifier, "MT-99");
  assert.equal(issue.state, "Todo");
  assert.equal(issue.stateType, "unstarted");
  assert.equal(mockRequest.mock.calls.length, 1);
  const [query] = mockRequest.mock.calls[0]!;
  assert.match(query as string, /issueCreate/);
});

test("SDK path archiveIssue sends mutation and checks success", async () => {
  const mockRequest = vi.fn(async () => ({
    issueArchive: { success: true },
  }));

  const settings = parseConfig(
    {
      tracker: { api_key: "lin_api_test", project_slug: "mono", active_states: ["Todo"] },
    },
    {},
  );
  const client = new LinearClient(settings, { graphqlClient: mockGraphqlClient(mockRequest) });

  await client.archiveIssue("issue-1");
  assert.equal(mockRequest.mock.calls.length, 1);
  const [query] = mockRequest.mock.calls[0]!;
  assert.match(query as string, /issueArchive/);
});

test("SDK path archiveIssue throws on failure response", async () => {
  const mockRequest = vi.fn(async () => ({
    issueArchive: { success: false },
  }));

  const settings = parseConfig(
    {
      tracker: { api_key: "lin_api_test", project_slug: "mono", active_states: ["Todo"] },
    },
    {},
  );
  const client = new LinearClient(settings, { graphqlClient: mockGraphqlClient(mockRequest) });

  await assert.rejects(() => client.archiveIssue("issue-1"), /linear issueArchive failed/);
});

test("SDK path updateIssueState sends mutation and normalizes response", async () => {
  const mockRequest = vi.fn(async () => ({
    issueUpdate: {
      success: true,
      issue: {
        id: "issue-1",
        identifier: "MT-1",
        title: "Updated issue",
        description: null,
        priority: 2,
        state: { id: "state-done", name: "Done", type: "completed" },
        branchName: "mt-1-branch",
        url: "https://linear.app/test/issue/MT-1",
        assignee: null,
        labels: { nodes: [] },
        inverseRelations: { nodes: [] },
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T01:00:00.000Z",
      },
    },
  }));

  const settings = parseConfig(
    {
      tracker: { api_key: "lin_api_test", project_slug: "mono", active_states: ["Todo"] },
    },
    {},
  );
  const client = new LinearClient(settings, { graphqlClient: mockGraphqlClient(mockRequest) });

  const issue = await client.updateIssueState("issue-1", "state-done");
  assert.equal(issue.state, "Done");
  assert.equal(issue.stateType, "completed");
  assert.equal(mockRequest.mock.calls.length, 1);
  const [query] = mockRequest.mock.calls[0]!;
  assert.match(query as string, /issueUpdate/);
});

test("SDK path fetchIssuesByIds deduplicates, batches, and orders", async () => {
  const uniqueIds = Array.from({ length: 51 }, (_, index) => `id-${index}`);
  const requestedIds = [uniqueIds[0]!, ...uniqueIds];
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

  const firstBatch = uniqueIds.slice(0, 50);
  const secondBatch = uniqueIds.slice(50);

  const mockRequest = vi.fn(async (_query: string, variables: Record<string, unknown>) => {
    calls.push({ query: _query, variables });
    const ids = variables.ids as string[];
    return {
      issues: {
        nodes: ids.map((id, index) => ({
          id,
          identifier: `MT-${index}`,
          title: `Issue ${id}`,
          description: null,
          priority: 2,
          state: { id: "s1", name: "Todo", type: "unstarted" },
          branchName: `${id}-branch`,
          url: `https://linear.app/test/issue/${id}`,
          assignee: null,
          labels: { nodes: [] },
          inverseRelations: { nodes: [] },
          createdAt: "2026-05-04T00:00:00.000Z",
          updatedAt: "2026-05-04T00:00:00.000Z",
        })),
      },
    };
  });

  const settings = parseConfig(
    {
      tracker: { api_key: "lin_api_test", project_slug: "mono", active_states: ["Todo"] },
    },
    {},
  );
  const client = new LinearClient(settings, { graphqlClient: mockGraphqlClient(mockRequest) });

  const issues = await client.fetchIssuesByIds(requestedIds);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.variables.ids, firstBatch);
  assert.equal(calls[0]?.variables.first, 50);
  assert.deepEqual(calls[1]?.variables.ids, secondBatch);
  assert.deepEqual(
    issues.map((issue) => issue.id),
    uniqueIds,
  );
});

test("SDK path projectBySlug parses teams and states", async () => {
  const mockRequest = vi.fn(async () => ({
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
                  nodes: [
                    { id: "s1", name: "Todo", type: "unstarted" },
                    { id: "s2", name: "Done", type: "completed" },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  }));

  const settings = parseConfig(
    {
      tracker: { api_key: "lin_api_test", project_slug: "my-proj", active_states: ["Todo"] },
    },
    {},
  );
  const client = new LinearClient(settings, { graphqlClient: mockGraphqlClient(mockRequest) });

  const project = await client.projectBySlug();
  assert.equal(project.id, "proj-1");
  assert.equal(project.name, "My Project");
  assert.equal(project.slugId, "my-proj");
  assert.equal(project.teams.length, 1);
  assert.equal(project.teams[0]?.key, "MP");
  assert.equal(project.teams[0]?.states.length, 2);
  assert.equal(project.teams[0]?.states[0]?.name, "Todo");
  assert.equal(project.teams[0]?.states[0]?.type, "unstarted");
  assert.equal(project.teams[0]?.states[1]?.name, "Done");
  assert.equal(project.teams[0]?.states[1]?.type, "completed");
});
