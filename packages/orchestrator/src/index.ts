import { randomUUID } from "node:crypto";

import {
  dispatchBlockReason,
  firstUnclaimedSlot,
  issueIsActive,
  shouldDispatchIssue,
  slotKey,
  sortForDispatch,
} from "@lorenz/dispatch";
import { ensembleSize } from "@lorenz/issue";
import { normalizeStateName, settingsForIssueState } from "@lorenz/config";
import { retryBackoffMs } from "@lorenz/policies/retry";
import { mergeMonotonicUsage } from "@lorenz/policies/usage";
import { selectLeastLoadedHost } from "@lorenz/policies/workerHost";
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
} from "@lorenz/domain";

import { createState, type OrchestratorState, type ReservationRecord } from "./state.js";
import {
  InMemoryClaimStore,
  NoopClaimStoreMutation,
  isAsyncClaimStore,
  isClaimStoreLike,
  type ClaimStore,
  type ClaimStoreLike,
  type ClaimStoreOperation,
  type ClaimStoreStatus,
} from "./claimStore.js";

export {
  CLAIM_STORE_SNAPSHOT_VERSION,
  hydrateState,
  serializeState,
  type HydrateStateOptions,
  type SerializedOrchestratorState,
  type SerializedReservationRecord,
  type SerializedRunningEntry,
} from "./codec.js";
export { createState, type OrchestratorState, type ReservationRecord } from "./state.js";
export {
  InMemoryClaimStore,
  PersistentClaimStore,
  AsyncPersistentClaimStore,
  isAsyncClaimStore,
  isClaimStore,
  isClaimStoreLike,
  NoopClaimStoreMutation,
  type AsyncClaimStore,
  type AsyncClaimStoreBackend,
  type ClaimStore,
  type ClaimStoreBackend,
  type ClaimStoreCapabilities,
  type ClaimStoreCheckpoint,
  type ClaimStoreLike,
  type ClaimStoreOperation,
  type ClaimStoreStatus,
} from "./claimStore.js";

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

