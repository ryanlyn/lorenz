import type { DispatchBlockEntry, Issue, RetryEntry, RunningEntry } from "@lorenz/domain";

import { createState, type OrchestratorState, type ReservationRecord } from "./state.js";

export const CLAIM_STORE_SNAPSHOT_VERSION = 1;

export interface SerializedRunningEntry extends Omit<
  RunningEntry,
  "startedAt" | "lastAgentTimestamp"
> {
  startedAt: string;
  lastAgentTimestamp?: string | null | undefined;
}

export interface SerializedReservationRecord extends Omit<
  ReservationRecord,
  "reservedAt" | "expiresAt" | "consumedRetry"
> {
  reservedAt: string;
  expiresAt?: string | undefined;
  consumedRetry: { key: string; entry: RetryEntry } | null;
}

export interface SerializedOrchestratorState {
  version: typeof CLAIM_STORE_SNAPSHOT_VERSION;
  running: Array<[string, SerializedRunningEntry]>;
  reserved: Array<[string, SerializedReservationRecord]>;
  claimed: string[];
  claimOwners?: Array<[string, string]> | undefined;
  retryAttempts: Array<[string, RetryEntry]>;
  completed: string[];
  usageTotals: OrchestratorState["usageTotals"];
  usageDeltaBases?: Array<[string, OrchestratorState["usageTotals"]]> | undefined;
  rateLimits: unknown;
  blockedDispatches: DispatchBlockEntry[];
}

export interface HydrateStateOptions {
  now?: Date | undefined;
  monotonicNowMs?: number | undefined;
  runningRecovery?: "abandon" | "preserve" | undefined;
  reservationRecovery?: "abandon" | "preserve" | undefined;
  fallbackClaimOwnerId?: string | undefined;
}

export function serializeState(state: OrchestratorState): SerializedOrchestratorState {
  return {
    version: CLAIM_STORE_SNAPSHOT_VERSION,
    running: [...state.running.entries()].map(([key, entry]) => [
      key,
      serializeRunningEntry(entry),
    ]),
    reserved: [...state.reserved.entries()].map(([key, record]) => [
      key,
      serializeReservationRecord(record),
    ]),
    claimed: [...state.claimed],
    claimOwners: [...state.claimOwners.entries()],
    retryAttempts: [...state.retryAttempts.entries()].map(([key, retry]) => [key, { ...retry }]),
    completed: [...state.completed],
    usageTotals: { ...state.usageTotals },
    usageDeltaBases: [...state.usageDeltaBases.entries()].map(([key, value]) => [
      key,
      { ...value },
    ]),
    rateLimits: cloneJsonValue(state.rateLimits),
    blockedDispatches: state.blockedDispatches.map((entry) => ({ ...entry })),
  };
}

export function hydrateState(
  snapshot: SerializedOrchestratorState,
  options: HydrateStateOptions = {},
): OrchestratorState {
  if (snapshot.version !== CLAIM_STORE_SNAPSHOT_VERSION) {
    throw new Error(
      `unsupported_claim_store_snapshot_version:${String((snapshot as { version: unknown }).version)}`,
    );
  }
  const state = createState();
  const abandonedRunningKeys = new Set<string>();
  const abandonedRunningEntries: Array<[string, SerializedRunningEntry]> = [];
  if (options.runningRecovery === "preserve") {
    state.running = new Map(
      snapshot.running.map(([key, entry]) => [key, hydrateRunningEntry(entry)]),
    );
  } else {
    for (const [key, entry] of snapshot.running) {
      abandonedRunningKeys.add(key);
      abandonedRunningEntries.push([key, entry]);
    }
  }
  state.retryAttempts = new Map(
    snapshot.retryAttempts.map(([key, retry]) => [key, hydrateRetryEntry(retry, options)]),
  );
  for (const [key, entry] of abandonedRunningEntries) {
    if (entry.retryAttempt === null || state.retryAttempts.has(key)) continue;
    state.retryAttempts.set(key, retryEntryFromAbandonedRunningEntry(entry, options));
  }
  const serializedClaimOwners = new Map(snapshot.claimOwners ?? []);
  if (options.reservationRecovery === "preserve") {
    state.reserved = new Map(
      snapshot.reserved.map(([key, record]) => [key, hydrateReservationRecord(record, options)]),
    );
    state.claimed = new Set(snapshot.claimed.filter((key) => !abandonedRunningKeys.has(key)));
  } else {
    const abandonedReservationKeys = new Set(snapshot.reserved.map(([key]) => key));
    state.claimed = new Set(
      snapshot.claimed.filter(
        (key) => !abandonedReservationKeys.has(key) && !abandonedRunningKeys.has(key),
      ),
    );
    for (const [, record] of snapshot.reserved) {
      const consumed = record.consumedRetry;
      if (consumed && !state.retryAttempts.has(consumed.key)) {
        state.retryAttempts.set(consumed.key, hydrateRetryEntry(consumed.entry, options));
      }
    }
  }
  for (const key of state.claimed) {
    const ownerId = serializedClaimOwners.get(key) ?? options.fallbackClaimOwnerId;
    if (ownerId) state.claimOwners.set(key, ownerId);
  }
  state.completed = new Set(snapshot.completed);
  state.usageTotals = { ...snapshot.usageTotals };
  state.usageDeltaBases = new Map(
    (snapshot.usageDeltaBases ?? []).map(([key, value]) => [key, { ...value }]),
  );
  state.rateLimits = cloneJsonValue(snapshot.rateLimits);
  state.blockedDispatches = snapshot.blockedDispatches.map((entry) => ({ ...entry }));
  return state;
}

