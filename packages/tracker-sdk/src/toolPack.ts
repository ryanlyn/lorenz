import { errorMessage, isRecord, type Issue, type Settings } from "@lorenz/domain";
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

import type { TrackerRegistry } from "./registry.js";
import type { TrackerToolOps } from "./provider.js";

const TRACKER_TOOL_NAMES = [
  "tracker_read_issue",
  "tracker_query",
  "tracker_update_status",
  "tracker_list_comments",
  "tracker_comment",
  "tracker_update_comment",
  "tracker_create_issue",
] as const;

const DEFAULT_SELECT = ["id", "identifier", "title", "state", "stateType", "labels", "url"];

/**
 * The provider-neutral `tracker` tool pack: one set of `tracker_*` tools that works against
 * whichever tracker drives dispatch, implemented purely over the provider's normalized
 * {@link TrackerToolOps}. Backends without tool operations (e.g. the in-process memory
 * fixture) advertise no tools and fail any direct call with a clear message.
 */
export function createTrackerToolProvider(trackers: TrackerRegistry): ToolProvider {
  return {
    name: "tracker",
    toolSpecs: (settings) =>
      opsFor(trackers, settings, fetch) === undefined ? [] : trackerToolSpecs(),
    executeTool: async (name, input, context) =>
      executeTrackerTool(trackers, name, input, context.settings, context.fetchImpl),
  };
}

function opsFor(
  trackers: TrackerRegistry,
  settings: Settings,
  fetchImpl: typeof fetch,
): TrackerToolOps | undefined {
  return trackers.get(settings.tracker.kind)?.createToolOps?.(settings, { fetchImpl });
}

function trackerToolSpecs(): ToolSpec[] {
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
      name: "tracker_list_comments",
      description: "List comments on an issue in the configured tracker. Args: issueId.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { issueId: { type: "string" } },
        required: ["issueId"],
      },
    },
    {
      name: "tracker_comment",
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
      name: "tracker_update_comment",
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
      name: "tracker_create_issue",
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

async function executeTrackerTool(
  trackers: TrackerRegistry,
  name: string,
  input: unknown,
  settings: Settings,
  fetchImpl: typeof fetch,
): Promise<ToolResult> {
  if (!isTrackerToolName(name)) return unsupportedToolFailure(name, TRACKER_TOOL_NAMES);
  const args = isRecord(input) ? input : {};
  const ops = opsFor(trackers, settings, fetchImpl);
  try {
    switch (name) {
      case "tracker_read_issue": {
        const issueId = requireStr(args, "issueId");
        if (!ops?.readIssue) return unavailableFailure(settings);
        return toolSuccess({ issue: await ops.readIssue(issueId) });
      }
      case "tracker_query":
        return await queryTrackerRows(ops, settings, args);
      case "tracker_update_status": {
        const issueId = requireStr(args, "issueId");
        const status = requireStr(args, "status");
        if (!ops?.updateStatus) return unavailableFailure(settings);
        return toolSuccess({ issue: await ops.updateStatus(issueId, status) });
      }
      case "tracker_list_comments": {
        const issueId = requireStr(args, "issueId");
        if (!ops?.listComments) return unavailableFailure(settings);
        return toolSuccess({ comments: await ops.listComments(issueId) });
      }
      case "tracker_comment": {
        const issueId = requireStr(args, "issueId");
        const body = requireStr(args, "body");
        if (!ops?.addComment) return unavailableFailure(settings);
        const comment = await ops.addComment(issueId, body);
        return toolSuccess(comment ? { ok: true, comment } : { ok: true });
      }
      case "tracker_update_comment": {
        const issueId = requireStr(args, "issueId");
        const commentId = requireStr(args, "commentId");
        const body = requireStr(args, "body");
        if (!ops?.updateComment) return unavailableFailure(settings);
        return toolSuccess({ comment: await ops.updateComment(issueId, commentId, body) });
      }
      case "tracker_create_issue": {
        const create = {
          title: requireStr(args, "title"),
          body: optStr(args.body),
          status: optStr(args.status),
          assignee: optStr(args.assignee),
        };
        if (!ops?.createIssue) return unavailableFailure(settings);
        return toolSuccess({ issue: await ops.createIssue(create) });
      }
    }
  } catch (error) {
    return toolFailure(errorMessage(error));
  }
}

async function queryTrackerRows(
  ops: TrackerToolOps | undefined,
  settings: Settings,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const select = parseSelect(args.select) ?? DEFAULT_SELECT;
  if (ops?.queryRows) return toolSuccess(await ops.queryRows(args));
  if (!ops?.queryIssues) return unavailableFailure(settings);
  return toolSuccess(projectIssues(await ops.queryIssues(args), select, args));
}

function unavailableFailure(settings: Settings): ToolResult {
  // An unset kind resolves to no provider, so it reports like the in-process memory fixture.
  return toolFailure(
    `tracker tools are unavailable for ${settings.tracker.kind ?? "memory"} tracker`,
  );
}

function isTrackerToolName(name: string): name is (typeof TRACKER_TOOL_NAMES)[number] {
  return (TRACKER_TOOL_NAMES as readonly string[]).includes(name);
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

function requireStr(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`'${key}' is required`);
  return value;
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
