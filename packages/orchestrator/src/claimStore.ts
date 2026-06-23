import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

import { isRecord, type RetryEntry, type RunningEntry } from "@lorenz/domain";

import {
  hydrateState,
  serializeState,
  type HydrateStateOptions,
  type SerializedOrchestratorState,
} from "./codec.js";
import { createState, type OrchestratorState, type ReservationRecord } from "./state.js";

export type ClaimStoreOperation =
  | "eligible_issues"
  | "claim"
  | "bind_reservation"
  | "cancel_reservation"
  | "refresh_running_issue"
  | "apply_update"
  | "finish"
  | "abandon_claim"
  | "cleanup_issue";

export interface ClaimStoreCapabilities {
  crashRecovery: boolean;
  sharedAcrossProcesses: boolean;
  retryDurability: boolean;
}

export interface ClaimStoreStatus {
  kind: string;
  ownerId: string;
  capabilities: ClaimStoreCapabilities;
  hydratedAt: string;
  transactionsApplied: number;
  lastOperation: ClaimStoreOperation | null;
  lastCheckpointAt: string | null;
}

export interface ClaimStore {
  readonly kind: string;
  readonly ownerId: string;
  readonly capabilities: ClaimStoreCapabilities;
  readonly state: OrchestratorState;
  read<T>(run: (state: OrchestratorState) => T): T;
  transaction<T>(operation: ClaimStoreOperation, run: (state: OrchestratorState) => T): T;
  heartbeatOwner(): void;
  status(): ClaimStoreStatus;
}

export interface AsyncClaimStore {
  readonly async: true;
  readonly kind: string;
  readonly ownerId: string;
  readonly capabilities: ClaimStoreCapabilities;
  readonly state: OrchestratorState;
  read<T>(run: (state: OrchestratorState) => T): Promise<T>;
  transaction<T>(operation: ClaimStoreOperation, run: (state: OrchestratorState) => T): Promise<T>;
  heartbeatOwner(): Promise<void>;
  status(): ClaimStoreStatus;
}

export type ClaimStoreLike = ClaimStore | AsyncClaimStore;

export interface ClaimStoreCheckpoint {
  version: 1;
  ownerId: string;
  writtenAt: string;
  operation: ClaimStoreOperation | "hydrate" | "flush" | "recover_stale_owners";
  state: SerializedOrchestratorState;
}

export class NoopClaimStoreMutation extends Error {
  constructor(readonly result?: unknown) {
    super("noop_claim_store_mutation");
  }
}

const noopAfterRecoverySymbol = Symbol("noop_after_recovery");

interface NoopAfterRecovery {
  readonly [noopAfterRecoverySymbol]: true;
  readonly error: NoopClaimStoreMutation;
}

function noopAfterRecovery(error: NoopClaimStoreMutation): NoopAfterRecovery {
  return { [noopAfterRecoverySymbol]: true, error };
}

function isNoopAfterRecovery(value: unknown): value is NoopAfterRecovery {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<NoopAfterRecovery>)[noopAfterRecoverySymbol] === true
  );
}

export interface ClaimStoreBackend {
  readonly kind: string;
  readonly capabilities: ClaimStoreCapabilities;
  load(): ClaimStoreCheckpoint | null;
  save(checkpoint: ClaimStoreCheckpoint): void;
  withExclusiveTransaction?<T>(run: () => T): T;
  heartbeatOwner?(ownerId: string, at: Date): void;
  ownerIsActive?(ownerId: string, now: Date, staleMs: number): boolean;
  close?(): void;
}

export interface AsyncClaimStoreBackend {
  readonly kind: string;
  readonly capabilities: ClaimStoreCapabilities;
  load(): Promise<ClaimStoreCheckpoint | null>;
  save(checkpoint: ClaimStoreCheckpoint): Promise<void>;
  withExclusiveTransaction?<T>(run: () => Promise<T>): Promise<T>;
  heartbeatOwner?(ownerId: string, at: Date): Promise<void>;
  ownerIsActive?(ownerId: string, now: Date, staleMs: number): Promise<boolean>;
  close?(): Promise<void>;
}

