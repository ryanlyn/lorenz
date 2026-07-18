import type {
  AgentKind,
  AgentUpdate,
  HookExecutionMessage,
  Issue,
  RunningEntry,
} from "@lorenz/domain";
import { redactDiagnosticText, redactDiagnosticValue } from "@lorenz/domain";
import type { RuntimeRunHistoryEntry, RuntimeRunOutcome } from "@lorenz/runtime-events";

export interface BuildRunHistoryEntryInput {
  id: string;
  issue: Issue;
  issueIdentifier?: string | undefined;
  state?: RuntimeRunHistoryEntry["state"];
  slotIndex: number;
  agentKind: AgentKind;
  outcome: RuntimeRunOutcome;
  turnCount: number;
  runningEntry?: RunningEntry | undefined;
  workspacePath?: RuntimeRunHistoryEntry["workspacePath"];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  error?: string | undefined;
  fallbackLastEvent?: RuntimeRunHistoryEntry["lastEvent"];
}

export function buildRunHistoryEntry(input: BuildRunHistoryEntryInput): RuntimeRunHistoryEntry {
  const entry = input.runningEntry;
  const workspacePath = "workspacePath" in input ? input.workspacePath : entry?.workspacePath;

  return {
    id: input.id,
    issueId: input.issue.id,
    issueIdentifier: input.issueIdentifier ?? input.issue.identifier,
    issueTitle: input.issue.title,
    state: "state" in input ? input.state : input.issue.state,
    slotIndex: input.slotIndex,
    ensembleSize: entry?.ensembleSize,
    agentKind: input.agentKind,
    outcome: input.outcome,
    turnCount: input.turnCount,
    sessionId: entry?.sessionId,
    executorPid: entry?.executorPid,
    workspacePath,
    workerHost: entry?.workerHost,
    usageTotals: entry?.usageTotals,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: input.durationMs,
    ...(input.error !== undefined ? { error: redactDiagnosticText(input.error) } : {}),
    lastEvent: entry?.lastAgentEvent ?? input.fallbackLastEvent,
    lastMessage: redactDiagnosticValue(entry?.lastAgentMessage),
    lastEventAt: entry?.lastAgentTimestamp?.toISOString() ?? null,
    retryAttempt: entry?.retryAttempt,
  };
}

export function agentUpdateRuntimeMessage(issueIdentifier: string, update: AgentUpdate): string {
  if (update.type !== "hook_execution") return `${issueIdentifier} ${update.type}`;
  return hookExecutionRuntimeMessage(issueIdentifier, update.message);
}

export function hookExecutionRuntimeMessage(
  issueIdentifier: string,
  message: HookExecutionMessage,
): string {
  const hookName = message.hookName ?? "hook";
  const parts = [
    `${issueIdentifier} ${hookName} hook ${message.status}`,
    `command=${inlineLogValue(message.command)}`,
  ];
  if (message.exitCode !== undefined) parts.push(`exit_code=${message.exitCode ?? "unknown"}`);
  if (message.error) {
    const suffix = message.errorTruncated ? " (truncated)" : "";
    parts.push(`error=${inlineLogValue(message.error)}${suffix}`);
  }
  if (message.output) {
    const suffix = message.outputTruncated ? " (truncated)" : "";
    parts.push(`output=${inlineLogValue(message.output)}${suffix}`);
  }
  return parts.join(" ");
}

function inlineLogValue(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, " ").trim());
}
