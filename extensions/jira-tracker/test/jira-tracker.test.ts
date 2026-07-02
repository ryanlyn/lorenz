import { test } from "vitest";
import { parseConfig } from "@lorenz/config";
import { assert } from "@lorenz/test-utils";
import { TrackerRegistry } from "@lorenz/tracker-sdk";

import {
  JiraClient,
  JiraMcpClient,
  executeJiraTool,
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

test("Jira REST client rejects repeated search cursors", async () => {
  const client = new JiraClient(jiraSettings(), {
    fetchImpl: fetchSequence(
      [],
      jsonResponse({ issues: [jiraIssue()], nextPageToken: "page-2" }),
      jsonResponse({ issues: [jiraIssue()], nextPageToken: "page-2" }),
    ),
  });

  await assert.rejects(
    () => client.searchIssues('project in ("ENG")'),
    /jira_pagination_repeated_cursor: searchIssues nextPageToken="page-2" was returned more than once/,
  );
});

test("Jira REST client rejects malformed search cursors", async () => {
  const client = new JiraClient(jiraSettings(), {
    fetchImpl: fetchSequence([], jsonResponse({ issues: [jiraIssue()], nextPageToken: 42 })),
  });

  await assert.rejects(
    () => client.searchIssues('project in ("ENG")'),
    /jira_pagination_malformed_cursor: searchIssues nextPageToken must be a non-empty string/,
  );
});

test("Jira REST client rejects page limit overflows", async () => {
  const client = new JiraClient(jiraSettings(), {
    fetchImpl: fetchSequence(
      [],
      jsonResponse({ issues: [jiraIssue()], nextPageToken: "page-2" }),
      jsonResponse({ issues: [jiraIssue()], nextPageToken: "page-3" }),
    ),
    paginationLimits: { maxPages: 2 },
  });

  await assert.rejects(
    () => client.searchIssues('project in ("ENG")'),
    /jira_pagination_page_limit_exceeded: searchIssues pages=3 max_pages=2/,
  );
});

test("Jira REST client rejects item limit overflows", async () => {
  const client = new JiraClient(jiraSettings(), {
    fetchImpl: fetchSequence([], jsonResponse({ issues: [jiraIssue(), jiraIssue()] })),
    paginationLimits: { maxItems: 1 },
  });

  await assert.rejects(
    () => client.searchIssues('project in ("ENG")'),
    /jira_pagination_item_limit_exceeded: searchIssues items=2 max_items=1/,
  );
});

test("Jira REST client degrades oversized nested issue metadata", async () => {
  const warnings: string[] = [];
  const issue = jiraIssue();
  const fields = issue.fields as Record<string, unknown>;
  fields.labels = Array.from({ length: 501 }, (_, index) => `label-${index}`);
  fields.issuelinks = Array.from({ length: 501 }, (_, index) => ({
    type: { name: "Blocks", inward: "is blocked by" },
    inwardIssue: {
      id: `blocker-${index}`,
      key: `ENG-B-${index}`,
      fields: { status: { name: "To Do", statusCategory: { key: "new" } } },
    },
  }));
  const client = new JiraClient(jiraSettings(), {
    fetchImpl: fetchSequence([], jsonResponse({ issues: [issue] })),
    logger: { warn: (message) => warnings.push(message) },
  });

  const issues = await client.searchIssues('project in ("ENG")');

  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0]?.labels, []);
  assert.deepEqual(issues[0]?.blockers, []);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0] ?? "", /field=labels issue=ENG-1 items=501 max_items=500/);
  assert.match(warnings[1] ?? "", /field=issuelinks issue=ENG-1 items=501 max_items=500/);
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

  const comment = await client.addComment("ENG-1", "First line\n\nSecond line");

  assert.equal(comment.id, "comment-1");
  assert.equal(calls[0]?.url, "https://example.atlassian.net/rest/api/3/issue/ENG-1/comment");
  assert.deepEqual(calls[0]?.body, {
    body: {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First line" }] },
        { type: "paragraph", content: [{ type: "text", text: "Second line" }] },
      ],
    },
  });
});

