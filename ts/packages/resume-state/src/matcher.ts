import type { AgentKind, Issue } from "@symphony/domain";

export interface ResumeStateIdentity {
  agentKind: AgentKind;
  resumeId: string;
  issueId?: string | null | undefined;
  issueIdentifier?: string | null | undefined;
  issueState?: string | null | undefined;
  workerHost?: string | null | undefined;
  workspacePath?: string | null | undefined;
}

export function resumeStateMatches(
  state: ResumeStateIdentity,
  input: { agentKind: AgentKind; issue: Issue; workspacePath: string; workerHost?: string | null },
): boolean {
  return (
    state.agentKind === input.agentKind &&
    state.resumeId.trim() !== "" &&
    storedStringMatches(state.issueId, input.issue.id) &&
    storedStringMatches(state.issueIdentifier, input.issue.identifier) &&
    storedStringMatches(state.issueState, input.issue.state) &&
    storedStringMatches(state.workspacePath, input.workspacePath) &&
    storedNullableMatches(state.workerHost, input.workerHost ?? null)
  );
}

function storedStringMatches(
  stored: string | null | undefined,
  current: string | null | undefined,
): boolean {
  return (
    typeof stored === "string" &&
    stored.trim() !== "" &&
    typeof current === "string" &&
    current.trim() !== "" &&
    stored === current
  );
}

function storedNullableMatches(
  stored: string | null | undefined,
  current: string | null | undefined,
): boolean {
  if (current === null || current === undefined) return stored === null || stored === undefined;
  return storedStringMatches(stored, current);
}
