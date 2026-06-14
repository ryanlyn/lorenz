import {
  dispatchBlockReason,
  firstUnclaimedSlot,
  issueIsActive,
  shouldDispatchIssue,
  slotKey,
  sortForDispatch,
} from "@symphony/dispatch";
import { ensembleSize } from "@symphony/issue";
import { normalizeStateName, settingsForIssueState } from "@symphony/config";
import { retryBackoffMs } from "@symphony/policies/retry";
import { mergeMonotonicUsage } from "@symphony/policies/usage";
import { selectLeastLoadedHost } from "@symphony/policies/workerHost";
import {
  systemClock,
  type AgentUpdate,
  type ClockPort,
  type DispatchBlockReason,
  type DispatchBlockEntry,
  type Issue,
  type RetryEntry,
  type RunningEntry,
  type Settings,
  type UsageTokenUpdate,
  type UsageTotals,
} from "@symphony/domain";

export interface OrchestratorState {
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  /** Retry entries keyed by slotKey(issueId, slotIndex). */
  retryAttempts: Map<string, RetryEntry>;
  completed: Set<string>;
  usageTotals: UsageTotals;
  rateLimits: unknown;
  blockedDispatches: DispatchBlockEntry[];
}

export function createState(): OrchestratorState {
  return {
    running: new Map(),
    claimed: new Set(),
    retryAttempts: new Map(),
    completed: new Set(),
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    rateLimits: null,
    blockedDispatches: [],
  };
}

function zeroUsageTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 };
}

function reportedUsageTotals(entry: RunningEntry): UsageTotals {
  return {
    inputTokens: entry.lastReportedInputTokens,
    outputTokens: entry.lastReportedOutputTokens,
    totalTokens: entry.lastReportedTotalTokens,
    secondsRunning: 0,
  };
}

function usageDelta(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value!) : 0;
}

function deltaNotAlreadyReported(delta: number, reported: number, base: number): number {
  return Math.max(0, delta - Math.max(0, reported - base));
}

function retrySlotIndex(retry: RetryEntry): number {
  return retry.slotIndex ?? 0;
}

export class Orchestrator {
  readonly state: OrchestratorState;
  private readonly usageDeltaBases = new Map<string, UsageTotals>();

  constructor(
    public settings: Settings,
    private readonly clock: ClockPort = systemClock,
    state: OrchestratorState = createState(),
  ) {
    this.state = state;
  }

  eligibleIssues(issues: Issue[]): Issue[] {
    this.cleanupRetryAttempts(issues);
    this.state.blockedDispatches = [];
    const runningByState = new Map<string, number>();
    for (const entry of this.state.running.values()) {
      const key = normalizeStateName(entry.issue.state);
      runningByState.set(key, (runningByState.get(key) ?? 0) + 1);
    }

    return sortForDispatch(issues).filter((issue) => {
      const retries = this.retryEntriesForIssue(issue.id);
      const dueRetries = retries.filter(([, retry]) => this.retryIsDue(retry));
      if (retries.length > 0 && dueRetries.length === 0) return false;
      if (dueRetries.length > 0) this.releaseStaleClaimsForRetry(issue.id);
      const blockedRetry = dueRetries[0]?.[1] ?? retries[0]?.[1];
      const dispatchState = {
        runningCount: this.state.running.size,
        runningByState,
        claimedSlots: this.state.claimed,
        workerCapacityAvailable: this.workerCapacityAvailable(),
      };
      const reason = dispatchBlockReason(issue, this.settings, dispatchState);
      if (reason) {
        this.state.blockedDispatches.push({
          issueId: issue.id,
          identifier: issue.identifier,
          state: issue.state,
          reason,
          workerHost: blockedRetry?.workerHost ?? null,
          issueUrl: issue.url ?? null,
        });
        for (const [key, retry] of dueRetries)
          this.rescheduleRetryAfterDispatchBlock(key, issue, retry, reason);
        return false;
      }
      return shouldDispatchIssue(issue, this.settings, dispatchState);
    });
  }

