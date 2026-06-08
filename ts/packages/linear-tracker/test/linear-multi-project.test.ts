import { test } from "vitest";
import { LinearClient, parseConfig } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

interface FetchCall {
  url: string;
  body: { query?: string; variables?: Record<string, unknown> };
}

test("Linear client queries multiple project slugs via project_slugs config", async () => {
  const calls: FetchCall[] = [];
  const client = new LinearClient(
    parseConfig(
      {
        tracker: {
          api_key: "linear-token",
          project_slugs: ["slug-a", "slug-b"],
          active_states: ["Todo"],
        },
      },
      {},
    ),
    fetchSequence(
      jsonResponse({
        data: {
          issues: {
            nodes: [linearIssue("id-1", "SA-1"), linearIssue("id-2", "SB-1")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      calls,
    ),
  );

  const issues = await client.fetchCandidateIssues();

  assert.equal(issues.length, 2);
  assert.deepEqual(calls[0]?.body.variables?.projectSlugs, ["slug-a", "slug-b"]);
  assert.match(String(calls[0]?.body.query), /slugId.*in.*\$projectSlugs/);
});

test("Linear client normalizes single project_slug into multi-slug query", async () => {
  const calls: FetchCall[] = [];
  const client = new LinearClient(
    parseConfig(
      {
        tracker: {
          api_key: "linear-token",
          project_slug: "mono",
          active_states: ["Todo"],
        },
      },
      {},
    ),
    fetchSequence(
      jsonResponse({
        data: {
          issues: {
            nodes: [linearIssue("id-1", "MT-1")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      calls,
    ),
  );

  const issues = await client.fetchCandidateIssues();

  assert.equal(issues.length, 1);
  assert.deepEqual(calls[0]?.body.variables?.projectSlugs, ["mono"]);
});

test("Linear client resolves project slugs from labels via API", async () => {
  const calls: FetchCall[] = [];
  const client = new LinearClient(
    parseConfig(
      {
        tracker: {
          api_key: "linear-token",
          project_labels: ["team:backend", "symphony-managed"],
          active_states: ["Todo"],
        },
      },
      {},
    ),
    fetchSequence(
      jsonResponse({
        data: {
          projects: {
            nodes: [{ slugId: "proj-a" }, { slugId: "proj-b" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      jsonResponse({
        data: {
          issues: {
            nodes: [linearIssue("id-1", "PA-1")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      calls,
    ),
  );

  const issues = await client.fetchCandidateIssues();

  assert.equal(issues.length, 1);
  assert.match(String(calls[0]?.body.query), /ProjectsByLabels/);
  assert.deepEqual(calls[0]?.body.variables?.labels, ["team:backend", "symphony-managed"]);
  assert.deepEqual(calls[1]?.body.variables?.projectSlugs, ["proj-a", "proj-b"]);
});

test("Linear client resolves project slugs from labels across every page", async () => {
  const calls: FetchCall[] = [];
  const client = new LinearClient(
    parseConfig(
      {
        tracker: {
          api_key: "linear-token",
          project_labels: ["team:backend"],
          active_states: ["Todo"],
        },
      },
      {},
    ),
    fetchSequence(
      jsonResponse({
        data: {
          projects: {
            nodes: [{ slugId: "proj-a" }],
            pageInfo: { hasNextPage: true, endCursor: "project-cursor-1" },
          },
        },
      }),
      jsonResponse({
        data: {
          projects: {
            nodes: [{ slugId: "proj-b" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      jsonResponse({
        data: {
          issues: {
            nodes: [linearIssue("id-1", "PA-1")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      calls,
    ),
  );

  const issues = await client.fetchCandidateIssues();

  assert.equal(issues.length, 1);
  assert.match(String(calls[0]?.body.query), /ProjectsByLabels/);
  assert.equal(calls[0]?.body.variables?.after, null);
  assert.equal(calls[1]?.body.variables?.after, "project-cursor-1");
  assert.deepEqual(calls[2]?.body.variables?.projectSlugs, ["proj-a", "proj-b"]);
});

test("Linear client throws when label resolution returns no projects", async () => {
  const client = new LinearClient(
    parseConfig(
      {
        tracker: {
          api_key: "linear-token",
          project_labels: ["nonexistent-label"],
          active_states: ["Todo"],
        },
      },
      {},
    ),
    fetchSequence(
      jsonResponse({
        data: {
          projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      }),
    ),
  );

  await assert.rejects(
    () => client.fetchCandidateIssues(),
    /no linear projects found for labels: nonexistent-label/,
  );
});

test("Linear client caches resolved project slugs across calls", async () => {
  const calls: FetchCall[] = [];
  const client = new LinearClient(
    parseConfig(
      {
        tracker: {
          api_key: "linear-token",
          project_labels: ["team:backend"],
          active_states: ["Todo"],
        },
      },
      {},
    ),
    fetchSequence(
      jsonResponse({
        data: {
          projects: {
            nodes: [{ slugId: "proj-a" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      jsonResponse({
        data: {
          issues: {
            nodes: [linearIssue("id-1", "PA-1")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      jsonResponse({
        data: {
          issues: {
            nodes: [linearIssue("id-2", "PA-2")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      calls,
    ),
  );

  await client.fetchCandidateIssues();
  await client.fetchCandidateIssues();

  const labelQueries = calls.filter((c) => String(c.body.query).includes("ProjectsByLabels"));
  assert.equal(labelQueries.length, 1);
});

test("Linear client retries project label resolution after transient failure", async () => {
  const calls: FetchCall[] = [];
  const client = new LinearClient(
    parseConfig(
      {
        tracker: {
          api_key: "linear-token",
          project_labels: ["team:backend"],
          active_states: ["Todo"],
        },
      },
      {},
    ),
    fetchSequence(
      jsonResponse({
        errors: [{ message: "temporary label lookup failure" }],
      }),
      jsonResponse({
        data: {
          projects: {
            nodes: [{ slugId: "proj-a" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      jsonResponse({
        data: {
          issues: {
            nodes: [linearIssue("id-1", "PA-1")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      calls,
    ),
  );

  await assert.rejects(() => client.fetchCandidateIssues(), /temporary label lookup failure/);

  const issues = await client.fetchCandidateIssues();

  assert.equal(issues.length, 1);
  const labelQueries = calls.filter((c) => String(c.body.query).includes("ProjectsByLabels"));
  assert.equal(labelQueries.length, 2);
  assert.deepEqual(calls[2]?.body.variables?.projectSlugs, ["proj-a"]);
});

test("Linear client throws when no project config is provided", async () => {
  const client = new LinearClient(
    parseConfig(
      {
        tracker: {
          api_key: "linear-token",
          active_states: ["Todo"],
        },
      },
      {},
    ),
    fetchSequence(),
  );

  await assert.rejects(
    () => client.fetchCandidateIssues(),
    /tracker.project_slug, tracker.project_slugs, or tracker.project_labels is required/,
  );
});

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
