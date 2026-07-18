import type { Settings } from "@lorenz/domain";
import { isRecord } from "@lorenz/domain";
import type { TrackerContext } from "@lorenz/tracker-sdk";
import {
  rejectUnknownOptions,
  resolveEnvReference,
  stringListOption,
  stringOption,
} from "@lorenz/tracker-sdk";

const JIRA_OPTION_KEYS = ["baseUrl", "email", "projectKeys", "jql", "issueType", "mcp"];
const JIRA_MCP_KEYS = new Set(["url", "token", "headers", "tools"]);
const JIRA_MCP_TOOL_NAMES = [
  "search",
  "readIssue",
  "updateStatus",
  "listComments",
  "comment",
  "updateComment",
  "createIssue",
] as const;
export type JiraMcpToolName = (typeof JIRA_MCP_TOOL_NAMES)[number];
const JIRA_MCP_TOOL_ALIASES: Readonly<Record<string, JiraMcpToolName>> = {
  read_issue: "readIssue",
  update_status: "updateStatus",
  list_comments: "listComments",
  update_comment: "updateComment",
  create_issue: "createIssue",
};

/** Tool names exposed by the external MCP server for Lorenz's tracker operations. */
export type JiraMcpToolMap = Partial<Record<JiraMcpToolName, string | undefined>>;

/** External MCP settings used when the Jira tracker proxies through another MCP server. */
export interface JiraMcpOptions {
  /** JSON-RPC endpoint for an external tracker MCP server. */
  url?: string | undefined;
  /** Optional bearer token for the external MCP server. */
  token?: string | undefined;
  /** Extra headers to send to the external MCP server. */
  headers?: Record<string, string> | undefined;
  /** Tool names exposed by the external MCP server for Lorenz's tracker operations. */
  tools?: JiraMcpToolMap | undefined;
}

/** Jira-specific keys of the selected tracker bundle, validated by the providers. */
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

type NormalizedJiraTrackerOptions = JiraTrackerOptions & Record<string, unknown>;

const normalizedOptions = new WeakMap<Record<string, unknown>, NormalizedJiraTrackerOptions>();

/**
 * Stable typed view over `settings.tracker.options` for Jira consumers. Config-parser output is
 * already cached; programmatically constructed settings are normalized and validated here once.
 */
export function jiraTrackerOptions(settings: Settings): JiraTrackerOptions {
  const options = settings.tracker.options;
  const cached = normalizedOptions.get(options);
  if (cached) return cached;
  const normalized = normalizeJiraTrackerOptions(settings.tracker.kind ?? "jira", options, {
    env: {},
  });
  normalizedOptions.set(options, normalized);
  return normalized;
}

/** Validate and normalize Jira provider options into the representation used at runtime. */
export function normalizeJiraTrackerOptions(
  kind: string,
  options: Record<string, unknown>,
  context: TrackerContext,
): NormalizedJiraTrackerOptions {
  const cached = normalizedOptions.get(options);
  if (cached === options) return cached;

  rejectUnknownOptions(options, JIRA_OPTION_KEYS, kind);
  const baseUrl =
    resolveEnvReference(stringOption(options, "baseUrl") ?? "$JIRA_BASE_URL", context.env) ||
    undefined;
  const email = resolveSecret(stringOption(options, "email"), context, "JIRA_EMAIL");
  const projectKeys = stringListOption(options, "projectKeys");
  const jql = stringOption(options, "jql");
  const issueType = stringOption(options, "issueType");
  const mcp = normalizeJiraMcpOptions(options.mcp, context);
  const normalized: NormalizedJiraTrackerOptions = {
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(projectKeys !== undefined ? { projectKeys } : {}),
    ...(jql !== undefined ? { jql } : {}),
    ...(issueType !== undefined ? { issueType } : {}),
    ...(mcp !== undefined ? { mcp } : {}),
  };
  normalizedOptions.set(normalized, normalized);
  return normalized;
}

function normalizeJiraMcpOptions(
  raw: unknown,
  context: TrackerContext,
): JiraMcpOptions | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new Error("tracker.mcp must be a map");
  const unknown = Object.keys(raw).filter((key) => !JIRA_MCP_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`unsupported tracker.mcp key(s): ${unknown.join(", ")}`);
  }
  const urlRaw = nestedStringValue(raw, "url", "tracker.mcp.url");
  const tokenRaw = nestedStringValue(raw, "token", "tracker.mcp.token");
  const url =
    urlRaw === undefined ? undefined : resolveEnvReference(urlRaw, context.env) || undefined;
  const token = resolveSecret(tokenRaw, context);
  const headers = raw.headers === undefined ? undefined : normalizeJiraMcpHeaders(raw.headers);
  const tools = raw.tools === undefined ? undefined : normalizeJiraMcpTools(raw.tools);
  return {
    ...(url !== undefined ? { url } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(tools !== undefined ? { tools } : {}),
  };
}

function normalizeJiraMcpHeaders(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) throw new Error("tracker.mcp.headers must be a map of strings");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== "string") throw new Error("tracker.mcp.headers must be a map of strings");
    headers[name] = value;
  }
  return headers;
}

function normalizeJiraMcpTools(raw: unknown): JiraMcpToolMap {
  if (!isRecord(raw)) throw new Error("tracker.mcp.tools must be a map");
  const tools: JiraMcpToolMap = {};
  for (const [key, value] of Object.entries(raw)) {
    const canonical = JIRA_MCP_TOOL_ALIASES[key] ?? key;
    if (!isJiraMcpToolName(canonical)) {
      throw new Error(`unsupported tracker.mcp.tools key(s): ${key}`);
    }
    if (typeof value !== "string") {
      throw new Error(`tracker.mcp.tools.${canonical} must be a string`);
    }
    tools[canonical] = value;
  }
  return tools;
}

function isJiraMcpToolName(value: string): value is JiraMcpToolName {
  return JIRA_MCP_TOOL_NAMES.some((name) => name === value);
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

function resolveSecret(
  value: string | undefined,
  context: TrackerContext,
  fallbackEnvVar?: string,
): string | undefined {
  if (value === undefined) {
    return fallbackEnvVar === undefined
      ? undefined
      : context.resolveSecret?.(undefined, fallbackEnvVar);
  }
  return context.resolveSecret ? context.resolveSecret(value, fallbackEnvVar) : value;
}
