import { AGENT_UPDATE_TYPES } from "@lorenz/domain";
import type { AgentKind, AgentUpdateType, DispatchBlockEntry, UsageTotals } from "@lorenz/domain";

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
  "run_reserving",
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
  "tracker_watch_started",
  "tracker_watch_error",
  "tracker_push",
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
  toolCallCount?: number | undefined;
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

/**
 * One in-acquire (reserved) slot: the dispatch slot is held while the worker pool
 * negotiates a concrete worker host, so it is deliberately HOST-LESS. Mirrors the
 * orchestrator's reservation snapshot shape.
 */
export interface RuntimeReservingEntry {
  issueId: string;
  identifier: string;
  slotIndex: number;
  /** Prior run's concrete host preferred for sticky re-acquire; null on a first run. */
  affinityHost: string | null;
  retryAttempt: number | null;
  reservedAtIso: string;
}

export interface RuntimeClaimStoreStatus {
  kind: string;
  ownerId: string;
  capabilities: {
    crashRecovery: boolean;
    sharedAcrossProcesses: boolean;
    retryDurability: boolean;
  };
  hydratedAt: string;
  transactionsApplied: number;
  lastOperation: string | null;
  lastCheckpointAt: string | null;
}

export interface RuntimeDaemonStatus {
  ownerId: string;
  pid: number;
  hostname: string;
  startedAt: string;
  workflowPath: string;
  workspaceRoot: string;
  lockPath: string;
  endpoint: { kind: "http" | "socket" | "none"; address: string };
  heartbeatAt: string;
  heartbeatAgeMs: number | null;
  stale: boolean;
  leadershipStoreKind: string;
}

export interface RuntimeSnapshot {
  appStatus: RuntimeAppStatus;
  /** Wall-clock time when the runtime instance was created. */
  appStartedAt?: string | undefined;
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
  /** In-acquire (reserved) slots; additive, absent from snapshots predating the lane. */
  reserving?: RuntimeReservingEntry[];
  retrying: RuntimeRetryEntry[];
  blocked: RuntimeBlockedEntry[];
  runHistory: RuntimeRunHistoryEntry[];
  usageTotals: UsageTotals;
  rateLimits: unknown;
  claimStore?: RuntimeClaimStoreStatus | undefined;
  daemon?: RuntimeDaemonStatus | undefined;
  logFile: string | null;
  recentEvents: RuntimeEvent[];
}
