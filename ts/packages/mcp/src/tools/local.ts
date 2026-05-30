import type { Settings } from "@symphony/domain";
import { BoardStore, resolveBoardDir } from "@symphony/local-tracker";

import type { ToolResult, ToolSpec } from "../tools.js";

const TOOL_NAMES = ["local_update_status", "local_comment", "local_create_issue"] as const;

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
        return { success: true, result: { issue } };
      }
      case "local_comment": {
        await store.appendComment(requireStr(args, "issueId"), requireStr(args, "body"));
        return { success: true, result: { ok: true } };
      }
      case "local_create_issue": {
        const body = optStr(args.body);
        const status = optStr(args.status);
        const issue = await store.create({
          title: requireStr(args, "title"),
          ...(body !== undefined ? { body } : {}),
          ...(status !== undefined ? { status } : {}),
        });
        return { success: true, result: { issue } };
      }
      default:
        return {
          success: false,
          error: "Unsupported tool.",
          result: { error: { message: "Unsupported tool.", supportedTools: [...TOOL_NAMES] } },
        };
    }
  } catch (error) {
    const message = (error as Error).message;
    return { success: false, error: message, result: { error: { message } } };
  }
}

function storeFor(settings: Settings): BoardStore {
  return new BoardStore(resolveBoardDir(settings.tracker.path));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`'${key}' is required`);
  return value;
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
