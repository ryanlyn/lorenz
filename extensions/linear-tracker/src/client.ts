import { LinearGraphQLClient } from "@linear/sdk";
export { LinearGraphQLClient } from "@linear/sdk";
import { normalizeIssue } from "@lorenz/issue";
import {
  errorMessage,
  isRecord,
  normalizeStateType,
  type Issue,
  type IssueStateType,
  type Settings,
} from "@lorenz/domain";

import { linearEndpoint, linearTrackerOptions } from "./options.js";

const LINEAR_REQUEST_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY_LOG_BYTES = 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const issueFields = `
  id
  identifier
  title
  description
  priority
  state { id name type }
  branchName
  url
  assignee { id }
  labels(first: 50) {
    nodes { name }
    pageInfo { hasNextPage endCursor }
  }
  inverseRelations(first: 50) {
    nodes {
      type
      issue {
        id
        identifier
        state { name type }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
  createdAt
  updatedAt
`;

interface LinearViewer {
  id: string;
  name?: string;
  email?: string;
}

export interface LinearState {
  id: string;
  name: string;
  type: IssueStateType | null;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
  states: LinearState[];
}

export interface LinearProject {
  id: string;
  name: string;
  slugId: string;
  teams: LinearTeam[];
}

interface LinearPageInfo {
  hasNextPage: boolean;
  endCursor?: string | null | undefined;
}

interface LinearRetryOptions {
  maxRetries?: number | undefined;
  baseDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
  sleep?: ((delayMs: number) => Promise<void>) | undefined;
  now?: (() => Date) | undefined;
}

interface ResolvedLinearRetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  requestTimeoutMs: number;
  sleep: (delayMs: number) => Promise<void>;
  now: () => Date;
}

export interface LinearClientLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface LinearClientDeps {
  fetchImpl?: typeof fetch | undefined;
  graphqlClient?: LinearGraphQLClient | undefined;
  logger?: LinearClientLogger | undefined;
}

export class LinearClient {
  private readonly retryOptions: ResolvedLinearRetryOptions;
  private resolvedAssignee?: Promise<string | undefined> | undefined;
  private resolvedProjectSlugs?: Promise<string[]> | undefined;
  private readonly gqlClient: LinearGraphQLClient | null;
  private readonly settings: Settings;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly logger: LinearClientLogger;

  constructor(
    settings: Settings,
    fetchImplOrDeps?: typeof fetch | LinearClientDeps,
    retryOptions: LinearRetryOptions = {},
  ) {
    this.settings = settings;
    this.retryOptions = {
      maxRetries: retryOptions.maxRetries ?? 4,
      baseDelayMs: retryOptions.baseDelayMs ?? 1_000,
      maxDelayMs: retryOptions.maxDelayMs ?? 30_000,
      requestTimeoutMs: retryOptions.requestTimeoutMs ?? LINEAR_REQUEST_TIMEOUT_MS,
      sleep: retryOptions.sleep ?? defaultSleep,
      now: retryOptions.now ?? (() => new Date()),
    };

    const deps = resolveDeps(fetchImplOrDeps);
    this.fetchImpl = deps.fetchImpl;
    this.logger = deps.logger ?? {
      warn: (message) => console.warn(message),
      error: (message) => console.error(message),
    };

    if (deps.graphqlClient) {
      this.gqlClient = deps.graphqlClient;
    } else if (settings.tracker.apiKey && !deps.fetchImpl) {
      this.gqlClient = new LinearGraphQLClient(linearEndpoint(settings), {
        headers: { authorization: settings.tracker.apiKey },
      });
    } else {
      this.gqlClient = null;
    }
  }

  async graphql<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (!this.settings.tracker.apiKey) throw new Error("missing Linear API key");