  claim(issue: Issue): RunningEntry | null {
    const retries = this.retryEntriesForIssue(issue.id);
    const retryEntry = retries.find(([, retry]) => this.retryIsDue(retry)) ?? retries[0];
    if (retryEntry && this.retryIsDue(retryEntry[1])) this.releaseStaleClaimsForRetry(issue.id);
    const retryEntryKey = retryEntry?.[0];
    const retry = retryEntry?.[1];
    const runningByState = new Map<string, number>();
    for (const entry of this.state.running.values()) {
      const key = normalizeStateName(entry.issue.state);
      runningByState.set(key, (runningByState.get(key) ?? 0) + 1);
    }
    if (
      !shouldDispatchIssue(issue, this.settings, {
        runningCount: this.state.running.size,
        runningByState,
        claimedSlots: this.state.claimed,
        workerCapacityAvailable: this.workerCapacityAvailable(),
      })
    ) {
      return null;
    }
    const slotIndex = firstUnclaimedSlot(
      issue,
      this.settings,
      this.state.claimed,
      retry?.slotIndex,
    );
    if (slotIndex === null) return null;
    const workerHost = this.selectWorkerHost(retry?.workerHost);
    if (workerHost === undefined) return null;

    const effective = settingsForIssueState(this.settings, issue.state);
    const size = ensembleSize(issue) ?? this.settings.agent.ensembleSize;
    const key = slotKey(issue.id, slotIndex);
    const entry: RunningEntry = {
      issue,
      identifier: issue.identifier,
      slotIndex,
      ensembleSize: size,
      agentKind: effective.agent.kind,
      workerHost,
      workspacePath: null,
      sessionId: null,
      executorPid: null,
      turnCount: 0,
      startedAt: this.clock.now(),
      lastAgentEvent: null,
      lastAgentTimestamp: null,
      usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
      lastReportedInputTokens: 0,
      lastReportedOutputTokens: 0,
      lastReportedTotalTokens: 0,
      retryAttempt: retry?.attempt ?? null,
    };

    this.state.claimed.add(key);
    this.state.running.set(key, entry);
    this.usageDeltaBases.set(key, zeroUsageTotals());
    if (retryEntryKey) this.state.retryAttempts.delete(retryEntryKey);
    return entry;
  }

  private selectWorkerHost(preferredHost?: string | null): string | null | undefined {
    const counts = new Map<string, number>();
    for (const entry of this.state.running.values()) {
      if (entry.workerHost) counts.set(entry.workerHost, (counts.get(entry.workerHost) ?? 0) + 1);
    }
    return selectLeastLoadedHost({
      hosts: this.settings.worker.sshHosts,
      runningCounts: counts,
      cap:
        this.settings.worker.maxConcurrentAgentsPerHost ?? this.settings.agent.maxConcurrentAgents,
      preferredHost,
    });
  }

  private workerCapacityAvailable(): boolean {
    if (this.settings.worker.sshHosts.length === 0) return true;
    return this.selectWorkerHost() !== undefined;
  }

  refreshRunningIssue(issue: Issue): void {
    for (const entry of this.state.running.values()) {
      if (entry.issue.id === issue.id) entry.issue = issue;
    }
  }

  applyUpdate(issueId: string, slotIndex: number, update: AgentUpdate): void {
    const key = slotKey(issueId, slotIndex);
    const entry = this.state.running.get(key);
    if (!entry) return;

    entry.lastAgentEvent = update.type;
    entry.lastAgentMessage = update.message;
    entry.lastAgentTimestamp = update.timestamp ?? this.clock.now();
    if (update.sessionId !== undefined) entry.sessionId = update.sessionId;
    if (update.executorPid !== undefined) entry.executorPid = update.executorPid;
    if (update.workspacePath !== undefined) entry.workspacePath = update.workspacePath;
    if (update.type === "turn_completed") entry.turnCount += 1;
    if (update.rateLimits !== undefined) this.state.rateLimits = update.rateLimits;
    if (update.usage) this.applyUsageUpdate(key, entry, update);
  }

