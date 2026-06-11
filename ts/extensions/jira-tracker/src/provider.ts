import type { Issue, Settings } from "@symphony/domain";
import { isRecord } from "@symphony/domain";
import type { TrackerContext, TrackerProvider, TrackerToolOps } from "@symphony/tracker-sdk";
import {
  rejectUnknownOptions,
  resolveEnvReference,
  stringListOption,
  stringOption,
} from "@symphony/tracker-sdk";

import { JiraClient, JiraMcpClient } from "./client.js";
import { jiraTrackerOptions, type JiraTrackerOptions } from "./options.js";

const JIRA_OPTION_KEYS = ["baseUrl", "email", "projectKeys", "jql", "issueType", "mcp"];
const JIRA_MCP_KEYS = new Set(["url", "token", "headers", "tools"]);
const JIRA_MCP_TOOL_KEYS = new Set([
  "search",
  "readIssue",
  "updateStatus",
  "comment",
  "createIssue",
]);
// `tracker.mcp.tools` is nested below the tracker section, so its snake_case aliases cannot
// ride on `configAliases` (top-level keys only) and are applied here during option parsing.
const JIRA_MCP_TOOL_ALIASES: Readonly<Record<string, string>> = {
  read_issue: "readIssue",
  update_status: "updateStatus",
  create_issue: "createIssue",
};

/** Jira Cloud tracker: issues are polled from the configured JQL/project scope over REST. */
export const jiraTrackerProvider: TrackerProvider = {
  kind: "jira",
  configAliases: { base_url: "baseUrl", project_keys: "projectKeys", issue_type: "issueType" },
  envFallbacks: { apiKey: "JIRA_API_KEY" },
  parseOptions: (options, context) => parseJiraOptions("jira", options, context),
  validateDispatch(settings) {
    const options = jiraTrackerOptions(settings);
    if (!options.baseUrl) throw new Error("tracker.base_url is required for jira tracker");
    if (!options.email) throw new Error("tracker.email is required for jira tracker");
    if (!settings.tracker.apiKey) throw new Error("tracker.api_key is required for jira tracker");
    assertJiraScope(options);
  },
  createClient: (settings) => new JiraClient(settings),
  createToolOps: (settings, { fetchImpl }) =>
    jiraToolOps(new JiraClient(settings, { fetchImpl }), settings),
  projectUrl: jiraProjectUrl,
};

/** Jira tracker proxied through an external MCP server instead of the Jira REST API. */
export const jiraMcpTrackerProvider: TrackerProvider = {
  kind: "jira-mcp",
  configAliases: { base_url: "baseUrl", project_keys: "projectKeys", issue_type: "issueType" },
  parseOptions: (options, context) => parseJiraOptions("jira-mcp", options, context),
  validateDispatch(settings) {
    const options = jiraTrackerOptions(settings);
    if (!options.mcp?.url) throw new Error("tracker.mcp.url is required for jira-mcp tracker");
    assertJiraScope(options);
  },
  createClient: (settings) => new JiraMcpClient(settings),
  createToolOps: (settings, { fetchImpl }) =>
    jiraToolOps(new JiraMcpClient(settings, { fetchImpl }), settings),
  projectUrl: jiraProjectUrl,
};

function parseJiraOptions(
  kind: string,
  options: Record<string, unknown>,
  context: TrackerContext,
): Record<string, unknown> {
  rejectUnknownOptions(options, JIRA_OPTION_KEYS, kind);
  const baseUrl =
    resolveEnvReference(stringOption(options, "baseUrl") ?? "$JIRA_BASE_URL", context.env) ||
    undefined;
  const email = context.resolveSecret?.(stringOption(options, "email"), "JIRA_EMAIL");
  const projectKeys = stringListOption(options, "projectKeys");
  const jql = stringOption(options, "jql");
  const issueType = stringOption(options, "issueType");
  const mcp = parseJiraMcp(options.mcp, context);
  return {
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(projectKeys !== undefined ? { projectKeys } : {}),
    ...(jql !== undefined ? { jql } : {}),
    ...(issueType !== undefined ? { issueType } : {}),
    ...(mcp !== undefined ? { mcp } : {}),
  };
}

