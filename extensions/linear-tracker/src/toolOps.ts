import { normalizeIssue } from "@lorenz/issue";
import { isRecord, type Issue, type Settings } from "@lorenz/domain";
import type {
  TrackerComment,
  TrackerCreateIssueInput,
  TrackerOpsContext,
  TrackerToolOps,
} from "@lorenz/tracker-sdk";

import { linearTrackerOptions } from "./options.js";
import { executeLinearTool } from "./tools.js";

const linearIssueFields = `
  id
  identifier
  title
  description
  priority
  state { id name type }
  branchName
  url
  assignee { id }
  labels(first: 50) { nodes { name } }
  inverseRelations(first: 50) {
    nodes {
      type
      issue { id identifier state { name type } }
    }
  }
  createdAt
  updatedAt
`;

/**
 * Normalized issue operations behind the provider-neutral `tracker_*` pack, implemented over
 * the same GraphQL transport as the `linear_graphql` tool (credentials, retries, logging).
 */
export function linearToolOps(settings: Settings, context: TrackerOpsContext): TrackerToolOps {
  const { fetchImpl } = context;
  return {
    readIssue: async (issueId) => readLinearIssue(settings, issueId, fetchImpl),
    queryIssues: async (args) => queryLinearIssues(settings, args, fetchImpl),
    updateStatus: async (issueId, status) =>
      updateLinearStatus(settings, issueId, status, fetchImpl),
    listComments: async (issueId) => listLinearComments(settings, issueId, fetchImpl),
    addComment: async (issueId, body) => createLinearComment(settings, issueId, body, fetchImpl),
    updateComment: async (_issueId, commentId, body) =>
      updateLinearComment(settings, commentId, body, fetchImpl),
    createIssue: async (input) => createLinearIssue(settings, input, fetchImpl),
  };
}

async function readLinearIssue(
  settings: Settings,
  issueId: string,
  fetchImpl: typeof fetch,
): Promise<Issue> {
  const data = await linearData<{ issue?: Record<string, unknown> | null }>(
    settings,
    `query LorenzTrackerReadIssue($id: String!) {
      issue(id: $id) { ${linearIssueFields} }
    }`,
    { id: issueId },
    fetchImpl,
  );
  if (!data.issue) throw new Error(`linear issue not found: ${issueId}`);
  return normalizeLinearIssue(data.issue, settings.tracker.assignee);
}