export interface InMemoryClaimStoreOptions {
  ownerId?: string | undefined;
  hydratedAt?: Date | undefined;
}

let nextInMemoryOwnerId = 1;

export class InMemoryClaimStore implements ClaimStore {
  readonly kind = "memory";
  readonly capabilities: ClaimStoreCapabilities = {
    crashRecovery: false,
    sharedAcrossProcesses: false,
    retryDurability: false,
  };
  readonly ownerId: string;
  private readonly hydratedAt: Date;
  private transactionsApplied = 0;
  private lastOperation: ClaimStoreOperation | null = null;

  constructor(
    readonly state: OrchestratorState,
    options: InMemoryClaimStoreOptions = {},
  ) {
    this.ownerId = options.ownerId ?? `memory:${process.pid}:${nextInMemoryOwnerId++}`;
    this.hydratedAt = options.hydratedAt ?? new Date();
  }

  read<T>(run: (state: OrchestratorState) => T): T {
    return run(this.state);
  }

  transaction<T>(operation: ClaimStoreOperation, run: (state: OrchestratorState) => T): T {
    const result = run(this.state);
    this.transactionsApplied += 1;
    this.lastOperation = operation;
    return result;
  }

  heartbeatOwner(): void {
    // Memory stores are process-local, so there is no external owner lease to refresh.
  }

  status(): ClaimStoreStatus {
    return {
      kind: this.kind,
      ownerId: this.ownerId,
      capabilities: { ...this.capabilities },
      hydratedAt: this.hydratedAt.toISOString(),
      transactionsApplied: this.transactionsApplied,
      lastOperation: this.lastOperation,
      lastCheckpointAt: null,
    };
  }
}

export class AsyncPersistentClaimStore implements AsyncClaimStore {
  readonly async = true as const;
  readonly ownerId: string;
  readonly kind: string;
  readonly capabilities: ClaimStoreCapabilities;
  readonly state: OrchestratorState;
  private readonly hydratedAt: Date;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly ownerLeaseStaleMs: number;
  private readonly hydrateOptions: HydrateStateOptions | (() => HydrateStateOptions) | undefined;
  private transactionsApplied = 0;
  private lastOperation: ClaimStoreOperation | null = null;
  private lastCheckpointAt: string | null = null;

  private constructor(
    private readonly backend: AsyncClaimStoreBackend,
    options: PersistentClaimStoreOptions = {},
  ) {
    this.kind = backend.kind;
    this.capabilities = backend.capabilities;
    if (this.capabilities.sharedAcrossProcesses && !backend.withExclusiveTransaction) {
      throw new Error("shared_claim_store_backend_requires_exclusive_transaction");
    }
    if (
      this.capabilities.sharedAcrossProcesses &&
      this.capabilities.crashRecovery &&
      (!backend.heartbeatOwner || !backend.ownerIsActive)
    ) {
      throw new Error("shared_crash_recovery_claim_store_requires_owner_leases");
    }
    this.ownerId =
      options.ownerId ??
      `${backend.kind}:${process.pid}:${nextPersistentOwnerId++}:${randomUUID()}`;
    this.hydratedAt = options.hydratedAt ?? new Date();
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.ownerLeaseStaleMs = options.ownerLeaseStaleMs ?? 300_000;
    this.hydrateOptions = options.hydrate;
    this.state = createState();
  }

  static async create(
    backend: AsyncClaimStoreBackend,
    options: PersistentClaimStoreOptions = {},
  ): Promise<AsyncPersistentClaimStore> {
    const store = new AsyncPersistentClaimStore(backend, options);
    await store.loadInitial();
    return store;
  }

