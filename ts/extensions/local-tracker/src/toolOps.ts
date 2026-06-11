import { normalizeIssue } from "@symphony/issue";
import { isRecord, type Issue, type Settings } from "@symphony/domain";
import type { TrackerQueryResult, TrackerToolOps } from "@symphony/tracker-sdk";

import { executeLocalTool } from "./tools.js";

/**
 * Normalized issue operations behind the provider-neutral `tracker_*` pack, delegating to
 * the `local_*` tools so both surfaces share one board implementation. The board's query
 * tool filters and projects natively, so queries are exposed as pre-projected rows.
 */
export function localToolOps(settings: Settings): TrackerToolOps {
  return {
    readIssue: async (issueId) => {
      const result = await executeLocalTool("local_read_issue", { issueId }, settings);
      if (!result.success) throw new Error(result.error ?? "local_read_issue failed");
      return localReadResultToIssue(result.result);
    },
    queryRows: async (args): Promise<TrackerQueryResult> => {
      const result = await executeLocalTool("local_query", args, settings);
      if (!result.success) throw new Error(result.error ?? "local_query failed");
      const payload = isRecord(result.result) ? result.result : {};
      return {
        rows: Array.isArray(payload.rows) ? (payload.rows as Array<Record<string, unknown>>) : [],
        total: typeof payload.total === "number" ? payload.total : 0,
        skipped: Array.isArray(payload.skipped) ? payload.skipped : [],
      };
    },
    updateStatus: async (issueId, status) => {
      const result = await executeLocalTool("local_update_status", { issueId, status }, settings);
      if (!result.success) throw new Error(result.error ?? "local_update_status failed");
      return issueResult(result.result);
    },
    addComment: async (issueId, body) => {
      const result = await executeLocalTool("local_comment", { issueId, body }, settings);
      if (!result.success) throw new Error(result.error ?? "local_comment failed");
    },
    createIssue: async (input) => {
      const result = await executeLocalTool(
        "local_create_issue",
        { title: input.title, body: input.body, status: input.status },
        settings,
      );
      if (!result.success) throw new Error(result.error ?? "local_create_issue failed");
      return issueResult(result.result);
    },
  };
}

function localReadResultToIssue(value: unknown): Issue {
  if (!isRecord(value) || !isRecord(value.issue))
    throw new Error("local_read_issue returned no issue");
  return normalizeIssue({
    id: requireStr(value.issue, "id"),
    identifier: requireStr(value.issue, "id"),
    title: requireStr(value.issue, "title"),
    description: typeof value.issue.description === "string" ? value.issue.description : null,
    state: requireStr(value.issue, "status"),
    state_type: stateTypeFromStatus(requireStr(value.issue, "status")),
    labels: [],
    blockers: [],
  });
}

function issueResult(value: unknown): Issue {
  if (!isRecord(value) || !isRecord(value.issue)) throw new Error("tracker tool returned no issue");
  return normalizeIssue(value.issue);
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
