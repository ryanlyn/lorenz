import { LinearGraphQLClient } from "@linear/sdk";
export { LinearGraphQLClient } from "@linear/sdk";
import { normalizeIssue } from "@lorenz/issue";
import { createTrackerPaginationGuard, type TrackerPaginationLimits } from "@lorenz/tracker-sdk";
import {
  errorMessage,
  isRecord,
  normalizeStateType,
  redactDiagnosticText,
  type Issue,
  type IssueStateType,
  type Settings,
} from "@lorenz/domain";

import { linearErrorContext } from "./diagnostics.js";
import { linearEndpoint, linearTrackerOptions } from "./options.js";

const LINEAR_REQUEST_TIMEOUT_MS = 30_000;
const LINEAR_CONNECTION_PAGE_SIZE = 50;

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

export interface LinearDegradedConnection {
  source: string;
  connection: string;
  reason: string;
  cursor?: string | null | undefined;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
  states: LinearState[];
  degradedConnections?: LinearDegradedConnection[] | undefined;
}

export interface LinearProject {
  id: string;
  name: string;
  slugId: string;
  teams: LinearTeam[];
  degradedConnections?: LinearDegradedConnection[] | undefined;
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

interface CompleteConnectionResult {
  nodes: unknown[];
  degradedConnections: LinearDegradedConnection[];
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
  paginationLimits?: TrackerPaginationLimits | undefined;
}

export class LinearClient {
  private readonly retryOptions: ResolvedLinearRetryOptions;
  private resolvedAssignee?: Promise<string | undefined> | undefined;
  private resolvedProjectSlugs?: Promise<string[]> | undefined;
  private readonly gqlClient: LinearGraphQLClient | null;
  private readonly settings: Settings;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly logger: LinearClientLogger;
  private readonly paginationLimits: TrackerPaginationLimits | undefined;

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
    this.paginationLimits = deps.paginationLimits;

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
        // eslint-disable-next-line preserve-caught-error -- Secret-boundary rethrows must not retain provider error objects.
        throw new Error(`linear api status ${response.status}`);
      }
      // eslint-disable-next-line preserve-caught-error -- Secret-boundary rethrows must not retain provider error objects.
      throw new Error(`linear_invalid_json: ${redactDiagnosticText(errorMessage(error))}`);
    }
    if (response.status === 429) {
      this.logStatusError(query, response.status, body);
      throw new Error("linear api status 429");
    }
    if (isRecord(body) && Array.isArray(body.errors) && body.errors.length > 0) {
      this.logStatusError(query, response.status, body);
      throw new Error(
        `linear_graphql_errors: ${redactDiagnosticText(JSON.stringify(body.errors))}`,
      );
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
        // eslint-disable-next-line preserve-caught-error -- Secret-boundary rethrows must not retain provider error objects.
        throw new Error(redactDiagnosticText(errorMessage(error)));
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
    return this.parseProject(project);
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
    const pagination = createTrackerPaginationGuard({
      tracker: "linear",
      resource: "issues",
      limits: this.paginationLimits,
    });

    for (;;) {
      pagination.recordPage();
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

      pagination.recordItems(data.issues.nodes.length);
      await this.appendNormalizedIssues(issues, data.issues.nodes, assignee);
      if (!data.issues.pageInfo.hasNextPage) return issues;
      after = pagination.nextCursor(data.issues.pageInfo.endCursor, "endCursor");
    }
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];
    createTrackerPaginationGuard({
      tracker: "linear",
      resource: "issuesByIds",
      limits: this.paginationLimits,
    }).recordItems(uniqueIds.length);
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
        await this.appendNormalizedIssues(issues, data.issues.nodes, assignee);
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
        if (data.issue) await this.appendNormalizedIssues(issues, [data.issue], assignee);
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
    const normalized = await this.normalizeLinearIssue(
      data.issueCreate.issue,
      await this.assigneeFilterValue(),
    );
    if (!normalized) throw new Error("linear issueCreate returned malformed issue");
    return normalized;
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
    const normalized = await this.normalizeLinearIssue(
      data.issueUpdate.issue,
      await this.assigneeFilterValue(),
    );
    if (!normalized) throw new Error("linear issueUpdate returned malformed issue");
    return normalized;
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
    const pagination = createTrackerPaginationGuard({
      tracker: "linear",
      resource: "projectsByLabels",
      limits: this.paginationLimits,
    });
    for (;;) {
      pagination.recordPage();
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
      pagination.recordItems(data.projects.nodes.length);
      slugs.push(...data.projects.nodes.map((p) => p.slugId));
      if (!data.projects.pageInfo?.hasNextPage) break;
      after = pagination.nextCursor(data.projects.pageInfo.endCursor, "endCursor");
    }
    if (slugs.length === 0)
      throw new Error(`no linear projects found for labels: ${labels.join(", ")}`);
    return slugs;
  }

  private async appendNormalizedIssues(
    target: Issue[],
    nodes: unknown[],
    assignee: string | undefined,
  ): Promise<void> {
    for (const issue of nodes) {
      const normalized = await this.normalizeLinearIssue(issue, assignee);
      if (normalized) target.push(normalized);
    }
  }

  private async normalizeLinearIssue(
    issue: unknown,
    assignee: string | undefined,
  ): Promise<Issue | null> {
    if (!isRecord(issue)) return null;
    try {
      return normalizeIssue(await this.linearIssuePayload(issue), assignee);
    } catch {
      return null;
    }
  }

  private async linearIssuePayload(
    issue: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const source = issueSource(issue);
    const issueId = stringField(issue, "id");
    const [labels, inverseRelations] = await Promise.all([
      this.completePagedConnection({
        source,
        connection: "issue.labels",
        initial: issue.labels,
        fetchPage: async (after) => this.fetchIssueLabelsPage(issueId, after),
      }),
      this.completePagedConnection({
        source,
        connection: "issue.inverseRelations",
        initial: issue.inverseRelations,
        fetchPage: async (after) => this.fetchIssueInverseRelationsPage(issueId, after),
      }),
    ]);
    const degradedConnections = [
      ...labels.degradedConnections,
      ...inverseRelations.degradedConnections,
    ];
    if (degradedConnections.length > 0) this.logDegradedConnections(degradedConnections);

    return linearIssuePayload(
      {
        ...issue,
        labels: connectionFromNodes(labels.nodes),
        inverseRelations: connectionFromNodes(inverseRelations.nodes),
      },
      degradedConnections,
    );
  }

  private async fetchIssueLabelsPage(issueId: string, after: string): Promise<unknown> {
    const data = await this.graphql<{ issue: { labels: unknown } | null }>(
      `query LorenzTsIssueLabels($id: String!, $first: Int!, $after: String) {
        issue(id: $id) {
          labels(first: $first, after: $after) {
            nodes { name }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: issueId, first: LINEAR_CONNECTION_PAGE_SIZE, after },
    );
    if (!data.issue) throw new Error(`linear issue not found: ${issueId}`);
    return data.issue.labels;
  }

  private async fetchIssueInverseRelationsPage(issueId: string, after: string): Promise<unknown> {
    const data = await this.graphql<{ issue: { inverseRelations: unknown } | null }>(
      `query LorenzTsIssueInverseRelations($id: String!, $first: Int!, $after: String) {
        issue(id: $id) {
          inverseRelations(first: $first, after: $after) {
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
        }
      }`,
      { id: issueId, first: LINEAR_CONNECTION_PAGE_SIZE, after },
    );
    if (!data.issue) throw new Error(`linear issue not found: ${issueId}`);
    return data.issue.inverseRelations;
  }

  private async parseProject(project: Record<string, unknown>): Promise<LinearProject> {
    const id = stringField(project, "id");
    const name = stringField(project, "name");
    const slugId = stringField(project, "slugId");
    const teams = await this.completePagedConnection({
      source: projectSource(project),
      connection: "project.teams",
      initial: project.teams,
      fetchPage: async (after) => this.fetchProjectTeamsPage(id, after),
    });
    const parsedTeams = await Promise.all(
      teams.nodes.map(async (team) => this.parseTeam(asRecord(team))),
    );
    const degradedConnections = [
      ...teams.degradedConnections,
      ...parsedTeams.flatMap((team) => team.degradedConnections ?? []),
    ];
    if (degradedConnections.length > 0) this.logDegradedConnections(degradedConnections);
    return {
      id,
      name,
      slugId,
      teams: parsedTeams,
      ...(degradedConnections.length > 0 ? { degradedConnections } : {}),
    };
  }

  private async fetchProjectTeamsPage(projectId: string, after: string): Promise<unknown> {
    const data = await this.graphql<{ project: { teams: unknown } | null }>(
      `query LorenzTsProjectTeams($id: String!, $first: Int!, $after: String) {
        project(id: $id) {
          teams(first: $first, after: $after) {
            nodes {
              id
              key
              name
              states(first: $first) {
                nodes { id name type }
                pageInfo { hasNextPage endCursor }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: projectId, first: LINEAR_CONNECTION_PAGE_SIZE, after },
    );
    if (!data.project) throw new Error(`linear project not found: ${projectId}`);
    return data.project.teams;
  }

  private async parseTeam(team: Record<string, unknown>): Promise<LinearTeam> {
    const id = stringField(team, "id");
    const key = stringField(team, "key");
    const name = stringField(team, "name");
    const states = await this.completePagedConnection({
      source: teamSource(team),
      connection: "project.team.states",
      initial: team.states,
      fetchPage: async (after) => this.fetchTeamStatesPage(id, after),
    });
    const degradedConnections = states.degradedConnections;
    return {
      id,
      key,
      name,
      states: states.nodes.map((state) => {
        const stateRecord = asRecord(state);
        return {
          id: stringField(stateRecord, "id"),
          name: stringField(stateRecord, "name"),
          type: normalizeStateType(stringField(stateRecord, "type")),
        };
      }),
      ...(degradedConnections.length > 0 ? { degradedConnections } : {}),
    };
  }

  private async fetchTeamStatesPage(teamId: string, after: string): Promise<unknown> {
    const data = await this.graphql<{ team: { states: unknown } | null }>(
      `query LorenzTsTeamStates($id: String!, $first: Int!, $after: String) {
        team(id: $id) {
          states(first: $first, after: $after) {
            nodes { id name type }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: teamId, first: LINEAR_CONNECTION_PAGE_SIZE, after },
    );
    if (!data.team) throw new Error(`linear team not found: ${teamId}`);
    return data.team.states;
  }

  private async completePagedConnection(input: {
    source: string;
    connection: string;
    initial: unknown;
    fetchPage: (after: string) => Promise<unknown>;
  }): Promise<CompleteConnectionResult> {
    const pagination = createTrackerPaginationGuard({
      tracker: "linear",
      resource: input.connection,
      limits: this.paginationLimits,
    });
    const initial = connectionSnapshot(input.initial);
    const nodes = [...initial.nodes];
    try {
      pagination.recordPage();
      pagination.recordItems(initial.nodes.length);
    } catch (error) {
      return {
        nodes: [],
        degradedConnections: [degradedConnection(input, errorMessage(error))],
      };
    }
    if (!initial.pageInfo?.hasNextPage) return { nodes, degradedConnections: [] };

    let after: string;
    try {
      after = pagination.nextCursor(initial.pageInfo.endCursor, "endCursor");
    } catch (error) {
      return {
        nodes,
        degradedConnections: [
          degradedConnection(input, errorMessage(error), initial.pageInfo.endCursor),
        ],
      };
    }

    for (;;) {
      let page: unknown;
      try {
        pagination.recordPage();
        page = await input.fetchPage(after);
      } catch (error) {
        return {
          nodes,
          degradedConnections: [degradedConnection(input, errorMessage(error), after)],
        };
      }

      const next = connectionSnapshot(page);
      if (!next.isConnection) {
        return {
          nodes,
          degradedConnections: [
            degradedConnection(input, "linear_invalid_connection_payload", after),
          ],
        };
      }
      try {
        pagination.recordItems(next.nodes.length);
      } catch (error) {
        return {
          nodes,
          degradedConnections: [degradedConnection(input, errorMessage(error), after)],
        };
      }
      nodes.push(...next.nodes);
      if (!next.pageInfo?.hasNextPage) return { nodes, degradedConnections: [] };
      try {
        after = pagination.nextCursor(next.pageInfo.endCursor, "endCursor");
      } catch (error) {
        return {
          nodes,
          degradedConnections: [
            degradedConnection(input, errorMessage(error), next.pageInfo.endCursor),
          ],
        };
      }
    }
  }

  private logDegradedConnections(degradedConnections: LinearDegradedConnection[]): void {
    for (const degraded of degradedConnections) {
      this.logger.warn(
        `linear tracker degraded connection source=${degraded.source} connection=${degraded.connection} reason=${degraded.reason}${degraded.cursor ? ` cursor=${degraded.cursor}` : ""}`,
      );
    }
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
      `Linear GraphQL request failed: ${redactDiagnosticText(errorMessage(error))}${linearErrorContext(query)}`,
    );
  }
}

function resolveDeps(fetchImplOrDeps?: typeof fetch | LinearClientDeps): {
  fetchImpl: typeof fetch | undefined;
  graphqlClient: LinearGraphQLClient | undefined;
  logger: LinearClientLogger | undefined;
  paginationLimits: TrackerPaginationLimits | undefined;
} {
  if (!fetchImplOrDeps)
    return {
      fetchImpl: undefined,
      graphqlClient: undefined,
      logger: undefined,
      paginationLimits: undefined,
    };
  if (typeof fetchImplOrDeps === "function")
    return {
      fetchImpl: fetchImplOrDeps,
      graphqlClient: undefined,
      logger: undefined,
      paginationLimits: undefined,
    };
  return {
    fetchImpl: fetchImplOrDeps.fetchImpl ?? undefined,
    graphqlClient: fetchImplOrDeps.graphqlClient ?? undefined,
    logger: fetchImplOrDeps.logger ?? undefined,
    paginationLimits: fetchImplOrDeps.paginationLimits ?? undefined,
  };
}

function linearIssuePayload(
  issue: Record<string, unknown>,
  degradedConnections: LinearDegradedConnection[] = [],
): Record<string, unknown> {
  return {
    ...issue,
    state: issue.state,
    state_type: isRecord(issue.state) ? issue.state.type : null,
    branch_name: issue.branchName,
    assignee_id: isRecord(issue.assignee) ? issue.assignee.id : null,
    labels: connectionSnapshot(issue.labels).nodes,
    relations: connectionSnapshot(issue.inverseRelations).nodes,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    ...(degradedConnections.length > 0 ? { linear_degraded_connections: degradedConnections } : {}),
  };
}

function normalizeStateNames(stateNames: unknown[]): string[] {
  return [...new Set(stateNames.map((stateName) => String(stateName)))];
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
    const msg = redactDiagnosticText(error.message);
    const cause = redactedLinearCause(error);
    if (msg.includes("429")) return new Error("linear api status 429", { cause });
    if (msg.toLowerCase().includes("graphql")) {
      return new Error(`linear_graphql_errors: ${msg}`, { cause });
    }
    return new Error(msg, { cause });
  }
  return new Error(redactDiagnosticText(String(error)));
}

function redactedLinearCause(error: unknown): Error {
  return new Error(redactDiagnosticText(errorMessage(error)));
}

function isConnection(value: unknown): value is { nodes: unknown[]; pageInfo?: unknown } {
  return isRecord(value) && Array.isArray(value.nodes);
}

function connectionSnapshot(value: unknown): {
  nodes: unknown[];
  pageInfo: LinearPageInfo | null;
  isConnection: boolean;
} {
  if (!isConnection(value)) return { nodes: [], pageInfo: null, isConnection: false };
  return { nodes: value.nodes, pageInfo: connectionPageInfo(value.pageInfo), isConnection: true };
}

function connectionPageInfo(value: unknown): LinearPageInfo | null {
  if (!isRecord(value) || typeof value.hasNextPage !== "boolean") return null;
  return {
    hasNextPage: value.hasNextPage,
    endCursor:
      typeof value.endCursor === "string" || value.endCursor === null ? value.endCursor : null,
  };
}

function connectionFromNodes(nodes: unknown[]): { nodes: unknown[]; pageInfo: LinearPageInfo } {
  return { nodes, pageInfo: { hasNextPage: false, endCursor: null } };
}

function degradedConnection(
  input: { source: string; connection: string },
  reason: string,
  cursor?: string | null,
): LinearDegradedConnection {
  return {
    source: input.source,
    connection: input.connection,
    reason,
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

function issueSource(issue: Record<string, unknown>): string {
  const identifier = typeof issue.identifier === "string" ? issue.identifier : "unknown";
  const id = typeof issue.id === "string" ? issue.id : "unknown";
  return `issue ${identifier} (${id})`;
}

function projectSource(project: Record<string, unknown>): string {
  const slug = typeof project.slugId === "string" ? project.slugId : "unknown";
  const id = typeof project.id === "string" ? project.id : "unknown";
  return `project ${slug} (${id})`;
}

function teamSource(team: Record<string, unknown>): string {
  const key = typeof team.key === "string" ? team.key : "unknown";
  const id = typeof team.id === "string" ? team.id : "unknown";
  return `team ${key} (${id})`;
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