  async read<T>(run: (state: OrchestratorState) => T): Promise<T> {
    const apply = async (): Promise<T> => {
      if (this.capabilities.sharedAcrossProcesses)
        await this.reload({ heartbeatOwner: false, recoverInactiveOwners: false });
      return run(this.state);
    };
    return this.backend.withExclusiveTransaction
      ? this.backend.withExclusiveTransaction(apply)
      : apply();
  }

  async transaction<T>(
    operation: ClaimStoreOperation,
    run: (state: OrchestratorState) => T,
  ): Promise<T> {
    let rollback: (() => void) | null = null;
    const preserveRecoveredNoop = this.backend.withExclusiveTransaction !== undefined;
    const rollbackLocalState = (): void => {
      rollback?.();
      rollback = null;
    };
    const apply = async (): Promise<T | NoopAfterRecovery> => {
      let recoveredInactiveOwners = false;
      if (this.capabilities.sharedAcrossProcesses)
        recoveredInactiveOwners = await this.reload({
          heartbeatOwner: true,
          recoverInactiveOwners: true,
        });
      const rollbackState = cloneStateContents(this.state);
      const rollbackTransactionsApplied = this.transactionsApplied;
      const rollbackLastOperation = this.lastOperation;
      const rollbackLastCheckpointAt = this.lastCheckpointAt;
      rollback = () => {
        replaceStateContents(this.state, rollbackState);
        this.transactionsApplied = rollbackTransactionsApplied;
        this.lastOperation = rollbackLastOperation;
        this.lastCheckpointAt = rollbackLastCheckpointAt;
      };
      try {
        const result = run(this.state);
        this.transactionsApplied += 1;
        this.lastOperation = operation;
        await this.save(operation);
        return result;
      } catch (error) {
        rollbackLocalState();
        if (
          recoveredInactiveOwners &&
          preserveRecoveredNoop &&
          error instanceof NoopClaimStoreMutation
        )
          return noopAfterRecovery(error);
        throw error;
      }
    };
    if (!this.backend.withExclusiveTransaction) {
      try {
        return (await apply()) as T;
      } finally {
        rollback = null;
      }
    }
    try {
      const result = await this.backend.withExclusiveTransaction(apply);
      rollback = null;
      if (isNoopAfterRecovery(result)) throw result.error;
      return result;
    } catch (error) {
      rollbackLocalState();
      throw error;
    }
  }

  async flush(): Promise<void> {
    const apply = async (): Promise<void> => {
      if (this.capabilities.sharedAcrossProcesses)
        await this.reload({ heartbeatOwner: true, recoverInactiveOwners: true });
      await this.save("flush");
    };
    if (this.backend.withExclusiveTransaction) await this.backend.withExclusiveTransaction(apply);
    else await apply();
  }

  async heartbeatOwner(): Promise<void> {
    const apply = async (): Promise<void> => this.writeOwnerHeartbeat();
    if (this.backend.withExclusiveTransaction) await this.backend.withExclusiveTransaction(apply);
    else await apply();
  }

  async close(): Promise<void> {
    await this.backend.close?.();
  }

  status(): ClaimStoreStatus {
    return {
      kind: this.kind,
      ownerId: this.ownerId,
      capabilities: { ...this.capabilities },
      hydratedAt: this.hydratedAt.toISOString(),
      transactionsApplied: this.transactionsApplied,
      lastOperation: this.lastOperation,
      lastCheckpointAt: this.lastCheckpointAt,
    };
  }

  private async loadInitial(): Promise<void> {
    const apply = async (): Promise<void> => {
      await this.writeOwnerHeartbeat();
      const checkpoint = await this.backend.load();
      if (checkpoint)
        replaceStateContents(
          this.state,
          hydrateState(checkpoint.state, this.hydrate(this.recovery(), checkpoint.ownerId)),
        );
      this.lastCheckpointAt = checkpoint?.writtenAt ?? null;
      if (await this.recoverInactiveOwners()) await this.save("recover_stale_owners");
    };
    if (this.backend.withExclusiveTransaction) await this.backend.withExclusiveTransaction(apply);
    else await apply();
  }

