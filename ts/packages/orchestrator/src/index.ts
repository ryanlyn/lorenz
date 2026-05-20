import {
  dispatchBlockReason,
  firstUnclaimedSlot,
  issueIsActive,
  shouldDispatchIssue,
  slotKey,
  sortForDispatch,
} from "@symphony/dispatch";
import { ensembleSize } from "@symphony/issue";
import { settingsForIssueState } from "@symphony/config";
import { retryBackoffMs } from "@symphony/policies/retry";
import { mergeMonotonicUsage } from "@symphony/policies/usage";
import { selectLeastLoadedHost } from "@symphony/policies/workerHost";
import type {
  AgentUpdate,
  DispatchBlockEntry,
  Issue,
  RetryEntry,
  RunningEntry,
  Settings,
  UsageTotals,
} from "@symphony/domain";
import { systemClock, type ClockPort } from "@symphony/ports";

export interface OrchestratorState {
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
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

export class Orchestrator {
  readonly state: OrchestratorState;

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
      runningByState.set(entry.issue.state, (runningByState.get(entry.issue.state) ?? 0) + 1);
    }

    return sortForDispatch(issues).filter((issue) => {
      const retry = this.state.retryAttempts.get(issue.id);
      if (retry && retry.dueAt.getTime() > this.clock.now().getTime()) return false;
      if (retry) this.releaseStaleClaimsForRetry(issue.id);
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
          workerHost: null,
        });
        return false;
      }
      return shouldDispatchIssue(issue, this.settings, dispatchState);
    });
  }

  claim(issue: Issue): RunningEntry | null {
    const retry = this.state.retryAttempts.get(issue.id);
    if (retry && retry.dueAt.getTime() <= this.clock.now().getTime())
      this.releaseStaleClaimsForRetry(issue.id);
    const runningByState = new Map<string, number>();
    for (const entry of this.state.running.values()) {
      runningByState.set(entry.issue.state, (runningByState.get(entry.issue.state) ?? 0) + 1);
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
    const workerHost = this.selectWorkerHost();
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
      resumeId: null,
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
    this.state.retryAttempts.delete(issue.id);
    return entry;
  }

  private selectWorkerHost(): string | null | undefined {
    const counts = new Map<string, number>();
    for (const entry of this.state.running.values()) {
      if (entry.workerHost) counts.set(entry.workerHost, (counts.get(entry.workerHost) ?? 0) + 1);
    }
    return selectLeastLoadedHost({
      hosts: this.settings.worker.sshHosts,
      runningCounts: counts,
      cap:
        this.settings.worker.maxConcurrentAgentsPerHost ?? this.settings.agent.maxConcurrentAgents,
    });
  }

  private workerCapacityAvailable(): boolean {
    if (this.settings.worker.sshHosts.length === 0) return true;
    return this.selectWorkerHost() !== undefined;
  }

  applyUpdate(issueId: string, slotIndex: number, update: AgentUpdate): void {
    const entry = this.state.running.get(slotKey(issueId, slotIndex));
    if (!entry) return;

    entry.lastAgentEvent = update.type;
    entry.lastAgentMessage = update.message;
    entry.lastAgentTimestamp = update.timestamp ?? this.clock.now();
    if (update.sessionId !== undefined) entry.sessionId = update.sessionId;
    if (update.resumeId !== undefined) entry.resumeId = update.resumeId;
    if (update.executorPid !== undefined) entry.executorPid = update.executorPid;
    if (update.workspacePath !== undefined) entry.workspacePath = update.workspacePath;
    if (update.type === "turn_completed") entry.turnCount += 1;
    if (update.rateLimits !== undefined) this.state.rateLimits = update.rateLimits;
    if (update.usage) this.applyUsageDelta(entry, update.usage);
  }

  finish(
    issueId: string,
    slotIndex: number,
    normal: boolean,
    error?: string | undefined,
    retryKind: "failure" | "continuation" = "failure",
  ): void {
    const key = slotKey(issueId, slotIndex);
    const entry = this.state.running.get(key);
    if (!entry) return;
    this.state.running.delete(key);
    this.state.claimed.delete(key);
    this.state.usageTotals.secondsRunning += Math.max(
      0,
      (this.clock.now().getTime() - entry.startedAt.getTime()) / 1000,
    );

    if (normal) {
      const attempt = retryKind === "continuation" ? 1 : (entry.retryAttempt ?? 0) + 1;
      this.state.completed.add(issueId);
      this.state.retryAttempts.set(issueId, {
        issueId,
        identifier: entry.identifier,
        attempt,
        dueAt: this.dueAt(
          retryBackoffMs(attempt, this.settings.agent.maxRetryBackoffMs, retryKind),
        ),
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
      }
    }
    this.state.retryAttempts.delete(issueId);
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
      retrying: [...this.state.retryAttempts.values()],
      blocked: this.state.blockedDispatches.map((entry) => ({ ...entry })),
      usageTotals: { ...this.state.usageTotals },
      rateLimits: this.state.rateLimits,
    };
  }

  private applyUsageDelta(entry: RunningEntry, usage: Partial<UsageTotals>): void {
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

  private cleanupRetryAttempts(issues: Issue[]): void {
    for (const issue of issues) {
      if (!issueIsActive(issue, this.settings)) this.state.retryAttempts.delete(issue.id);
    }
  }

  private dueAt(delayMs: number): Date {
    const dueAt = this.clock.now();
    dueAt.setTime(dueAt.getTime() + delayMs);
    return dueAt;
  }

  private releaseStaleClaimsForRetry(issueId: string): void {
    for (const key of [...this.state.claimed]) {
      if (!key.startsWith(`${issueId}:`)) continue;
      if (!this.state.running.has(key)) this.state.claimed.delete(key);
    }
  }
}