async function queryLinearIssues(
  settings: Settings,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Issue[]> {
  const issueIds = stringArray(args.issueIds);
  if (issueIds) {
    const data = await linearData<{ issues: { nodes: Array<Record<string, unknown>> } }>(
      settings,
      `query LorenzTrackerIssuesById($ids: [ID!]!, $first: Int!) {
        issues(filter: {id: {in: $ids}}, first: $first) { nodes { ${linearIssueFields} } }
      }`,
      { ids: issueIds, first: issueIds.length },
      fetchImpl,
    );
    return data.issues.nodes.map((issue) => normalizeLinearIssue(issue, settings.tracker.assignee));
  }
  const states = stringArray(args.states) ?? settings.tracker.activeStates;
  const options = linearTrackerOptions(settings);
  const projectSlugs = options.projectSlugs ?? (options.projectSlug ? [options.projectSlug] : []);
  const data = await linearData<{ issues: { nodes: Array<Record<string, unknown>> } }>(
    settings,
    `query LorenzTrackerQuery($projectSlugs: [String!]!, $stateNames: [String!]!, $first: Int!) {
      issues(filter: {project: {slugId: {in: $projectSlugs}}, state: {name: {in: $stateNames}}}, first: $first) {
        nodes { ${linearIssueFields} }
      }
    }`,
    { projectSlugs, stateNames: states, first: numberArg(args.limit, 50) },
    fetchImpl,
  );
  return data.issues.nodes.map((issue) => normalizeLinearIssue(issue, settings.tracker.assignee));
}

async function updateLinearStatus(
  settings: Settings,
  issueId: string,
  status: string,
  fetchImpl: typeof fetch,
): Promise<Issue> {
  const lookup = await linearData<{
    issue?: { team?: { states?: { nodes?: Array<{ id: string; name: string }> } } } | null;
  }>(
    settings,
    `query LorenzTrackerLinearStates($id: String!) {
      issue(id: $id) { team { states(first: 100) { nodes { id name } } } }
    }`,
    { id: issueId },
    fetchImpl,
  );
  const state = lookup.issue?.team?.states?.nodes?.find(
    (candidate) => candidate.name.trim().toLowerCase() === status.trim().toLowerCase(),
  );
  if (!state) throw new Error(`linear state not found: ${status}`);
  const data = await linearData<{
    issueUpdate: { success: boolean; issue: Record<string, unknown> | null };
  }>(
    settings,
    `mutation LorenzTrackerLinearUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success issue { ${linearIssueFields} } }
    }`,
    { id: issueId, input: { stateId: state.id } },
    fetchImpl,
  );
  if (!data.issueUpdate.success || !data.issueUpdate.issue)
    throw new Error("linear issueUpdate failed");
  return normalizeLinearIssue(data.issueUpdate.issue, settings.tracker.assignee);
}

async function createLinearComment(
  settings: Settings,
  issueId: string,
  body: string,
  fetchImpl: typeof fetch,
): Promise<TrackerComment> {
  const data = await linearData<{
    commentCreate: { success: boolean; comment: Record<string, unknown> | null };
  }>(
    settings,
    `mutation LorenzTrackerLinearComment($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
        comment {
          id
          body
          createdAt
          updatedAt
          url
          user { id name email }
        }
      }
    }`,
    { input: { issueId, body } },
    fetchImpl,
  );
  if (!data.commentCreate.success || !data.commentCreate.comment) {
    throw new Error("linear commentCreate failed");
  }
  return normalizeLinearComment(data.commentCreate.comment);
}

async function listLinearComments(
  settings: Settings,
  issueId: string,
  fetchImpl: typeof fetch,
): Promise<TrackerComment[]> {
  const out: TrackerComment[] = [];
  let after: string | null = null;
  for (;;) {
    const data = await linearData<unknown>(
      settings,
      `query LorenzTrackerLinearComments($id: String!, $after: String) {
        issue(id: $id) {
          comments(first: 100, after: $after) {
            nodes {
              id
              body
              createdAt
              updatedAt
              url
              user { id name email }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }`,
      { id: issueId, after },
      fetchImpl,
    );
    const issue = isRecord(data) && isRecord(data.issue) ? data.issue : null;
    if (!issue) throw new Error(`linear issue not found: ${issueId}`);
    const comments = isRecord(issue.comments) ? issue.comments : {};
    const nodes = Array.isArray(comments.nodes) ? comments.nodes : [];
    for (const node of nodes) {
      if (isRecord(node)) out.push(normalizeLinearComment(node));
    }
    const pageInfo = isRecord(comments.pageInfo) ? comments.pageInfo : {};
    after = stringValue(pageInfo, "endCursor");
    if (pageInfo.hasNextPage !== true || !after) return out;
  }
}

async function updateLinearComment(
  settings: Settings,
  commentId: string,
  body: string,
  fetchImpl: typeof fetch,
): Promise<TrackerComment> {
  const data = await linearData<{
    commentUpdate: { success: boolean; comment: Record<string, unknown> | null };
  }>(
    settings,
    `mutation LorenzTrackerLinearCommentUpdate($id: String!, $input: CommentUpdateInput!) {
      commentUpdate(id: $id, input: $input) {
        success
        comment {
          id
          body
          createdAt
          updatedAt
          url
          user { id name email }
        }
      }
    }`,
    { id: commentId, input: { body } },
    fetchImpl,
  );
  if (!data.commentUpdate.success || !data.commentUpdate.comment) {
    throw new Error("linear commentUpdate failed");
  }
  return normalizeLinearComment(data.commentUpdate.comment);
}

async function createLinearIssue(
  settings: Settings,
  input: TrackerCreateIssueInput,
  fetchImpl: typeof fetch,
): Promise<Issue> {
  const options = linearTrackerOptions(settings);
  const projectSlug = options.projectSlug ?? options.projectSlugs?.[0];
  if (!projectSlug) throw new Error("tracker.project_slug is required to create Linear issues");
  const projectData = await linearData<{
    projects: {
      nodes: Array<{
        id: string;
        teams: {
          nodes: Array<{
            id: string;
            states: { nodes: Array<{ id: string; name: string; type: string }> };
          }>;
        };
      }>;
    };
  }>(
    settings,
    `query LorenzTrackerLinearProject($slug: String!) {
      projects(filter: {slugId: {eq: $slug}}, first: 1) {
        nodes { id teams(first: 1) { nodes { id states(first: 100) { nodes { id name type } } } } }
      }
    }`,
    { slug: projectSlug },
    fetchImpl,
  );
  const project = projectData.projects.nodes[0];
  const team = project?.teams.nodes[0];
  if (!project || !team) throw new Error(`linear project not found: ${projectSlug}`);
  const state =
    team.states.nodes.find((candidate) => candidate.name === input.status) ??
    team.states.nodes.find((candidate) => candidate.type === "unstarted") ??
    team.states.nodes[0];
  if (!state) throw new Error("linear project has no workflow states");
  const assignee = input.assignee?.trim() || settings.tracker.assignee?.trim();
  const data = await linearData<{
    issueCreate: { success: boolean; issue: Record<string, unknown> | null };
  }>(
    settings,
    `mutation LorenzTrackerLinearCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { ${linearIssueFields} } }
    }`,
    {
      input: {
        teamId: team.id,
        projectId: project.id,
        stateId: state.id,
        title: input.title,
        description: input.body ?? "",
        ...(assignee ? { assigneeId: assignee } : {}),
      },
    },
    fetchImpl,
  );
  if (!data.issueCreate.success || !data.issueCreate.issue)
    throw new Error("linear issueCreate failed");
  return normalizeLinearIssue(data.issueCreate.issue, settings.tracker.assignee);
}

async function linearData<T>(
  settings: Settings,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<T> {
  const result = await executeLinearTool(
    "linear_graphql",
    { query, variables },
    settings,
    fetchImpl,
  );
  if (!result.success) throw new Error(result.error ?? "linear_graphql failed");
  const body = result.result;
  if (!isRecord(body) || !isRecord(body.data)) throw new Error("linear_graphql returned no data");
  return body.data as T;
}

function normalizeLinearIssue(issue: Record<string, unknown>, assignee?: string): Issue {
  return normalizeIssue(
    {
      ...issue,
      state: issue.state,
      state_type: isRecord(issue.state) ? issue.state.type : null,
      branch_name: issue.branchName,
      assignee_id: isRecord(issue.assignee) ? issue.assignee.id : null,
      labels: nodesFromConnection(issue.labels),
      relations: nodesFromConnection(issue.inverseRelations),
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
    },
    assignee,
  );
}

function normalizeLinearComment(comment: Record<string, unknown>): TrackerComment {
  const user = isRecord(comment.user) ? comment.user : {};
  return {
    id: requireStr(comment, "id"),
    body: typeof comment.body === "string" ? comment.body : "",
    author: stringValue(user, "id") ?? stringValue(user, "name") ?? stringValue(user, "email"),
    createdAt: stringValue(comment, "createdAt"),
    updatedAt: stringValue(comment, "updatedAt"),
    url: stringValue(comment, "url"),
  };
}

function nodesFromConnection(value: unknown): unknown[] {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return [];
  return value.nodes;
}

function stringValue(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function requireStr(record: Record<string, unknown>, key: string): string {
  const value = stringValue(record, key);
  if (!value) throw new Error(`'${key}' is required`);
  return value;
}

function stringArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("expected an array of strings");
  }
  return value;
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
