import type {
  AgentKind,
  DispatchBlockEntry,
  Issue,
  RetryEntry,
  RunningEntry,
  UsageTotals,
} from "@lorenz/domain";

/**
 * Internal record of a phase-1 slot hold while the dispatch coordinator negotiates capacity
 * asynchronously. Keyed by slotKey(issueId, slotIndex) in OrchestratorState.reserved.
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
  /** Wall-clock expiry used to rebase the defensive sweep across process boundaries. */
  expiresAt: Date;
  /** Defensive expiry, swept by Orchestrator.eligibleIssues. */
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
  /** Owner id for each live running or reserved claim. */
  claimOwners: Map<string, string>;
  /** Retry entries keyed by slotKey(issueId, slotIndex). */
  retryAttempts: Map<string, RetryEntry>;
  completed: Set<string>;
  usageTotals: UsageTotals;
  /** Incremental usage report baseline keyed by slotKey(issueId, slotIndex). */
  usageDeltaBases: Map<string, UsageTotals>;
  rateLimits: unknown;
  blockedDispatches: DispatchBlockEntry[];
}

export function createState(): OrchestratorState {
  return {
    running: new Map(),
    reserved: new Map(),
    claimed: new Set(),
    claimOwners: new Map(),
    retryAttempts: new Map(),
    completed: new Set(),
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    usageDeltaBases: new Map(),
    rateLimits: null,
    blockedDispatches: [],
  };
}
