import { errorMessage, isRecord, type Issue, type Settings } from "@symphony/domain";
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
} from "@symphony/tool-sdk";

import { BoardStore, type BoardStoreOptions } from "./boardStore.js";
import { localToolPackOptions, validateLocalToolOptions } from "./options.js";
import { resolveBoardDir } from "./resolveBoardDir.js";

const TOOL_NAMES = [
  "local_update_status",
  "local_comment",
  "local_create_issue",
  "local_read_issue",
  "local_query",
] as const;

/** Default projection for `local_query` when `select` is omitted. */
const DEFAULT_LOCAL_SELECT = ["id", "title", "state", "stateType", "labels"];

export function localToolSpecs(): ToolSpec[] {
  return [
    {
      name: "local_update_status",
      description: "Move a local board issue to a new status. Args: issueId, status.",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" }, status: { type: "string" } },
        required: ["issueId", "status"],
      },
    },
    {
      name: "local_comment",
      description: "Append a comment to a local board issue. Args: issueId, body.",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" }, body: { type: "string" } },
        required: ["issueId", "body"],
      },
    },
    {
      name: "local_create_issue",
      description: "Create a new local board issue. Args: title, body?, status?.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          status: { type: "string" },
        },
        required: ["title"],
      },
    },
    {
      name: "local_read_issue",
      description:
        "Read a local board issue: its current status, title, description, and comments.",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" } },
        required: ["issueId"],
      },
    },
    {
      name: "local_query",
      description:
        "Query local board issues (read-only). Filter with a JSON predicate DSL, project fields, " +
        "order, and page. Row fields: id, identifier, title, description, state, stateType, labels, " +
        "createdAt, updatedAt; add 'comments' to select to include each issue's comment lines. " +
        "Args: where? (filter), select? (string[]), order_by? ([{field,dir}]), limit?, offset?.",
      inputSchema: {
        type: "object",
        properties: {
          where: { type: "object" },
          select: { type: "array", items: { type: "string" } },
          order_by: { type: "array", items: { type: "object" } },
          limit: { type: "number" },
          offset: { type: "number" },
        },
      },
    },
  ];
}

export async function executeLocalTool(
  name: string,
  input: unknown,
  settings: Settings,
): Promise<ToolResult> {
  const store = storeFor(settings);
  const args = isRecord(input) ? input : {};
  try {
    switch (name) {
      case "local_update_status": {
        const issue = await store.updateStatus(
          requireStr(args, "issueId"),
          requireStr(args, "status"),
        );
        return toolSuccess({ issue });
      }
      case "local_comment": {
        await store.appendComment(requireStr(args, "issueId"), requireStr(args, "body"));
        return toolSuccess({ ok: true });
      }
      case "local_create_issue": {
        const body = optStr(args.body);
        const status = optStr(args.status);
        const issue = await store.create({
          title: requireStr(args, "title"),
          ...(body !== undefined ? { body } : {}),
          ...(status !== undefined ? { status } : {}),
        });
        return toolSuccess({ issue });
      }
      case "local_read_issue": {
        const { id, status, title, description, comments } = await store.readContent(
          requireStr(args, "issueId"),
        );
        return toolSuccess({ issue: { id, status, title, description }, comments });
      }
      case "local_query": {
        const spec = parseQuerySpec(args);
        const select = parseSelect(args.select) ?? DEFAULT_LOCAL_SELECT;
        // Surface malformed board files instead of hiding them; a query never throws on a bad file.
        const skipped: Array<{ id: string; error: string }> = [];
        const queryStore = storeFor(settings, {
          onSkip: ({ id, error }) => skipped.push({ id, error }),
        });
        const records = (await queryStore.list()).map(toLocalRecord);
        const { rows, total } = applyQuery(records, spec);
        const includeComments = select.includes("comments");
        const out: Array<Record<string, unknown>> = [];
        for (const row of rows) {
          const projected = pickFields(row, select);
          // `comments` is not on the base record (it costs an extra read); fetch it only when asked.
          if (includeComments) {
            projected.comments = (await queryStore.readContent(String(row.id))).comments;
          }
          out.push(projected);
        }
        return toolSuccess({ rows: out, total, skipped });
      }
      default:
        return unsupportedToolFailure(name, TOOL_NAMES);
    }
  } catch (error) {
    return toolFailure(errorMessage(error));
  }
}

/** The local board tool pack: read and write `<prefix><n>.md` issues in the board directory. */
export const localToolProvider: ToolProvider = {
  name: "local",
  validateOptions: (options) => validateLocalToolOptions(options),
  toolSpecs: () => localToolSpecs(),
  executeTool: async (name, input, context) => executeLocalTool(name, input, context.settings),
};

function storeFor(settings: Settings, options: BoardStoreOptions = {}): BoardStore {
  const { path: boardPath, idPrefix } = localToolPackOptions(settings);
  return new BoardStore(resolveBoardDir(boardPath), {
    ...(idPrefix !== undefined ? { idPrefix } : {}),
    ...options,
  });
}

/** Flat, filterable view of a board issue for `local_query` (comments are fetched on demand). */
function toLocalRecord(issue: Issue): Record<string, unknown> {
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
