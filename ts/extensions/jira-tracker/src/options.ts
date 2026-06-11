import type { Settings } from "@symphony/domain";
import { isRecord } from "@symphony/domain";
import { stringListOption, stringOption } from "@symphony/tracker-sdk";

/** Tool names exposed by the external MCP server for Symphony's tracker operations. */
export interface JiraMcpToolMap {
  search?: string | undefined;
  readIssue?: string | undefined;
  updateStatus?: string | undefined;
  comment?: string | undefined;
  createIssue?: string | undefined;
}

/** External MCP settings used when the Jira tracker proxies through another MCP server. */
export interface JiraMcpOptions {
  /** JSON-RPC endpoint for an external tracker MCP server. */
  url?: string | undefined;
  /** Optional bearer token for the external MCP server. */
  token?: string | undefined;
  /** Extra headers to send to the external MCP server. */
  headers?: Record<string, string> | undefined;
  /** Tool names exposed by the external MCP server for Symphony's tracker operations. */
  tools?: JiraMcpToolMap | undefined;
}

/** Jira-specific keys of the `tracker:` config section, validated by the providers. */
export interface JiraTrackerOptions {
  /** Base URL of the Jira site, e.g. `https://example.atlassian.net`. */
  baseUrl?: string | undefined;
  /** Account email paired with `tracker.api_key` for Jira Cloud basic auth. */
  email?: string | undefined;
  /** Jira project keys that scope candidate issues and receive created issues. */
  projectKeys?: string[] | undefined;
  /** JQL replacing the project-key scope for candidate and state queries. */
  jql?: string | undefined;
  /** Issue type used when creating issues; defaults to `"Task"`. */
  issueType?: string | undefined;
  /** External MCP connection used by the `jira-mcp` tracker kind. */
  mcp?: JiraMcpOptions | undefined;
}

/** Typed view over `settings.tracker.options` for the Jira providers. */
export function jiraTrackerOptions(settings: Settings): JiraTrackerOptions {
  const options = settings.tracker.options;
  return {
    baseUrl: stringOption(options, "baseUrl"),
    email: stringOption(options, "email"),
    projectKeys: stringListOption(options, "projectKeys"),
    jql: stringOption(options, "jql"),
    issueType: stringOption(options, "issueType"),
    mcp: mcpValue(options.mcp),
  };
}

function mcpValue(value: unknown): JiraMcpOptions | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("tracker.mcp must be a map");
  return {
    url: nestedStringValue(value, "url", "tracker.mcp.url"),
    token: nestedStringValue(value, "token", "tracker.mcp.token"),
    headers: headersValue(value.headers),
    tools: toolsValue(value.tools),
  };
}

function headersValue(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("tracker.mcp.headers must be a map of strings");
  const headers: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error("tracker.mcp.headers must be a map of strings");
    headers[name] = entry;
  }
  return headers;
}

function toolsValue(value: unknown): JiraMcpToolMap | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("tracker.mcp.tools must be a map");
  return {
    search: nestedStringValue(value, "search", "tracker.mcp.tools.search"),
    readIssue: nestedStringValue(value, "readIssue", "tracker.mcp.tools.readIssue"),
    updateStatus: nestedStringValue(value, "updateStatus", "tracker.mcp.tools.updateStatus"),
    comment: nestedStringValue(value, "comment", "tracker.mcp.tools.comment"),
    createIssue: nestedStringValue(value, "createIssue", "tracker.mcp.tools.createIssue"),
  };
}

function nestedStringValue(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}
