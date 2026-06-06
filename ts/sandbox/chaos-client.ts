import type { Issue, IssueStateType, RuntimeTrackerClient } from "@symphony/cli";

import { cloneIssue, sleep } from "./fixtures.js";

/** Configuration for chaos-monkey behavior on the tracker client. */
export interface ChaosConfig {
  /** Probability (0-1) that any fetch call throws an error. Default 0. */
  failureRate?: number;
  /** Additional delay (ms) added to every call. Default 0. */
  latencyMs?: number;
  /** Issue IDs that always fail when fetched. */
  intermittentErrorIds?: Set<string>;
}

/**
 * A tracker client that wraps MemoryTrackerClient with chaos-monkey capabilities:
 * configurable failure rate, latency injection, intermittent errors, and dynamic
 * issue manipulation at runtime.
 */
export class ChaosLinearClient implements RuntimeTrackerClient {
  private issues: Issue[];
  private config: Required<ChaosConfig>;
  private _callCount = 0;

  constructor(
    issues: Issue[] = [],
    chaosConfig: ChaosConfig = {},
  ) {
    this.issues = issues.map(cloneIssue);
    this.config = {
      failureRate: chaosConfig.failureRate ?? 0,
      latencyMs: chaosConfig.latencyMs ?? 0,
      intermittentErrorIds: chaosConfig.intermittentErrorIds ?? new Set(),
    };
  }

  /** Total number of API calls made against this client. */
  get callCount(): number {
    return this._callCount;
  }

  /** Reset the call counter. */
  resetCallCount(): void {
    this._callCount = 0;
  }

  /** Add an issue at runtime. */
  addIssue(issue: Issue): void {
    this.issues.push(cloneIssue(issue));
  }

  /** Remove an issue by ID. Returns true if found and removed. */
  removeIssue(id: string): boolean {
    const before = this.issues.length;
    this.issues = this.issues.filter((i) => i.id !== id);
    return this.issues.length < before;
  }

  /** Update an issue in-place by ID. Merges provided fields. */
  updateIssue(id: string, patch: Partial<Issue>): boolean {
    const issue = this.issues.find((i) => i.id === id);
    if (!issue) return false;
    Object.assign(issue, patch);
    return true;
  }

  /** Change the state of a specific issue (simulating external state transitions). */
  changeIssueState(id: string, state: string, stateType?: IssueStateType): boolean {
    const issue = this.issues.find((i) => i.id === id);
    if (!issue) return false;
    issue.state = state;
    if (stateType !== undefined) {
      issue.stateType = stateType;
    }
    return true;
  }

  /** Replace the full chaos config at runtime. */
  setChaosConfig(config: ChaosConfig): void {
    this.config = {
      failureRate: config.failureRate ?? this.config.failureRate,
      latencyMs: config.latencyMs ?? this.config.latencyMs,
      intermittentErrorIds: config.intermittentErrorIds ?? this.config.intermittentErrorIds,
    };
  }

  /** Get a readonly snapshot of current issues. */
  getIssues(): Issue[] {
    return this.issues.map(cloneIssue);
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    await this.applyChaosMaybeThrow();
    return this.issues.map(cloneIssue);
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    await this.applyChaosMaybeThrow();
    const wanted = new Set(ids);
    const results: Issue[] = [];
    for (const issue of this.issues) {
      if (!wanted.has(issue.id)) continue;
      if (this.config.intermittentErrorIds.has(issue.id)) {
        throw new Error(`ChaosLinearClient: intermittent error fetching issue ${issue.id}`);
      }
      results.push(cloneIssue(issue));
    }
    return results;
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    await this.applyChaosMaybeThrow();
    const normalizedStates = new Set(states.map((s) => s.trim().toLowerCase()));
    return this.issues
      .filter((i) => normalizedStates.has(i.state.trim().toLowerCase()))
      .map(cloneIssue);
  }

  private async applyChaosMaybeThrow(): Promise<void> {
    this._callCount += 1;
    if (this.config.latencyMs > 0) {
      await sleep(this.config.latencyMs);
    }
    if (this.config.failureRate > 0 && Math.random() < this.config.failureRate) {
      throw new Error(`ChaosLinearClient: random failure (rate=${this.config.failureRate})`);
    }
  }
}