test("Jira REST client lists comments and normalizes bodies", async () => {
  const calls: FetchCall[] = [];
  const client = new JiraClient(jiraSettings(), {
    fetchImpl: fetchSequence(calls, jsonResponse({ comments: [jiraComment()], total: 1 })),
  });

  const comments = await client.listComments("ENG-1");

  assert.equal(
    calls[0]?.url,
    "https://example.atlassian.net/rest/api/3/issue/ENG-1/comment?startAt=0&maxResults=100",
  );
  assert.deepEqual(comments, [
    {
      id: "comment-1",
      body: "## Codex Workpad",
      author: "account-1",
      createdAt: "2026-06-01T00:00:00.000+0000",
      updatedAt: "2026-06-01T00:00:00.000+0000",
      url: "https://example.atlassian.net/rest/api/3/issue/10001/comment/comment-1",
    },
  ]);
});

test("Jira REST client updates comments as Atlassian document format", async () => {
  const calls: FetchCall[] = [];
  const client = new JiraClient(jiraSettings(), {
    fetchImpl: fetchSequence(calls, jsonResponse(jiraComment({ body: "Updated workpad" }))),
  });

  const comment = await client.updateComment("ENG-1", "comment-1", "Updated workpad\n\nProof");

  assert.equal(comment.body, "Updated workpad");
  assert.equal(
    calls[0]?.url,
    "https://example.atlassian.net/rest/api/3/issue/ENG-1/comment/comment-1",
  );
  assert.deepEqual(calls[0]?.body, {
    body: {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Updated workpad" }] },
        { type: "paragraph", content: [{ type: "text", text: "Proof" }] },
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

test("Jira MCP client rejects oversized search payloads", async () => {
  const settings = jiraMcpSettings();
  const client = new JiraMcpClient(settings, {
    fetchImpl: fetchSequence(
      [],
      jsonResponse({
        jsonrpc: "2.0",
        id: "1",
        result: {
          content: [{ type: "text", text: JSON.stringify({ issues: [jiraIssue(), jiraIssue()] }) }],
        },
      }),
    ),
    paginationLimits: { maxItems: 1 },
  });

  await assert.rejects(
    () => client.searchIssues('project in ("ENG")'),
    /jira_pagination_item_limit_exceeded: mcpSearchIssues items=2 max_items=1/,
  );
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

  const comment = await client.addComment("ENG-1", "Looks good");

  assert.deepEqual(comment, { id: "10000", body: "Looks good" });
  assert.deepEqual(calls[0]?.body.params, {
    name: "jira_add_comment",
    arguments: { issue_key: "ENG-1", comment: "Looks good" },
  });
});

test("Jira MCP client lists comments with the configured tool", async () => {
  const calls: FetchCall[] = [];
  const settings = parseConfig(
    {
      tracker: {
        kind: "jira-mcp",
        base_url: "https://example.atlassian.net",
        project_keys: ["ENG"],
        mcp: {
          url: "http://127.0.0.1:5123/mcp",
          token: "mcp-token",
          tools: { list_comments: "atlassian_get_jira_comments" },
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
          content: [{ type: "text", text: JSON.stringify({ comments: [jiraComment()] }) }],
        },
      }),
    ),
  });

  const comments = await client.listComments("ENG-1");

  assert.equal(comments[0]?.id, "comment-1");
  assert.equal(comments[0]?.body, "## Codex Workpad");
  assert.deepEqual(calls[0]?.body.params, {
    name: "atlassian_get_jira_comments",
    arguments: { issue_key: "ENG-1" },
  });
});

test("Jira MCP client updates comments with the configured tool and comment args", async () => {
  const calls: FetchCall[] = [];
  const settings = parseConfig(
    {
      tracker: {
        kind: "jira-mcp",
        base_url: "https://example.atlassian.net",
        project_keys: ["ENG"],
        mcp: {
          url: "http://127.0.0.1:5123/mcp",
          token: "mcp-token",
          tools: { update_comment: "atlassian_update_jira_comment" },
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
          content: [
            { type: "text", text: JSON.stringify({ comment: jiraComment({ body: "Updated" }) }) },
          ],
        },
      }),
    ),
  });

  const comment = await client.updateComment("ENG-1", "comment-1", "Updated");

  assert.equal(comment.body, "Updated");
  assert.deepEqual(calls[0]?.body.params, {
    name: "atlassian_update_jira_comment",
    arguments: {
      issue_key: "ENG-1",
      comment_id: "comment-1",
      comment: "Updated",
    },
  });
});

test("Jira MCP client retries comment updates with alternate args on tool payload errors", async () => {
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
          content: [
            { type: "text", text: JSON.stringify({ comment: jiraComment({ body: "Updated" }) }) },
          ],
        },
      }),
    ),
  });

  await client.updateComment("ENG-1", "comment-1", "Updated");

  assert.deepEqual(calls[0]?.body.params, {
    name: "jira_update_comment",
    arguments: {
      issue_key: "ENG-1",
      comment_id: "comment-1",
      comment: "Updated",
    },
  });
  assert.deepEqual(calls[1]?.body.params, {
    name: "jira_update_comment",
    arguments: {
      issueKey: "ENG-1",
      comment_id: "comment-1",
      comment: "Updated",
    },
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

test("jira_read_issue routes a jira tracker to the REST client", async () => {
  const calls: FetchCall[] = [];
  const result = await executeJiraTool(
    "jira_read_issue",
    { issueId: "ENG-1" },
    jiraSettings(),
    fetchSequence(calls, jsonResponse(jiraIssue())),
  );

  assert.equal(result.success, true);
  assert.equal((result.result as { issue: { identifier: string } }).issue.identifier, "ENG-1");
  // The REST endpoint proves clientFor selected JiraClient, not the MCP transport.
  assert.match(
    calls[0]?.url ?? "",
    /^https:\/\/example\.atlassian\.net\/rest\/api\/3\/issue\/ENG-1/,
  );
});

test("jira_read_issue routes a jira-mcp tracker to the MCP client", async () => {
  const calls: FetchCall[] = [];
  const result = await executeJiraTool(
    "jira_read_issue",
    { issueId: "ENG-1" },
    jiraMcpSettings(),
    fetchSequence(
      calls,
      jsonResponse({
        jsonrpc: "2.0",
        id: "1",
        result: { content: [{ type: "text", text: JSON.stringify({ issue: jiraIssue() }) }] },
      }),
    ),
  );

  assert.equal(result.success, true);
  assert.equal((result.result as { issue: { identifier: string } }).issue.identifier, "ENG-1");
  // The JSON-RPC call to the MCP url proves clientFor selected JiraMcpClient, not the REST client.
  assert.equal(calls[0]?.url, "http://127.0.0.1:5123/mcp");
  assert.equal(calls[0]?.body.method, "tools/call");
  assert.equal((calls[0]?.body.params as { name: string }).name, "jira_get_issue");
});

test("jira_query projects rows through select against the jira client", async () => {
  const calls: FetchCall[] = [];
  const result = await executeJiraTool(
    "jira_query",
    { issueIds: ["ENG-1"], select: ["id", "identifier", "state"] },
    jiraSettings(),
    fetchSequence(calls, jsonResponse({ total: 1, issues: [jiraIssue()] })),
  );

  assert.equal(result.success, true);
  const { rows, total } = result.result as {
    rows: Array<Record<string, unknown>>;
    total: number;
  };
  assert.equal(total, 1);
  assert.deepEqual(rows, [{ id: "10001", identifier: "ENG-1", state: "To Do" }]);
  assert.equal(calls[0]?.url, "https://example.atlassian.net/rest/api/3/search/jql");
});

test("jira_comment returns the created comment when the backend exposes it", async () => {
  const calls: FetchCall[] = [];
  const result = await executeJiraTool(
    "jira_comment",
    { issueId: "ENG-1", body: "progress note" },
    jiraSettings(),
    fetchSequence(calls, jsonResponse(jiraComment({ id: "c-1", body: "progress note" }))),
  );

  assert.equal(result.success, true);
  assert.deepEqual(result.result as Record<string, unknown>, {
    ok: true,
    comment: {
      id: "c-1",
      body: "progress note",
      author: "account-1",
      createdAt: "2026-06-01T00:00:00.000+0000",
      updatedAt: "2026-06-01T00:00:00.000+0000",
      url: "https://example.atlassian.net/rest/api/3/issue/10001/comment/c-1",
    },
  });
});

test("tracker tools validate required args before touching the network", async () => {
  const result = await executeJiraTool("jira_read_issue", {}, jiraSettings(), () => {
    throw new Error("should not fetch when args are invalid");
  });

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /'issueId' is required/);
});

test("an unknown tracker tool name fails listing the supported tools", async () => {
  const result = await executeJiraTool("jira_bogus", {}, jiraSettings(), fetch);

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Unsupported tool: "jira_bogus"/);
});

