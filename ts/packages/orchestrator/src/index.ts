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
  type AgentKind,
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

/**
 * Internal record of a phase-1 slot hold while the dispatch coordinator negotiates capacity
 * asynchronously. Keyed by slotKey(issueId, slotIndex) in {@link OrchestratorState.reserved}.
 * Host-less by design: the orchestrator never stores a non-concrete worker host.
 */
export interface ReservationRecord {
  /** Kept whole so per-state cap accounting (runningByState) works for reservations. */
  issue: Issue;
  slotIndex: number;
  /** Opaque per-reservation token; bind/cancel are no-ops on mismatch (ABA guard). */
  token: string;
  agentKind: AgentKind;
  ensembleSize: number;
  /** Prior run's concrete host from the consumed retry entry. */
  affinityHost: string | null;
  retryAttempt: number | null;
  reservedAt: Date;
  /** Defensive expiry, swept by {@link Orchestrator.eligibleIssues}. */
  expiresAtMonotonicMs: number;
  /** The due RetryEntry consumed at reserve time, kept so cancel can restore it. */
  consumedRetry: { key: string; entry: RetryEntry } | null;
}

export interface OrchestratorState {
  running: Map<string, RunningEntry>;
  /** Phase-1 slot reservations; counted in EVERY concurrency-cap check. */
  reserved: Map<string, ReservationRecord>;
  /** Contains running AND reserved keys. */
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
    reserved: new Map(),
    claimed: new Set(),
    retryAttempts: new Map(),
    completed: new Set(),
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    rateLimits: null,
    blockedDispatches: [],
  };
}

/**
 * Phase-1 hold on a dispatch slot while the coordinator negotiates capacity.
 * Host-less by design: the orchestrator never records a non-concrete host.
 */
export interface SlotReservation {
  readonly issueId: string;
  readonly identifier: string;
  readonly slotIndex: number;
  /** Opaque per-reservation token; bind/cancel are no-ops on mismatch (ABA guard). */
  readonly token: string;
  readonly agentKind: AgentKind;
  readonly ensembleSize: number;
  /**
   * Prior run's CONCRETE workerHost from the consumed RetryEntry; threads into the
   * coordinator's acquire as the sticky-retry affinity key.
   */
  readonly affinityHost: string | null;
  readonly retryAttempt: number | null;
  /** Defensive expiry (acquireTimeoutMs * 2 + 60s grace); swept by eligibleIssues. */
  readonly expiresAtMonotonicMs: number;
}

export type ClaimResult =
  /** Static/local path (no governing pool): the RunningEntry is minted at claim time. */
  | { kind: "running"; entry: RunningEntry }
  /**
   * Pool governs: the slot is held host-less; the concrete host arrives via
   * {@link Orchestrator.bindReservation} after the coordinator binds a run slot.
   */
  | { kind: "reserved"; reservation: SlotReservation };

/** One entry of {@link Orchestrator.snapshot}'s `reserving` lane (in-acquire slots). */
export interface ReservationSnapshotEntry {
  issueId: string;
  identifier: string;
  slotIndex: number;
  affinityHost: string | null;
  retryAttempt: number | null;
  reservedAtIso: string;
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

/**
 * Optional capacity gate supplied by a configured worker pool. The probe is installed for the
 * orchestrator's LIFETIME whenever a pool object exists, but a config reload can DISABLE or REMOVE
 * the pool (it drains to zero) without the probe being torn down. {@link CapacityProbe.governs}
 * reports whether the live pool currently governs capacity: only while it does are worker-host
 * decisions delegated to {@link CapacityProbe.canAcquire} and the static `sshHosts` selection
 * bypassed (claim then holds the slot as a host-less reservation until
 * {@link Orchestrator.bindReservation} supplies the concrete bound host). Once it no longer
 * governs (a disabled pool), both paths fall through to the normal static/local logic so a
 * reload that turns the pool off cannot permanently block dispatch as `worker_host_capacity`.
 */
export interface CapacityProbe {
  governs(): boolean;
  canAcquire(): boolean;
}

export class Orchestrator {
  readonly state: OrchestratorState;
  private readonly usageDeltaBases = new Map<string, UsageTotals>();
  private nextReservationToken = 1;

  constructor(
    public settings: Settings,
    private readonly clock: ClockPort = systemClock,
    state: OrchestratorState = createState(),
    private readonly capacityProbe?: CapacityProbe,
  ) {
    this.state = state;
  }

