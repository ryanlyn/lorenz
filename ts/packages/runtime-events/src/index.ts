import { AGENT_UPDATE_TYPES } from "@symphony/domain";
import type { AgentKind, AgentUpdateType, DispatchBlockEntry, UsageTotals } from "@symphony/domain";

export type RuntimeAppStatus = "starting" | "idle" | "polling" | "running" | "stopping" | "error";
export type RuntimePollStatus = "idle" | "checking" | "error";
export const RUNTIME_RUN_OUTCOMES = ["success", "failed", "stalled", "canceled"] as const;
export type RuntimeRunOutcome = (typeof RUNTIME_RUN_OUTCOMES)[number];
export type RuntimeRunLastEvent = AgentUpdateType | "agent_stalled";
export const RUNTIME_EVENT_TYPES = [
  ...AGENT_UPDATE_TYPES,
  "dry_run",
  "poll_error",
  "dispatch_skipped",
  "run_started",
  "dispatch_refresh_failed",
  "run_completed",
  "run_failed",
  "workflow_reloaded",
  "workflow_reload_failed",
  "reconcile_refresh_failed",
  "workspace_cleanup",
  "run_reconciled",
  "run_stalled",
  "startup_workspace_cleanup",
  "startup_workspace_cleanup_failed",
  "retry_timer_due",
  "retry_timer_error",
  "refresh_error",
] as const;
export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

export interface RuntimeEvent {
  type: RuntimeEventType;
  message: string;
  at: string;
}

export interface RuntimeRunHistoryEntry {
  id: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle?: string | null | undefined;
  state?: string | null | undefined;
  slotIndex: number;
  ensembleSize?: number | undefined;
  agentKind: AgentKind;
  outcome: RuntimeRunOutcome;
  turnCount: number;
  sessionId?: string | null | undefined;
  executorPid?: string | null | undefined;
  workspacePath?: string | null | undefined;
  workerHost?: string | null | undefined;
  usageTotals?: UsageTotals | undefined;
  startedAt: string;
  endedAt: string;
  durationMs?: number | undefined;
  error?: string | undefined;
  lastEvent?: RuntimeRunLastEvent | null | undefined;
  lastMessage?: unknown;
  lastEventAt?: string | null | undefined;
  retryAttempt?: number | null | undefined;
}

export interface RuntimeRunningEntry {
  runId?: string | undefined;
  issueId: string;
  issueIdentifier: string;
  issueUrl?: string | null | undefined;
  issueTitle: string;
  state: string;
  slotIndex: number;
  ensembleSize: number;
  agentKind: AgentKind;
  sessionId?: string | null | undefined;
  executorPid?: string | null | undefined;
  workerHost?: string | null | undefined;
  turnCount: number;
  startedAt: string;
  lastEvent?: AgentUpdateType | null | undefined;
  lastMessage?: unknown;
  lastEventAt?: string | null | undefined;
  workspacePath?: string | null | undefined;
  usageTotals: UsageTotals;
  retryAttempt?: number | null | undefined;
}

export interface RuntimeRetryEntry {
  issueId: string;
  issueIdentifier: string;
  issueUrl?: string | null | undefined;
  attempt: number;
  dueAtIso: string;
  monotonicDeadlineMs: number;
  error?: string | undefined;
  slotIndex?: number | undefined;
  workerHost?: string | null | undefined;
  workspacePath?: string | null | undefined;
}

export type RuntimeBlockedEntry = DispatchBlockEntry;

export interface RuntimeSnapshot {
  appStatus: RuntimeAppStatus;
  workflowPath: string;
  poll: {
    status: RuntimePollStatus;
    candidates: number;
    eligible: number;
    lastPollAt: string | null;
    nextPollAt: string | null;
    lastError: string | null;
  };
  running: RuntimeRunningEntry[];
  retrying: RuntimeRetryEntry[];
  blocked: RuntimeBlockedEntry[];
  runHistory: RuntimeRunHistoryEntry[];
  usageTotals: UsageTotals;
  rateLimits: unknown;
  logFile: string | null;
  recentEvents: RuntimeEvent[];
}
