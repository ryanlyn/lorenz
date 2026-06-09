import { normalizeIssue } from "@symphony/issue";
import {
  ISSUE_STATE_TYPES,
  isRecord,
  type Issue,
  type IssueRef,
  type RuntimeTrackerClient,
} from "@symphony/domain";

export class MemoryTrackerClient implements RuntimeTrackerClient {
  private readonly issues: Issue[];

  constructor(issues: Array<Issue | Record<string, unknown>> = []) {
    this.issues = issues.map((issue) =>
      isIssue(issue) ? cloneIssue(issue) : normalizeIssue(issue),
    );
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return Promise.resolve(this.issues.map(cloneIssue));
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    const wanted = new Set(ids);
    return Promise.resolve(this.issues.filter((issue) => wanted.has(issue.id)).map(cloneIssue));
  }

  updateIssue(id: string, fields: Partial<Pick<Issue, "state" | "stateType">>): void {
    const issue = this.issues.find((i) => i.id === id);
    if (!issue) return;
    if (fields.state !== undefined) issue.state = fields.state;
    if (fields.stateType !== undefined) issue.stateType = fields.stateType;
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const wanted = new Set(states.map(normalizeState));
    return Promise.resolve(
      this.issues.filter((issue) => wanted.has(normalizeState(issue.state))).map(cloneIssue),
    );
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
    typeof value.stateType === "string" &&
    isIssueStateType(value.stateType) &&
    Array.isArray(value.labels) &&
    value.labels.every((label) => typeof label === "string") &&
    Array.isArray(value.blockers) &&
    value.blockers.every(isIssueRef)
  );
}

function isIssueRef(value: unknown): value is IssueRef {
  return (
    isRecord(value) &&
    isOptionalString(value.id) &&
    isOptionalString(value.identifier) &&
    isOptionalString(value.state) &&
    isOptionalIssueStateType(value.stateType)
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalIssueStateType(value: unknown): boolean {
  return value === undefined || value === null || isIssueStateType(value);
}

function isIssueStateType(value: unknown): value is Issue["stateType"] {
  return typeof value === "string" && (ISSUE_STATE_TYPES as readonly string[]).includes(value);
}

function normalizeState(value: string): string {
  return value.trim().toLowerCase();
}
