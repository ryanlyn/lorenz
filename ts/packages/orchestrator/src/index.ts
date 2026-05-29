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

import { type SlotState, transitionSlot } from "./slot-state.js";

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

  /**
   * Slot FSM state -- the authoritative source of truth for slot lifecycle phase.
   * The legacy `state.running`/`state.claimed`/`state.retryAttempts` collections are
   * maintained in parallel during the migration period. Once all consumers read from
   * the FSM directly, the legacy collections can be removed.
   *
   * TODO(fsm-migration): Remove dual-write to legacy collections
   * (`state.running`, `state.claimed`, `state.retryAttempts`) once snapshot() and
   * eligibleIssues() read from the FSM. Target: next iteration after this FSM
   * stabilizes (i.e., after the runtime integration tests pass without legacy reads).
   */
  private readonly slots = new Map<string, SlotState>();

  constructor(
    public settings: Settings,
    private readonly clock: ClockPort = systemClock,
    state: OrchestratorState = createState(),
  ) {
    this.state = state;
  }

  private getSlotState(key: string): SlotState {
    return this.slots.get(key) ?? { phase: "idle" };
  }

  private setSlotState(key: string, slotState: SlotState): void {
    if (slotState.phase === "idle" || slotState.phase === "completed") {
      this.slots.delete(key);
    } else {
      this.slots.set(key, slotState);
    }
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

    // Transition slot state machine
    const slotState = this.getSlotState(key);
    this.setSlotState(key, transitionSlot(slotState, { type: "CLAIM", entry }));

    // Maintain legacy data structures
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

  refreshRunningIssue(issue: Issue): void {
    for (const entry of this.state.running.values()) {
      if (entry.issue.id === issue.id) entry.issue = issue;
    }
  }

  applyUpdate(issueId: string, slotIndex: number, update: AgentUpdate): void {
    const key = slotKey(issueId, slotIndex);

    // Read from slot FSM as the guard -- only process updates for running slots
    const slotState = this.getSlotState(key);
    if (slotState.phase !== "running") return;

    // Transition slot state -- UPDATE mutates the entry in place and returns
    // the same state reference, so slotState.entry remains valid after this call.
    this.setSlotState(
      key,
      transitionSlot(slotState, { type: "UPDATE", update, now: this.clock.now() }),
    );

    // Handle orchestrator-level side effects not managed by slot state
    if (update.rateLimits !== undefined) this.state.rateLimits = update.rateLimits;
    if (update.usage) this.applyUsageDelta(slotState.entry, update.usage);
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

    // Accumulate runtime before clearing
    this.state.usageTotals.secondsRunning += Math.max(
      0,
      (this.clock.now().getTime() - entry.startedAt.getTime()) / 1000,
    );

    if (normal) {
      const attempt = retryKind === "continuation" ? 1 : (entry.retryAttempt ?? 0) + 1;
      const retryEntry: RetryEntry = {
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
      };

      // Transition slot state machine: running -> retrying
      const slotState = this.getSlotState(key);
      this.setSlotState(key, transitionSlot(slotState, { type: "FINISH_WITH_RETRY", retryEntry }));

      // Maintain legacy data structures
      this.state.completed.add(issueId);
      this.state.retryAttempts.set(issueId, retryEntry);
    } else {
      // Transition slot state machine: running -> idle
      const slotState = this.getSlotState(key);
      this.setSlotState(key, transitionSlot(slotState, { type: "FINISH_NO_RETRY" }));
    }

    // Clear from legacy running/claimed
    this.state.running.delete(key);
    this.state.claimed.delete(key);
  }

  cleanupIssue(issueId: string): void {
    // Collect keys first to avoid iterating while mutating
    const runningKeys = [...this.state.running.entries()]
      .filter(([, entry]) => entry.issue.id === issueId)
      .map(([key]) => key);
    for (const key of runningKeys) {
      const slotState = this.getSlotState(key);
      this.setSlotState(key, transitionSlot(slotState, { type: "CLEANUP" }));
      this.state.running.delete(key);
      this.state.claimed.delete(key);
    }

    // Also cleanup any retry-phase slots for this issue.
    // Uses issueIdFromSlotKey to stay coupled to the canonical slotKey format.
    const retryKeys = [...this.slots.entries()]
      .filter(([key, s]) => issueIdFromSlotKey(key) === issueId && s.phase === "retrying")
      .map(([key]) => key);
    for (const key of retryKeys) {
      const slotState = this.getSlotState(key);
      this.setSlotState(key, transitionSlot(slotState, { type: "CLEANUP" }));
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
      if (issueIdFromSlotKey(key) !== issueId) continue;
      // Use the slot FSM as the source of truth: if the slot is not in "running"
      // phase, the claim is stale and should be released.
      const slot = this.getSlotState(key);
      if (slot.phase !== "running") this.state.claimed.delete(key);
    }
  }
}

/**
 * Extracts the issueId portion from a slot key produced by slotKey().
 * Coupled to the `${issueId}:${slotIndex}` format defined in @symphony/dispatch.
 */
function issueIdFromSlotKey(key: string): string {
  const sep = key.lastIndexOf(":");
  return sep === -1 ? key : key.slice(0, sep);
}

export type { SlotState, SlotEvent } from "./slot-state.js";
export { transitionSlot, initialSlotState } from "./slot-state.js";
