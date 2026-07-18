import type { Settings } from "@lorenz/domain";
import type { TrackerProvider } from "@lorenz/tracker-sdk";

import { JiraClient, JiraMcpClient } from "./client.js";
import {
  jiraTrackerOptions,
  normalizeJiraTrackerOptions,
  type JiraTrackerOptions,
} from "./options.js";
import { JIRA_TOOL_PACK_NAME } from "./tools.js";

/** Jira Cloud tracker: issues are polled from the configured JQL/project scope over REST. */
export const jiraTrackerProvider: TrackerProvider = {
  kind: "jira",
  configAliases: { base_url: "baseUrl", project_keys: "projectKeys", issue_type: "issueType" },
  envFallbacks: { apiKey: "JIRA_API_KEY" },
  parseOptions: (options, context) => normalizeJiraTrackerOptions("jira", options, context),
  validateDispatch(settings) {
    const options = jiraTrackerOptions(settings);
    if (!options.baseUrl) throw new Error("tracker.base_url is required for jira tracker");
    if (!options.email) throw new Error("tracker.email is required for jira tracker");
    if (!settings.tracker.apiKey) throw new Error("tracker.api_key is required for jira tracker");
    assertJiraScope(options);
  },
  createClient: (settings) => new JiraClient(settings),
  defaultToolPacks: () => [JIRA_TOOL_PACK_NAME],
  projectUrl: jiraProjectUrl,
};

/** Jira tracker proxied through an external MCP server instead of the Jira REST API. */
export const jiraMcpTrackerProvider: TrackerProvider = {
  kind: "jira-mcp",
  configAliases: { base_url: "baseUrl", project_keys: "projectKeys", issue_type: "issueType" },
  parseOptions: (options, context) => normalizeJiraTrackerOptions("jira-mcp", options, context),
  validateDispatch(settings) {
    const options = jiraTrackerOptions(settings);
    if (!options.mcp?.url) throw new Error("tracker.mcp.url is required for jira-mcp tracker");
    assertJiraScope(options);
  },
  createClient: (settings) => new JiraMcpClient(settings),
  defaultToolPacks: () => [JIRA_TOOL_PACK_NAME],
  projectUrl: jiraProjectUrl,
};

function assertJiraScope(options: JiraTrackerOptions): void {
  const hasJql = !!options.jql?.trim();
  const hasProjectKeys = !!options.projectKeys && options.projectKeys.length > 0;
  if (!hasJql && !hasProjectKeys) {
    throw new Error("tracker.jql or tracker.project_keys is required for jira trackers");
  }
}

function jiraProjectUrl(settings: Settings): string | undefined {
  const options = jiraTrackerOptions(settings);
  const baseUrl = options.baseUrl?.replace(/\/+$/, "");
  const projectKey = options.projectKeys?.[0]?.trim();
  return baseUrl && projectKey
    ? `${baseUrl}/jira/software/c/projects/${encodeURIComponent(projectKey)}/issues`
    : undefined;
}