  private async save(operation: ClaimStoreCheckpoint["operation"]): Promise<void> {
    const writtenAt = this.now().toISOString();
    await this.backend.save({
      version: 1,
      ownerId: this.ownerId,
      writtenAt,
      operation,
      state: serializeState(this.state),
    });
    this.lastCheckpointAt = writtenAt;
  }

  private async reload(options: {
    heartbeatOwner: boolean;
    recoverInactiveOwners: boolean;
  }): Promise<boolean> {
    if (options.heartbeatOwner) await this.writeOwnerHeartbeat();
    const ownedEphemeralFields = captureOwnedRunningEphemeralFields(this.state, this.ownerId);
    const checkpoint = await this.backend.load();
    replaceStateContents(
      this.state,
      checkpoint
        ? hydrateState(checkpoint.state, this.hydrate("preserve", checkpoint.ownerId))
        : createState(),
    );
    restoreOwnedRunningEphemeralFields(this.state, this.ownerId, ownedEphemeralFields);
    this.lastCheckpointAt = checkpoint?.writtenAt ?? null;
    if (options.recoverInactiveOwners && (await this.recoverInactiveOwners())) {
      await this.save("recover_stale_owners");
      return true;
    }
    return false;
  }

  private async writeOwnerHeartbeat(): Promise<void> {
    await this.backend.heartbeatOwner?.(this.ownerId, this.now());
  }

  private async recoverInactiveOwners(): Promise<boolean> {
    if (!this.capabilities.sharedAcrossProcesses || !this.backend.ownerIsActive) return false;
    const now = this.now();
    let recovered = false;
    const activeOwners = new Map<string, boolean>();
    for (const [key, ownerId] of [...this.state.claimOwners.entries()]) {
      if (ownerId === this.ownerId) continue;
      let ownerActive = activeOwners.get(ownerId);
      if (ownerActive === undefined) {
        ownerActive = await this.backend.ownerIsActive(ownerId, now, this.ownerLeaseStaleMs);
        activeOwners.set(ownerId, ownerActive);
      }
      if (ownerActive) continue;
      const reservation = this.state.reserved.get(key);
      if (
        reservation?.consumedRetry &&
        !this.state.retryAttempts.has(reservation.consumedRetry.key)
      ) {
        this.state.retryAttempts.set(
          reservation.consumedRetry.key,
          reservation.consumedRetry.entry,
        );
      }
      const running = this.state.running.get(key);
      if (running && running.retryAttempt !== null && !this.state.retryAttempts.has(key))
        this.state.retryAttempts.set(key, this.retryEntryFromRunningClaim(running, now));
      this.state.running.delete(key);
      this.state.reserved.delete(key);
      this.state.claimed.delete(key);
      this.state.claimOwners.delete(key);
      recovered = true;
    }
    return recovered;
  }

  private hydrate(
    recovery: HydrateStateOptions["reservationRecovery"],
    fallbackClaimOwnerId: string,
  ): HydrateStateOptions {
    const base =
      typeof this.hydrateOptions === "function"
        ? this.hydrateOptions()
        : (this.hydrateOptions ?? { now: this.now(), monotonicNowMs: this.monotonicNow() });
    return {
      ...base,
      fallbackClaimOwnerId,
      reservationRecovery: recovery,
      runningRecovery: recovery,
    };
  }

  private recovery(): HydrateStateOptions["reservationRecovery"] {
    return this.capabilities.sharedAcrossProcesses ? "preserve" : "abandon";
  }

