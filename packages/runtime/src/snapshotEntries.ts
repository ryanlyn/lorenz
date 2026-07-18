import {
  redactDiagnosticText,
  redactDiagnosticValue,
  type RetryEntry,
  type RunningEntry,
} from "@lorenz/domain";
import type { RuntimeRetryEntry, RuntimeRunningEntry } from "@lorenz/runtime-events";

export function runtimeRunningEntry(
  entry: RunningEntry,
  runId: string | undefined,
): RuntimeRunningEntry {
  return {
    runId,
    issueId: entry.issue.id,
    issueIdentifier: entry.identifier,
    issueUrl: entry.issue.url ?? null,
    issueTitle: entry.issue.title,
    state: entry.issue.state,
    slotIndex: entry.slotIndex,
    ensembleSize: entry.ensembleSize,
    agentKind: entry.agentKind,
    sessionId: entry.sessionId,
    executorPid: entry.executorPid,
    workerHost: entry.workerHost,
    turnCount: entry.turnCount,
    startedAt: entry.startedAt.toISOString(),
    lastEvent: entry.lastAgentEvent,
    lastMessage: redactDiagnosticValue(entry.lastAgentMessage),
    lastEventAt: entry.lastAgentTimestamp?.toISOString() ?? null,
    toolCallCount: entry.toolCallCount ?? 0,
    workspacePath: entry.workspacePath,
    usageTotals: { ...entry.usageTotals },
    retryAttempt: entry.retryAttempt,
  };
}

export function runtimeRetryEntry(entry: RetryEntry): RuntimeRetryEntry {
  return {
    issueId: entry.issueId,
    issueIdentifier: entry.identifier,
    issueUrl: entry.issueUrl ?? null,
    attempt: entry.attempt,
    dueAtIso: entry.dueAtIso,
    monotonicDeadlineMs: entry.monotonicDeadlineMs,
    ...(entry.error !== undefined ? { error: redactDiagnosticText(entry.error) } : {}),
    ...(entry.slotIndex !== undefined ? { slotIndex: entry.slotIndex } : {}),
    ...(entry.workerHost !== undefined ? { workerHost: entry.workerHost } : {}),
    ...(entry.workspacePath !== undefined ? { workspacePath: entry.workspacePath } : {}),
  };
}
