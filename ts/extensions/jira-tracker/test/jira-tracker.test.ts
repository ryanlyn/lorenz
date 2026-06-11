import { test } from "vitest";
import { parseConfig } from "@symphony/config";
import { assert } from "@symphony/test-utils";
import { TrackerRegistry } from "@symphony/tracker-sdk";

import {
  JiraClient,
  JiraMcpClient,
  jiraMcpTrackerProvider,
  jiraTrackerProvider,
} from "@symphony/jira-tracker";

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
  assert.match(String(calls[0]?.body.jql), /project in \("ENG"\)/);
  assert.match(String(calls[0]?.body.jql), /status in \("To Do"\)/);
  assert.match(String(calls[0]?.body.jql), /assignee = "account-1"/);
  assert.match(String(calls[0]?.body.jql), /labels = "agent"/);
  assert.equal(
    calls[0]?.headers.authorization,
    `Basic ${Buffer.from("bot@example.com:jira-token").toString("base64")}`,
  );
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
  overrides: { statusName?: string; statusCategory?: string } = {},
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
      labels: ["Symphony:Backend"],
      assignee: { accountId: "account-1" },
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