  /**
   * Per-state counts of slots holding concurrency capacity: running entries PLUS reserved
   * (in-acquire) slots. Reservations must count toward every cap or dispatch could exceed
   * `maxConcurrentAgents` during acquire windows.
   */
  private runningByStateCounts(): Map<string, number> {
    const runningByState = new Map<string, number>();
    const fold = (issue: Issue): void => {
      const key = normalizeStateName(issue.state);
      runningByState.set(key, (runningByState.get(key) ?? 0) + 1);
    };
    for (const entry of this.state.running.values()) fold(entry.issue);
    for (const record of this.state.reserved.values()) fold(record.issue);
    return runningByState;
  }

  /** Total slots holding concurrency capacity (running + reserved). */
  private occupiedSlotCount(): number {
    return this.state.running.size + this.state.reserved.size;
  }

  eligibleIssues(issues: Issue[]): Issue[] {
    this.sweepExpiredReservations();
    this.cleanupRetryAttempts(issues);
    this.state.blockedDispatches = [];
    const runningByState = this.runningByStateCounts();

    return sortForDispatch(issues).filter((issue) => {
      const retries = this.retryEntriesForIssue(issue.id);
      const dueRetries = retries.filter(([, retry]) => this.retryIsDue(retry));
      if (retries.length > 0 && dueRetries.length === 0) return false;
      if (dueRetries.length > 0) this.releaseStaleClaimsForRetry(issue.id);
      const blockedRetry = dueRetries[0]?.[1] ?? retries[0]?.[1];
      const dispatchState = {
        runningCount: this.occupiedSlotCount(),
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

  claim(issue: Issue): ClaimResult | null {
    const retries = this.retryEntriesForIssue(issue.id);
    const retryEntry = retries.find(([, retry]) => this.retryIsDue(retry)) ?? retries[0];
    if (retryEntry && this.retryIsDue(retryEntry[1])) this.releaseStaleClaimsForRetry(issue.id);
    const retryEntryKey = retryEntry?.[0];
    const retry = retryEntry?.[1];
    if (
      !shouldDispatchIssue(issue, this.settings, {
        runningCount: this.occupiedSlotCount(),
        runningByState: this.runningByStateCounts(),
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
    if (this.capacityProbe?.governs()) {
      // The pool governs capacity: hold the slot host-less while the coordinator
      // negotiates a concrete worker asynchronously (bindReservation mints the
      // RunningEntry only once a real host is bound).
      return { kind: "reserved", reservation: this.reserveSlot(issue, slotIndex, retryEntry) };
    }
    // No pool (or a disabled pool whose probe no longer governs): take the normal
    // static/local selection, which yields null/local when ssh_hosts is empty.
    const selected = this.selectWorkerHost(retry?.workerHost);
    if (selected === undefined) return null;
    const workerHost = selected;

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
    return { kind: "running", entry };
  }

  /**
   * Phase 1 of the pool-governed dispatch: registers a host-less {@link ReservationRecord}
   * holding the dispatch slot (claimed + reserved, NOT running) and consumes the due retry
   * entry, stashing it on the record so {@link Orchestrator.cancelReservation} can restore it.
   */
  private reserveSlot(
    issue: Issue,
    slotIndex: number,
    retryEntry: [string, RetryEntry] | undefined,
  ): SlotReservation {
    const effective = settingsForIssueState(this.settings, issue.state);
    const size = ensembleSize(issue) ?? this.settings.agent.ensembleSize;
    const key = slotKey(issue.id, slotIndex);
    const acquireTimeoutMs = this.settings.worker.workerPool?.acquireTimeoutMs ?? 30_000;
    const record: ReservationRecord = {
      issue,
      slotIndex,
      token: `reservation-${this.nextReservationToken++}`,
      agentKind: effective.agent.kind,
      ensembleSize: size,
      affinityHost: retryEntry?.[1].workerHost ?? null,
      retryAttempt: retryEntry?.[1].attempt ?? null,
      reservedAt: this.clock.now(),
      // Strictly longer than any well-behaved acquire: the pool's waiter timer bounds
      // the non-grow path at acquireTimeoutMs; the generous grace covers a grow's
      // provision + readiness probes.
      expiresAtMonotonicMs: this.clock.monotonicMs() + acquireTimeoutMs * 2 + 60_000,
      consumedRetry: retryEntry ? { key: retryEntry[0], entry: retryEntry[1] } : null,
    };
    this.state.claimed.add(key);
    this.state.reserved.set(key, record);
    if (retryEntry) this.state.retryAttempts.delete(retryEntry[0]);
    return {
      issueId: issue.id,
      identifier: issue.identifier,
      slotIndex,
      token: record.token,
      agentKind: record.agentKind,
      ensembleSize: record.ensembleSize,
      affinityHost: record.affinityHost,
      retryAttempt: record.retryAttempt,
      expiresAtMonotonicMs: record.expiresAtMonotonicMs,
    };
  }

  /**
   * Phase 2: atomically mints the RunningEntry with the CONCRETE bound host and moves the slot
   * from `reserved` to `running`. Returns null when the reservation was cancelled/expired (or
   * re-reserved) meanwhile - the token mismatch is the ABA guard - in which case the caller
   * releases the bound slot healthy. `startedAt` is the bind time, so run seconds never bill
   * the provision wait.
   */
  bindReservation(reservation: SlotReservation, workerHost: string): RunningEntry | null {
    const key = slotKey(reservation.issueId, reservation.slotIndex);
    const record = this.state.reserved.get(key);
    if (!record || record.token !== reservation.token) return null;
    this.state.reserved.delete(key);
    const entry: RunningEntry = {
      issue: record.issue,
      identifier: record.issue.identifier,
      slotIndex: record.slotIndex,
      ensembleSize: record.ensembleSize,
      agentKind: record.agentKind,
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
      retryAttempt: record.retryAttempt,
    };
    this.state.claimed.add(key);
    this.state.running.set(key, entry);
    this.usageDeltaBases.set(key, zeroUsageTotals());
    return entry;
  }

  /**
   * Frees a reserved slot with NO backoff and RESTORES the consumed RetryEntry (affinity and
   * attempt counter survive a capacity miss). Idempotent and token-checked: a stale reservation
   * (cancelled, expired, or superseded by a re-reserve) is a no-op.
   */
  cancelReservation(reservation: SlotReservation): void {
    const key = slotKey(reservation.issueId, reservation.slotIndex);
    const record = this.state.reserved.get(key);
    if (!record || record.token !== reservation.token) return;
    this.cancelReservationRecord(key, record);
  }

  /** Shared cancel path for token-checked cancels, the expiry sweep, and cleanupIssue. */
  private cancelReservationRecord(key: string, record: ReservationRecord): void {
    this.state.reserved.delete(key);
    this.state.claimed.delete(key);
    const consumed = record.consumedRetry;
    if (consumed && !this.state.retryAttempts.has(consumed.key)) {
      this.state.retryAttempts.set(consumed.key, consumed.entry);
    }
  }

  /**
   * Cancels (with retry restore) any reservation past its defensive expiry so a hung acquire
   * (e.g. a wedged endpoint open) cannot strand a concurrency slot until shutdown. A late
   * successful acquire after the sweep is token-guarded to a null bind.
   */
  private sweepExpiredReservations(): void {
    const nowMs = this.clock.monotonicMs();
    for (const [key, record] of [...this.state.reserved.entries()]) {
      if (nowMs >= record.expiresAtMonotonicMs) this.cancelReservationRecord(key, record);
    }
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
    // Only honor the probe while the live pool actually governs capacity. A disabled
    // pool's probe lingers but reports canAcquire() === false; deferring to it would
    // permanently block dispatch as worker_host_capacity, so fall through to the
    // static/local logic (local has capacity, ssh_hosts honored) instead.
    if (this.capacityProbe?.governs()) return this.capacityProbe.canAcquire();
    if (this.settings.worker.sshHosts.length === 0) return true;
    return this.selectWorkerHost() !== undefined;
  }

  refreshRunningIssue(issue: Issue): void {
    for (const entry of this.state.running.values()) {
      if (entry.issue.id === issue.id) entry.issue = issue;
    }
    // Reserved records feed per-state cap accounting, so a long acquire must not
    // hold a stale issue state either.
    for (const record of this.state.reserved.values()) {
      if (record.issue.id === issue.id) record.issue = issue;
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
    // Cancel any in-acquire reservation (token retired -> a late bind returns null).
    // The restore-then-delete composition is safe: the subsequent
    // deleteRetryAttemptsForIssue removes any restored retry entry.
    for (const [key, record] of [...this.state.reserved.entries()]) {
      if (record.issue.id === issueId) this.cancelReservationRecord(key, record);
    }
    this.deleteRetryAttemptsForIssue(issueId);
    this.state.completed.add(issueId);
  }

  snapshot(): {
    running: RunningEntry[];
    reserving: ReservationSnapshotEntry[];
    retrying: RetryEntry[];
    blocked: DispatchBlockEntry[];
    usageTotals: UsageTotals;
    rateLimits: unknown;
  } {
    return {
      running: [...this.state.running.values()],
      reserving: [...this.state.reserved.values()].map((record) => ({
        issueId: record.issue.id,
        identifier: record.issue.identifier,
        slotIndex: record.slotIndex,
        affinityHost: record.affinityHost,
        retryAttempt: record.retryAttempt,
        reservedAtIso: record.reservedAt.toISOString(),
      })),
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
      // Claimed-without-running is a legitimate state while a reservation holds the
      // slot; releasing it here would let a due retry on one ensemble slot free
      // another slot's live reservation and enable duplicate same-slot dispatch.
      if (this.state.reserved.has(key)) continue;
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
