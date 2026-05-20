import { normalizeIssue } from "@symphony/issue";
import type { Issue, RuntimeTrackerClient } from "@symphony/domain";

export class MemoryTrackerClient implements RuntimeTrackerClient {
  private readonly issues: Issue[];

  constructor(issues: Array<Issue | Record<string, unknown>> = []) {
    this.issues = issues.map((issue) =>
      isIssue(issue)
        ? { ...issue, labels: [...issue.labels], blockers: [...issue.blockers] }
        : normalizeIssue(issue),
    );
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.issues.map(cloneIssue);
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    const wanted = new Set(ids);
    return this.issues.filter((issue) => wanted.has(issue.id)).map(cloneIssue);
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const wanted = new Set(states.map(normalizeState));
    return this.issues.filter((issue) => wanted.has(normalizeState(issue.state))).map(cloneIssue);
  }
}

export function memoryIssuesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown>[] {
  const json = env.SYMPHONY_MEMORY_TRACKER_ISSUES_JSON ?? env.SYMPHONY_MEMORY_TRACKER_ISSUES;
  if (!json || json.trim() === "") return [];
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed))
    throw new Error("SYMPHONY_MEMORY_TRACKER_ISSUES_JSON must be a JSON array");
  return parsed.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`memory tracker issue ${index} must be an object`);
    return entry;
  });
}

function cloneIssue(issue: Issue): Issue {
  return {
    ...issue,
    labels: [...issue.labels],
    blockers: issue.blockers.map((blocker) => ({ ...blocker })),
  };
}

function isIssue(value: Issue | Record<string, unknown>): value is Issue {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.identifier === "string" &&
    typeof value.title === "string" &&
    typeof value.state === "string" &&
    Array.isArray(value.labels) &&
    Array.isArray(value.blockers)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeState(value: string): string {
  return value.trim().toLowerCase();
}