  private retryEntryFromRunningClaim(entry: RunningEntry, now: Date): RetryEntry {
    return {
      issueId: entry.issue.id,
      identifier: entry.identifier,
      issueUrl: entry.issue.url ?? null,
      attempt: entry.retryAttempt ?? 1,
      monotonicDeadlineMs: this.monotonicNow(),
      dueAtIso: now.toISOString(),
      slotIndex: entry.slotIndex,
      workerHost: entry.workerHost,
      workspacePath: entry.workspacePath,
    };
  }
}

export interface PersistentClaimStoreOptions {
  ownerId?: string | undefined;
  hydratedAt?: Date | undefined;
  now?: (() => Date) | undefined;
  monotonicNow?: (() => number) | undefined;
  ownerLeaseStaleMs?: number | undefined;
  hydrate?: HydrateStateOptions | (() => HydrateStateOptions) | undefined;
}

let nextPersistentOwnerId = 1;

export class PersistentClaimStore implements ClaimStore {
  readonly ownerId: string;
  readonly kind: string;
  readonly capabilities: ClaimStoreCapabilities;
  readonly state: OrchestratorState;
  private readonly hydratedAt: Date;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly ownerLeaseStaleMs: number;
  private readonly hydrateOptions: HydrateStateOptions | (() => HydrateStateOptions) | undefined;
  private transactionsApplied = 0;
  private lastOperation: ClaimStoreOperation | null = null;
  private lastCheckpointAt: string | null = null;

  constructor(
    private readonly backend: ClaimStoreBackend,
    options: PersistentClaimStoreOptions = {},
  ) {
    this.kind = backend.kind;
    this.capabilities = backend.capabilities;
    if (this.capabilities.sharedAcrossProcesses && !backend.withExclusiveTransaction) {
      throw new Error("shared_claim_store_backend_requires_exclusive_transaction");
    }
    if (
      this.capabilities.sharedAcrossProcesses &&
      this.capabilities.crashRecovery &&
      (!backend.heartbeatOwner || !backend.ownerIsActive)
    ) {
      throw new Error("shared_crash_recovery_claim_store_requires_owner_leases");
    }
    this.ownerId =
      options.ownerId ??
      `${backend.kind}:${process.pid}:${nextPersistentOwnerId++}:${randomUUID()}`;
    this.hydratedAt = options.hydratedAt ?? new Date();
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.ownerLeaseStaleMs = options.ownerLeaseStaleMs ?? 300_000;
    this.hydrateOptions = options.hydrate;
    this.state = createState();
    const loadInitial = (): void => {
      this.writeOwnerHeartbeat();
      const checkpoint = backend.load();
      if (checkpoint)
        replaceStateContents(
          this.state,
          hydrateState(checkpoint.state, this.hydrate(this.recovery(), checkpoint.ownerId)),
        );
      this.lastCheckpointAt = checkpoint?.writtenAt ?? null;
      if (this.recoverInactiveOwners()) this.save("recover_stale_owners");
    };
    if (backend.withExclusiveTransaction) backend.withExclusiveTransaction(loadInitial);
    else loadInitial();
  }

  read<T>(run: (state: OrchestratorState) => T): T {
    const apply = (): T => {
      if (this.capabilities.sharedAcrossProcesses)
        this.reload({ heartbeatOwner: false, recoverInactiveOwners: false });
      return run(this.state);
    };
    return this.backend.withExclusiveTransaction
      ? this.backend.withExclusiveTransaction(apply)
      : apply();
  }

