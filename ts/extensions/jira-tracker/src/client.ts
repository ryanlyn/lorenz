import {
  errorMessage,
  isRecord,
  type Issue,
  type IssueRef,
  type IssueStateType,
  type RuntimeTrackerClient,
  type Settings,
} from "@lorenz/domain";
import { defaultStateType, normalizeIssue } from "@lorenz/issue";

import { jiraTrackerOptions, type JiraMcpToolMap } from "./options.js";

const JIRA_REQUEST_TIMEOUT_MS = 30_000;
/** Issues must carry this label to be picked up for dispatch; it marks them as delegated to agents. */
const AGENT_LABEL = "agent";
const JIRA_FIELDS = [
  "summary",
  "description",
  "status",
  "labels",
  "issuelinks",
  "assignee",
  "priority",
  "created",
  "updated",
];
const DEFAULT_JIRA_ISSUE_TYPE = "Task";
const DEFAULT_MCP_TOOLS: Required<JiraMcpToolMap> = {
  search: "jira_search",
  readIssue: "jira_get_issue",
  updateStatus: "jira_transition_issue",
  comment: "jira_add_comment",
  createIssue: "jira_create_issue",
};

export interface JiraClientDeps {
  fetchImpl?: typeof fetch | undefined;
}

export class JiraClient implements RuntimeTrackerClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly settings: Settings,
    deps: JiraClientDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.searchIssues(candidateJql(this.settings));
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];
    const field = uniqueIds.every((id) => /^\d+$/.test(id)) ? "id" : "key";
    const issues = await this.searchIssues(`${field} in (${uniqueIds.map(jqlString).join(", ")})`);
    const order = new Map(uniqueIds.map((id, index) => [id, index]));
    return issues.sort((left, right) => {
      const leftIndex = order.get(left.id) ?? order.get(left.identifier) ?? order.size;
      const rightIndex = order.get(right.id) ?? order.get(right.identifier) ?? order.size;
      return leftIndex - rightIndex;
    });
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const jql = statesJql(this.settings, states);
    return jql ? this.searchIssues(jql) : [];
  }

  async readIssue(issueIdOrKey: string): Promise<Issue> {
    const raw = await this.request<Record<string, unknown>>(
      `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}?fields=${encodeURIComponent(JIRA_FIELDS.join(","))}`,
      { method: "GET" },
    );
    return normalizeJiraIssue(raw, assigneeFilterValue(this.settings), this.baseUrl());
  }

  async updateIssueStatus(issueIdOrKey: string, status: string): Promise<Issue> {
    const transitions = await this.request<{ transitions?: Array<Record<string, unknown>> }>(
      `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/transitions`,
      { method: "GET" },
    );
    const transition = (transitions.transitions ?? []).find(
      (candidate) =>
        typeof candidate.name === "string" &&
        candidate.name.trim().toLowerCase() === status.trim().toLowerCase(),
    );
    const transitionId = stringField(transition, "id");
    if (!transitionId) throw new Error(`jira transition not found for status: ${status}`);

    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
    return this.readIssue(issueIdOrKey);
  }

  async addComment(issueIdOrKey: string, body: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: adfDocument(body) }),
    });
  }

  async createIssue(input: {
    title: string;
    body?: string | undefined;
    status?: string | undefined;
    assignee?: string | undefined;
  }): Promise<Issue> {
    const projectKey = this.requiredProjectKey();
    const assignee = await this.createIssueAssignee(input.assignee);
    const created = await this.request<Record<string, unknown>>("/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          issuetype: {
            name: jiraTrackerOptions(this.settings).issueType ?? DEFAULT_JIRA_ISSUE_TYPE,
          },
          summary: input.title,
          ...(input.body !== undefined ? { description: adfDocument(input.body) } : {}),
          assignee,
        },
      }),
    });
    const issueId = stringField(created, "id") ?? stringField(created, "key");
    if (!issueId) throw new Error("jira issue create returned no id or key");
    if (input.status !== undefined && input.status.trim() !== "") {
      return this.updateIssueStatus(issueId, input.status);
    }
    return this.readIssue(issueId);
  }

  async searchIssues(jql: string, maxResults = 50): Promise<Issue[]> {
    const out: Issue[] = [];
    // Jira Cloud removed the legacy `/rest/api/3/search` endpoint; the enhanced
    // `/search/jql` endpoint replaces `startAt`/`total` offset paging with an
    // opaque `nextPageToken` and omits a total count (pages run until no token).
    let nextPageToken: string | undefined;
    for (;;) {
      const page = await this.request<Record<string, unknown>>("/rest/api/3/search/jql", {
        method: "POST",
        body: JSON.stringify({
          jql,
          maxResults,
          fields: JIRA_FIELDS,
          ...(nextPageToken !== undefined ? { nextPageToken } : {}),
        }),
      });
      const nodes = Array.isArray(page.issues) ? page.issues : [];
      for (const node of nodes) {
        if (isRecord(node))
          out.push(normalizeJiraIssue(node, assigneeFilterValue(this.settings), this.baseUrl()));
      }
      const token = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
      if (nodes.length === 0 || token === undefined) return out;
      nextPageToken = token;
    }
  }

  private requiredProjectKey(): string {
    const key = jiraTrackerOptions(this.settings).projectKeys?.[0]?.trim();
    if (!key) throw new Error("tracker.project_keys is required to create Jira issues");
    return key;
  }

  private baseUrl(): string {
    const baseUrl = jiraTrackerOptions(this.settings).baseUrl?.replace(/\/+$/, "");
    if (!baseUrl) throw new Error("tracker.base_url is required for jira tracker");
    return baseUrl;
  }

  private async createIssueAssignee(
    inputAssignee: string | undefined,
  ): Promise<Record<string, string>> {
    const explicitAssignee = explicitCreateAssignee(inputAssignee, this.settings);
    if (explicitAssignee) return { accountId: explicitAssignee };
    const currentUser = await this.request<Record<string, unknown>>("/rest/api/3/myself", {
      method: "GET",
    });
    const accountId = stringField(currentUser, "accountId");
    if (accountId) return { accountId };
    const name = stringField(currentUser, "name");
    if (name) return { name };
    throw new Error("jira current user returned no accountId");
  }

  private authHeader(): string {
    const email = jiraTrackerOptions(this.settings).email;
    const token = this.settings.tracker.apiKey;
    if (!email) throw new Error("tracker.email is required for jira tracker");
    if (!token) throw new Error("tracker.api_key is required for jira tracker");
    return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  }

  private async request<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl()}${path}`, {
      ...init,
      signal: AbortSignal.timeout(JIRA_REQUEST_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: this.authHeader(),
        ...init.headers,
      },
    });
    const text = await response.text();
    const body = text.trim() === "" ? null : parseJson(text);
    if (!response.ok) {
      throw new Error(`jira api status ${response.status}: ${summarizeBody(body ?? text)}`);
    }
    return body as T;
  }
}

export class JiraMcpClient implements RuntimeTrackerClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly settings: Settings,
    deps: JiraClientDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.searchIssues(candidateJql(this.settings));
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];
    const readTool = this.toolName("readIssue", false);
    if (readTool) {
      const issues: Issue[] = [];
      for (const id of uniqueIds) {
        const payload = await this.callTool(readTool, issueRefArgs(id));
        const issue = firstIssueFromPayload(
          payload,
          assigneeFilterValue(this.settings),
          this.baseUrlOrNull(),
        );
        if (issue) issues.push(issue);
      }
      return issues;
    }
    return this.searchIssues(`key in (${uniqueIds.map(jqlString).join(", ")})`);
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const jql = statesJql(this.settings, states);
    return jql ? this.searchIssues(jql) : [];
  }

  async readIssue(issueIdOrKey: string): Promise<Issue> {
    const payload = await this.callTool(this.toolName("readIssue"), issueRefArgs(issueIdOrKey));
    const issue = firstIssueFromPayload(
      payload,
      assigneeFilterValue(this.settings),
      this.baseUrlOrNull(),
    );
    if (!issue) throw new Error("jira-mcp read issue returned no issue");
    return issue;
  }

  async updateIssueStatus(issueIdOrKey: string, status: string): Promise<Issue> {
    const payload = await this.callTool(this.toolName("updateStatus"), {
      ...issueRefArgs(issueIdOrKey),
      status,
    });
    return (
      firstIssueFromPayload(payload, assigneeFilterValue(this.settings), this.baseUrlOrNull()) ??
      this.readIssue(issueIdOrKey)
    );
  }

  async addComment(issueIdOrKey: string, body: string): Promise<void> {
    const tool = this.toolName("comment");
    const failures: string[] = [];
    for (const args of commentArgs(issueIdOrKey, body)) {
      try {
        const payload = await this.callTool(tool, args);
        const payloadError = mcpToolPayloadError(payload);
        if (!payloadError) return;
        failures.push(payloadError);
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }
    throw new Error(`jira-mcp add comment failed: ${failures.join("; ")}`);
  }

  async createIssue(input: {
    title: string;
    body?: string | undefined;
    status?: string | undefined;
    assignee?: string | undefined;
  }): Promise<Issue> {
    const options = jiraTrackerOptions(this.settings);
    const payload = await this.callTool(this.toolName("createIssue"), {
      projectKey: options.projectKeys?.[0],
      issueType: options.issueType ?? DEFAULT_JIRA_ISSUE_TYPE,
      title: input.title,
      summary: input.title,
      body: input.body,
      description: input.body,
      status: input.status,
      ...createAssigneeArgs(input.assignee, this.settings),
    });
    const issue = firstIssueFromPayload(
      payload,
      assigneeFilterValue(this.settings),
      this.baseUrlOrNull(),
    );
    if (!issue) throw new Error("jira-mcp create issue returned no issue");
    return issue;
  }

  async searchIssues(jql: string): Promise<Issue[]> {
    const payload = await this.callTool(this.toolName("search"), { jql, fields: JIRA_FIELDS });
    return issuesFromPayload(payload, assigneeFilterValue(this.settings), this.baseUrlOrNull());
  }

  private baseUrlOrNull(): string | null {
    return jiraTrackerOptions(this.settings).baseUrl?.replace(/\/+$/, "") ?? null;
  }

  private toolName(name: keyof Required<JiraMcpToolMap>, required?: true): string;
  private toolName(name: keyof Required<JiraMcpToolMap>, required: false): string | null;
  private toolName(name: keyof Required<JiraMcpToolMap>, required = true): string | null {
    const tool = jiraTrackerOptions(this.settings).mcp?.tools?.[name] ?? DEFAULT_MCP_TOOLS[name];
    if (!tool && required) throw new Error(`tracker.mcp.tools.${name} is required`);
    return tool || null;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const mcp = jiraTrackerOptions(this.settings).mcp;
    const url = mcp?.url;
    if (!url) throw new Error("tracker.mcp.url is required for jira-mcp tracker");
    const response = await this.fetchImpl(url, {
      method: "POST",
      signal: AbortSignal.timeout(JIRA_REQUEST_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(mcp.token ? { authorization: `Bearer ${mcp.token}` } : {}),
        ...(mcp.headers ?? {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `lorenz-jira-mcp-${Date.now()}`,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const text = await response.text();
    const body = text.trim() === "" ? null : parseJson(text);
    if (!response.ok)
      throw new Error(`jira-mcp status ${response.status}: ${summarizeBody(body ?? text)}`);
    if (isRecord(body) && isRecord(body.error)) {
      throw new Error(
        `jira-mcp error: ${stringField(body.error, "message") ?? summarizeBody(body.error)}`,
      );
    }
    return mcpResultPayload(body);
  }
}

/**
 * JQL selecting issues eligible for dispatch. Candidates are always restricted to issues
 * assigned to the worker's user and labeled {@link AGENT_LABEL}, so Lorenz never picks up
 * work that was not explicitly delegated to it — even when `tracker.jql` widens the scope.
 */
function candidateJql(settings: Settings): string {
  const parts: string[] = [];
  const base = baseScopeJql(settings);
  if (base) parts.push(base);
  if (settings.tracker.activeStates.length > 0) {
    parts.push(`status in (${settings.tracker.activeStates.map(jqlString).join(", ")})`);
  }
  parts.push(assigneeJql(settings), `labels = ${jqlString(AGENT_LABEL)}`);
  return parts.join(" AND ");
}

function assigneeJql(settings: Settings): string {
  const assignee = settings.tracker.assignee?.trim();
  return !assignee || assignee.toLowerCase() === "me"
    ? "assignee = currentUser()"
    : `assignee = ${jqlString(assignee)}`;
}

function statesJql(settings: Settings, states: string[]): string | null {
  const stateNames = normalizeStateNames(states);
  if (stateNames.length === 0) return null;
  const stateJql = `status in (${stateNames.map(jqlString).join(", ")})`;
  const scoped = baseScopeJql(settings);
  return scoped ? `${scoped} AND ${stateJql}` : stateJql;
}

function baseScopeJql(settings: Settings): string {
  const options = jiraTrackerOptions(settings);
  const jql = options.jql?.trim();
  if (jql) return `(${jql})`;
  const projectKeys = options.projectKeys ?? [];
  if (projectKeys.length === 0) return "";
  return `project in (${projectKeys.map(jqlString).join(", ")})`;
}

function assigneeFilterValue(settings: Settings): string | undefined {
  const assignee = settings.tracker.assignee?.trim();
  if (!assignee || assignee.toLowerCase() === "me") return undefined;
  return assignee;
}

function explicitCreateAssignee(
  inputAssignee: string | undefined,
  settings: Settings,
): string | null {
  const assignee = inputAssignee?.trim() || settings.tracker.assignee?.trim();
  if (!assignee || assignee.toLowerCase() === "me" || assignee.toLowerCase() === "currentuser()") {
    return null;
  }
  return assignee;
}

function createAssigneeArgs(
  inputAssignee: string | undefined,
  settings: Settings,
): Record<string, string> {
  const assignee = explicitCreateAssignee(inputAssignee, settings);
  return assignee
    ? {
        assignee,
        assigneeId: assignee,
        assigneeAccountId: assignee,
      }
    : {};
}

function issueRefArgs(issueIdOrKey: string): Record<string, unknown> {
  // External MCP servers disagree on the parameter name, so send the common aliases.
  return { issueIdOrKey, issueId: issueIdOrKey, key: issueIdOrKey };
}

function commentArgs(issueIdOrKey: string, body: string): Array<Record<string, unknown>> {
  return [
    { issue_key: issueIdOrKey, comment: body },
    { issueKey: issueIdOrKey, comment: body },
    { issueIdOrKey, comment: body },
    { issueId: issueIdOrKey, comment: body },
    { key: issueIdOrKey, comment: body },
    { issue_key: issueIdOrKey, body },
    { issueKey: issueIdOrKey, body },
    { issueIdOrKey, body },
    { issueId: issueIdOrKey, body },
    { key: issueIdOrKey, body },
  ];
}

export function normalizeJiraIssue(
  issue: Record<string, unknown>,
  assignee?: string,
  baseUrl?: string | null,
): Issue {
  const fields = isRecord(issue.fields) ? issue.fields : {};
  const status = isRecord(fields.status) ? fields.status : {};
  const assigneeRecord = isRecord(fields.assignee) ? fields.assignee : {};
  const key =
    stringField(issue, "key") ?? stringField(issue, "identifier") ?? stringField(issue, "id");
  if (!key) throw new Error("jira issue key is required");
  const id = stringField(issue, "id") ?? key;
  const state = stringField(status, "name") ?? stringField(fields, "status") ?? "";
  const rawStateType =
    stateTypeFromJiraStatus(status) ?? defaultStateType(state) ?? normalizeFallbackStateType(state);

  return normalizeIssue(
    {
      id,
      identifier: key,
      title: stringField(fields, "summary") ?? stringField(issue, "title") ?? key,
      description: jiraDescriptionToText(fields.description),
      state,
      state_type: rawStateType,
      labels: Array.isArray(fields.labels) ? fields.labels : [],
      blockers: jiraBlockers(fields.issuelinks),
      assignee_id: stringField(assigneeRecord, "accountId") ?? stringField(assigneeRecord, "name"),
      priority: jiraPriority(fields.priority),
      created_at: stringField(fields, "created") ?? stringField(issue, "createdAt"),
      updated_at: stringField(fields, "updated") ?? stringField(issue, "updatedAt"),
      url: baseUrl
        ? `${baseUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`
        : stringField(issue, "url"),
    },
    assignee,
  );
}

function issuesFromPayload(
  payload: unknown,
  assignee: string | undefined,
  baseUrl: string | null,
): Issue[] {
  const rawIssues = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.issues)
      ? payload.issues
      : isRecord(payload) && Array.isArray(payload.rows)
        ? payload.rows
        : isRecord(payload) && isRecord(payload.data) && Array.isArray(payload.data.issues)
          ? payload.data.issues
          : [];
  return rawIssues.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    try {
      return [
        isRecord(raw.fields) || raw.key
          ? normalizeJiraIssue(raw, assignee, baseUrl)
          : normalizeIssue(raw, assignee),
      ];
    } catch {
      return [];
    }
  });
}

function firstIssueFromPayload(
  payload: unknown,
  assignee: string | undefined,
  baseUrl: string | null,
): Issue | null {
  if (isRecord(payload) && isRecord(payload.issue)) {
    return isRecord(payload.issue.fields) || payload.issue.key
      ? normalizeJiraIssue(payload.issue, assignee, baseUrl)
      : normalizeIssue(payload.issue, assignee);
  }
  if (isRecord(payload) && (isRecord(payload.fields) || payload.key)) {
    return normalizeJiraIssue(payload, assignee, baseUrl);
  }
  if (isRecord(payload)) {
    try {
      return normalizeIssue(payload, assignee);
    } catch {
      // Fall through to list-shaped payloads.
    }
  }
  return issuesFromPayload(payload, assignee, baseUrl)[0] ?? null;
}

function mcpResultPayload(body: unknown): unknown {
  if (!isRecord(body) || !isRecord(body.result)) return body;
  const result = body.result;
  if (Array.isArray(result.content)) {
    const text = result.content
      .flatMap((entry) => (isRecord(entry) && typeof entry.text === "string" ? [entry.text] : []))
      .join("\n")
      .trim();
    if (text !== "") {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    }
  }
  return result;
}

function mcpToolPayloadError(payload: unknown): string | null {
  if (typeof payload === "string") {
    const text = payload.trim();
    if (/^(error|failed|failure)\b/i.test(text)) return text;
    return null;
  }
  if (!isRecord(payload)) return null;
  const success = payload.success;
  if (success === false) {
    return (
      stringField(payload, "error") ?? stringField(payload, "message") ?? summarizeBody(payload)
    );
  }
  if (typeof payload.error === "string") return payload.error;
  if (isRecord(payload.error))
    return stringField(payload.error, "message") ?? summarizeBody(payload.error);
  return null;
}

function stateTypeFromJiraStatus(status: Record<string, unknown>): IssueStateType | null {
  const category = isRecord(status.statusCategory) ? status.statusCategory : {};
  const key = stringField(category, "key")?.trim().toLowerCase();
  if (key === "new") return "unstarted";
  if (key === "indeterminate") return "started";
  if (key === "done") return "completed";
  return null;
}

function normalizeFallbackStateType(state: string): IssueStateType {
  const normalized = state.trim().toLowerCase();
  if (normalized.includes("cancel")) return "canceled";
  if (
    normalized.includes("done") ||
    normalized.includes("closed") ||
    normalized.includes("resolved")
  ) {
    return "completed";
  }
  if (normalized.includes("backlog")) return "backlog";
  if (normalized.includes("triage")) return "triage";
  if (normalized.includes("todo") || normalized.includes("open")) return "unstarted";
  return "started";
}

function jiraBlockers(value: unknown): IssueRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((link) => {
    if (!isRecord(link) || !isRecord(link.type)) return [];
    const name = stringField(link.type, "name")?.toLowerCase() ?? "";
    const inward = stringField(link.type, "inward")?.toLowerCase() ?? "";
    if (!name.includes("block") && !inward.includes("block")) return [];
    const blocker = link.inwardIssue;
    if (!isRecord(blocker)) return [];
    const fields = isRecord(blocker.fields) ? blocker.fields : {};
    const status = isRecord(fields.status) ? fields.status : {};
    return [
      {
        id: stringField(blocker, "id") ?? undefined,
        identifier: stringField(blocker, "key") ?? undefined,
        state: stringField(status, "name") ?? undefined,
        stateType: stateTypeFromJiraStatus(status) ?? null,
      },
    ];
  });
}

function jiraPriority(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const name = stringField(value, "name")?.trim().toLowerCase();
  if (name === "highest" || name === "high") return 1;
  if (name === "medium") return 2;
  if (name === "low") return 3;
  if (name === "lowest") return 4;
  return null;
}

function jiraDescriptionToText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value) return null;
  const text = adfToText(value).trim();
  return text === "" ? null : text;
}

function adfToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  const children = Array.isArray(value.content) ? value.content.map(adfToText).filter(Boolean) : [];
  const separator = value.type === "paragraph" || value.type === "listItem" ? " " : "\n";
  return children.join(separator);
}

function adfDocument(text: string): Record<string, unknown> {
  return {
    type: "doc",
    version: 1,
    content: text.split(/\r?\n/).map((line) => ({
      type: "paragraph",
      content: line === "" ? [] : [{ type: "text", text: line }],
    })),
  };
}

function normalizeStateNames(stateNames: unknown[]): string[] {
  return [...new Set(stateNames.map((stateName) => String(stateName)))];
}

function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function stringField(record: unknown, key: string): string | null {
  if (!isRecord(record)) return null;
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`jira_invalid_json: ${errorMessage(error)}`, { cause: error });
  }
}

function summarizeBody(body: unknown): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > 500 ? `${text.slice(0, 500)}...<truncated>` : text;
}
