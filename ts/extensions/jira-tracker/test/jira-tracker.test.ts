import { test } from "vitest";
import { parseConfig } from "@lorenz/config";
import { assert } from "@lorenz/test-utils";
import { TrackerRegistry } from "@lorenz/tracker-sdk";

import {
  JiraClient,
  JiraMcpClient,
  jiraMcpTrackerProvider,
  jiraTrackerProvider,
} from "@lorenz/jira-tracker";

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

// Private registry: Jira options in the tracker config section are normalized by the
// registered provider during parsing.
const trackers = new TrackerRegistry();
trackers.register(jiraTrackerProvider);
trackers.register(jiraMcpTrackerProvider);

test("Jira REST client searches scoped candidates and normalizes Jira fields", async () => {
  const calls: FetchCall[] = [];
  const settings = parseConfig(
    {
      tracker: {
        kind: "jira",
        base_url: "https://example.atlassian.net/",
        email: "bot@example.com",
        api_key: "jira-token",
        project_keys: ["ENG"],
        active_states: ["To Do"],
        assignee: "account-1",
      },
    },
    {},
    {},
    trackers,
  );
  const client = new JiraClient(settings, {
    fetchImpl: fetchSequence(
      calls,
      jsonResponse({
        startAt: 0,
        maxResults: 50,
        total: 1,
        issues: [jiraIssue()],
      }),
    ),
  });

  const issues = await client.fetchCandidateIssues();

  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.id, "10001");
  assert.equal(issues[0]?.identifier, "ENG-1");
  assert.equal(issues[0]?.stateType, "unstarted");
  assert.equal(issues[0]?.description, "Fix the thing");
  assert.equal(issues[0]?.assignedToWorker, true);
  assert.equal(issues[0]?.url, "https://example.atlassian.net/browse/ENG-1");
  assert.equal(calls[0]?.url, "https://example.atlassian.net/rest/api/3/search/jql");
  assert.match(String(calls[0]?.body.jql), /project in \("ENG"\)/);
  assert.match(String(calls[0]?.body.jql), /status in \("To Do"\)/);
  assert.match(String(calls[0]?.body.jql), /assignee = "account-1"/);
  assert.match(String(calls[0]?.body.jql), /labels = "agent"/);
  assert.equal(
    calls[0]?.headers.authorization,
    `Basic ${Buffer.from("bot@example.com:jira-token").toString("base64")}`,
  );
});

test("Jira REST client pages /search/jql via nextPageToken until exhausted", async () => {
  const calls: FetchCall[] = [];
  const client = new JiraClient(jiraSettings(), {
    fetchImpl: fetchSequence(
      calls,
      jsonResponse({ issues: [jiraIssue()], nextPageToken: "page-2" }),
      jsonResponse({ issues: [jiraIssue()] }),
    ),
  });

  const issues = await client.searchIssues('project in ("ENG")');

  assert.equal(issues.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, "https://example.atlassian.net/rest/api/3/search/jql");
  assert.equal(calls[0]?.body.nextPageToken, undefined);
  assert.equal(calls[1]?.body.nextPageToken, "page-2");
});

test("Jira REST client updates status via the matching transition", async () => {
  const calls: FetchCall[] = [];
  const client = new JiraClient(jiraSettings(), {
    fetchImpl: fetchSequence(
      calls,
      jsonResponse({ transitions: [{ id: "31", name: "In Progress" }] }),
      jsonResponse(null, 204),
      jsonResponse(jiraIssue({ statusName: "In Progress", statusCategory: "indeterminate" })),
    ),
  });

  const issue = await client.updateIssueStatus("ENG-1", "In Progress");

  assert.equal(issue.state, "In Progress");
  assert.equal(issue.stateType, "started");
  assert.deepEqual(calls[1]?.body, { transition: { id: "31" } });
});

test("Jira REST client adds comments as Atlassian document format", async () => {
  const calls: FetchCall[] = [];
  const client = new JiraClient(jiraSettings(), {
    fetchImpl: fetchSequence(calls, jsonResponse({ id: "comment-1" })),
  });

  await client.addComment("ENG-1", "First line\n\nSecond line");

  assert.equal(calls[0]?.url, "https://example.atlassian.net/rest/api/3/issue/ENG-1/comment");
  assert.deepEqual(calls[0]?.body, {
    body: {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First line" }] },
        { type: "paragraph", content: [] },
        { type: "paragraph", content: [{ type: "text", text: "Second line" }] },
      ],
    },
  });
});

test("Jira REST client assigns created issues to the current user by default", async () => {
  const calls: FetchCall[] = [];
  const client = new JiraClient(jiraSettings(), {
    fetchImpl: fetchSequence(
      calls,
      jsonResponse({ accountId: "account-current" }),
      jsonResponse({ id: "10001", key: "ENG-1" }),
      jsonResponse(jiraIssue({ assigneeAccountId: "account-current" })),
    ),
  });

  const issue = await client.createIssue({ title: "Follow-up", body: "details" });

  assert.equal(issue.identifier, "ENG-1");
  assert.equal(issue.assigneeId, "account-current");
  assert.equal(calls[0]?.url, "https://example.atlassian.net/rest/api/3/myself");
  assert.equal(calls[1]?.url, "https://example.atlassian.net/rest/api/3/issue");
  const fields = (calls[1]?.body.fields ?? {}) as Record<string, unknown>;
  assert.deepEqual(fields.assignee, { accountId: "account-current" });
});