  transaction<T>(operation: ClaimStoreOperation, run: (state: OrchestratorState) => T): T {
    let rollback: (() => void) | null = null;
    const preserveRecoveredNoop = this.backend.withExclusiveTransaction !== undefined;
    const rollbackLocalState = (): void => {
      rollback?.();
      rollback = null;
    };
    const apply = (): T | NoopAfterRecovery => {
      let recoveredInactiveOwners = false;
      if (this.capabilities.sharedAcrossProcesses)
        recoveredInactiveOwners = this.reload({
          heartbeatOwner: true,
          recoverInactiveOwners: true,
        });
      const rollbackState = cloneStateContents(this.state);
      const rollbackTransactionsApplied = this.transactionsApplied;
      const rollbackLastOperation = this.lastOperation;
      const rollbackLastCheckpointAt = this.lastCheckpointAt;
      rollback = () => {
        replaceStateContents(this.state, rollbackState);
        this.transactionsApplied = rollbackTransactionsApplied;
        this.lastOperation = rollbackLastOperation;
        this.lastCheckpointAt = rollbackLastCheckpointAt;
      };
      try {
        const result = run(this.state);
        this.transactionsApplied += 1;
        this.lastOperation = operation;
        this.save(operation);
        return result;
      } catch (error) {
        rollbackLocalState();
        if (
          recoveredInactiveOwners &&
          preserveRecoveredNoop &&
          error instanceof NoopClaimStoreMutation
        )
          return noopAfterRecovery(error);
        throw error;
      }
    };
    if (!this.backend.withExclusiveTransaction) {
      try {
        return apply() as T;
      } finally {
        rollback = null;
      }
    }
    try {
      const result = this.backend.withExclusiveTransaction(apply);
      rollback = null;
      if (isNoopAfterRecovery(result)) throw result.error;
      return result;
    } catch (error) {
      rollbackLocalState();
      throw error;
    }
  }

  flush(): void {
    const apply = (): void => {
      if (this.capabilities.sharedAcrossProcesses)
        this.reload({ heartbeatOwner: true, recoverInactiveOwners: true });
      this.save("flush");
    };
    if (this.backend.withExclusiveTransaction) this.backend.withExclusiveTransaction(apply);
    else apply();
  }

  heartbeatOwner(): void {
    const apply = (): void => this.writeOwnerHeartbeat();
    if (this.backend.withExclusiveTransaction) this.backend.withExclusiveTransaction(apply);
    else apply();
  }

  close(): void {
    this.backend.close?.();
  }

  status(): ClaimStoreStatus {
    return {
      kind: this.kind,
      ownerId: this.ownerId,
      capabilities: { ...this.capabilities },
      hydratedAt: this.hydratedAt.toISOString(),
      transactionsApplied: this.transactionsApplied,
      lastOperation: this.lastOperation,
      lastCheckpointAt: this.lastCheckpointAt,
    };
  }

  private save(operation: ClaimStoreCheckpoint["operation"]): void {
    const writtenAt = this.now().toISOString();
    this.backend.save({
      version: 1,
      ownerId: this.ownerId,
      writtenAt,
      operation,
      state: serializeState(this.state),
    });
    this.lastCheckpointAt = writtenAt;
  }

  private reload(options: { heartbeatOwner: boolean; recoverInactiveOwners: boolean }): boolean {
    if (options.heartbeatOwner) this.writeOwnerHeartbeat();
    const ownedEphemeralFields = captureOwnedRunningEphemeralFields(this.state, this.ownerId);
    const checkpoint = this.backend.load();
    replaceStateContents(
      this.state,
      checkpoint
        ? hydrateState(checkpoint.state, this.hydrate("preserve", checkpoint.ownerId))
        : createState(),
    );
    restoreOwnedRunningEphemeralFields(this.state, this.ownerId, ownedEphemeralFields);
    this.lastCheckpointAt = checkpoint?.writtenAt ?? null;
    if (options.recoverInactiveOwners && this.recoverInactiveOwners()) {
      this.save("recover_stale_owners");
      return true;
    }
    return false;
  }

  private writeOwnerHeartbeat(): void {
    this.backend.heartbeatOwner?.(this.ownerId, this.now());
  }

