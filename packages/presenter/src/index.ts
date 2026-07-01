import type {
  RuntimeRunHistoryEntry,
  RuntimeRunningEntry,
  RuntimeSnapshot,
} from "@lorenz/runtime-events";
import { humanizeAgentMessage } from "@lorenz/humanize";
import {
  durationMs,
  redactDiagnosticText,
  redactDiagnosticValue,
  type UsageTotals,
} from "@lorenz/domain";

export interface PresenterParams {
  [key: string]: string | boolean | number | undefined;
}

export interface TokensPayload {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface UsageTotalsPayload extends TokensPayload {
  seconds_running: number;
}

export interface RunningEntryPayload {
  issue_id: string;
  issue_identifier: string;
  issue_url: string | null;
  state: string;
  slot_index: number;
  ensemble_size: number;
  worker_host: string | null;
  workspace_path: string | null;
  session_id: string | null;
  turn_count: number;
  agent_kind: string;
  executor_pid: string | null;
  usage_totals: UsageTotalsPayload;
  last_event: string | null;
  last_message: string | null;
  started_at: string;
  last_event_at: string | null;
  tokens: TokensPayload;
}

export interface RetryEntryPayload {
  issue_id: string;
  issue_identifier: string;
  issue_url: string | null;
  attempt: number;
  due_at: string;
  error: string | null;
  worker_host: string | null;
  workspace_path: string | null;
}

export interface BlockedEntryPayload {
  issue_id: string;
  issue_identifier: string;
  issue_url: string | null;
  state: string;
  reason: string;
  label: string;
  worker_host: string | null;
}

export interface ClaimStorePayload {
  kind: string;
  owner_id: string;
  capabilities: {
    crash_recovery: boolean;
    shared_across_processes: boolean;
    retry_durability: boolean;
  };
  hydrated_at: string;
  transactions_applied: number;
  last_operation: string | null;
  last_checkpoint_at: string | null;
}

export interface OpsStatePayload {
  generated_at: string;
  counts: { running: number; retrying: number; blocked: number };
  blocked_by_reason: Record<string, number>;
  running: RunningEntryPayload[];
  retrying: RetryEntryPayload[];
  blocked: BlockedEntryPayload[];
  usage_totals: UsageTotalsPayload;
  rate_limits: unknown;
  claim_store: ClaimStorePayload | null;
}

type RunsPayloadResult =
  | { status: "ok"; payload: Record<string, unknown> }
  | { status: "run_not_found" };

export function statePayload(snapshot: RuntimeSnapshot, generatedAt = nowIso()): OpsStatePayload {
  return {
    generated_at: generatedAt,
    counts: {
      running: snapshot.running.length,
      retrying: snapshot.retrying.length,
      blocked: snapshot.blocked.length,
    },
    blocked_by_reason: blockedByReasonPayload(snapshot.blocked),
    running: snapshot.running.map(runningEntryPayload),
    retrying: snapshot.retrying.map((entry) => ({
      issue_id: entry.issueId,
      issue_identifier: entry.issueIdentifier,
      issue_url: entry.issueUrl ?? null,
      attempt: entry.attempt,
      due_at: entry.dueAtIso,
      error: entry.error === undefined ? null : redactDiagnosticText(entry.error),
      worker_host: entry.workerHost ?? null,
      workspace_path: entry.workspacePath ?? null,
    })),
    blocked: snapshot.blocked.map(blockedEntryPayload),
    usage_totals: usagePayload(snapshot.usageTotals),
    rate_limits: redactDiagnosticValue(snapshot.rateLimits),
    claim_store: claimStorePayload(snapshot.claimStore),
  };
}

function claimStorePayload(snapshot: RuntimeSnapshot["claimStore"]): ClaimStorePayload | null {
  if (!snapshot) return null;
  return {
    kind: snapshot.kind,
    owner_id: snapshot.ownerId,
    capabilities: {
      crash_recovery: snapshot.capabilities.crashRecovery,
      shared_across_processes: snapshot.capabilities.sharedAcrossProcesses,
      retry_durability: snapshot.capabilities.retryDurability,
    },
    hydrated_at: snapshot.hydratedAt,
    transactions_applied: snapshot.transactionsApplied,
    last_operation: snapshot.lastOperation,
    last_checkpoint_at: snapshot.lastCheckpointAt,
  };
}

export function issuePayload(
  snapshot: RuntimeSnapshot,
  issueIdentifier: string,
): { status: "ok"; payload: Record<string, unknown> } | { status: "issue_not_found" } {
  const running = snapshot.running.find((entry) => entry.issueIdentifier === issueIdentifier);
  const retry = snapshot.retrying.find((entry) => entry.issueIdentifier === issueIdentifier);
  if (!running && !retry) return { status: "issue_not_found" };
  const currentRetryAttempt = issueCurrentRetryAttempt(running, retry);

  return {
    status: "ok",
    payload: {
      issue_identifier: issueIdentifier,
      issue_id: running?.issueId ?? retry?.issueId ?? null,
      status: running ? "running" : "retrying",
      workspace: {
        path: running?.workspacePath ?? retry?.workspacePath ?? null,
        host: running?.workerHost ?? retry?.workerHost ?? null,
      },
      attempts: {
        restart_count: Math.max(currentRetryAttempt - 1, 0),
        current_retry_attempt: currentRetryAttempt,
      },
      running: running ? runningIssuePayload(running) : null,
      retry: retry
        ? {
            attempt: retry.attempt,
            due_at: retry.dueAtIso,
            error: retry.error === undefined ? null : redactDiagnosticText(retry.error),
            worker_host: retry.workerHost ?? null,
            workspace_path: retry.workspacePath ?? null,
          }
        : null,
      logs: { codex_session_logs: [] },
      recent_events: running?.lastEventAt
        ? [
            {
              at: running.lastEventAt,
              event: running.lastEvent ?? null,
              message: summarizeMessage(running.lastMessage),
            },
          ]
        : [],
      last_error: retry?.error === undefined ? null : redactDiagnosticText(retry.error),
      tracked: {},
    },
  };
}

function issueCurrentRetryAttempt(
  running: RuntimeRunningEntry | undefined,
  retry: RuntimeSnapshot["retrying"][number] | undefined,
): number {
  return running?.retryAttempt ?? retry?.attempt ?? 0;
}

export function runsPayload(
  snapshot: RuntimeSnapshot,
  params: PresenterParams,
  generatedAt = nowIso(),
): RunsPayloadResult {
  const logFile = snapshot.logFile ?? null;
  const runs = filterRuns(
    [
      ...snapshot.running.map((entry) => runningRunPayload(entry, logFile)),
      ...snapshot.runHistory.map((entry) => historyRunPayload(entry, logFile)),
    ],
    params,
  );

  if (truthyParam(params.cost)) {
    return {
      status: "ok",
      payload: { generated_at: generatedAt, view: "cost", summary: costSummaryPayload(runs) },
    };
  }

  if (truthyParam(params.retries)) {
    return {
      status: "ok",
      payload: { generated_at: generatedAt, view: "retries", issues: retriesPayload(runs) },
    };
  }

  const requestedId = stringParam(params.id);
  if (requestedId !== null) {
    if (requestedId === "") return runsListPayload(generatedAt, runs, params);
    const run = runs.find((entry) => entry.id === requestedId);
    if (!run) return { status: "run_not_found" };
    return {
      status: "ok",
      payload: {
        generated_at: generatedAt,
        view: "run",
        run,
        related_runs: runs
          .filter((entry) => entry.id !== run.id && entry.issue_id === run.issue_id)
          .slice(0, 10),
      },
    };
  }

  return runsListPayload(generatedAt, runs, params);
}

function runsListPayload(
  generatedAt: string,
  runs: RunPayload[],
  params: PresenterParams,
): RunsPayloadResult {
  return {
    status: "ok",
    payload: {
      generated_at: generatedAt,
      view: "runs",
      summary: runsSummaryPayload(runs),
      runs: runs.slice(0, limitParam(params.limit)),
    },
  };
}

interface RunPayload {
  id: string;
  issue_id: string;
  issue_identifier: string;
  issue_title: string | null;
  state: string | null;
  slot_index: number;
  ensemble_size: number;
  agent_kind: string;
  outcome: string;
  retry_attempt: number;
  worker_host: string | null;
  workspace_path: string | null;
  session_id: string | null;
  executor_pid: string | null;
  usage_totals: ReturnType<typeof usagePayload>;
  turn_count: number;
  failure_reason: string | null;
  last_event: string | null;
  last_message: string | null;
  last_event_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  cost: { estimated_cost_usd: number | null };
  tokens: ReturnType<typeof tokenPayload>;
  log_hints: {
    lorenz_log_file: string | null;
    workspace_path: string | null;
    session_id: string | null;
    issue_identifier: string;
  };
}

function runningRunPayload(entry: RuntimeRunningEntry, logFile: string | null): RunPayload {
  const usage = entry.usageTotals;
  return {
    id: entry.runId ?? `running-${entry.issueIdentifier}-${entry.slotIndex}`,
    issue_id: entry.issueId,
    issue_identifier: entry.issueIdentifier,
    issue_title: entry.issueTitle,
    state: entry.state,
    slot_index: entry.slotIndex,
    ensemble_size: entry.ensembleSize,
    agent_kind: entry.agentKind,
    outcome: "running",
    retry_attempt: entry.retryAttempt ?? 0,
    worker_host: entry.workerHost ?? null,
    workspace_path: entry.workspacePath ?? null,
    session_id: entry.sessionId ?? null,
    executor_pid: entry.executorPid ?? null,
    usage_totals: usagePayload(usage),
    turn_count: entry.turnCount,
    failure_reason: null,
    last_event: entry.lastEvent ?? null,
    last_message: summarizeMessage(entry.lastMessage),
    last_event_at: entry.lastEventAt ?? null,
    started_at: entry.startedAt,
    ended_at: null,
    duration_ms: durationSince(entry.startedAt),
    cost: { estimated_cost_usd: null },
    tokens: tokenPayload(usage),
    log_hints: logHints(
      logFile,
      entry.workspacePath ?? null,
      entry.sessionId ?? null,
      entry.issueIdentifier,
    ),
  };
}

function historyRunPayload(entry: RuntimeRunHistoryEntry, logFile: string | null): RunPayload {
  const usage = entry.usageTotals ?? {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    secondsRunning: 0,
  };
  return {
    id: entry.id,
    issue_id: entry.issueId,
    issue_identifier: entry.issueIdentifier,
    issue_title: entry.issueTitle ?? null,
    state: entry.state ?? null,
    slot_index: entry.slotIndex,
    ensemble_size: entry.ensembleSize ?? 1,
    agent_kind: entry.agentKind,
    outcome: entry.outcome,
    retry_attempt: entry.retryAttempt ?? 0,
    worker_host: entry.workerHost ?? null,
    workspace_path: entry.workspacePath ?? null,
    session_id: entry.sessionId ?? null,
    executor_pid: entry.executorPid ?? null,
    usage_totals: usagePayload(usage),
    turn_count: entry.turnCount,
    failure_reason: entry.error === undefined ? null : redactDiagnosticText(entry.error),
    last_event: entry.lastEvent ?? null,
    last_message: summarizeMessage(entry.lastMessage),
    last_event_at: entry.lastEventAt ?? null,
    started_at: entry.startedAt,
    ended_at: entry.endedAt,
    duration_ms: entry.durationMs ?? durationMs(entry.startedAt, entry.endedAt),
    cost: { estimated_cost_usd: null },
    tokens: tokenPayload(usage),
    log_hints: logHints(
      logFile,
      entry.workspacePath ?? null,
      entry.sessionId ?? null,
      entry.issueIdentifier,
    ),
  };
}

function blockedEntryPayload(entry: RuntimeSnapshot["blocked"][number]): BlockedEntryPayload {
  return {
    issue_id: entry.issueId,
    issue_identifier: entry.identifier,
    issue_url: entry.issueUrl ?? null,
    state: entry.state,
    reason: entry.reason,
    label: blockReasonLabel(entry.reason),
    worker_host: entry.workerHost ?? null,
  };
}

function runningEntryPayload(entry: RuntimeRunningEntry): RunningEntryPayload {
  return {
    issue_id: entry.issueId,
    issue_identifier: entry.issueIdentifier,
    issue_url: entry.issueUrl ?? null,
    state: entry.state,
    slot_index: entry.slotIndex,
    ensemble_size: entry.ensembleSize,
    worker_host: entry.workerHost ?? null,
    workspace_path: entry.workspacePath ?? null,
    session_id: entry.sessionId ?? null,
    turn_count: entry.turnCount,
    agent_kind: entry.agentKind,
    executor_pid: entry.executorPid ?? null,
    usage_totals: usagePayload(entry.usageTotals),
    last_event: entry.lastEvent ?? null,
    last_message: summarizeMessage(entry.lastMessage),
    started_at: entry.startedAt,
    last_event_at: entry.lastEventAt ?? null,
    tokens: tokenPayload(entry.usageTotals),
  };
}

function runningIssuePayload(entry: RuntimeRunningEntry): Record<string, unknown> {
  return {
    slot_index: entry.slotIndex,
    ensemble_size: entry.ensembleSize,
    retry_attempt: entry.retryAttempt ?? 0,
    worker_host: entry.workerHost ?? null,
    workspace_path: entry.workspacePath ?? null,
    session_id: entry.sessionId ?? null,
    turn_count: entry.turnCount,
    agent_kind: entry.agentKind,
    executor_pid: entry.executorPid ?? null,
    usage_totals: usagePayload(entry.usageTotals),
    state: entry.state,
    started_at: entry.startedAt,
    last_event: entry.lastEvent ?? null,
    last_message: summarizeMessage(entry.lastMessage),
    last_event_at: entry.lastEventAt ?? null,
    tokens: tokenPayload(entry.usageTotals),
  };
}

function filterRuns(runs: RunPayload[], params: PresenterParams): RunPayload[] {
  let filtered = runs;
  const issue = stringParam(params.issue);
  if (issue !== null && issue !== "") {
    filtered = filtered.filter((run) => run.issue_identifier === issue || run.issue_id === issue);
  }
  if (truthyParam(params.failed)) {
    filtered = filtered.filter((run) => run.outcome === "failed" || run.outcome === "stalled");
  }
  return filtered;
}

function runsSummaryPayload(runs: RunPayload[]): Record<string, number> {
  return {
    total: runs.length,
    running: runs.filter((run) => run.outcome === "running").length,
    success: runs.filter((run) => run.outcome === "success").length,
    failed: runs.filter((run) => run.outcome === "failed").length,
    stalled: runs.filter((run) => run.outcome === "stalled").length,
    canceled: runs.filter((run) => run.outcome === "canceled").length,
  };
}

function costSummaryPayload(runs: RunPayload[]): Record<string, unknown> {
  const byAgent = new Map<string, RunPayload[]>();
  for (const run of runs)
    byAgent.set(run.agent_kind, [...(byAgent.get(run.agent_kind) ?? []), run]);
  const totalTokens = sum(runs, (run) => run.tokens.total_tokens);
  return {
    totals: {
      run_count: runs.length,
      total_tokens: totalTokens,
      estimated_cost_usd: null,
    },
    by_agent: [...byAgent.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([agent, agentRuns]) => {
        const input = sum(agentRuns, (run) => run.tokens.input_tokens);
        const output = sum(agentRuns, (run) => run.tokens.output_tokens);
        const total = sum(agentRuns, (run) => run.tokens.total_tokens);
        return {
          agent_kind: agent,
          run_count: agentRuns.length,
          completed_count: agentRuns.filter((run) => run.outcome !== "running").length,
          input_tokens: input,
          output_tokens: output,
          total_tokens: total,
          average_total_tokens_per_run: agentRuns.length === 0 ? 0 : total / agentRuns.length,
          estimated_cost_usd: null,
        };
      }),
    top_runs: [...runs]
      .sort(
        (left, right) =>
          right.tokens.total_tokens - left.tokens.total_tokens || left.id.localeCompare(right.id),
      )
      .slice(0, 10),
  };
}

function retriesPayload(runs: RunPayload[]): Array<Record<string, unknown>> {
  const grouped = new Map<string, RunPayload[]>();
  for (const run of runs)
    grouped.set(run.issue_identifier, [...(grouped.get(run.issue_identifier) ?? []), run]);
  return [...grouped.entries()]
    .map(([identifier, issueRuns]) => ({
      identifier,
      issueRuns,
      retryAttempts: distinctRetryAttempts(issueRuns),
    }))
    .filter(({ retryAttempts }) => retryAttempts.some((attempt) => attempt > 0))
    .map(({ identifier, issueRuns, retryAttempts }) => {
      const sortedRuns = [...issueRuns].sort(compareLatestRun);
      const latest = sortedRuns[0];
      return {
        issue_identifier: identifier,
        issue_id: latest?.issue_id ?? null,
        issue_title: latest?.issue_title ?? null,
        attempts: retryAttempts.length,
        latest_outcome: latest?.outcome ?? "unknown",
        total_tokens: sum(issueRuns, (run) => run.tokens.total_tokens),
        latest_run_id: latest?.id ?? null,
        latest_failure_reason: latest?.failure_reason ?? null,
      };
    })
    .sort((left, right) => {
      const attemptDelta = Number(right.attempts) - Number(left.attempts);
      if (attemptDelta !== 0) return attemptDelta;
      const tokenDelta = Number(right.total_tokens) - Number(left.total_tokens);
      if (tokenDelta !== 0) return tokenDelta;
      return String(left.issue_identifier).localeCompare(String(right.issue_identifier));
    });
}

function distinctRetryAttempts(runs: RunPayload[]): number[] {
  return [...new Set(runs.map((run) => run.retry_attempt))].sort((left, right) => left - right);
}

function usagePayload(usage: UsageTotals): UsageTotalsPayload {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    seconds_running: usage.secondsRunning,
  };
}