function parseJiraMcp(raw: unknown, context: TrackerContext): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new Error("tracker.mcp must be a map");
  const unknown = Object.keys(raw).filter((key) => !JIRA_MCP_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`unsupported tracker.mcp key(s): ${unknown.join(", ")}`);
  }
  const urlRaw = mcpString(raw, "url", "tracker.mcp.url");
  const tokenRaw = mcpString(raw, "token", "tracker.mcp.token");
  const url =
    urlRaw === undefined ? undefined : resolveEnvReference(urlRaw, context.env) || undefined;
  const token = tokenRaw === undefined ? undefined : context.resolveSecret?.(tokenRaw);
  const headers = raw.headers === undefined ? undefined : parseJiraMcpHeaders(raw.headers);
  const tools = raw.tools === undefined ? undefined : parseJiraMcpTools(raw.tools);
  return {
    ...(url !== undefined ? { url } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(tools !== undefined ? { tools } : {}),
  };
}

function parseJiraMcpHeaders(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) throw new Error("tracker.mcp.headers must be a map of strings");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== "string") throw new Error("tracker.mcp.headers must be a map of strings");
    headers[name] = value;
  }
  return headers;
}

function parseJiraMcpTools(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) throw new Error("tracker.mcp.tools must be a map");
  const tools: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const canonical = JIRA_MCP_TOOL_ALIASES[key] ?? key;
    if (!JIRA_MCP_TOOL_KEYS.has(canonical)) {
      throw new Error(`unsupported tracker.mcp.tools key(s): ${key}`);
    }
    if (typeof value !== "string") {
      throw new Error(`tracker.mcp.tools.${canonical} must be a string`);
    }
    tools[canonical] = value;
  }
  return tools;
}

function mcpString(record: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function assertJiraScope(options: JiraTrackerOptions): void {
  const hasJql = !!options.jql?.trim();
  const hasProjectKeys = !!options.projectKeys && options.projectKeys.length > 0;
  if (!hasJql && !hasProjectKeys) {
    throw new Error("tracker.jql or tracker.project_keys is required for jira trackers");
  }
}

function jiraToolOps(client: JiraClient | JiraMcpClient, settings: Settings): TrackerToolOps {
  return {
    readIssue: async (issueId) => client.readIssue(issueId),
    queryIssues: async (args) => queryJiraIssues(client, settings, args),
    updateStatus: async (issueId, status) => client.updateIssueStatus(issueId, status),
    addComment: async (issueId, body) => client.addComment(issueId, body),
    createIssue: async (input) => client.createIssue(input),
  };
}

async function queryJiraIssues(
  client: JiraClient | JiraMcpClient,
  settings: Settings,
  args: Record<string, unknown>,
): Promise<Issue[]> {
  const issueIds = stringArray(args.issueIds);
  if (issueIds) return client.fetchIssuesByIds(issueIds);
  if (typeof args.jql === "string" && args.jql.trim() !== "") return client.searchIssues(args.jql);
  const states = stringArray(args.states);
  if (states) return client.fetchIssuesByStates(states);
  if (settings.tracker.activeStates.length > 0) return client.fetchCandidateIssues();
  return [];
}

function stringArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("expected an array of strings");
  }
  return value;
}

function jiraProjectUrl(settings: Settings): string | undefined {
  const options = jiraTrackerOptions(settings);
  const baseUrl = options.baseUrl?.replace(/\/+$/, "");
  const projectKey = options.projectKeys?.[0]?.trim();
  return baseUrl && projectKey
    ? `${baseUrl}/jira/software/c/projects/${encodeURIComponent(projectKey)}/issues`
    : undefined;
}