function isToolCallNotification(update: AgentUpdate): boolean {
  if (update.type !== "session_notification") return false;
  if (!isRecord(update.message)) return false;
  const payload = update.message.update;
  return isRecord(payload) && payload.sessionUpdate === "tool_call";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  private readonly claimStore: ClaimStoreLike;

  constructor(
    public settings: Settings,
    private readonly clock: ClockPort = systemClock,
    stateOrClaimStore: OrchestratorState | ClaimStoreLike = createState(),
    private readonly capacityProbe?: CapacityProbe,
  ) {
    this.claimStore = isClaimStoreLike(stateOrClaimStore)
      ? stateOrClaimStore
      : new InMemoryClaimStore(stateOrClaimStore);
    this.state = this.claimStore.state;
  }

  claimStoreStatus(): ClaimStoreStatus {
    return this.claimStore.status();
  }

  ownsClaim(issueId: string, slotIndex: number): boolean {
    const key = slotKey(issueId, slotIndex);
    return this.syncClaimStore().read(() => this.claimIsOwnedByThisStore(key));
  }

  async ownsClaimAsync(issueId: string, slotIndex: number): Promise<boolean> {
    const key = slotKey(issueId, slotIndex);
    return this.claimStore.read(() => this.claimIsOwnedByThisStore(key));
  }

  heartbeatClaimOwner(): void {
    this.syncClaimStore().heartbeatOwner();
  }

  async heartbeatClaimOwnerAsync(): Promise<void> {
    await this.claimStore.heartbeatOwner();
  }

  private withClaimStore<T>(operation: ClaimStoreOperation, run: () => T): T {
    return this.syncClaimStore().transaction(operation, run);
  }

  private async withClaimStoreAsync<T>(operation: ClaimStoreOperation, run: () => T): Promise<T> {
    return this.claimStore.transaction(operation, run);
  }

  private noopAsNull<T>(run: () => T): T | null {
    try {
      return run();
    } catch (error) {
      if (error instanceof NoopClaimStoreMutation) return null;
      throw error;
    }
  }

  private async noopAsNullAsync<T>(run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof NoopClaimStoreMutation) return null;
      throw error;
    }
  }

  private ignoreNoop(run: () => void): void {
    try {
      run();
    } catch (error) {
      if (error instanceof NoopClaimStoreMutation) return;
      throw error;
    }
  }

  private async ignoreNoopAsync(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (error instanceof NoopClaimStoreMutation) return;
      throw error;
    }
  }

  private syncClaimStore(): ClaimStore {
    if (isAsyncClaimStore(this.claimStore)) throw new Error("async_claim_store_requires_async_api");
    return this.claimStore;
  }

  private claimIsOwnedByThisStore(key: string): boolean {
    if (
      !this.state.claimed.has(key) &&
      !this.state.running.has(key) &&
      !this.state.reserved.has(key)
    )
      return false;
    return (this.state.claimOwners.get(key) ?? this.claimStore.ownerId) === this.claimStore.ownerId;
  }

  private recordClaimOwner(key: string): void {
    this.state.claimOwners.set(key, this.claimStore.ownerId);
  }

  private releaseClaimOwner(key: string): void {
    this.state.claimOwners.delete(key);
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

  private canSkipUnchangedEligibleIssues(): boolean {
    const capabilities = this.claimStore.capabilities;
    return (
      capabilities.crashRecovery ||
      capabilities.sharedAcrossProcesses ||
      capabilities.retryDurability
    );
  }

  eligibleIssues(issues: Issue[]): Issue[] {
    try {
      return this.withClaimStore("eligible_issues", () => this.eligibleIssuesInTransaction(issues));
    } catch (error) {
      if (error instanceof NoopClaimStoreMutation) return error.result as Issue[];
      throw error;
    }
  }

  async eligibleIssuesAsync(issues: Issue[]): Promise<Issue[]> {
    try {
      return await this.withClaimStoreAsync("eligible_issues", () =>
        this.eligibleIssuesInTransaction(issues),
      );
    } catch (error) {
      if (error instanceof NoopClaimStoreMutation) return error.result as Issue[];
      throw error;
    }
  }

  private eligibleIssuesInTransaction(issues: Issue[]): Issue[] {
    let stateChanged = this.sweepExpiredReservations();
    stateChanged = this.cleanupRetryAttempts(issues) || stateChanged;
    const blockedDispatches: DispatchBlockEntry[] = [];
    const runningByState = this.runningByStateCounts();

    const result = sortForDispatch(issues).filter((issue) => {
      const retries = this.retryEntriesForIssue(issue.id);
      const dueRetries = retries.filter(([, retry]) => this.retryIsDue(retry));
      if (retries.length > 0 && dueRetries.length === 0) return false;
      if (dueRetries.length > 0)
        stateChanged = this.releaseStaleClaimsForRetry(issue.id) || stateChanged;
      const blockedRetry = dueRetries[0]?.[1] ?? retries[0]?.[1];
      const dispatchState = {
        runningCount: this.occupiedSlotCount(),
        runningByState,
        claimedSlots: this.state.claimed,
        workerCapacityAvailable: this.workerCapacityAvailable(),
      };
      const reason = dispatchBlockReason(issue, this.settings, dispatchState);
      if (reason) {
        blockedDispatches.push({
          issueId: issue.id,
          identifier: issue.identifier,
          state: issue.state,
          reason,
          workerHost: blockedRetry?.workerHost ?? null,
          issueUrl: issue.url ?? null,
        });
        for (const [key, retry] of dueRetries)
          stateChanged =
            this.rescheduleRetryAfterDispatchBlock(key, issue, retry, reason) || stateChanged;
        return false;
      }
      return shouldDispatchIssue(issue, this.settings, dispatchState);
    });
    if (!dispatchBlockEntriesEqual(this.state.blockedDispatches, blockedDispatches)) {
      this.state.blockedDispatches = blockedDispatches;
      stateChanged = true;
    }
    if (!stateChanged && this.canSkipUnchangedEligibleIssues()) {
      throw new NoopClaimStoreMutation(result);
    }
    return result;
  }

  claim(issue: Issue): ClaimResult | null {
    return this.noopAsNull(() =>
      this.withClaimStore("claim", () => this.claimInTransaction(issue)),
    );
  }

  async claimAsync(issue: Issue): Promise<ClaimResult | null> {
    return this.noopAsNullAsync(async () =>
      this.withClaimStoreAsync("claim", () => this.claimInTransaction(issue)),
    );
  }

  private claimInTransaction(issue: Issue): ClaimResult | null {
    const retries = this.retryEntriesForIssue(issue.id);
    const retryEntry = retries.find(([, retry]) => this.retryIsDue(retry)) ?? retries[0];
    let stateChanged = false;
    if (retryEntry && this.retryIsDue(retryEntry[1]))
      stateChanged = this.releaseStaleClaimsForRetry(issue.id) || stateChanged;
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
      if (stateChanged) return null;
      throw new NoopClaimStoreMutation();
    }
    const slotIndex = firstUnclaimedSlot(
      issue,
      this.settings,
      this.state.claimed,
      retry?.slotIndex,
    );
    if (slotIndex === null) {
      if (stateChanged) return null;
      throw new NoopClaimStoreMutation();
    }
    if (this.capacityProbe?.governs()) {
      // The pool governs capacity: hold the slot host-less while the coordinator
      // negotiates a concrete worker asynchronously (bindReservation mints the
      // RunningEntry only once a real host is bound).
      return { kind: "reserved", reservation: this.reserveSlot(issue, slotIndex, retryEntry) };
    }
    // No pool (or a disabled pool whose probe no longer governs): take the normal
    // static/local selection, which yields null/local when ssh_hosts is empty.
    const selected = this.selectWorkerHost(retry?.workerHost);
    if (selected === undefined) {
      if (stateChanged) return null;
      throw new NoopClaimStoreMutation();
    }
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
      toolCallCount: 0,
      usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
      lastReportedInputTokens: 0,
      lastReportedOutputTokens: 0,
      lastReportedTotalTokens: 0,
      retryAttempt: retry?.attempt ?? null,
    };

    this.state.claimed.add(key);
    this.recordClaimOwner(key);
    this.state.running.set(key, entry);
    this.state.usageDeltaBases.set(key, zeroUsageTotals());
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
    const reservedAt = this.clock.now();
    const expiryDelayMs = acquireTimeoutMs * 2 + 60_000;
    const expiresAt = new Date(reservedAt.getTime() + expiryDelayMs);
    const record: ReservationRecord = {
      issue,
      slotIndex,
      token: `reservation-${randomUUID()}`,
      agentKind: effective.agent.kind,
      ensembleSize: size,
      affinityHost: retryEntry?.[1].workerHost ?? null,
      retryAttempt: retryEntry?.[1].attempt ?? null,
      reservedAt,
      expiresAt,
      // Strictly longer than any well-behaved acquire: the pool's waiter timer bounds
      // the non-grow path at acquireTimeoutMs; the generous grace covers a grow's
      // provision + readiness probes.
      expiresAtMonotonicMs: this.clock.monotonicMs() + expiryDelayMs,
      consumedRetry: retryEntry ? { key: retryEntry[0], entry: retryEntry[1] } : null,
    };
    this.state.claimed.add(key);
    this.recordClaimOwner(key);
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
    return this.noopAsNull(() =>
      this.withClaimStore("bind_reservation", () =>
        this.bindReservationInTransaction(reservation, workerHost),
      ),
    );
  }

  async bindReservationAsync(
    reservation: SlotReservation,
    workerHost: string,
  ): Promise<RunningEntry | null> {
    return this.noopAsNullAsync(async () =>
      this.withClaimStoreAsync("bind_reservation", () =>
        this.bindReservationInTransaction(reservation, workerHost),
      ),
    );
  }

  private bindReservationInTransaction(
    reservation: SlotReservation,
    workerHost: string,
  ): RunningEntry | null {
    const key = slotKey(reservation.issueId, reservation.slotIndex);
    const record = this.state.reserved.get(key);
    if (!record || record.token !== reservation.token || !this.claimIsOwnedByThisStore(key))
      throw new NoopClaimStoreMutation();
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
      toolCallCount: 0,
      usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
      lastReportedInputTokens: 0,
      lastReportedOutputTokens: 0,
      lastReportedTotalTokens: 0,
      retryAttempt: record.retryAttempt,
    };
    this.state.claimed.add(key);
    this.recordClaimOwner(key);
    this.state.running.set(key, entry);
    this.state.usageDeltaBases.set(key, zeroUsageTotals());
    return entry;
  }

  /**
   * Frees a reserved slot with NO backoff and RESTORES the consumed RetryEntry (affinity and
   * attempt counter survive a capacity miss). Idempotent and token-checked: a stale reservation
   * (cancelled, expired, or superseded by a re-reserve) is a no-op.
   */
  cancelReservation(reservation: SlotReservation): void {
    this.ignoreNoop(() =>
      this.withClaimStore("cancel_reservation", () =>
        this.cancelReservationInTransaction(reservation),
      ),
    );
  }

  async cancelReservationAsync(reservation: SlotReservation): Promise<void> {
    await this.ignoreNoopAsync(async () =>
      this.withClaimStoreAsync("cancel_reservation", () =>
        this.cancelReservationInTransaction(reservation),
      ),
    );
  }

  private cancelReservationInTransaction(reservation: SlotReservation): void {
    const key = slotKey(reservation.issueId, reservation.slotIndex);
    const record = this.state.reserved.get(key);
    if (!record || record.token !== reservation.token || !this.claimIsOwnedByThisStore(key))
      throw new NoopClaimStoreMutation();
    this.cancelReservationRecord(key, record);
  }

  abandonClaim(issueId: string, slotIndex: number): void {
    this.ignoreNoop(() =>
      this.withClaimStore("abandon_claim", () =>
        this.abandonClaimInTransaction(issueId, slotIndex),
      ),
    );
  }

  async abandonClaimAsync(issueId: string, slotIndex: number): Promise<void> {
    await this.ignoreNoopAsync(async () =>
      this.withClaimStoreAsync("abandon_claim", () =>
        this.abandonClaimInTransaction(issueId, slotIndex),
      ),
    );
  }

  private abandonClaimInTransaction(issueId: string, slotIndex: number): void {
    const key = slotKey(issueId, slotIndex);
    if (!this.claimIsOwnedByThisStore(key)) throw new NoopClaimStoreMutation();
    const reservation = this.state.reserved.get(key);
    if (reservation) {
      this.cancelReservationRecord(key, reservation);
      return;
    }
    const running = this.state.running.get(key);
    if (running) this.restoreRunningRetry(key, running);
    this.state.running.delete(key);
    this.state.claimed.delete(key);
    this.releaseClaimOwner(key);
    this.state.usageDeltaBases.delete(key);
  }

  /** Shared cancel path for token-checked cancels, the expiry sweep, and cleanupIssue. */
  private cancelReservationRecord(key: string, record: ReservationRecord): void {
    this.state.reserved.delete(key);
    this.state.claimed.delete(key);
    this.releaseClaimOwner(key);
    const consumed = record.consumedRetry;
    if (consumed && !this.state.retryAttempts.has(consumed.key)) {
      this.state.retryAttempts.set(consumed.key, consumed.entry);
    }
  }

  private restoreRunningRetry(key: string, entry: RunningEntry): void {
    if (entry.retryAttempt === null || this.state.retryAttempts.has(key)) return;
    this.state.retryAttempts.set(key, {
      issueId: entry.issue.id,
      identifier: entry.identifier,
      issueUrl: entry.issue.url ?? null,
      attempt: entry.retryAttempt,
      monotonicDeadlineMs: this.clock.monotonicMs(),
      dueAtIso: this.clock.now().toISOString(),
      slotIndex: entry.slotIndex,
      workerHost: entry.workerHost,
      workspacePath: entry.workspacePath,
    });
  }

  /**
   * Cancels (with retry restore) any reservation past its defensive expiry so a hung acquire
   * (e.g. a wedged endpoint open) cannot strand a concurrency slot until shutdown. A late
   * successful acquire after the sweep is token-guarded to a null bind.
   */
  private sweepExpiredReservations(): boolean {
    const nowMs = this.clock.monotonicMs();
    let stateChanged = false;
    for (const [key, record] of [...this.state.reserved.entries()]) {
      if (nowMs >= record.expiresAtMonotonicMs) {
        this.cancelReservationRecord(key, record);
        stateChanged = true;
      }
    }
    return stateChanged;
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
    this.ignoreNoop(() =>
      this.withClaimStore("refresh_running_issue", () =>
        this.refreshRunningIssueInTransaction(issue),
      ),
    );
  }

  async refreshRunningIssueAsync(issue: Issue): Promise<void> {
    await this.ignoreNoopAsync(async () =>
      this.withClaimStoreAsync("refresh_running_issue", () =>
        this.refreshRunningIssueInTransaction(issue),
      ),
    );
  }

  private refreshRunningIssueInTransaction(issue: Issue): void {
    let stateChanged = false;
    for (const entry of this.state.running.values()) {
      if (entry.issue.id === issue.id && entry.issue !== issue) {
        entry.issue = issue;
        stateChanged = true;
      }
    }
    // Reserved records feed per-state cap accounting, so a long acquire must not
    // hold a stale issue state either.
    for (const record of this.state.reserved.values()) {
      if (record.issue.id === issue.id && record.issue !== issue) {
        record.issue = issue;
        stateChanged = true;
      }
    }
    if (!stateChanged) throw new NoopClaimStoreMutation();
  }

  applyUpdate(issueId: string, slotIndex: number, update: AgentUpdate): void {
    try {
      if (agentUpdateCanSkipCheckpoint(update)) {
        this.applyUpdateInTransaction(issueId, slotIndex, update);
        return;
      }
      this.withClaimStore("apply_update", () =>
        this.applyUpdateInTransaction(issueId, slotIndex, update),
      );
    } catch (error) {
      if (error instanceof NoopClaimStoreMutation) return;
      throw error;
    }
  }

  async applyUpdateAsync(issueId: string, slotIndex: number, update: AgentUpdate): Promise<void> {
    try {
      if (agentUpdateCanSkipCheckpoint(update)) {
        this.applyUpdateInTransaction(issueId, slotIndex, update);
        return;
      }
      await this.withClaimStoreAsync("apply_update", () =>
        this.applyUpdateInTransaction(issueId, slotIndex, update),
      );
    } catch (error) {
      if (error instanceof NoopClaimStoreMutation) return;
      throw error;
    }
  }

  private applyUpdateInTransaction(issueId: string, slotIndex: number, update: AgentUpdate): void {
    const key = slotKey(issueId, slotIndex);
    const entry = this.state.running.get(key);
    if (!entry) throw new NoopClaimStoreMutation();
    if (!this.claimIsOwnedByThisStore(key)) throw new NoopClaimStoreMutation();

    entry.lastAgentEvent = update.type;
    entry.lastAgentMessage = update.message;
    entry.lastAgentTimestamp = update.timestamp ?? this.clock.now();
    if (update.sessionId !== undefined) entry.sessionId = update.sessionId;
    if (update.executorPid !== undefined) entry.executorPid = update.executorPid;
    if (update.workspacePath !== undefined) entry.workspacePath = update.workspacePath;
    if (update.type === "turn_completed") entry.turnCount += 1;
    if (isToolCallNotification(update)) entry.toolCallCount = (entry.toolCallCount ?? 0) + 1;
    if (update.rateLimits !== undefined) this.state.rateLimits = update.rateLimits;
    if (update.usage) this.applyUsageUpdate(key, entry, update);
  }

  finish(
    issueId: string,
    slotIndex: number,
    normal: boolean,
    error?: string,
    retryKind: "failure" | "continuation" = "failure",
  ): RunningEntry | null {
    return this.noopAsNull(() =>
      this.withClaimStore("finish", () =>
        this.finishInTransaction(issueId, slotIndex, normal, error, retryKind),
      ),
    );
  }

  async finishAsync(
    issueId: string,
    slotIndex: number,
    normal: boolean,
    error?: string,
    retryKind: "failure" | "continuation" = "failure",
  ): Promise<RunningEntry | null> {
    return this.noopAsNullAsync(async () =>
      this.withClaimStoreAsync("finish", () =>
        this.finishInTransaction(issueId, slotIndex, normal, error, retryKind),
      ),
    );
  }

  private finishInTransaction(
    issueId: string,
    slotIndex: number,
    normal: boolean,
    error: string | undefined,
    retryKind: "failure" | "continuation",
  ): RunningEntry | null {
    const key = slotKey(issueId, slotIndex);
    const entry = this.state.running.get(key);
    if (!entry) throw new NoopClaimStoreMutation();
    if (!this.claimIsOwnedByThisStore(key)) throw new NoopClaimStoreMutation();
    this.state.running.delete(key);
    this.state.claimed.delete(key);
    this.releaseClaimOwner(key);
    this.state.usageDeltaBases.delete(key);
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
    return entry;
  }

  cleanupIssue(issueId: string): void {
    this.ignoreNoop(() =>
      this.withClaimStore("cleanup_issue", () => this.cleanupIssueInTransaction(issueId)),
    );
  }

  async cleanupIssueAsync(issueId: string): Promise<void> {
    await this.ignoreNoopAsync(async () =>
      this.withClaimStoreAsync("cleanup_issue", () => this.cleanupIssueInTransaction(issueId)),
    );
  }

  private cleanupIssueInTransaction(issueId: string): void {
    let stateChanged = false;
    for (const [key, entry] of this.state.running.entries()) {
      if (entry.issue.id === issueId && this.claimIsOwnedByThisStore(key)) {
        this.state.running.delete(key);
        this.state.claimed.delete(key);
        this.releaseClaimOwner(key);
        this.state.usageDeltaBases.delete(key);
        stateChanged = true;
      }
    }
    // Cancel any in-acquire reservation (token retired -> a late bind returns null).
    // The restore-then-delete composition is safe: the subsequent
    // deleteRetryAttemptsForIssue removes any restored retry entry.
    for (const [key, record] of [...this.state.reserved.entries()]) {
      if (record.issue.id === issueId && this.claimIsOwnedByThisStore(key)) {
        this.cancelReservationRecord(key, record);
        stateChanged = true;
      }
    }
    stateChanged = this.deleteRetryAttemptsForIssue(issueId) || stateChanged;
    if (!this.state.completed.has(issueId)) {
      this.state.completed.add(issueId);
      stateChanged = true;
    }
    if (!stateChanged) throw new NoopClaimStoreMutation();
  }

  snapshot(): OrchestratorSnapshot {
    if (isAsyncClaimStore(this.claimStore)) return this.snapshotInTransaction();
    return this.syncClaimStore().read(() => this.snapshotInTransaction());
  }

  async snapshotAsync(): Promise<OrchestratorSnapshot> {
    return this.claimStore.read(() => this.snapshotInTransaction());
  }

  private snapshotInTransaction(): OrchestratorSnapshot {
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
      claimStore: this.claimStore.status(),
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
    const base = this.state.usageDeltaBases.get(key) ?? reportedUsageTotals(entry);
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
    this.state.usageDeltaBases.set(key, nextBase);
    entry.lastReportedInputTokens = Math.max(entry.lastReportedInputTokens, nextBase.inputTokens);
    entry.lastReportedOutputTokens = Math.max(
      entry.lastReportedOutputTokens,
      nextBase.outputTokens,
    );
    entry.lastReportedTotalTokens = Math.max(entry.lastReportedTotalTokens, nextBase.totalTokens);
  }

  private cleanupRetryAttempts(issues: Issue[]): boolean {
    let stateChanged = false;
    for (const issue of issues) {
      if (!issueIsActive(issue, this.settings))
        stateChanged = this.deleteRetryAttemptsForIssue(issue.id) || stateChanged;
    }
    return stateChanged;
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
  ): boolean {
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
    return true;
  }

  private releaseStaleClaimsForRetry(issueId: string): boolean {
    let stateChanged = false;
    for (const key of [...this.state.claimed]) {
      if (!key.startsWith(`${issueId}:`)) continue;
      // Claimed-without-running is a legitimate state while a reservation holds the
      // slot; releasing it here would let a due retry on one ensemble slot free
      // another slot's live reservation and enable duplicate same-slot dispatch.
      if (this.state.reserved.has(key)) continue;
      if (!this.state.running.has(key)) {
        this.state.claimed.delete(key);
        this.releaseClaimOwner(key);
        stateChanged = true;
      }
    }
    return stateChanged;
  }

  private retryEntriesForIssue(issueId: string): Array<[string, RetryEntry]> {
    return [...this.state.retryAttempts.entries()]
      .filter(([, retry]) => retry.issueId === issueId)
      .sort((left, right) => retrySlotIndex(left[1]) - retrySlotIndex(right[1]));
  }

  private retryIsDue(retry: RetryEntry): boolean {
    return this.clock.monotonicMs() >= retry.monotonicDeadlineMs;
  }

  private deleteRetryAttemptsForIssue(issueId: string): boolean {
    let stateChanged = false;
    for (const [key, retry] of this.state.retryAttempts.entries()) {
      if (retry.issueId === issueId) {
        this.state.retryAttempts.delete(key);
        stateChanged = true;
      }
    }
    return stateChanged;
  }
}

function dispatchBlockEntriesEqual(
  left: DispatchBlockEntry[],
  right: DispatchBlockEntry[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      entry.issueId === other.issueId &&
      entry.identifier === other.identifier &&
      entry.state === other.state &&
      entry.reason === other.reason &&
      (entry.workerHost ?? null) === (other.workerHost ?? null) &&
      (entry.issueUrl ?? null) === (other.issueUrl ?? null)
    );
  });
}

function agentUpdateCanSkipCheckpoint(update: AgentUpdate): boolean {
  return (
    update.type === "session_notification" &&
    update.usage === undefined &&
    update.rateLimits === undefined &&
    update.workspacePath === undefined
  );
}

export interface OrchestratorSnapshot {
  running: RunningEntry[];
  reserving: ReservationSnapshotEntry[];
  retrying: RetryEntry[];
  blocked: DispatchBlockEntry[];
  usageTotals: UsageTotals;
  rateLimits: unknown;
  claimStore: ClaimStoreStatus;
}

function dispatchBlockError(reason: DispatchBlockReason): string {
  return `dispatch blocked by ${reason.replaceAll("_", " ")}`;
}
