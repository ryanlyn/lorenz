import { http, HttpResponse } from "msw";

interface FakeLinearState {
  id: string;
  name: string;
  type: string;
}

interface FakeLinearTeam {
  id: string;
  key: string;
  name: string;
  states: FakeLinearState[];
}

interface FakeLinearProject {
  id: string;
  name: string;
  slugId: string;
  teams: FakeLinearTeam[];
}

interface FakeLinearViewer {
  id: string;
  name: string;
  email: string;
}

interface FakeLinearConfig {
  viewer: FakeLinearViewer;
  project: FakeLinearProject;
}

interface FakeIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  state: { id: string; name: string; type: string };
  branchName: string;
  url: string;
  assignee: { id: string } | null;
  labels: { nodes: Array<{ name: string }> };
  inverseRelations: { nodes: never[] };
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export function createFakeLinearHandlers(config: FakeLinearConfig) {
  const issues: FakeIssue[] = [];
  let issueCounter = 0;

  function issuePayload(issue: FakeIssue) {
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      state: issue.state,
      branchName: issue.branchName,
      url: issue.url,
      assignee: issue.assignee,
      labels: issue.labels,
      inverseRelations: issue.inverseRelations,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    };
  }

  return [
    http.post("https://api.linear.app/graphql", async ({ request }) => {
      const body = (await request.json()) as { query: string; variables?: Record<string, unknown> };
      const { query, variables } = body;
      const operationName = extractOperationName(query);

      if (operationName === "SymphonyTsViewer") {
        return HttpResponse.json({
          data: { viewer: config.viewer },
        });
      }

      if (operationName === "SymphonyTsProject") {
        const slug = variables?.slug as string | undefined;
        if (slug !== config.project.slugId) {
          return HttpResponse.json({ data: { projects: { nodes: [] } } });
        }
        return HttpResponse.json({
          data: {
            projects: {
              nodes: [
                {
                  id: config.project.id,
                  name: config.project.name,
                  slugId: config.project.slugId,
                  teams: {
                    nodes: config.project.teams.map((team) => ({
                      id: team.id,
                      key: team.key,
                      name: team.name,
                      states: {
                        nodes: team.states.map((state) => ({
                          id: state.id,
                          name: state.name,
                          type: state.type,
                        })),
                      },
                    })),
                  },
                },
              ],
            },
          },
        });
      }

      if (operationName === "SymphonyTsCreateIssue") {
        const input = variables?.input as Record<string, unknown>;
        issueCounter += 1;
        const team =
          config.project.teams.find((t) => t.id === input.teamId) ?? config.project.teams[0];
        const state = team.states.find((s) => s.id === input.stateId) ?? team.states[0];
        const now = new Date().toISOString();
        const issue: FakeIssue = {
          id: `fake-issue-${issueCounter}`,
          identifier: `${team.key}-${issueCounter}`,
          title: (input.title as string) ?? "",
          description: (input.description as string) ?? null,
          priority: 0,
          state: { id: state.id, name: state.name, type: state.type },
          branchName: `${team.key.toLowerCase()}-${issueCounter}-fake`,
          url: `https://linear.app/fake/issue/${team.key}-${issueCounter}`,
          assignee: input.assigneeId ? { id: input.assigneeId as string } : null,
          labels: { nodes: [] },
          inverseRelations: { nodes: [] },
          createdAt: now,
          updatedAt: now,
          archived: false,
        };
        issues.push(issue);
        return HttpResponse.json({
          data: {
            issueCreate: { success: true, issue: issuePayload(issue) },
          },
        });
      }

      if (operationName === "SymphonyTsPoll") {
        const stateNames = (variables?.stateNames as string[]) ?? [];
        const first = (variables?.first as number) ?? 50;
        const after = (variables?.after as string | null) ?? null;

        const filtered = issues.filter((i) => !i.archived && stateNames.includes(i.state.name));
        const afterIndex = after ? filtered.findIndex((i) => i.id === after) + 1 : 0;
        const page = filtered.slice(afterIndex, afterIndex + first);
        const hasNextPage = afterIndex + first < filtered.length;
        const endCursor = page.length > 0 ? page[page.length - 1].id : null;

        return HttpResponse.json({
          data: {
            issues: {
              nodes: page.map(issuePayload),
              pageInfo: { hasNextPage, endCursor },
            },
          },
        });
      }

      if (operationName === "SymphonyTsIssuesById") {
        const ids = (variables?.ids as string[]) ?? [];
        const matched = issues.filter((i) => ids.includes(i.id));
        return HttpResponse.json({
          data: {
            issues: { nodes: matched.map(issuePayload) },
          },
        });
      }

      if (operationName === "SymphonyTsUpdateIssue") {
        const id = variables?.id as string;
        const input = variables?.input as Record<string, unknown>;
        const issue = issues.find((i) => i.id === id);
        if (!issue) {
          return HttpResponse.json({
            data: { issueUpdate: { success: false, issue: null } },
          });
        }
        if (input.stateId) {
          const allStates = config.project.teams.flatMap((t) => t.states);
          const newState = allStates.find((s) => s.id === input.stateId);
          if (newState) {
            issue.state = { id: newState.id, name: newState.name, type: newState.type };
          }
        }
        issue.updatedAt = new Date().toISOString();
        return HttpResponse.json({
          data: { issueUpdate: { success: true, issue: issuePayload(issue) } },
        });
      }

      if (operationName === "SymphonyTsArchiveIssue") {
        const id = variables?.id as string;
        const issue = issues.find((i) => i.id === id);
        if (!issue) {
          return HttpResponse.json({
            data: { issueArchive: { success: false } },
          });
        }
        issue.archived = true;
        return HttpResponse.json({
          data: { issueArchive: { success: true } },
        });
      }

      return HttpResponse.json({
        data: parseGenericGraphql(query),
      });
    }),
  ];
}

function extractOperationName(query: string): string | null {
  const match = /(?:query|mutation)\s+(\w+)/.exec(query);
  return match?.[1] ?? null;
}

function parseGenericGraphql(query: string): Record<string, unknown> {
  const fieldMatch = /\{\s*(\w+)/.exec(query.replace(/^[^{]*/, ""));
  const rootField = fieldMatch?.[1] ?? "unknown";
  return { [rootField]: null };
}