function tokenPayload(usage: UsageTotals): TokensPayload {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  };
}

function logHints(
  logFile: string | null,
  workspacePath: string | null,
  sessionId: string | null,
  issueIdentifier: string,
) {
  return {
    lorenz_log_file: logFile,
    workspace_path: workspacePath,
    session_id: sessionId,
    issue_identifier: issueIdentifier,
  };
}

function blockedByReasonPayload(blocked: RuntimeSnapshot["blocked"]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of blocked) counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
  return counts;
}

function blockReasonLabel(reason: string): string {
  if (reason === "global_concurrency_cap") return "global concurrency cap";
  if (reason === "local_concurrency_cap") return "local state concurrency cap";
  if (reason === "worker_host_capacity") return "worker host capacity";
  return reason;
}

function compareLatestRun(left: RunPayload, right: RunPayload): number {
  const timeDelta = runSortTime(right) - runSortTime(left);
  if (timeDelta !== 0) return timeDelta;
  return right.id.localeCompare(left.id);
}

function runSortTime(run: RunPayload): number {
  const value = run.ended_at ?? run.started_at;
  if (!value) return 0;
  return new Date(value).getTime();
}

function summarizeMessage(message: unknown): string | null {
  if (message === null || message === undefined) return null;
  return redactDiagnosticText(humanizeAgentMessage(message));
}

function truthyParam(value: string | boolean | number | undefined): boolean {
  return (
    value === true ||
    value === 1 ||
    value === "true" ||
    value === "1" ||
    value === "yes" ||
    value === "on"
  );
}

function stringParam(value: string | boolean | number | undefined): string | null {
  if (typeof value !== "string") return null;
  return value.trim();
}

function limitParam(value: string | boolean | number | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? "20"), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 200);
}

function durationSince(startedAt: string): number {
  return Math.max(0, Date.now() - new Date(startedAt).getTime());
}

function sum<T>(values: T[], callback: (value: T) => number): number {
  return values.reduce((total, value) => total + callback(value), 0);
}

function nowIso(): string {
  return new Date().toISOString();
}