  finish(
    issueId: string,
    slotIndex: number,
    normal: boolean,
    error?: string,
    retryKind: "failure" | "continuation" = "failure",
  ): void {
    const key = slotKey(issueId, slotIndex);
    const entry = this.state.running.get(key);
    if (!entry) return;
    this.state.running.delete(key);
    this.state.claimed.delete(key);
    this.usageDeltaBases.delete(key);
    this.state.usageTotals.secondsRunning += Math.max(
      0,
      (this.clock.now().getTime() - entry.startedAt.getTime()) / 1000,
    );

    if (normal) {
      const attempt = retryKind === "continuation" ? 1 : (entry.retryAttempt ?? 0) + 1;
      this.state.completed.add(issueId);
      const deadline = this.retryDeadline(
        retryBackoffMs(attempt, this.settings.agent.maxRetryBackoffMs, retryKind),
      );
      this.state.retryAttempts.set(slotKey(issueId, slotIndex), {
        issueId,
        identifier: entry.identifier,
        issueUrl: entry.issue.url ?? null,
        attempt,
        monotonicDeadlineMs: deadline.monotonicDeadlineMs,
        dueAtIso: deadline.dueAtIso,
        slotIndex,
        workerHost: entry.workerHost,
        workspacePath: entry.workspacePath,
        error,
      });
    }
  }

  cleanupIssue(issueId: string): void {
    for (const [key, entry] of this.state.running.entries()) {
      if (entry.issue.id === issueId) {
        this.state.running.delete(key);
        this.state.claimed.delete(key);
        this.usageDeltaBases.delete(key);
      }
    }
    this.deleteRetryAttemptsForIssue(issueId);
    this.state.completed.add(issueId);
  }

  snapshot(): {
    running: RunningEntry[];
    retrying: RetryEntry[];
    blocked: DispatchBlockEntry[];
    usageTotals: UsageTotals;
    rateLimits: unknown;
  } {
    return {
      running: [...this.state.running.values()],
      retrying: [...this.state.retryAttempts.values()].map((entry) => ({ ...entry })),
      blocked: this.state.blockedDispatches.map((entry) => ({ ...entry })),
      usageTotals: { ...this.state.usageTotals },
      rateLimits: this.state.rateLimits,
    };
  }

  private applyUsageUpdate(key: string, entry: RunningEntry, update: AgentUpdate): void {
    if (!update.usage) return;
    if (update.usageKind === "delta") {
      this.applyIncrementalUsage(key, entry, update.usage);
      return;
    }
    this.applyCumulativeUsage(entry, update.usage);
  }

  private applyCumulativeUsage(entry: RunningEntry, usage: UsageTokenUpdate): void {
    const merged = mergeMonotonicUsage({
      entryTotals: entry.usageTotals,
      reportedTotals: {
        inputTokens: entry.lastReportedInputTokens,
        outputTokens: entry.lastReportedOutputTokens,
        totalTokens: entry.lastReportedTotalTokens,
        secondsRunning: 0,
      },
      globalTotals: this.state.usageTotals,
      update: usage,
    });

    entry.usageTotals = merged.entryTotals;
    entry.lastReportedInputTokens = merged.reportedTotals.inputTokens;
    entry.lastReportedOutputTokens = merged.reportedTotals.outputTokens;
    entry.lastReportedTotalTokens = merged.reportedTotals.totalTokens;
    this.state.usageTotals = merged.globalTotals;
  }