function serializeRunningEntry(entry: RunningEntry): SerializedRunningEntry {
  return {
    issue: cloneIssue(entry.issue),
    identifier: entry.identifier,
    slotIndex: entry.slotIndex,
    ensembleSize: entry.ensembleSize,
    agentKind: entry.agentKind,
    workerHost: entry.workerHost,
    workspacePath: entry.workspacePath,
    turnCount: entry.turnCount,
    usageTotals: { ...entry.usageTotals },
    lastReportedInputTokens: entry.lastReportedInputTokens,
    lastReportedOutputTokens: entry.lastReportedOutputTokens,
    lastReportedTotalTokens: entry.lastReportedTotalTokens,
    lastAgentEvent: entry.lastAgentEvent ?? null,
    startedAt: entry.startedAt.toISOString(),
    lastAgentTimestamp: entry.lastAgentTimestamp?.toISOString() ?? null,
    retryAttempt: entry.retryAttempt,
  };
}

function hydrateRunningEntry(entry: SerializedRunningEntry): RunningEntry {
  return {
    ...entry,
    issue: cloneIssue(entry.issue),
    usageTotals: { ...entry.usageTotals },
    startedAt: new Date(entry.startedAt),
    lastAgentTimestamp: entry.lastAgentTimestamp ? new Date(entry.lastAgentTimestamp) : null,
  };
}

function serializeReservationRecord(record: ReservationRecord): SerializedReservationRecord {
  return {
    ...record,
    issue: cloneIssue(record.issue),
    reservedAt: record.reservedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    consumedRetry: record.consumedRetry
      ? { key: record.consumedRetry.key, entry: { ...record.consumedRetry.entry } }
      : null,
  };
}

function hydrateReservationRecord(
  record: SerializedReservationRecord,
  options: HydrateStateOptions,
): ReservationRecord {
  const expiresAt = new Date(record.expiresAt ?? record.reservedAt);
  return {
    ...record,
    issue: cloneIssue(record.issue),
    reservedAt: new Date(record.reservedAt),
    expiresAt,
    expiresAtMonotonicMs: hydrateMonotonicDeadline(
      expiresAt.toISOString(),
      record.expiresAtMonotonicMs,
      options,
    ),
    consumedRetry: record.consumedRetry
      ? {
          key: record.consumedRetry.key,
          entry: hydrateRetryEntry(record.consumedRetry.entry, options),
        }
      : null,
  };
}

function hydrateRetryEntry(retry: RetryEntry, options: HydrateStateOptions): RetryEntry {
  return {
    ...retry,
    monotonicDeadlineMs: hydrateMonotonicDeadline(
      retry.dueAtIso,
      retry.monotonicDeadlineMs,
      options,
    ),
  };
}

function retryEntryFromAbandonedRunningEntry(
  entry: SerializedRunningEntry,
  options: HydrateStateOptions,
): RetryEntry {
  const now = options.now ?? new Date();
  return {
    issueId: entry.issue.id,
    identifier: entry.identifier,
    issueUrl: entry.issue.url ?? null,
    attempt: entry.retryAttempt ?? 1,
    monotonicDeadlineMs: options.monotonicNowMs ?? 0,
    dueAtIso: now.toISOString(),
    slotIndex: entry.slotIndex,
    workerHost: entry.workerHost,
    workspacePath: entry.workspacePath,
  };
}

function hydrateMonotonicDeadline(
  dueAtIso: string,
  fallbackMonotonicDeadlineMs: number,
  options: HydrateStateOptions,
): number {
  const now = options.now;
  const monotonicNowMs = options.monotonicNowMs;
  if (!now || monotonicNowMs === undefined) return fallbackMonotonicDeadlineMs;
  const dueAtMs = Date.parse(dueAtIso);
  if (!Number.isFinite(dueAtMs)) return fallbackMonotonicDeadlineMs;
  return monotonicNowMs + Math.max(0, dueAtMs - now.getTime());
}

function cloneIssue(issue: Issue): Issue {
  const { raw, ...normalizedIssue } = issue;
  void raw;
  return {
    ...normalizedIssue,
    labels: [...issue.labels],
    blockers: issue.blockers.map((blocker) => ({ ...blocker })),
  };
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