  private recoverInactiveOwners(): boolean {
    if (!this.capabilities.sharedAcrossProcesses || !this.backend.ownerIsActive) return false;
    const now = this.now();
    let recovered = false;
    const activeOwners = new Map<string, boolean>();
    for (const [key, ownerId] of [...this.state.claimOwners.entries()]) {
      if (ownerId === this.ownerId) continue;
      let ownerActive = activeOwners.get(ownerId);
      if (ownerActive === undefined) {
        ownerActive = this.backend.ownerIsActive(ownerId, now, this.ownerLeaseStaleMs);
        activeOwners.set(ownerId, ownerActive);
      }
      if (ownerActive) continue;
      const reservation = this.state.reserved.get(key);
      if (
        reservation?.consumedRetry &&
        !this.state.retryAttempts.has(reservation.consumedRetry.key)
      ) {
        this.state.retryAttempts.set(
          reservation.consumedRetry.key,
          reservation.consumedRetry.entry,
        );
      }
      const running = this.state.running.get(key);
      if (running && running.retryAttempt !== null && !this.state.retryAttempts.has(key))
        this.state.retryAttempts.set(key, this.retryEntryFromRunningClaim(running, now));
      this.state.running.delete(key);
      this.state.reserved.delete(key);
      this.state.claimed.delete(key);
      this.state.claimOwners.delete(key);
      recovered = true;
    }
    return recovered;
  }

  private hydrate(
    recovery: HydrateStateOptions["reservationRecovery"],
    fallbackClaimOwnerId: string,
  ): HydrateStateOptions {
    const base =
      typeof this.hydrateOptions === "function"
        ? this.hydrateOptions()
        : (this.hydrateOptions ?? { now: this.now(), monotonicNowMs: this.monotonicNow() });
    return {
      ...base,
      fallbackClaimOwnerId,
      reservationRecovery: recovery,
      runningRecovery: recovery,
    };
  }

  private recovery(): HydrateStateOptions["reservationRecovery"] {
    return this.capabilities.sharedAcrossProcesses ? "preserve" : "abandon";
  }

  private retryEntryFromRunningClaim(entry: RunningEntry, now: Date): RetryEntry {
    return {
      issueId: entry.issue.id,
      identifier: entry.identifier,
      issueUrl: entry.issue.url ?? null,
      attempt: entry.retryAttempt ?? 1,
      monotonicDeadlineMs: this.monotonicNow(),
      dueAtIso: now.toISOString(),
      slotIndex: entry.slotIndex,
      workerHost: entry.workerHost,
      workspacePath: entry.workspacePath,
    };
  }
}

export function isClaimStore(value: unknown): value is ClaimStore {
  if (!isRecord(value)) return false;
  const candidate = value as Partial<ClaimStore> & { async?: unknown };
  if (candidate.async === true) return false;
  return (
    typeof candidate.kind === "string" &&
    typeof candidate.ownerId === "string" &&
    typeof candidate.capabilities === "object" &&
    typeof candidate.read === "function" &&
    typeof candidate.transaction === "function" &&
    typeof candidate.heartbeatOwner === "function" &&
    typeof candidate.status === "function" &&
    candidate.state !== undefined
  );
}

export function isAsyncClaimStore(value: unknown): value is AsyncClaimStore {
  if (!isRecord(value)) return false;
  const candidate = value as Partial<AsyncClaimStore>;
  return (
    candidate.async === true &&
    typeof candidate.kind === "string" &&
    typeof candidate.ownerId === "string" &&
    typeof candidate.capabilities === "object" &&
    typeof candidate.read === "function" &&
    typeof candidate.transaction === "function" &&
    typeof candidate.heartbeatOwner === "function" &&
    typeof candidate.status === "function" &&
    candidate.state !== undefined
  );
}

export function isClaimStoreLike(value: unknown): value is ClaimStoreLike {
  return isAsyncClaimStore(value) || isClaimStore(value);
}

