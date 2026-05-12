import { normalizeIssue } from "./issue.js";
import type { Issue, Settings } from "./types.js";

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
  labels { nodes { name } }
  inverseRelations(first: 50) {
    nodes {
      type
      issue {
        id
        identifier
        state { name type }
      }
    }
  }
  createdAt
  updatedAt
`;

export interface LinearViewer {
  id: string;
  name?: string;
  email?: string;
}

export interface LinearState {
  id: string;
  name: string;
  type: string;
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

export interface LinearRetryOptions {
  maxRetries?: number | undefined;
  baseDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  sleep?: ((delayMs: number) => Promise<void>) | undefined;
  now?: (() => Date) | undefined;
}

interface ResolvedLinearRetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (delayMs: number) => Promise<void>;
  now: () => Date;
}

export class LinearClient {
  private readonly retryOptions: ResolvedLinearRetryOptions;
  private resolvedAssignee?: Promise<string | undefined> | undefined;

  constructor(
    private settings: Settings,
    private fetchImpl: typeof fetch = fetch,
    retryOptions: LinearRetryOptions = {},
  ) {
    this.retryOptions = {
      maxRetries: retryOptions.maxRetries ?? 4,
      baseDelayMs: retryOptions.baseDelayMs ?? 1_000,
      maxDelayMs: retryOptions.maxDelayMs ?? 30_000,
      sleep: retryOptions.sleep ?? sleep,
      now: retryOptions.now ?? (() => new Date()),
    };
  }

  async graphql<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (!this.settings.tracker.apiKey) throw new Error("missing Linear API key");

    const response = await this.fetchWithRateLimitRetry(query, variables);
    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch (error) {
      if (!response.ok) throw new Error(`linear api status ${response.status}`, { cause: error });
      throw new Error(`linear_invalid_json: ${errorMessage(error)}`, { cause: error });
    }
    if (response.status === 429) throw new Error("linear api status 429");
    if (isRecord(body) && Array.isArray(body.errors) && body.errors.length > 0) {
      throw new Error(`linear_graphql_errors: ${JSON.stringify(body.errors)}`);
    }
    if (!response.ok) throw new Error(`linear api status ${response.status}`);
    if (!isRecord(body) || !isRecord(body.data)) throw new Error("linear_unknown_payload");
    return body.data as T;
  }

  private async fetchWithRateLimitRetry(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Response> {
    for (let retryCount = 0; ; retryCount += 1) {
      const response = await this.fetchImpl(this.settings.tracker.endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "content-type": "application/json",
          authorization: this.settings.tracker.apiKey ?? "",
        },
        body: JSON.stringify({ query, variables }),
      });
      if (response.status !== 429 || retryCount >= this.retryOptions.maxRetries) return response;
      await this.retryOptions.sleep(retryDelayMs(response.headers, this.retryOptions, retryCount));
    }
  }

  async viewer(): Promise<LinearViewer> {
    const data = await this.graphql<{ viewer: LinearViewer }>(
      `query SymphonyTsViewer { viewer { id name email } }`,
    );
    return data.viewer;
  }

  async projectBySlug(projectSlug = this.requiredProjectSlug()): Promise<LinearProject> {
    const data = await this.graphql<{
      projects: { nodes: Array<Record<string, unknown>> };
    }>(
      `query SymphonyTsProject($slug: String!) {
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
                states(first: 50) { nodes { id name type } }
              }
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
    let after: string | null = null;
    const issues: Issue[] = [];
    const assignee = await this.assigneeFilterValue();

    for (;;) {
      const data: {
        issues: {
          nodes: Array<Record<string, unknown>>;
          pageInfo: { hasNextPage: boolean; endCursor?: string | null };
        };
      } = await this.graphql(
        `query SymphonyTsPoll($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $after: String) {
          issues(filter: {project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
            nodes { ${issueFields} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        {
          projectSlug: this.requiredProjectSlug(),
          stateNames,
          first: 50,
          after,
        },
      );

      issues.push(
        ...data.issues.nodes.map((issue) => normalizeIssue(linearIssuePayload(issue), assignee)),
      );
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
      const data = await this.graphql<{
        issues: { nodes: Array<Record<string, unknown>> };
      }>(
        `query SymphonyTsIssuesById($ids: [ID!]!, $first: Int!) {
          issues(filter: {id: {in: $ids}}, first: $first) {
            nodes { ${issueFields} }
          }
        }`,
        { ids: batchIds, first: batchIds.length },
      );
      issues.push(
        ...data.issues.nodes.map((issue) => normalizeIssue(linearIssuePayload(issue), assignee)),
      );
    }

    return issues.sort((left, right) => {
      const leftIndex = issueOrder.get(left.id) ?? issueOrder.size;
      const rightIndex = issueOrder.get(right.id) ?? issueOrder.size;
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
  }): Promise<Issue> {
    const data = await this.graphql<{
      issueCreate: { success: boolean; issue: Record<string, unknown> | null };
    }>(
      `mutation SymphonyTsCreateIssue($input: IssueCreateInput!) {
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
      `mutation SymphonyTsUpdateIssue($id: String!, $input: IssueUpdateInput!) {
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
      `mutation SymphonyTsArchiveIssue($id: String!) {
        issueArchive(id: $id) {
          success
        }
      }`,
      { id: issueId },
    );
    if (!data.issueArchive.success) throw new Error("linear issueArchive failed");
  }

  private requiredProjectSlug(): string {
    if (!this.settings.tracker.projectSlug) throw new Error("tracker.project_slug is required");
    return this.settings.tracker.projectSlug;
  }

  private assigneeFilterValue(): Promise<string | undefined> {
    if (!this.resolvedAssignee) {
      this.resolvedAssignee = this.resolveAssigneeFilterValue();
    }
    return this.resolvedAssignee;
  }

  private async resolveAssigneeFilterValue(): Promise<string | undefined> {
    const assignee = this.settings.tracker.assignee;
    if (!assignee || assignee.trim() === "") return undefined;
    if (assignee.trim().toLowerCase() !== "me") return assignee;
    return (await this.viewer()).id;
  }
}

function linearIssuePayload(issue: Record<string, unknown>): Record<string, unknown> {
  return {
    ...issue,
    state: issue.state,
    state_type: isRecord(issue.state) ? issue.state.type : null,
    branch_name: issue.branchName,
    assignee_id: isRecord(issue.assignee) ? issue.assignee.id : null,
    labels: isConnection(issue.labels) ? issue.labels.nodes : [],
    relations: isConnection(issue.inverseRelations) ? issue.inverseRelations.nodes : [],
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function parseProject(project: Record<string, unknown>): LinearProject {
  const teams = isConnection(project.teams) ? project.teams.nodes : [];
  return {
    id: stringField(project, "id"),
    name: stringField(project, "name"),
    slugId: stringField(project, "slugId"),
    teams: teams.map((team) => {
      const teamRecord = asRecord(team);
      const states = isConnection(teamRecord.states) ? teamRecord.states.nodes : [];
      return {
        id: stringField(teamRecord, "id"),
        key: stringField(teamRecord, "key"),
        name: stringField(teamRecord, "name"),
        states: states.map((state) => {
          const stateRecord = asRecord(state);
          return {
            id: stringField(stateRecord, "id"),
            name: stringField(stateRecord, "name"),
            type: stringField(stateRecord, "type"),
          };
        }),
      };
    }),
  };
}

function isConnection(value: unknown): value is { nodes: unknown[] } {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