  private applyIncrementalUsage(key: string, entry: RunningEntry, usage: UsageTokenUpdate): void {
    const base = this.usageDeltaBases.get(key) ?? reportedUsageTotals(entry);
    const inputDelta = usageDelta(usage.inputTokens);
    const outputDelta = usageDelta(usage.outputTokens);
    const reportedTotalDelta = Number.isFinite(usage.totalTokens)
      ? Math.max(0, usage.totalTokens!, inputDelta + outputDelta)
      : inputDelta + outputDelta;

    const inputToAdd = deltaNotAlreadyReported(
      inputDelta,
      entry.lastReportedInputTokens,
      base.inputTokens,
    );
    const outputToAdd = deltaNotAlreadyReported(
      outputDelta,
      entry.lastReportedOutputTokens,
      base.outputTokens,
    );
    const totalToAdd = deltaNotAlreadyReported(
      reportedTotalDelta,
      entry.lastReportedTotalTokens,
      base.totalTokens,
    );

    const nextInput = entry.usageTotals.inputTokens + inputToAdd;
    const nextOutput = entry.usageTotals.outputTokens + outputToAdd;
    const nextTotal = Math.max(entry.usageTotals.totalTokens + totalToAdd, nextInput + nextOutput);
    const actualTotalToAdd = nextTotal - entry.usageTotals.totalTokens;

    entry.usageTotals = {
      inputTokens: nextInput,
      outputTokens: nextOutput,
      totalTokens: nextTotal,
      secondsRunning: entry.usageTotals.secondsRunning,
    };
    this.state.usageTotals = {
      inputTokens: this.state.usageTotals.inputTokens + inputToAdd,
      outputTokens: this.state.usageTotals.outputTokens + outputToAdd,
      totalTokens: this.state.usageTotals.totalTokens + actualTotalToAdd,
      secondsRunning: this.state.usageTotals.secondsRunning,
    };

    const nextBase = {
      inputTokens: base.inputTokens + inputDelta,
      outputTokens: base.outputTokens + outputDelta,
      totalTokens: base.totalTokens + reportedTotalDelta,
      secondsRunning: 0,
    };
    this.usageDeltaBases.set(key, nextBase);
    entry.lastReportedInputTokens = Math.max(entry.lastReportedInputTokens, nextBase.inputTokens);
    entry.lastReportedOutputTokens = Math.max(
      entry.lastReportedOutputTokens,
      nextBase.outputTokens,
    );
    entry.lastReportedTotalTokens = Math.max(entry.lastReportedTotalTokens, nextBase.totalTokens);
  }

  private cleanupRetryAttempts(issues: Issue[]): void {
    for (const issue of issues) {
      if (!issueIsActive(issue, this.settings)) this.deleteRetryAttemptsForIssue(issue.id);
    }
  }

  private retryDeadline(delayMs: number): { dueAtIso: string; monotonicDeadlineMs: number } {
    const dueAt = this.clock.now();
    dueAt.setTime(dueAt.getTime() + delayMs);
    return {
      dueAtIso: dueAt.toISOString(),
      monotonicDeadlineMs: this.clock.monotonicMs() + delayMs,
    };
  }

  private rescheduleRetryAfterDispatchBlock(
    key: string,
    issue: Issue,
    retry: RetryEntry,
    reason: DispatchBlockReason,
  ): void {
    const attempt = retry.attempt + 1;
    const deadline = this.retryDeadline(
      retryBackoffMs(attempt, this.settings.agent.maxRetryBackoffMs, "failure"),
    );
    this.state.retryAttempts.set(key, {
      ...retry,
      issueId: issue.id,
      identifier: issue.identifier,
      issueUrl: issue.url ?? retry.issueUrl ?? null,
      attempt,
      monotonicDeadlineMs: deadline.monotonicDeadlineMs,
      dueAtIso: deadline.dueAtIso,
      error: dispatchBlockError(reason),
    });
  }

  private releaseStaleClaimsForRetry(issueId: string): void {
    for (const key of [...this.state.claimed]) {
      if (!key.startsWith(`${issueId}:`)) continue;
      if (!this.state.running.has(key)) this.state.claimed.delete(key);
    }
  }

  private retryEntriesForIssue(issueId: string): Array<[string, RetryEntry]> {
    return [...this.state.retryAttempts.entries()]
      .filter(([, retry]) => retry.issueId === issueId)
      .sort((left, right) => retrySlotIndex(left[1]) - retrySlotIndex(right[1]));
  }

  private retryIsDue(retry: RetryEntry): boolean {
    return this.clock.monotonicMs() >= retry.monotonicDeadlineMs;
  }

  private deleteRetryAttemptsForIssue(issueId: string): void {
    for (const [key, retry] of this.state.retryAttempts.entries()) {
      if (retry.issueId === issueId) this.state.retryAttempts.delete(key);
    }
  }
}

function dispatchBlockError(reason: DispatchBlockReason): string {
  return `dispatch blocked by ${reason.replaceAll("_", " ")}`;
}