function replaceStateContents(target: OrchestratorState, source: OrchestratorState): void {
  target.running = source.running;
  target.reserved = source.reserved;
  target.claimed = source.claimed;
  target.claimOwners = source.claimOwners;
  target.retryAttempts = source.retryAttempts;
  target.completed = source.completed;
  target.usageTotals = source.usageTotals;
  target.usageDeltaBases = source.usageDeltaBases;
  target.rateLimits = source.rateLimits;
  target.blockedDispatches = source.blockedDispatches;
}

function cloneStateContents(source: OrchestratorState): OrchestratorState {
  const state = createState();
  state.running = new Map(
    [...source.running.entries()].map(([key, entry]) => [key, cloneRunningEntry(entry)]),
  );
  state.reserved = new Map(
    [...source.reserved.entries()].map(([key, record]) => [key, cloneReservationRecord(record)]),
  );
  state.claimed = new Set(source.claimed);
  state.claimOwners = new Map(source.claimOwners);
  state.retryAttempts = new Map(
    [...source.retryAttempts.entries()].map(([key, entry]) => [key, { ...entry }]),
  );
  state.completed = new Set(source.completed);
  state.usageTotals = { ...source.usageTotals };
  state.usageDeltaBases = new Map(
    [...source.usageDeltaBases.entries()].map(([key, value]) => [key, { ...value }]),
  );
  state.rateLimits = source.rateLimits;
  state.blockedDispatches = source.blockedDispatches.map((entry) => ({ ...entry }));
  return state;
}

function cloneRunningEntry(entry: RunningEntry): RunningEntry {
  return {
    ...entry,
    issue: cloneIssueForMemory(entry.issue),
    usageTotals: { ...entry.usageTotals },
    startedAt: new Date(entry.startedAt),
    lastAgentTimestamp: entry.lastAgentTimestamp ? new Date(entry.lastAgentTimestamp) : null,
  };
}

function cloneReservationRecord(record: ReservationRecord): ReservationRecord {
  return {
    ...record,
    issue: cloneIssueForMemory(record.issue),
    reservedAt: new Date(record.reservedAt),
    expiresAt: new Date(record.expiresAt),
    consumedRetry: record.consumedRetry
      ? { key: record.consumedRetry.key, entry: { ...record.consumedRetry.entry } }
      : null,
  };
}

function cloneIssueForMemory(issue: RunningEntry["issue"]): RunningEntry["issue"] {
  return {
    ...issue,
    labels: [...issue.labels],
    blockers: issue.blockers.map((blocker) => ({ ...blocker })),
  };
}

type EphemeralRunningFields = Pick<
  RunningEntry,
  "executorPid" | "lastAgentEvent" | "lastAgentMessage" | "lastAgentTimestamp" | "sessionId"
>;

function captureOwnedRunningEphemeralFields(
  state: OrchestratorState,
  ownerId: string,
): Map<string, EphemeralRunningFields> {
  const fields = new Map<string, EphemeralRunningFields>();
  for (const [key, entry] of state.running.entries()) {
    if (state.claimOwners.get(key) !== ownerId) continue;
    fields.set(key, {
      executorPid: entry.executorPid,
      lastAgentEvent: entry.lastAgentEvent,
      lastAgentMessage: entry.lastAgentMessage,
      lastAgentTimestamp: entry.lastAgentTimestamp,
      sessionId: entry.sessionId,
    });
  }
  return fields;
}

function restoreOwnedRunningEphemeralFields(
  state: OrchestratorState,
  ownerId: string,
  fields: Map<string, EphemeralRunningFields>,
): void {
  for (const [key, field] of fields.entries()) {
    if (state.claimOwners.get(key) !== ownerId) continue;
    const entry = state.running.get(key);
    if (!entry) continue;
    entry.executorPid = field.executorPid;
    entry.lastAgentEvent = field.lastAgentEvent;
    entry.lastAgentMessage = field.lastAgentMessage;
    entry.lastAgentTimestamp = field.lastAgentTimestamp;
    entry.sessionId = field.sessionId;
  }
}
