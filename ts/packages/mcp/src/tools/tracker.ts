import { JiraClient, JiraMcpClient } from "@symphony/jira-tracker";
import { normalizeIssue } from "@symphony/issue";
import {
  errorMessage,
  isRecord,
  type Issue,
  type Settings,
  type TrackerKind,
} from "@symphony/domain";

import { applyQuery, parseQuerySpec, parseSelect, pickFields } from "../filter.js";
import type { ToolResult, ToolSpec } from "../tools.js";

import { executeLinearTool } from "./linear.js";
import { executeLocalTool } from "./local.js";
import { toolFailure, toolSuccess, unsupportedToolFailure } from "./result.js";

const TRACKER_TOOL_NAMES = [
  "tracker_read_issue",
  "tracker_query",
  "tracker_update_status",
  "tracker_comment",
  "tracker_create_issue",
] as const;

const DEFAULT_SELECT = ["id", "identifier", "title", "state", "stateType", "labels", "url"];

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

export function trackerToolSpecs(kind: TrackerKind): ToolSpec[] {
  if (kind === "memory") return [];
  return [
    {
      name: "tracker_read_issue",
      description:
        "Read one issue from the configured tracker. Args: issueId (tracker id or key when supported).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { issueId: { type: "string" } },
        required: ["issueId"],
      },
    },
    {
      name: "tracker_query",
      description:
        "Query issues from the configured tracker. Args: states?, issueIds?, jql? (Jira), where?, select?, order_by?, limit?, offset?.",
      inputSchema: {
        type: "object",
        additionalProperties: true,
        properties: {
          states: { type: "array", items: { type: "string" } },
          issueIds: { type: "array", items: { type: "string" } },
          jql: { type: "string" },
          where: { type: "object" },
          select: { type: "array", items: { type: "string" } },
          order_by: { type: "array", items: { type: "object" } },
          limit: { type: "number" },
          offset: { type: "number" },
        },
      },
    },
    {
      name: "tracker_update_status",
      description:
        "Move an issue in the configured tracker to a new status. Args: issueId, status.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { issueId: { type: "string" }, status: { type: "string" } },
        required: ["issueId", "status"],
      },
    },
    {
      name: "tracker_comment",
      description: "Add a comment to an issue in the configured tracker. Args: issueId, body.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { issueId: { type: "string" }, body: { type: "string" } },
        required: ["issueId", "body"],
      },
    },
    {
      name: "tracker_create_issue",
      description: "Create an issue in the configured tracker. Args: title, body?, status?.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          status: { type: "string" },
        },
        required: ["title"],
      },
    },
  ];
}

