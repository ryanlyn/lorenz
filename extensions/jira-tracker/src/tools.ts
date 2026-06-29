import { errorMessage, isOneOf, isRecord, type Issue, type Settings } from "@lorenz/domain";
import {
  applyQuery,
  parseQuerySpec,
  parseSelect,
  pickFields,
  toolFailure,
  toolSuccess,
  unsupportedToolFailure,
  type ToolProvider,
  type ToolResult,
  type ToolSpec,
} from "@lorenz/tool-sdk";

import { JiraClient, JiraMcpClient } from "./client.js";

/**
 * Pack named `jira` so the pack name and its tool names (`jira_*`) stay coherent with the other
 * trackers (pack `linear` owns `linear_*`, `local` owns `local_*`). Jira is the only tracker that
 * owns this pack; it is mounted exclusively for the `jira` / `jira-mcp` backends via
 * {@link jiraTrackerProvider}'s `defaultToolPacks`.
 */
export const JIRA_TOOL_PACK_NAME = "jira";

const JIRA_TOOL_NAMES = [
  "jira_read_issue",
  "jira_query",
  "jira_update_status",
  "jira_list_comments",
  "jira_comment",
  "jira_update_comment",
  "jira_create_issue",
] as const;

const DEFAULT_SELECT = ["id", "identifier", "title", "state", "stateType", "labels", "url"];

/**
 * The `jira_*` tool pack owned by the Jira extension. The tools operate over the same Jira
 * REST / MCP transport that feeds dispatch, picking the client that matches the configured
 * tracker kind. Mounted only when a `jira` / `jira-mcp` tracker drives dispatch.
 */
export const jiraToolProvider: ToolProvider = {
  name: JIRA_TOOL_PACK_NAME,
  toolSpecs: () => jiraToolSpecs(),
  executeTool: async (name, input, context) =>
    executeJiraTool(name, input, context.settings, context.fetchImpl),
};

export function jiraToolSpecs(): ToolSpec[] {
  return [
    {
      name: "jira_read_issue",
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
      name: "jira_query",
      description:
        "Query issues from the configured tracker. Args: states?, issueIds?, query? (native query string, for trackers with a query language), where?, select?, order_by?, limit?, offset?.",
      inputSchema: {
        type: "object",
        additionalProperties: true,
        properties: {
          states: { type: "array", items: { type: "string" } },
          issueIds: { type: "array", items: { type: "string" } },
          query: { type: "string" },
          where: { type: "object" },
          select: { type: "array", items: { type: "string" } },
          order_by: { type: "array", items: { type: "object" } },
          limit: { type: "number" },
          offset: { type: "number" },
        },
      },
    },
    {
      name: "jira_update_status",
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
      name: "jira_list_comments",
      description: "List comments on an issue in the configured tracker. Args: issueId.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { issueId: { type: "string" } },
        required: ["issueId"],
      },
    },
    {
      name: "jira_comment",
      description:
        "Add a comment to an issue in the configured tracker. Args: issueId, body. Returns the created comment when the provider exposes it.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { issueId: { type: "string" }, body: { type: "string" } },
        required: ["issueId", "body"],
      },
    },
    {
      name: "jira_update_comment",
      description:
        "Update a comment on an issue in the configured tracker. Args: issueId, commentId, body.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          issueId: { type: "string" },
          commentId: { type: "string" },
          body: { type: "string" },
        },
        required: ["issueId", "commentId", "body"],
      },
    },
    {
      name: "jira_create_issue",
      description:
        "Create an issue in the configured tracker. Args: title, body?, status?, assignee?.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          status: { type: "string" },
          assignee: { type: "string" },
        },
        required: ["title"],
      },
    },
  ];
}

/** Pick the Jira client matching the configured tracker kind (`jira` REST vs `jira-mcp`). */
function clientFor(settings: Settings, fetchImpl: typeof fetch): JiraClient | JiraMcpClient {
  return settings.tracker.kind === "jira-mcp"
    ? new JiraMcpClient(settings, { fetchImpl })
    : new JiraClient(settings, { fetchImpl });
}

export async function executeJiraTool(
  name: string,
  input: unknown,
  settings: Settings,
  fetchImpl: typeof fetch,
): Promise<ToolResult> {
  if (!isOneOf(name, JIRA_TOOL_NAMES)) return unsupportedToolFailure(name, JIRA_TOOL_NAMES);
  const args = isRecord(input) ? input : {};
  const client = clientFor(settings, fetchImpl);
  try {
    switch (name) {
      case "jira_read_issue":
        return toolSuccess({ issue: await client.readIssue(requireStr(args, "issueId")) });
      case "jira_query": {
        const select = parseSelect(args.select) ?? DEFAULT_SELECT;
        const issues = await queryJiraIssues(client, settings, args);
        return toolSuccess(projectIssues(issues, select, args));
      }
      case "jira_update_status":
        return toolSuccess({
          issue: await client.updateIssueStatus(
            requireStr(args, "issueId"),
            requireStr(args, "status"),
          ),
        });
      case "jira_list_comments":
        return toolSuccess({ comments: await client.listComments(requireStr(args, "issueId")) });
      case "jira_comment": {
        const comment = await client.addComment(
          requireStr(args, "issueId"),
          requireStr(args, "body"),
        );
        return toolSuccess(comment ? { ok: true, comment } : { ok: true });
      }
      case "jira_update_comment":
        return toolSuccess({
          comment: await client.updateComment(
            requireStr(args, "issueId"),
            requireStr(args, "commentId"),
            requireStr(args, "body"),
          ),
        });
      case "jira_create_issue":
        return toolSuccess({
          issue: await client.createIssue({
            title: requireStr(args, "title"),
            body: optStr(args.body),
            status: optStr(args.status),
            assignee: optStr(args.assignee),
          }),
        });
    }
  } catch (error) {
    return toolFailure(errorMessage(error));
  }
}

async function queryJiraIssues(
  client: JiraClient | JiraMcpClient,
  settings: Settings,
  args: Record<string, unknown>,
): Promise<Issue[]> {
  const issueIds = stringArray(args.issueIds);
  if (issueIds) return client.fetchIssuesByIds(issueIds);
  const nativeQuery = typeof args.query === "string" ? args.query : args.jql;
  if (typeof nativeQuery === "string" && nativeQuery.trim() !== "") {
    return client.searchIssues(nativeQuery);
  }
  const states = stringArray(args.states);
  if (states) return client.fetchIssuesByStates(states);
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

function stringArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("expected an array of strings");
  }
  return value;
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`'${key}' is required`);
  return value;
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