test("Jira REST client assigns created issues to the configured assignee", async () => {
  const calls: FetchCall[] = [];
  const settings = parseConfig(
    {
      tracker: {
        kind: "jira",
        base_url: "https://example.atlassian.net",
        email: "bot@example.com",
        api_key: "jira-token",
        project_keys: ["ENG"],
        assignee: "account-1",
      },
    },
    {},
    {},
    trackers,
  );
  const client = new JiraClient(settings, {
    fetchImpl: fetchSequence(
      calls,
      jsonResponse({ id: "10001", key: "ENG-1" }),
      jsonResponse(jiraIssue()),
    ),
  });

  await client.createIssue({ title: "Follow-up" });

  assert.equal(calls[0]?.url, "https://example.atlassian.net/rest/api/3/issue");
  const fields = (calls[0]?.body.fields ?? {}) as Record<string, unknown>;
  assert.deepEqual(fields.assignee, { accountId: "account-1" });
});

test("Jira MCP client calls configured external tools and normalizes returned issues", async () => {
  const calls: FetchCall[] = [];
  const settings = parseConfig(
    {
      tracker: {
        kind: "jira-mcp",
        base_url: "https://example.atlassian.net",
        project_keys: ["ENG"],
        active_states: ["To Do"],
        mcp: {
          url: "http://127.0.0.1:5123/mcp",
          token: "mcp-token",
          tools: { search: "atlassian_search_jira" },
        },
      },
    },
    {},
    {},
    trackers,
  );
  const client = new JiraMcpClient(settings, {
    fetchImpl: fetchSequence(
      calls,
      jsonResponse({
        jsonrpc: "2.0",
        id: "1",
        result: {
          content: [{ type: "text", text: JSON.stringify({ issues: [jiraIssue()] }) }],
        },
      }),
    ),
  });

  const issues = await client.fetchCandidateIssues();

  assert.equal(issues[0]?.identifier, "ENG-1");
  assert.equal(calls[0]?.url, "http://127.0.0.1:5123/mcp");
  assert.equal(calls[0]?.headers.authorization, "Bearer mcp-token");
  assert.deepEqual(calls[0]?.body.params, {
    name: "atlassian_search_jira",
    arguments: {
      jql: 'project in ("ENG") AND status in ("To Do") AND assignee = currentUser() AND labels = "agent"',
      fields: [
        "summary",
        "description",
        "status",
        "labels",
        "issuelinks",
        "assignee",
        "priority",
        "created",
        "updated",
      ],
    },
  });
});

test("Jira MCP client adds comments with issue_key and comment args", async () => {
  const calls: FetchCall[] = [];
  const settings = jiraMcpSettings();
  const client = new JiraMcpClient(settings, {
    fetchImpl: fetchSequence(
      calls,
      jsonResponse({
        jsonrpc: "2.0",
        id: "1",
        result: {
          content: [{ type: "text", text: "Comment added. ID: 10000" }],
        },
      }),
    ),
  });

  await client.addComment("ENG-1", "Looks good");

  assert.deepEqual(calls[0]?.body.params, {
    name: "jira_add_comment",
    arguments: { issue_key: "ENG-1", comment: "Looks good" },
  });
});

test("Jira MCP client retries comments with alternate args on tool payload errors", async () => {
  const calls: FetchCall[] = [];
  const settings = jiraMcpSettings();
  const client = new JiraMcpClient(settings, {
    fetchImpl: fetchSequence(
      calls,
      jsonResponse({
        jsonrpc: "2.0",
        id: "1",
        result: {
          content: [{ type: "text", text: "Error: issue_key is not accepted" }],
        },
      }),
      jsonResponse({
        jsonrpc: "2.0",
        id: "2",
        result: {
          content: [{ type: "text", text: "Comment added. ID: 10000" }],
        },
      }),
    ),
  });

  await client.addComment("ENG-1", "Looks good");

  assert.deepEqual(calls[0]?.body.params, {
    name: "jira_add_comment",
    arguments: { issue_key: "ENG-1", comment: "Looks good" },
  });
  assert.deepEqual(calls[1]?.body.params, {
    name: "jira_add_comment",
    arguments: { issueKey: "ENG-1", comment: "Looks good" },
  });
});