    if (this.gqlClient) {
      return this.graphqlWithSdkClient<T>(query, variables);
    }
    return this.graphqlWithFetch<T>(query, variables);
  }

  private async graphqlWithSdkClient<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    for (let retryCount = 0; ; retryCount += 1) {
      try {
        return await withTimeout(
          this.gqlClient!.request<T, Record<string, unknown>>(query, variables),
          this.retryOptions.requestTimeoutMs,
        );
      } catch (error: unknown) {
        if (isRateLimitError(error) && retryCount < this.retryOptions.maxRetries) {
          const delayMs = retryDelayFromError(error, this.retryOptions, retryCount);
          this.logRateLimitRetry(query, retryCount, delayMs, error);
          await this.retryOptions.sleep(delayMs);
          continue;
        }
        const classified = reclassifyError(error);
        this.logRequestError(query, classified);
        throw classified;
      }
    }
  }

  private async graphqlWithFetch<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetchWithRateLimitRetry(query, variables);
    const errorBodyText = !response.ok ? await safeResponseText(response) : null;
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (!response.ok) {
        this.logStatusError(query, response.status, errorBodyText ?? errorMessage(error));
        throw new Error(`linear api status ${response.status}`, { cause: error });
      }
      throw new Error(`linear_invalid_json: ${errorMessage(error)}`, { cause: error });
    }
    if (response.status === 429) {
      this.logStatusError(query, response.status, body);
      throw new Error("linear api status 429");
    }
    if (isRecord(body) && Array.isArray(body.errors) && body.errors.length > 0) {
      this.logStatusError(query, response.status, body);
      throw new Error(`linear_graphql_errors: ${JSON.stringify(body.errors)}`);
    }
    if (!response.ok) {
      this.logStatusError(query, response.status, body);
      throw new Error(`linear api status ${response.status}`);
    }
    if (!isRecord(body) || !isRecord(body.data)) {
      this.logStatusError(query, response.status, body);
      throw new Error("linear_unknown_payload");
    }
    return body.data as T;
  }

  private async fetchWithRateLimitRetry(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Response> {
    for (let retryCount = 0; ; retryCount += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl!(linearEndpoint(this.settings), {
          method: "POST",
          signal: AbortSignal.timeout(this.retryOptions.requestTimeoutMs),
          headers: {
            "content-type": "application/json",
            authorization: this.settings.tracker.apiKey ?? "",
          },
          body: JSON.stringify({ query, variables }),
        });
      } catch (error: unknown) {
        this.logRequestError(query, error);
        throw error;
      }
      if (response.status !== 429 || retryCount >= this.retryOptions.maxRetries) return response;
      const delayMs = retryDelayMs(response.headers, this.retryOptions, retryCount);
      this.logRateLimitRetry(query, retryCount, delayMs, await safeResponseText(response));
      await this.retryOptions.sleep(delayMs);
    }
  }

  async viewer(): Promise<LinearViewer> {
    const data = await this.graphql<{ viewer: LinearViewer }>(
      `query LorenzTsViewer { viewer { id name email } }`,
    );
    return data.viewer;
  }

  async projectBySlug(projectSlug = this.requiredProjectSlug()): Promise<LinearProject> {
    const data = await this.graphql<{
      projects: { nodes: Array<Record<string, unknown>> };
    }>(
      `query LorenzTsProject($slug: String!) {
        projects(filter: {slugId: {eq: $slug}}, first: 1) {
          nodes {
            id
            name
            slugId
            teams(first: 10) {
              nodes {
                id
                key
                name
                states(first: 50) {
                  nodes { id name type }
                  pageInfo { hasNextPage endCursor }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      { slug: projectSlug },
    );
    const project = data.projects.nodes[0];
    if (!project) throw new Error(`linear project not found: ${projectSlug}`);
    return parseProject(project);
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.fetchIssuesByStates(this.settings.tracker.activeStates);
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    const normalizedStateNames = normalizeStateNames(stateNames);
    if (normalizedStateNames.length === 0) return [];

    let after: string | null = null;
    const issues: Issue[] = [];
    const assignee = await this.assigneeFilterValue();
    const projectSlugs = await this.resolveProjectSlugs();

    for (;;) {
      const data: {
        issues: {
          nodes: Array<Record<string, unknown>>;
          pageInfo: { hasNextPage: boolean; endCursor?: string | null };
        };
      } = await this.graphql(
        `query LorenzTsPoll($projectSlugs: [String!]!, $stateNames: [String!]!, $first: Int!, $after: String) {
          issues(filter: {project: {slugId: {in: $projectSlugs}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
            nodes { ${issueFields} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        {
          projectSlugs,
          stateNames: normalizedStateNames,
          first: 50,
          after,
        },
      );

      appendNormalizedIssues(issues, data.issues.nodes, assignee);
      if (!data.issues.pageInfo.hasNextPage) return issues;
      if (!data.issues.pageInfo.endCursor) throw new Error("linear_missing_end_cursor");
      after = data.issues.pageInfo.endCursor;
    }
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];
    const assignee = await this.assigneeFilterValue();

    const issueOrder = new Map(uniqueIds.map((id, index) => [id, index]));
    const issues: Issue[] = [];
    for (let index = 0; index < uniqueIds.length; index += 50) {
      const batchIds = uniqueIds.slice(index, index + 50);
      try {
        const data = await this.graphql<{
          issues: { nodes: Array<Record<string, unknown>> };
        }>(
          `query LorenzTsIssuesById($ids: [ID!]!, $first: Int!) {
            issues(filter: {id: {in: $ids}}, first: $first) {
              nodes { ${issueFields} }
            }
          }`,
          { ids: batchIds, first: batchIds.length },
        );
        appendNormalizedIssues(issues, data.issues.nodes, assignee);
      } catch (error) {
        // Identifier-shaped inputs ("MT-32" from workspace directory names) can make
        // the id filter reject the whole batch; those resolve via the fallback below.
        // A batch of well-formed ids failing is a real error and must surface.
        if (batchIds.every((id) => UUID_PATTERN.test(id))) throw error;
      }
    }

    // Workspace cleanup passes issue identifiers (directory names), which the id filter
    // cannot match. Resolve whatever the bulk lookup missed through the singular
    // issue(id:) query, which accepts identifiers; unknown names (stray directories,
    // deleted issues) are skipped rather than failing the lookup.
    const found = new Set(issues.flatMap((issue) => [issue.id, issue.identifier]));
    for (const id of uniqueIds) {
      if (found.has(id) || UUID_PATTERN.test(id)) continue;
      try {
        const data = await this.graphql<{ issue: Record<string, unknown> | null }>(
          `query LorenzTsIssueByIdentifier($id: String!) {
            issue(id: $id) {
              ${issueFields}
            }
          }`,
          { id },
        );
        if (data.issue) appendNormalizedIssues(issues, [data.issue], assignee);
      } catch {
        // Best-effort identifier resolution.
      }
    }

    return issues.sort((left, right) => {
      const leftIndex =
        issueOrder.get(left.id) ?? issueOrder.get(left.identifier) ?? issueOrder.size;
      const rightIndex =
        issueOrder.get(right.id) ?? issueOrder.get(right.identifier) ?? issueOrder.size;
      return leftIndex - rightIndex;
    });
  }

  async createIssue(input: {
    teamId: string;
    projectId: string;
    stateId: string;
    title: string;
    description: string;
    assigneeId?: string;
    priority?: number;
  }): Promise<Issue> {
    const data = await this.graphql<{
      issueCreate: { success: boolean; issue: Record<string, unknown> | null };
    }>(
      `mutation LorenzTsCreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { ${issueFields} }
        }
      }`,
      {
        input: {
          teamId: input.teamId,
          projectId: input.projectId,
          stateId: input.stateId,
          title: input.title,
          description: input.description,
          assigneeId: input.assigneeId,
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
        },
      },
    );
    if (!data.issueCreate.success || !data.issueCreate.issue)
      throw new Error("linear issueCreate failed");
    return normalizeIssue(
      linearIssuePayload(data.issueCreate.issue),
      await this.assigneeFilterValue(),
    );
  }

  async updateIssueState(issueId: string, stateId: string): Promise<Issue> {
    const data = await this.graphql<{
      issueUpdate: { success: boolean; issue: Record<string, unknown> | null };
    }>(
      `mutation LorenzTsUpdateIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue { ${issueFields} }
        }
      }`,
      { id: issueId, input: { stateId } },
    );
    if (!data.issueUpdate.success || !data.issueUpdate.issue)
      throw new Error("linear issueUpdate failed");
    return normalizeIssue(
      linearIssuePayload(data.issueUpdate.issue),
      await this.assigneeFilterValue(),
    );
  }

  async archiveIssue(issueId: string): Promise<void> {
    const data = await this.graphql<{
      issueArchive: { success: boolean };
    }>(
      `mutation LorenzTsArchiveIssue($id: String!) {
        issueArchive(id: $id) {
          success
        }
      }`,
      { id: issueId },
    );
    if (!data.issueArchive.success) throw new Error("linear issueArchive failed");
  }

  async resolveProjectSlugs(): Promise<string[]> {
    if (this.resolvedProjectSlugs) return this.resolvedProjectSlugs;

    const resolution = this.doResolveProjectSlugs();
    this.resolvedProjectSlugs = resolution;
    try {
      return await resolution;
    } catch (error: unknown) {
      if (this.resolvedProjectSlugs === resolution) this.resolvedProjectSlugs = undefined;
      throw error;
    }
  }

  private async doResolveProjectSlugs(): Promise<string[]> {
    const { projectSlug, projectSlugs, projectLabels } = linearTrackerOptions(this.settings);
    if (projectSlugs && projectSlugs.length > 0) return projectSlugs;
    if (projectLabels && projectLabels.length > 0)
      return this.resolveProjectSlugsByLabels(projectLabels);
    if (projectSlug) return [projectSlug];
    throw new Error(
      "tracker.project_slug, tracker.project_slugs, or tracker.project_labels is required",
    );
  }

  private async resolveProjectSlugsByLabels(labels: string[]): Promise<string[]> {
    let after: string | null = null;
    const slugs: string[] = [];
    for (;;) {
      const data: {
        projects: {
          nodes: Array<{ slugId: string }>;
          pageInfo?: LinearPageInfo | undefined;
        };
      } = await this.graphql(
        `query LorenzTsProjectsByLabels($labels: [String!]!, $first: Int!, $after: String) {
          projects(filter: {labels: {name: {in: $labels}}}, first: $first, after: $after) {
            nodes { slugId }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { labels, first: 100, after },
      );
      slugs.push(...data.projects.nodes.map((p) => p.slugId));
      if (!data.projects.pageInfo?.hasNextPage) break;
      if (!data.projects.pageInfo.endCursor)
        throw new Error("linear_missing_end_cursor: projectsByLabels");
      after = data.projects.pageInfo.endCursor;
    }
    if (slugs.length === 0)
      throw new Error(`no linear projects found for labels: ${labels.join(", ")}`);
    return slugs;
  }

  private requiredProjectSlug(): string {
    const { projectSlug } = linearTrackerOptions(this.settings);
    if (!projectSlug) throw new Error("tracker.project_slug is required");
    return projectSlug;
  }

  private async assigneeFilterValue(): Promise<string | undefined> {
    if (this.resolvedAssignee) return this.resolvedAssignee;

    const resolution = this.resolveAssigneeFilterValue();
    this.resolvedAssignee = resolution;
    try {
      return await resolution;
    } catch (error: unknown) {
      if (this.resolvedAssignee === resolution) this.resolvedAssignee = undefined;
      throw error;
    }
  }

  private async resolveAssigneeFilterValue(): Promise<string | undefined> {
    const assignee = this.settings.tracker.assignee;
    if (!assignee || assignee.trim() === "") return undefined;
    if (assignee.trim().toLowerCase() !== "me") return assignee;
    return (await this.viewer()).id;
  }

  private logRateLimitRetry(
    query: string,
    retryCount: number,
    delayMs: number,
    body: unknown,
  ): void {
    this.logger.warn(
      `Linear GraphQL request rate limited status=429 retry=${retryCount + 1}/${this.retryOptions.maxRetries} delay_ms=${delayMs}${linearErrorContext(query, body)}`,
    );
  }

  private logStatusError(query: string, status: number, body: unknown): void {
    this.logger.error(
      `Linear GraphQL request failed status=${status}${linearErrorContext(query, body)}`,
    );
  }

  private logRequestError(query: string, error: unknown): void {
    this.logger.error(
      `Linear GraphQL request failed: ${errorMessage(error)}${linearErrorContext(query)}`,
    );
  }
}

function resolveDeps(fetchImplOrDeps?: typeof fetch | LinearClientDeps): {
  fetchImpl: typeof fetch | undefined;
  graphqlClient: LinearGraphQLClient | undefined;
  logger: LinearClientLogger | undefined;
} {
  if (!fetchImplOrDeps)
    return { fetchImpl: undefined, graphqlClient: undefined, logger: undefined };
  if (typeof fetchImplOrDeps === "function")
    return { fetchImpl: fetchImplOrDeps, graphqlClient: undefined, logger: undefined };
  return {
    fetchImpl: fetchImplOrDeps.fetchImpl ?? undefined,
    graphqlClient: fetchImplOrDeps.graphqlClient ?? undefined,
    logger: fetchImplOrDeps.logger ?? undefined,
  };
}

function linearIssuePayload(issue: Record<string, unknown>): Record<string, unknown> {
  return {
    ...issue,
    state: issue.state,
    state_type: isRecord(issue.state) ? issue.state.type : null,
    branch_name: issue.branchName,
    assignee_id: isRecord(issue.assignee) ? issue.assignee.id : null,
    labels: nodesFromConnection(issue.labels, "issue.labels"),
    relations: nodesFromConnection(issue.inverseRelations, "issue.inverseRelations"),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function appendNormalizedIssues(
  target: Issue[],
  nodes: unknown[],
  assignee: string | undefined,
): void {
  for (const issue of nodes) {
    const normalized = normalizeLinearIssue(issue, assignee);
    if (normalized) target.push(normalized);
  }
}

function normalizeLinearIssue(issue: unknown, assignee: string | undefined): Issue | null {
  if (!isRecord(issue)) return null;
  try {
    return normalizeIssue(linearIssuePayload(issue), assignee);
  } catch (error) {
    if (isLinearConnectionTruncatedError(error)) throw error;
    return null;
  }
}

function normalizeStateNames(stateNames: unknown[]): string[] {
  return [...new Set(stateNames.map((stateName) => String(stateName)))];
}

function parseProject(project: Record<string, unknown>): LinearProject {
  const teams = nodesFromConnection(project.teams, "project.teams");
  return {
    id: stringField(project, "id"),
    name: stringField(project, "name"),
    slugId: stringField(project, "slugId"),
    teams: teams.map((team) => {
      const teamRecord = asRecord(team);
      const states = nodesFromConnection(teamRecord.states, "project.team.states");
      return {
        id: stringField(teamRecord, "id"),
        key: stringField(teamRecord, "key"),
        name: stringField(teamRecord, "name"),
        states: states.map((state) => {
          const stateRecord = asRecord(state);
          return {
            id: stringField(stateRecord, "id"),
            name: stringField(stateRecord, "name"),
            type: normalizeStateType(stringField(stateRecord, "type")),
          };
        }),
      };
    }),
  };
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as Record<string, unknown>;
  const msg = "message" in error ? String(err.message) : "";
  if (msg.includes("429") || msg.toLowerCase().includes("rate limit")) return true;
  if ("status" in error && err.status === 429) return true;
  if ("response" in error) {
    const resp = err.response;
    if (isRecord(resp) && resp.status === 429) return true;
  }
  return false;
}

function retryDelayFromError(
  error: unknown,
  options: ResolvedLinearRetryOptions,
  retryCount: number,
): number {
  return (
    parseRetryAfterMs(retryAfterHeaderValueFromError(error), options.now) ??
    exponentialRetryDelayMs(options, retryCount)
  );
}

function reclassifyError(error: unknown): Error {
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes("429")) return new Error("linear api status 429", { cause: error });
    if (msg.toLowerCase().includes("graphql")) {
      return new Error(`linear_graphql_errors: ${msg}`, { cause: error });
    }
    return error;
  }
  return new Error(String(error));
}

class LinearConnectionTruncatedError extends Error {
  constructor(connectionName: string) {
    super(`linear_truncated_connection: ${connectionName}`);
    this.name = "LinearConnectionTruncatedError";
  }
}

function isLinearConnectionTruncatedError(error: unknown): error is LinearConnectionTruncatedError {
  return error instanceof LinearConnectionTruncatedError;
}

function nodesFromConnection(value: unknown, connectionName: string): unknown[] {
  if (!isConnection(value)) return [];
  if (isRecord(value.pageInfo) && value.pageInfo.hasNextPage === true) {
    throw new LinearConnectionTruncatedError(connectionName);
  }
  return value.nodes;
}

function isConnection(value: unknown): value is { nodes: unknown[]; pageInfo?: unknown } {
  return isRecord(value) && Array.isArray(value.nodes);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`missing Linear field: ${key}`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected Linear object");
  return value;
}

function linearErrorContext(query: string, body?: unknown): string {
  const parts: string[] = [];
  const operation = operationName(query);
  if (operation) parts.push(`operation=${operation}`);
  if (body !== undefined) parts.push(`body=${summarizeErrorBody(body)}`);
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

function operationName(query: string): string | null {
  return /\b(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query)?.[1] ?? null;
}

function summarizeErrorBody(body: unknown): string {
  const text = typeof body === "string" ? body : (JSON.stringify(body) ?? String(body));
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_ERROR_BODY_LOG_BYTES) return compact;
  return `${compact.slice(0, MAX_ERROR_BODY_LOG_BYTES)}...<truncated>`;
}

function retryAfterHeaderValueFromError(error: unknown): string | null {
  if (!isRecord(error)) return null;
  return headerValue(error.headers, "retry-after") ?? headerValue(error.response, "retry-after");
}

function headerValue(source: unknown, headerName: string): string | null {
  if (source instanceof Headers) return source.get(headerName);
  if (!isRecord(source)) return null;
  if (source.headers !== undefined) return headerValue(source.headers, headerName);
  for (const [key, value] of Object.entries(source)) {
    if (key.toLowerCase() !== headerName) continue;
    if (Array.isArray(value)) return headerString(value[0]);
    return headerString(value);
  }
  return null;
}

function headerString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`linear api timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.clone().text();
  } catch (error) {
    return errorMessage(error);
  }
}

function retryDelayMs(
  headers: Headers,
  options: ResolvedLinearRetryOptions,
  retryCount: number,
): number {
  return (
    parseRetryAfterMs(headers.get("retry-after"), options.now) ??
    exponentialRetryDelayMs(options, retryCount)
  );
}

function parseRetryAfterMs(retryAfter: string | null, now: () => Date): number | null {
  if (retryAfter === null) return null;
  const trimmed = retryAfter.trim();
  if (trimmed === "") return null;
  const seconds = Number(trimmed);
  if (Number.isInteger(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - now().getTime());
  return null;
}

function exponentialRetryDelayMs(options: ResolvedLinearRetryOptions, retryCount: number): number {
  if (options.baseDelayMs <= 0) return Math.max(options.maxDelayMs, 1);
  if (options.maxDelayMs <= 0) return options.baseDelayMs;
  return Math.min(options.baseDelayMs * 2 ** retryCount, options.maxDelayMs);
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