test("a failing jira request surfaces as a failed tool result, not a thrown error", async () => {
  const calls: FetchCall[] = [];
  const result = await executeJiraTool(
    "jira_read_issue",
    { issueId: "ENG-1" },
    jiraSettings(),
    fetchSequence(calls, jsonResponse({ errorMessages: ["boom"] }, 500)),
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /jira api status 500/);
});

test("jira tool failures redact tracker secrets and secret references", async () => {
  const calls: FetchCall[] = [];
  const basic = Buffer.from("bot@example.com:jira-token").toString("base64");
  const result = await executeJiraTool(
    "jira_read_issue",
    { issueId: "ENG-1" },
    jiraSettings(),
    fetchSequence(
      calls,
      jsonResponse(
        {
          errorMessages: [`bad auth api_key=jira-token Basic ${basic} op://vault/item/jira-token`],
        },
        500,
      ),
    ),
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /jira api status 500/);
  assert.notMatch(result.error ?? "", /jira-token/);
  assert.notMatch(result.error ?? "", new RegExp(basic));
  assert.notMatch(result.error ?? "", /op:\/\/vault\/item\/jira-token/);
  assert.match(result.error ?? "", /\[REDACTED\]/);
});

test("jira-mcp JSON-RPC errors redact tracker secrets and secret references", async () => {
  const calls: FetchCall[] = [];
  const basic = Buffer.from("bot@example.com:jira-token").toString("base64");
  const result = await executeJiraTool(
    "jira_read_issue",
    { issueId: "ENG-1" },
    jiraMcpSettings(),
    fetchSequence(
      calls,
      jsonResponse({
        jsonrpc: "2.0",
        id: "1",
        error: {
          code: -32000,
          message: `bad auth api_key=jira-token Basic ${basic} op://vault/item/jira-token`,
        },
      }),
    ),
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /jira-mcp error/);
  assert.notMatch(result.error ?? "", /jira-token/);
  assert.notMatch(result.error ?? "", new RegExp(basic));
  assert.notMatch(result.error ?? "", /op:\/\/vault\/item\/jira-token/);
  assert.match(result.error ?? "", /\[REDACTED\]/);
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
  overrides: {
    statusName?: string;
    statusCategory?: string;
    assigneeAccountId?: string;
    description?: string;
  } = {},
): Record<string, unknown> {
  return {
    id: "10001",
    key: "ENG-1",
    fields: {
      summary: "Fix login",
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: overrides.description ?? "Fix the thing" }],
          },
        ],
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

function jiraComment(overrides: { id?: string; body?: string } = {}): Record<string, unknown> {
  const id = overrides.id ?? "comment-1";
  return {
    id,
    body: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: overrides.body ?? "## Codex Workpad" }],
        },
      ],
    },
    author: { accountId: "account-1", displayName: "Jira Bot" },
    created: "2026-06-01T00:00:00.000+0000",
    updated: "2026-06-01T00:00:00.000+0000",
    self: `https://example.atlassian.net/rest/api/3/issue/10001/comment/${id}`,
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
