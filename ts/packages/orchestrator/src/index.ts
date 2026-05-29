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
import { SlotRegistry, RunningHandleImpl, type IRunningHandle } from "@symphony/fsm";

// --- Derived state view (backward-compatible interface) ---

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

export interface ClaimResult extends RunningEntry {
  handle: IRunningHandle;
}

export class Orchestrator {
  readonly slotRegistry: SlotRegistry = new SlotRegistry();

  // Aggregated usage totals (derived computation kept on orchestrator)
  private _usageTotals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    secondsRunning: 0,
  };
  private _rateLimits: unknown = null;
  private _blockedDispatches: DispatchBlockEntry[] = [];

  // RunningEntry data stored alongside the FSM (keyed by slot key)
  private readonly _entries: Map<string, RunningEntry> = new Map();

  // RetryEntry data stored alongside the FSM (keyed by issue id)
  private readonly _retries: Map<string, RetryEntry> = new Map();

  // Completed issue ids
  private readonly _completed: Set<string> = new Set();

  constructor(
    public settings: Settings,
    private readonly clock: ClockPort = systemClock,
    state?: OrchestratorState,
  ) {
    // Seed from legacy state if provided
    if (state && (state.running.size > 0 || state.claimed.size > 0)) {
      for (const [key, entry] of state.running) {
        this._entries.set(key, entry);
        this.slotRegistry.getOrCreate(key);
        this.slotRegistry.transition(key, {
          kind: "claim",
          runId: key,
          entry: entry as unknown as Record<string, unknown>,
          handle: { runId: key, controller: new AbortController() },
        });
      }
      for (const key of state.claimed) {
        if (!this._entries.has(key)) {
          this.slotRegistry.getOrCreate(key);
          // Mark as claimed without a running entry (stale claim)
          this.slotRegistry.transition(key, {
            kind: "claim",
            runId: key,
            entry: {},
            handle: { runId: key, controller: new AbortController() },
          });
        }
      }
      for (const [id, retry] of state.retryAttempts) {
        this._retries.set(id, retry);
      }
      for (const id of state.completed) {
        this._completed.add(id);
      }
      this._usageTotals = { ...state.usageTotals };
      this._rateLimits = state.rateLimits;
    }
  }

  /** Backward-compatible state view derived from registry. */
  get state(): OrchestratorState {
    return {
      running: this._entries,
      claimed: this._claimedSet(),
      retryAttempts: this._retries,
      completed: this._completed,
      usageTotals: this._usageTotals,
      rateLimits: this._rateLimits,
      blockedDispatches: this._blockedDispatches,
    };
  }

  private _claimedSet(): Set<string> {
    // Build claimed set from registry: any slot in claimed or running state
    const set = new Set<string>();
    for (const [key, state] of this.slotRegistry.entries()) {
      if (state.kind === "claimed" || state.kind === "running") {
        set.add(key);
      }
    }
    return set;
  }

  eligibleIssues(issues: Issue[]): Issue[] {
    // Remove retry attempts if the issue is no longer active
    this.cleanupRetryAttempts(issues);
    this._blockedDispatches = [];
    const runningByState = new Map<string, number>();
    for (const entry of this._entries.values()) {
      runningByState.set(entry.issue.state, (runningByState.get(entry.issue.state) ?? 0) + 1);
    }

    const claimed = this._claimedSet();

    // Check if issues can be dispatched to workers and sort by priority
    return sortForDispatch(issues).filter((issue) => {
      const retry = this._retries.get(issue.id);
      // Not yet time for retry
      if (retry && retry.dueAt.getTime() > this.clock.now().getTime()) return false;
      if (retry) this.releaseStaleClaimsForRetry(issue.id);
      const dispatchState = {
        runningCount: this._entries.size,
        runningByState,
        claimedSlots: claimed,
        workerCapacityAvailable: this.workerCapacityAvailable(),
      };
      const reason = dispatchBlockReason(issue, this.settings, dispatchState);
      if (reason) {
        this._blockedDispatches.push({
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

  claim(issue: Issue): ClaimResult | null {
    const retry = this._retries.get(issue.id);
    // If it's not yet time to retry and the issue isn't running, release the claim
    if (retry && retry.dueAt.getTime() <= this.clock.now().getTime())
      this.releaseStaleClaimsForRetry(issue.id);
    const runningByState = new Map<string, number>();
    for (const entry of this._entries.values()) {
      runningByState.set(entry.issue.state, (runningByState.get(entry.issue.state) ?? 0) + 1);
    }
    const claimed = this._claimedSet();
    if (
      !shouldDispatchIssue(issue, this.settings, {
        runningCount: this._entries.size,
        runningByState,
        claimedSlots: claimed,
        workerCapacityAvailable: this.workerCapacityAvailable(),
      })
    ) {
      return null;
    }
    const slotIndex = firstUnclaimedSlot(issue, this.settings, claimed, retry?.slotIndex);
    if (slotIndex === null) return null;
    const workerHost = this.selectWorkerHost();
    if (workerHost === undefined) return null; // would happen if all hosts are at capacity

    // Override bits of the settings if specified (from the WORKFLOW.md YAML front matter)
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

    // Create a proper RunningHandle for this generation
    const handle = new RunningHandleImpl(key, key, slotIndex, issue.id, this.slotRegistry);

    // Store entry and transition FSM
    this._entries.set(key, entry);
    this._retries.delete(issue.id);

    // If slot is in terminal 'done' state, reset it so it can be reclaimed
    const existing = this.slotRegistry.getState(key);
    if (existing !== null && existing.kind === "done") {
      this.slotRegistry.delete(key);
    }
    this.slotRegistry.getOrCreate(key);
    this.slotRegistry.transition(key, {
      kind: "claim",
      runId: key,
      entry: entry as unknown as Record<string, unknown>,
      handle: { runId: key, controller: handle.controller },
    });

    return Object.assign(entry, { handle });
  }

  private selectWorkerHost(): string | null | undefined {
    // Count number of running agents on each worker host, returning the least loaded host
    const counts = new Map<string, number>();
    for (const entry of this._entries.values()) {
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

  refreshRunningIssue(issue: Issue): void {
    for (const entry of this._entries.values()) {
      if (entry.issue.id === issue.id) entry.issue = issue;
    }
  }

  applyUpdate(issueId: string, slotIndex: number, update: AgentUpdate): void {
    const key = slotKey(issueId, slotIndex);
    const entry = this._entries.get(key);
    if (!entry) return;

    entry.lastAgentEvent = update.type;
    entry.lastAgentMessage = update.message;
    entry.lastAgentTimestamp = update.timestamp ?? this.clock.now();
    if (update.sessionId !== undefined) entry.sessionId = update.sessionId;
    if (update.resumeId !== undefined) entry.resumeId = update.resumeId;
    if (update.executorPid !== undefined) entry.executorPid = update.executorPid;
    if (update.workspacePath !== undefined) entry.workspacePath = update.workspacePath;
    if (update.type === "turn_completed") entry.turnCount += 1;
    if (update.rateLimits !== undefined) this._rateLimits = update.rateLimits;
    if (update.usage) this.applyUsageDelta(entry, update.usage);

    // Transition claimed->running or running self-loop in FSM
    this.slotRegistry.transition(key, { kind: "agent_update", runId: key });
  }

  finish(
    issueId: string,
    slotIndex: number,
    normal: boolean,
    error?: string,
    retryKind: "failure" | "continuation" = "failure",
  ): void {
    const key = slotKey(issueId, slotIndex);
    const entry = this._entries.get(key);
    if (!entry) return;
    this._entries.delete(key);
    this._usageTotals.secondsRunning += Math.max(
      0,
      (this.clock.now().getTime() - entry.startedAt.getTime()) / 1000,
    );

    if (normal) {
      const attempt = retryKind === "continuation" ? 1 : (entry.retryAttempt ?? 0) + 1;
      this._completed.add(issueId);
      this._retries.set(issueId, {
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
      // Transition FSM to retrying
      this.slotRegistry.transition(key, { kind: "run_finished", runId: key });
    } else {
      // Non-normal finish transitions to done
      this.slotRegistry.transition(key, {
        kind: "reconcile_terminal",
        reason: error ?? "abnormal",
      });
    }
  }

  cleanupIssue(issueId: string): void {
    for (const [key, entry] of this._entries.entries()) {
      if (entry.issue.id === issueId) {
        this._entries.delete(key);
        // Transition FSM to done
        this.slotRegistry.transition(key, {
          kind: "reconcile_terminal",
          reason: "cleanup",
        });
      }
    }
    this._retries.delete(issueId);
    this._completed.add(issueId);
  }

  snapshot(): {
    running: RunningEntry[];
    retrying: RetryEntry[];
    blocked: DispatchBlockEntry[];
    usageTotals: UsageTotals;
    rateLimits: unknown;
  } {
    return {
      running: [...this._entries.values()],
      retrying: [...this._retries.values()],
      blocked: this._blockedDispatches.map((entry) => ({ ...entry })),
      usageTotals: { ...this._usageTotals },
      rateLimits: this._rateLimits,
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
      globalTotals: this._usageTotals,
      update: usage,
    });

    entry.usageTotals = merged.entryTotals;
    entry.lastReportedInputTokens = merged.reportedTotals.inputTokens;
    entry.lastReportedOutputTokens = merged.reportedTotals.outputTokens;
    entry.lastReportedTotalTokens = merged.reportedTotals.totalTokens;
    this._usageTotals = merged.globalTotals;
  }

  private cleanupRetryAttempts(issues: Issue[]): void {
    for (const issue of issues) {
      if (!issueIsActive(issue, this.settings)) this._retries.delete(issue.id);
    }
  }

  private dueAt(delayMs: number): Date {
    const dueAt = this.clock.now();
    dueAt.setTime(dueAt.getTime() + delayMs);
    return dueAt;
  }

  private releaseStaleClaimsForRetry(issueId: string): void {
    // Release FSM slots that are in 'claimed' state without a running entry
    for (const [key, slotState] of this.slotRegistry.entries()) {
      if (!key.startsWith(`${issueId}:`)) continue;
      if (slotState.kind === "claimed" && !this._entries.has(key)) {
        // Transition stale claim to done so the slot can be reclaimed
        this.slotRegistry.transition(key, {
          kind: "reconcile_terminal",
          reason: "stale_claim_release",
        });
      }
    }
  }
}