export async function executeTrackerTool(
  name: string,
  input: unknown,
  settings: Settings,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult> {
  if (!isTrackerToolName(name)) return unsupportedToolFailure(name, TRACKER_TOOL_NAMES);
  const args = isRecord(input) ? input : {};
  try {
    switch (name) {
      case "tracker_read_issue":
        return toolSuccess({
          issue: await readIssue(settings, requireStr(args, "issueId"), fetchImpl),
        });
      case "tracker_query":
        return toolSuccess(await queryIssues(settings, args, fetchImpl));
      case "tracker_update_status":
        return toolSuccess({
          issue: await updateStatus(
            settings,
            requireStr(args, "issueId"),
            requireStr(args, "status"),
            fetchImpl,
          ),
        });
      case "tracker_comment":
        await addComment(
          settings,
          requireStr(args, "issueId"),
          requireStr(args, "body"),
          fetchImpl,
        );
        return toolSuccess({ ok: true });
      case "tracker_create_issue":
        return toolSuccess({
          issue: await createIssue(
            settings,
            {
              title: requireStr(args, "title"),
              body: optStr(args.body),
              status: optStr(args.status),
            },
            fetchImpl,
          ),
        });
    }
  } catch (error) {
    return toolFailure(errorMessage(error));
  }
}

function isTrackerToolName(name: string): name is (typeof TRACKER_TOOL_NAMES)[number] {
  return (TRACKER_TOOL_NAMES as readonly string[]).includes(name);
}

async function readIssue(
  settings: Settings,
  issueId: string,
  fetchImpl: typeof fetch,
): Promise<Issue> {
  switch (settings.tracker.kind) {
    case "local": {
      const result = await executeLocalTool("local_read_issue", { issueId }, settings);
      if (!result.success) throw new Error(result.error ?? "local_read_issue failed");
      return localReadResultToIssue(result.result);
    }
    case "linear":
      return readLinearIssue(settings, issueId, fetchImpl);
    case "jira":
      return new JiraClient(settings, { fetchImpl }).readIssue(issueId);
    case "jira-mcp":
      return new JiraMcpClient(settings, { fetchImpl }).readIssue(issueId);
    case "memory":
    case undefined:
      throw new Error("tracker tools are unavailable for memory tracker");
  }
}

async function queryIssues(
  settings: Settings,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<{
  rows: Array<Record<string, unknown>>;
  total: number;
  skipped?: unknown[] | undefined;
}> {
  const select = parseSelect(args.select) ?? DEFAULT_SELECT;
  switch (settings.tracker.kind) {
    case "local": {
      const result = await executeLocalTool("local_query", args, settings);
      if (!result.success) throw new Error(result.error ?? "local_query failed");
      const payload = isRecord(result.result) ? result.result : {};
      return {
        rows: Array.isArray(payload.rows) ? (payload.rows as Array<Record<string, unknown>>) : [],
        total: typeof payload.total === "number" ? payload.total : 0,
        skipped: Array.isArray(payload.skipped) ? payload.skipped : [],
      };
    }
    case "linear":
      return projectIssues(await queryLinearIssues(settings, args, fetchImpl), select, args);
    case "jira": {
      const client = new JiraClient(settings, { fetchImpl });
      const issues = await queryRuntimeClient(client, settings, args);
      return projectIssues(issues, select, args);
    }
    case "jira-mcp": {
      const client = new JiraMcpClient(settings, { fetchImpl });
      const issues = await queryRuntimeClient(client, settings, args);
      return projectIssues(issues, select, args);
    }
    case "memory":
    case undefined:
      throw new Error("tracker tools are unavailable for memory tracker");
  }
}

async function updateStatus(
  settings: Settings,
  issueId: string,
  status: string,
  fetchImpl: typeof fetch,
): Promise<Issue> {
  switch (settings.tracker.kind) {
    case "local": {
      const result = await executeLocalTool("local_update_status", { issueId, status }, settings);
      if (!result.success) throw new Error(result.error ?? "local_update_status failed");
      return issueResult(result.result);
    }
    case "linear":
      return updateLinearStatus(settings, issueId, status, fetchImpl);
    case "jira":
      return new JiraClient(settings, { fetchImpl }).updateIssueStatus(issueId, status);
    case "jira-mcp":
      return new JiraMcpClient(settings, { fetchImpl }).updateIssueStatus(issueId, status);
    case "memory":
    case undefined:
      throw new Error("tracker tools are unavailable for memory tracker");
  }
}

async function addComment(
  settings: Settings,
  issueId: string,
  body: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  switch (settings.tracker.kind) {
    case "local": {
      const result = await executeLocalTool("local_comment", { issueId, body }, settings);
      if (!result.success) throw new Error(result.error ?? "local_comment failed");
      return;
    }
    case "linear":
      await createLinearComment(settings, issueId, body, fetchImpl);
      return;
    case "jira":
      await new JiraClient(settings, { fetchImpl }).addComment(issueId, body);
      return;
    case "jira-mcp":
      await new JiraMcpClient(settings, { fetchImpl }).addComment(issueId, body);
      return;
    case "memory":
    case undefined:
      throw new Error("tracker tools are unavailable for memory tracker");
  }
}

async function createIssue(
  settings: Settings,
  input: { title: string; body?: string | undefined; status?: string | undefined },
  fetchImpl: typeof fetch,
): Promise<Issue> {
  switch (settings.tracker.kind) {
    case "local": {
      const result = await executeLocalTool(
        "local_create_issue",
        { title: input.title, body: input.body, status: input.status },
        settings,
      );
      if (!result.success) throw new Error(result.error ?? "local_create_issue failed");
      return issueResult(result.result);
    }
    case "linear":
      return createLinearIssue(settings, input, fetchImpl);
    case "jira":
      return new JiraClient(settings, { fetchImpl }).createIssue(input);
    case "jira-mcp":
      return new JiraMcpClient(settings, { fetchImpl }).createIssue(input);
    case "memory":
    case undefined:
      throw new Error("tracker tools are unavailable for memory tracker");
  }
}

async function queryRuntimeClient(
  client: {
    searchIssues?: (jql: string) => Promise<Issue[]>;
    fetchIssuesByIds(ids: string[]): Promise<Issue[]>;
    fetchIssuesByStates?(states: string[]): Promise<Issue[]>;
    fetchCandidateIssues(): Promise<Issue[]>;
  },
  settings: Settings,
  args: Record<string, unknown>,
): Promise<Issue[]> {
  const issueIds = stringArray(args.issueIds);
  if (issueIds) return client.fetchIssuesByIds(issueIds);
  if (typeof args.jql === "string" && args.jql.trim() !== "" && client.searchIssues) {
    return client.searchIssues(args.jql);
  }
  const states = stringArray(args.states);
  if (states && client.fetchIssuesByStates) return client.fetchIssuesByStates(states);
  if (settings.tracker.activeStates.length > 0) return client.fetchCandidateIssues();
  return [];
}

function projectIssues(
  issues: Issue[],
  select: string[],
  args: Record<string, unknown>,
): { rows: Array<Record<string, unknown>>; total: number } {
  const spec = parseQuerySpec(args);
  const records = issues.map(issueRecord);
  const { rows, total } = applyQuery(records, spec);
  return { rows: rows.map((row) => pickFields(row, select)), total };
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
  const projectSlugs =
    settings.tracker.projectSlugs ??
    (settings.tracker.projectSlug ? [settings.tracker.projectSlug] : []);
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
  input: { title: string; body?: string | undefined; status?: string | undefined },
  fetchImpl: typeof fetch,
): Promise<Issue> {
  const projectSlug = settings.tracker.projectSlug ?? settings.tracker.projectSlugs?.[0];
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

function localReadResultToIssue(value: unknown): Issue {
  if (!isRecord(value) || !isRecord(value.issue))
    throw new Error("local_read_issue returned no issue");
  return normalizeIssue({
    id: requireString(value.issue, "id"),
    identifier: requireString(value.issue, "id"),
    title: requireString(value.issue, "title"),
    description: typeof value.issue.description === "string" ? value.issue.description : null,
    state: requireString(value.issue, "status"),
    state_type: stateTypeFromStatus(requireString(value.issue, "status")),
    labels: [],
    blockers: [],
  });
}

function issueResult(value: unknown): Issue {
  if (!isRecord(value) || !isRecord(value.issue)) throw new Error("tracker tool returned no issue");
  return normalizeIssue(value.issue);
}

function issueRecord(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    state: issue.state,
    stateType: issue.stateType,
    labels: issue.labels,
    createdAt: issue.createdAt ?? null,
    updatedAt: issue.updatedAt ?? null,
    url: issue.url ?? null,
  };
}

function stateTypeFromStatus(status: string): Issue["stateType"] {
  const normalized = status.trim().toLowerCase();
  if (normalized.includes("done") || normalized.includes("closed")) return "completed";
  if (normalized.includes("cancel")) return "canceled";
  if (normalized.includes("backlog")) return "backlog";
  if (normalized.includes("triage")) return "triage";
  if (normalized.includes("progress")) return "started";
  return "unstarted";
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`'${key}' is required`);
  return value;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} is required`);
  return value;
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
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