test("Jira MCP client retries comments with issueId and comment args", async () => {
  const calls: FetchCall[] = [];
  const settings = jiraMcpSettings();
  const client = new JiraMcpClient(settings, {
    fetchImpl: fetchSequence(
      calls,
      ...Array.from({ length: 3 }, (_, index) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: String(index + 1),
          result: {
            content: [{ type: "text", text: "Error: wrong argument shape" }],
          },
        }),
      ),
      jsonResponse({
        jsonrpc: "2.0",
        id: "4",
        result: {
          content: [{ type: "text", text: "Comment added. ID: 10000" }],
        },
      }),
    ),
  });

  await client.addComment("ENG-1", "Looks good");

  assert.deepEqual(calls[3]?.body.params, {
    name: "jira_add_comment",
    arguments: { issueId: "ENG-1", comment: "Looks good" },
  });
});

test("Jira MCP client surfaces comment tool payload errors", async () => {
  const settings = jiraMcpSettings();
  const client = new JiraMcpClient(settings, {
    fetchImpl: fetchSequence(
      [],
      ...Array.from({ length: 10 }, (_, index) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: String(index + 1),
          result: {
            content: [{ type: "text", text: "Error: comment failed" }],
          },
        }),
      ),
    ),
  });

  await assert.rejects(
    () => client.addComment("ENG-1", "Looks good"),
    /jira-mcp add comment failed: Error: comment failed/,
  );
});

test("Jira MCP client omits assignee args when no concrete owner is configured", async () => {
  const calls: FetchCall[] = [];
  const settings = jiraMcpSettings();
  const client = new JiraMcpClient(settings, {
    fetchImpl: fetchSequence(
      calls,
      jsonResponse({
        jsonrpc: "2.0",
        id: "1",
        result: {
          content: [{ type: "text", text: JSON.stringify({ issue: jiraIssue() }) }],
        },
      }),
    ),
  });

  await client.createIssue({ title: "Follow-up", body: "details" });

  const args = ((calls[0]?.body.params as Record<string, unknown>).arguments ?? {}) as Record<
    string,
    unknown
  >;
  assert.equal(args.assignee, undefined);
  assert.equal(args.assigneeId, undefined);
  assert.equal(args.assigneeAccountId, undefined);
});

test("Jira MCP client sends the configured assignee when creating issues", async () => {
  const calls: FetchCall[] = [];
  const settings = parseConfig(
    {
      tracker: {
        kind: "jira-mcp",
        base_url: "https://example.atlassian.net",
        project_keys: ["ENG"],
        assignee: "account-1",
        mcp: {
          url: "http://127.0.0.1:5123/mcp",
          token: "mcp-token",
        },
      },
    },
    {},
    {},
    trackers,
  );
  const client = new JiraMcpClient(settings, {
    fetchImpl: fetchSequence(
      calls,
      jsonResponse({
        jsonrpc: "2.0",
        id: "1",
        result: {
          content: [{ type: "text", text: JSON.stringify({ issue: jiraIssue() }) }],
        },
      }),
    ),
  });

  const issue = await client.createIssue({ title: "Follow-up", body: "details" });

  assert.equal(issue.identifier, "ENG-1");
  assert.deepEqual(calls[0]?.body.params, {
    name: "jira_create_issue",
    arguments: {
      projectKey: "ENG",
      issueType: "Task",
      title: "Follow-up",
      summary: "Follow-up",
      body: "details",
      description: "details",
      assignee: "account-1",
      assigneeId: "account-1",
      assigneeAccountId: "account-1",
    },
  });
});

function jiraMcpSettings() {
  return parseConfig(
    {
      tracker: {
        kind: "jira-mcp",
        base_url: "https://example.atlassian.net",
        project_keys: ["ENG"],
        mcp: {
          url: "http://127.0.0.1:5123/mcp",
          token: "mcp-token",
        },
      },
    },
    {},
    {},
    trackers,
  );
}

function jiraSettings() {
  return parseConfig(
    {
      tracker: {
        kind: "jira",
        base_url: "https://example.atlassian.net",
        email: "bot@example.com",
        api_key: "jira-token",
        project_keys: ["ENG"],
      },
    },
    {},
    {},
    trackers,
  );
}

function jiraIssue(
  overrides: { statusName?: string; statusCategory?: string; assigneeAccountId?: string } = {},
): Record<string, unknown> {
  return {
    id: "10001",
    key: "ENG-1",
    fields: {
      summary: "Fix login",
      description: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Fix the thing" }] }],
      },
      status: {
        name: overrides.statusName ?? "To Do",
        statusCategory: { key: overrides.statusCategory ?? "new" },
      },
      labels: ["Lorenz:Backend"],
      assignee: { accountId: overrides.assigneeAccountId ?? "account-1" },
      priority: { name: "High" },
      created: "2026-06-01T00:00:00.000+0000",
      updated: "2026-06-02T00:00:00.000+0000",
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : body === null ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchSequence(calls: FetchCall[], ...responses: Response[]): typeof fetch {
  return (async (input, init) => {
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      body:
        typeof init?.body === "string" && init.body.trim() !== ""
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {},
      headers: headerRecord(init?.headers),
    });
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch call");
    return response;
  }) as typeof fetch;
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers;
}
