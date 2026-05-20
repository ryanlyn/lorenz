import type { Issue } from "@symphony/domain";

export interface ResumeIdentity {
  agent: string;
  issueId: string;
  workspacePath: string;
  workerHost?: string | null | undefined;
}

export function resumeIdentityMatches(
  stored: ResumeIdentity,
  current: {
    agent: string;
    issue: Issue;
    workspacePath: string;
    workerHost?: string | null | undefined;
  },
): boolean {
  return (
    stored.agent === current.agent &&
    stored.issueId === current.issue.id &&
    stored.workspacePath === current.workspacePath &&
    (stored.workerHost ?? null) === (current.workerHost ?? null)
  );
}
