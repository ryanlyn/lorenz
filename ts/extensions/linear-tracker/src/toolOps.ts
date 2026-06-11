import { normalizeIssue } from "@symphony/issue";
import { isRecord, type Issue, type Settings } from "@symphony/domain";
import type {
  TrackerCreateIssueInput,
  TrackerOpsContext,
  TrackerToolOps,
} from "@symphony/tracker-sdk";

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
    addComment: async (issueId, body) => createLinearComment(settings, issueId, body, fetchImpl),
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
    `query SymphonyTrackerReadIssue($id: String!) {
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
      `query SymphonyTrackerIssuesById($ids: [ID!]!, $first: Int!) {
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
    `query SymphonyTrackerQuery($projectSlugs: [String!]!, $stateNames: [String!]!, $first: Int!) {
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
    `query SymphonyTrackerLinearStates($id: String!) {
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
    `mutation SymphonyTrackerLinearUpdate($id: String!, $input: IssueUpdateInput!) {
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
): Promise<void> {
  const data = await linearData<{ commentCreate: { success: boolean } }>(
    settings,
    `mutation SymphonyTrackerLinearComment($input: CommentCreateInput!) {
      commentCreate(input: $input) { success }
    }`,
    { input: { issueId, body } },
    fetchImpl,
  );
  if (!data.commentCreate.success) throw new Error("linear commentCreate failed");
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
    `query SymphonyTrackerLinearProject($slug: String!) {
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
  const data = await linearData<{
    issueCreate: { success: boolean; issue: Record<string, unknown> | null };
  }>(
    settings,
    `mutation SymphonyTrackerLinearCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { ${linearIssueFields} } }
    }`,
    {
      input: {
        teamId: team.id,
        projectId: project.id,
        stateId: state.id,
        title: input.title,
        description: input.body ?? "",
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

function nodesFromConnection(value: unknown): unknown[] {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return [];
  return value.nodes;
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
