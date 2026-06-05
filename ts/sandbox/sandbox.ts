/**
 * Testing sandbox for Symphony runtime.
 *
 * Provides chaos-monkey tracker clients, configurable fake agent runners,
 * scenario orchestration, issue factory helpers, timed mutations, assertions,
 * parametrization helpers, and a CLI interface -- all purely in-memory
 * with no file I/O.
 *
 * CLI usage: npx tsx demo/sandbox.ts <scenario-file.json>
 */

import { parseConfig, normalizeIssue } from "@symphony/cli";
import { SymphonyRuntime } from "@symphony/runtime";
import type {
  Issue,
  IssueStateType,
  Settings,
  WorkflowDefinition,
  RuntimeTrackerClient,
  AgentUpdate,
  UsageTotals,
  RunResult,
} from "@symphony/cli";
import type {
  RuntimeRunner,
  RuntimeSnapshot,
  RuntimeEvent,
  SymphonyRuntimeOptions,
} from "@symphony/runtime";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Promisified setTimeout. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Quickly create an Issue object with sensible defaults. */
export function makeIssue(
  id: string,
  identifier: string,
  overrides: Record<string, unknown> = {},
): Issue {
  return normalizeIssue({
    id,
    identifier,
    title: overrides.title ?? `Issue ${identifier}`,
    state: overrides.state ?? "Todo",
    stateType: overrides.stateType ?? "unstarted",
    labels: overrides.labels ?? [],
    blockers: overrides.blockers ?? [],
    priority: overrides.priority ?? 2,
    description: overrides.description ?? null,
    ...overrides,
  });
}

/** Create a Settings object with sensible testing defaults. */
export function makeSettings(overrides: Record<string, unknown> = {}): Settings {
  return parseConfig(
    {
      tracker: {
        kind: "memory",
        endpoint: "memory://test",
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Done", "Cancelled"],
        dispatch: {
          acceptUnrouted: true,
          onlyRoutes: null,
          routeLabelPrefix: "Symphony:",
        },
      },
      polling: { intervalMs: 100 },
      workspace: { root: "/tmp/sandbox_workspaces" },
      agent: {
        kind: "codex",
        maxConcurrentAgents: 5,
        maxTurns: 10,
        maxRetryBackoffMs: 1000,
        ensembleSize: 1,
      },
      codex: {
        command: "echo codex",
        approvalPolicy: "never",
        threadSandbox: "workspace-write",
        turnSandboxPolicy: null,
        turnTimeoutMs: 60_000,
        readTimeoutMs: 5_000,
        stallTimeoutMs: 30_000,
      },
      claude: {
        command: "echo claude",
        turnTimeoutMs: 60_000,
        stallTimeoutMs: 30_000,
        strictMcpConfig: true,
        providerConfig: { permissions: { defaultMode: "dontAsk" } },
      },
      ...overrides,
    },
    {},
    { tmpdir: "/tmp", cwd: "/tmp" },
  );
}

/** Create N issues forming a dependency chain where each blocks the next. */
export function makeDependencyChain(count: number): Issue[] {
  const issues: Issue[] = [];
  for (let i = 0; i < count; i++) {
    const id = `chain-${i}`;
    const identifier = `CHAIN-${i}`;
    const blockers =
      i > 0
        ? [{ id: `chain-${i - 1}`, identifier: `CHAIN-${i - 1}`, state: "Todo", stateType: "unstarted" }]
        : [];
    issues.push(
      makeIssue(id, identifier, { blockers }),
    );
  }
  return issues;
}

/** Create N issues with varied priorities (1 = urgent through N = low). */
export function makePrioritySpread(count: number): Issue[] {
  const issues: Issue[] = [];
  for (let i = 0; i < count; i++) {
    issues.push(
      makeIssue(`prio-${i}`, `PRIO-${i}`, { priority: i + 1 }),
    );
  }
  return issues;
}

/** Create many concurrent issues for load testing. */
export function makeHighTraffic(count: number): Issue[] {
  const issues: Issue[] = [];
  for (let i = 0; i < count; i++) {
    issues.push(
      makeIssue(`traffic-${i}`, `TRAFFIC-${i}`, { priority: 2 }),
    );
  }
  return issues;
}

// ---------------------------------------------------------------------------
// ChaosLinearClient
// ---------------------------------------------------------------------------

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

  // -- Dynamic manipulation --

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

  // -- RuntimeTrackerClient implementation --

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
      throw new Error(
        `ChaosLinearClient: random failure (rate=${this.config.failureRate})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// FakeAgentRunner
// ---------------------------------------------------------------------------

/** Per-issue behavior configuration for the fake runner. */
export interface FakeRunnerIssueBehavior {
  /** Whether this issue should succeed. Default true. */
  shouldSucceed?: boolean;
  /** Error message when failing. */
  errorMessage?: string;
  /** Number of turns before completion. Default 1. */
  turnCount?: number;
  /** Delay (ms) per turn. Default 0. */
  latencyPerTurnMs?: number;
  /** If true, the runner never resolves (simulates a stall). */
  stall?: boolean;
  /** Simulated token usage reported per turn. */
  usagePerTurn?: Partial<UsageTotals>;
  /** If true, throw mid-turn to simulate a session crash. */
  crashMidTurn?: boolean;
  /** Turn number at which to crash (1-based). Default 1 if crashMidTurn is true. */
  crashAtTurn?: number;
  /** Arbitrary AgentUpdate sequence to emit before completing. */
  customUpdates?: AgentUpdate[];
}

/** Configuration for the FakeAgentRunner factory. */
export interface FakeRunnerConfig {
  /** Default behavior for issues not matched by ID or pattern. */
  defaultBehavior?: FakeRunnerIssueBehavior;
  /** Per-issue overrides keyed by issue ID. */
  byId?: Record<string, FakeRunnerIssueBehavior>;
  /** Pattern-based overrides. First matching pattern wins. */
  byPattern?: Array<{ pattern: RegExp; behavior: FakeRunnerIssueBehavior }>;
}

/**
 * Creates a RuntimeRunner function with configurable behavior per issue.
 * Supports success/failure, turn counts, latency, stalls, usage reporting,
 * session crashes, and arbitrary update sequences.
 */
export function createFakeAgentRunner(config: FakeRunnerConfig = {}): RuntimeRunner {
  const defaultBehavior: Required<FakeRunnerIssueBehavior> = {
    shouldSucceed: true,
    errorMessage: "FakeAgentRunner: simulated failure",
    turnCount: 1,
    latencyPerTurnMs: 0,
    stall: false,
    usagePerTurn: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    crashMidTurn: false,
    crashAtTurn: 1,
    customUpdates: [],
  };

  function resolveBehavior(issue: Issue): Required<FakeRunnerIssueBehavior> {
    // Check by ID first
    if (config.byId && config.byId[issue.id]) {
      return { ...defaultBehavior, ...config.defaultBehavior, ...config.byId[issue.id] };
    }
    // Check patterns
    if (config.byPattern) {
      for (const { pattern, behavior } of config.byPattern) {
        if (pattern.test(issue.id) || pattern.test(issue.identifier)) {
          return { ...defaultBehavior, ...config.defaultBehavior, ...behavior };
        }
      }
    }
    // Use default
    return { ...defaultBehavior, ...config.defaultBehavior };
  }

  const runner: RuntimeRunner = async (input) => {
    const { issue, onUpdate, abortSignal } = input;
    const behavior = resolveBehavior(issue);
    const workspace = `/tmp/sandbox_workspaces/${issue.identifier}`;
    const allUpdates: AgentUpdate[] = [];

    // Emit workspace_prepared
    const workspaceUpdate: AgentUpdate = {
      type: "workspace_prepared",
      message: `workspace prepared at ${workspace}`,
      workspacePath: workspace,
    };
    onUpdate?.(workspaceUpdate);
    allUpdates.push(workspaceUpdate);

    // Emit session_started
    const sessionUpdate: AgentUpdate = {
      type: "session_started",
      message: `session started (fake-session-${issue.id})`,
      sessionId: `fake-session-${issue.id}`,
    };
    onUpdate?.(sessionUpdate);
    allUpdates.push(sessionUpdate);

    // Stall simulation: never resolve
    if (behavior.stall) {
      return new Promise<RunResult>(() => {
        // Intentionally never resolves
      });
    }

    // Emit custom updates if any
    for (const update of behavior.customUpdates) {
      onUpdate?.(update);
      allUpdates.push(update);
    }

    // Process turns
    let completedTurns = 0;
    for (let turn = 1; turn <= behavior.turnCount; turn++) {
      // Check abort signal
      if (abortSignal?.aborted) {
        throw new Error("FakeAgentRunner: aborted");
      }

      // Simulate latency
      if (behavior.latencyPerTurnMs > 0) {
        await sleep(behavior.latencyPerTurnMs);
      }

      // Crash mid-turn
      if (behavior.crashMidTurn && turn === behavior.crashAtTurn) {
        const crashUpdate: AgentUpdate = {
          type: "turn_failed",
          message: "session crash",
        };
        onUpdate?.(crashUpdate);
        allUpdates.push(crashUpdate);
        throw new Error("FakeAgentRunner: session crashed mid-turn");
      }

      // Emit turn_started
      const turnStarted: AgentUpdate = {
        type: "turn_started",
        message: `turn ${turn}`,
      };
      onUpdate?.(turnStarted);
      allUpdates.push(turnStarted);

      // Emit usage
      if (behavior.usagePerTurn) {
        const usageUpdate: AgentUpdate = {
          type: "usage",
          usage: { ...behavior.usagePerTurn },
        };
        onUpdate?.(usageUpdate);
        allUpdates.push(usageUpdate);
      }

      // Emit turn_completed
      const turnCompleted: AgentUpdate = {
        type: "turn_completed",
        sessionId: `fake-session-${issue.id}`,
        resumeId: `fake-resume-${issue.id}`,
        usage: { ...behavior.usagePerTurn },
      };
      onUpdate?.(turnCompleted);
      allUpdates.push(turnCompleted);

      completedTurns += 1;
    }

    // After all turns, fail or succeed
    if (!behavior.shouldSucceed) {
      throw new Error(behavior.errorMessage);
    }

    const result: RunResult = {
      workspace,
      turnCount: completedTurns,
      updates: allUpdates,
      resumeId: `fake-resume-${issue.id}`,
      agentKind: "codex",
    };

    return result;
  };

  return runner;
}

// ---------------------------------------------------------------------------
// Scenario Runner
// ---------------------------------------------------------------------------

/** Collected events from a sandbox run. */
export interface SandboxResult {
  /** All runtime snapshots captured during the run. */
  snapshots: RuntimeSnapshot[];
  /** All runtime events captured during the run. */
  events: RuntimeEvent[];
  /** Errors thrown during poll ticks. */
  errors: Error[];
  /** Final snapshot after all ticks complete. */
  finalSnapshot: RuntimeSnapshot;
  /** Number of poll ticks executed. */
  ticksExecuted: number;
  /** Total API calls made to the chaos client. */
  clientCallCount: number;
}

/** Configuration for a sandbox scenario. */
export interface SandboxScenario {
  /** Issues to seed the tracker with. */
  issues: Issue[];
  /** Settings overrides (raw config format, passed to parseConfig). */
  settingsOverrides?: Record<string, unknown>;
  /** Chaos configuration for the tracker client. */
  chaosConfig?: ChaosConfig;
  /** Fake runner behavior configuration. */
  runnerConfig?: FakeRunnerConfig;
  /** Number of poll ticks to execute. Default 1. */
  pollTicks?: number;
  /** Delay (ms) between poll ticks. Default 0. */
  tickDelayMs?: number;
  /** If true, wait for all in-flight runs after each tick. Default true. */
  waitForRuns?: boolean;
  /** Optional mutations to apply between ticks. Keyed by tick number (0-based). */
  mutations?: Record<number, (client: ChaosLinearClient) => void>;
  /** Timed mutations: applied by time offset from scenario start. */
  timedMutations?: TimedMutation[];
  /** Assertions to check after scenario completes. */
  assertions?: Assertion[];
}

/**
 * Run a sandbox scenario: sets up the runtime with the chaos client and fake
 * runner, executes poll ticks, collects all events and snapshots, and returns
 * the full history.
 */
export async function runScenario(scenario: SandboxScenario): Promise<SandboxResult> {
  const settings = makeSettings(scenario.settingsOverrides ?? {});
  const client = new ChaosLinearClient(scenario.issues, scenario.chaosConfig);
  const runner = createFakeAgentRunner(scenario.runnerConfig ?? {});

  const workflow: WorkflowDefinition = {
    path: "/tmp/sandbox_workflow.md",
    config: {},
    promptTemplate: "Fix issue {{ issue.identifier }}: {{ issue.title }}",
    settings,
  };

  const snapshots: RuntimeSnapshot[] = [];
  const events: RuntimeEvent[] = [];
  const errors: Error[] = [];

  const runtimeOptions: SymphonyRuntimeOptions = {
    workflow,
    client,
    runner,
    removeIssueWorkspaces: async () => {},
    deleteResumeState: async () => {},
    appendLogEvent: async () => {},
  };

  const runtime = new SymphonyRuntime(runtimeOptions);

  // Subscribe to snapshot changes
  const unsubscribe = runtime.subscribe((snapshot) => {
    snapshots.push(snapshot);
    // Collect new events not yet seen
    for (const event of snapshot.recentEvents) {
      if (!events.some((e) => e.at === event.at && e.type === event.type && e.message === event.message)) {
        events.push(event);
      }
    }
  });

  // Set up timed mutations
  const timedMutationTimers: ReturnType<typeof setTimeout>[] = [];
  if (scenario.timedMutations && scenario.timedMutations.length > 0) {
    for (const tm of scenario.timedMutations) {
      const timer = setTimeout(() => {
        applyMutationDescriptor(client, tm.mutate);
      }, tm.afterMs);
      timedMutationTimers.push(timer);
    }
  }

  const ticks = scenario.pollTicks ?? 1;
  const waitForRuns = scenario.waitForRuns ?? true;
  let ticksExecuted = 0;

  try {
    for (let tick = 0; tick < ticks; tick++) {
      // Apply mutations if any for this tick
      const mutationFn = scenario.mutations?.[tick];
      if (mutationFn) {
        mutationFn(client);
      }

      try {
        await runtime.pollOnce({ waitForRuns });
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }

      ticksExecuted += 1;

      if (scenario.tickDelayMs && scenario.tickDelayMs > 0 && tick < ticks - 1) {
        await sleep(scenario.tickDelayMs);
      }
    }
  } finally {
    // Clear timed mutation timers
    for (const timer of timedMutationTimers) {
      clearTimeout(timer);
    }
    runtime.stop();
    unsubscribe();
  }

  const finalSnapshot = runtime.snapshot();

  return {
    snapshots,
    events,
    errors,
    finalSnapshot,
    ticksExecuted,
    clientCallCount: client.callCount,
  };
}

// ---------------------------------------------------------------------------
// Timed Mutations
// ---------------------------------------------------------------------------

/** Mutation descriptor types for JSON-serializable mutation definitions. */
export type MutationDescriptor =
  | { type: "add_issue"; issue: Record<string, unknown> }
  | { type: "remove_issue"; issueId: string }
  | { type: "change_state"; issueId: string; state: string; stateType?: IssueStateType }
  | { type: "update_priority"; issueId: string; priority: number }
  | { type: "add_blocker"; issueId: string; blockerId: string; blockerIdentifier?: string }
  | { type: "remove_blocker"; issueId: string; blockerId: string }
  | { type: "change_labels"; issueId: string; labels: string[] }
  | { type: "set_chaos"; failureRate?: number; latencyMs?: number };

/** A timed mutation: applied after a time offset from scenario start. */
export interface TimedMutation {
  /** Milliseconds after scenario start to apply this mutation. */
  afterMs: number;
  /** The mutation to apply. */
  mutate: MutationDescriptor;
}

/** Apply a mutation descriptor to the chaos client. */
function applyMutationDescriptor(client: ChaosLinearClient, descriptor: MutationDescriptor): void {
  switch (descriptor.type) {
    case "add_issue": {
      const id = (descriptor.issue.id as string) ?? `dynamic-${Date.now()}`;
      const identifier = (descriptor.issue.identifier as string) ?? `DYN-${Date.now()}`;
      const issue = makeIssue(id, identifier, descriptor.issue);
      client.addIssue(issue);
      break;
    }
    case "remove_issue":
      client.removeIssue(descriptor.issueId);
      break;
    case "change_state":
      client.changeIssueState(descriptor.issueId, descriptor.state, descriptor.stateType);
      break;
    case "update_priority":
      client.updateIssue(descriptor.issueId, { priority: descriptor.priority });
      break;
    case "add_blocker": {
      const issues = client.getIssues();
      const target = issues.find((i) => i.id === descriptor.issueId);
      if (target) {
        const newBlockers = [
          ...target.blockers,
          { id: descriptor.blockerId, identifier: descriptor.blockerIdentifier ?? descriptor.blockerId, state: "Todo" },
        ];
        client.updateIssue(descriptor.issueId, { blockers: newBlockers });
      }
      break;
    }
    case "remove_blocker": {
      const issues2 = client.getIssues();
      const target2 = issues2.find((i) => i.id === descriptor.issueId);
      if (target2) {
        const filtered = target2.blockers.filter((b) => b.id !== descriptor.blockerId);
        client.updateIssue(descriptor.issueId, { blockers: filtered });
      }
      break;
    }
    case "change_labels":
      client.updateIssue(descriptor.issueId, { labels: descriptor.labels });
      break;
    case "set_chaos":
      client.setChaosConfig({
        failureRate: descriptor.failureRate,
        latencyMs: descriptor.latencyMs,
      });
      break;
  }
}

// ---------------------------------------------------------------------------
// Assertion Framework
// ---------------------------------------------------------------------------

/** Assertion types that can be checked against a SandboxResult. */
export type Assertion =
  | { type: "running_count"; expected: number }
  | { type: "not_running"; issueId: string }
  | { type: "is_running"; issueId: string }
  | { type: "event_occurred"; eventType: string; messageContains?: string }
  | { type: "event_not_occurred"; eventType: string; messageContains?: string }
  | { type: "retry_count"; issueId: string; minAttempts: number }
  | { type: "usage_bounds"; maxInputTokens?: number; maxOutputTokens?: number; maxTotalTokens?: number }
  | { type: "final_state"; issueId: string; expectedState: string }
  | { type: "dispatch_order"; issueIds: string[] }
  | { type: "no_errors" }
  | { type: "blocker_respected"; blockedIssueId: string; blockerIssueId: string }
  | { type: "concurrency_cap"; maxConcurrent: number };

/** Result of a single assertion check. */
export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  message: string;
}

/** Check all assertions against a SandboxResult. */
export function checkAssertions(result: SandboxResult, assertions: Assertion[]): AssertionResult[] {
  return assertions.map((assertion) => checkSingleAssertion(result, assertion));
}

function checkSingleAssertion(result: SandboxResult, assertion: Assertion): AssertionResult {
  switch (assertion.type) {
    case "running_count": {
      const actual = result.finalSnapshot.running.length;
      const passed = actual === assertion.expected;
      return {
        assertion,
        passed,
        message: passed
          ? `running_count: ${actual} === ${assertion.expected}`
          : `running_count: expected ${assertion.expected}, got ${actual}`,
      };
    }

    case "not_running": {
      const isRunning = result.finalSnapshot.running.some((r) => r.issueId === assertion.issueId);
      const passed = !isRunning;
      return {
        assertion,
        passed,
        message: passed
          ? `not_running: ${assertion.issueId} is not running`
          : `not_running: ${assertion.issueId} is still running`,
      };
    }

    case "is_running": {
      const isRunning = result.finalSnapshot.running.some((r) => r.issueId === assertion.issueId);
      return {
        assertion,
        passed: isRunning,
        message: isRunning
          ? `is_running: ${assertion.issueId} is running`
          : `is_running: ${assertion.issueId} is not running`,
      };
    }

    case "event_occurred": {
      const found = result.events.some(
        (e) =>
          e.type === assertion.eventType &&
          (!assertion.messageContains || e.message.includes(assertion.messageContains)),
      );
      return {
        assertion,
        passed: found,
        message: found
          ? `event_occurred: found ${assertion.eventType}`
          : `event_occurred: ${assertion.eventType} not found${assertion.messageContains ? ` (containing "${assertion.messageContains}")` : ""}`,
      };
    }

    case "event_not_occurred": {
      const found = result.events.some(
        (e) =>
          e.type === assertion.eventType &&
          (!assertion.messageContains || e.message.includes(assertion.messageContains)),
      );
      return {
        assertion,
        passed: !found,
        message: !found
          ? `event_not_occurred: ${assertion.eventType} correctly absent`
          : `event_not_occurred: ${assertion.eventType} unexpectedly found`,
      };
    }

    case "retry_count": {
      const retryEvents = result.events.filter(
        (e) => e.type === "run_failed" && e.message.includes(assertion.issueId),
      );
      const retryEntries = result.finalSnapshot.retrying.filter(
        (r) => r.issueId === assertion.issueId,
      );
      const maxAttempt = Math.max(
        retryEvents.length,
        ...retryEntries.map((r) => r.attempt),
        0,
      );
      const passed = maxAttempt >= assertion.minAttempts;
      return {
        assertion,
        passed,
        message: passed
          ? `retry_count: ${assertion.issueId} retried ${maxAttempt} times (>= ${assertion.minAttempts})`
          : `retry_count: ${assertion.issueId} retried ${maxAttempt} times (expected >= ${assertion.minAttempts})`,
      };
    }

    case "usage_bounds": {
      const usage = result.finalSnapshot.usageTotals;
      const checks: string[] = [];
      let passed = true;
      if (assertion.maxInputTokens !== undefined && (usage.inputTokens ?? 0) > assertion.maxInputTokens) {
        passed = false;
        checks.push(`inputTokens ${usage.inputTokens} > ${assertion.maxInputTokens}`);
      }
      if (assertion.maxOutputTokens !== undefined && (usage.outputTokens ?? 0) > assertion.maxOutputTokens) {
        passed = false;
        checks.push(`outputTokens ${usage.outputTokens} > ${assertion.maxOutputTokens}`);
      }
      if (assertion.maxTotalTokens !== undefined && (usage.totalTokens ?? 0) > assertion.maxTotalTokens) {
        passed = false;
        checks.push(`totalTokens ${usage.totalTokens} > ${assertion.maxTotalTokens}`);
      }
      return {
        assertion,
        passed,
        message: passed
          ? `usage_bounds: within limits`
          : `usage_bounds: exceeded - ${checks.join(", ")}`,
      };
    }

    case "final_state": {
      // Check run history for the issue's final state
      const historyEntries = result.finalSnapshot.runHistory.filter(
        (h) => h.issueId === assertion.issueId,
      );
      const lastEntry = historyEntries[historyEntries.length - 1];
      const actualState = lastEntry?.state ?? null;
      const passed = actualState === assertion.expectedState;
      return {
        assertion,
        passed,
        message: passed
          ? `final_state: ${assertion.issueId} in state "${assertion.expectedState}"`
          : `final_state: ${assertion.issueId} expected "${assertion.expectedState}", got "${actualState}"`,
      };
    }

    case "dispatch_order": {
      // Extract dispatch order from run_started events
      const startedEvents = result.events.filter((e) => e.type === "run_started");
      const dispatchedIds: string[] = [];
      for (const event of startedEvents) {
        // Message format: "IDENTIFIER slot=N" - extract the identifier
        const identifier = event.message.split(" ")[0];
        // Find issue ID by identifier from run history
        const histEntry = result.finalSnapshot.runHistory.find(
          (h) => h.issueIdentifier === identifier,
        );
        if (histEntry) {
          dispatchedIds.push(histEntry.issueId);
        }
      }
      // Check that the expected order is a subsequence of actual dispatches
      let orderIdx = 0;
      for (const id of dispatchedIds) {
        if (orderIdx < assertion.issueIds.length && id === assertion.issueIds[orderIdx]) {
          orderIdx++;
        }
      }
      const passed = orderIdx === assertion.issueIds.length;
      return {
        assertion,
        passed,
        message: passed
          ? `dispatch_order: correct order observed`
          : `dispatch_order: expected [${assertion.issueIds.join(", ")}], dispatched [${dispatchedIds.join(", ")}]`,
      };
    }

    case "no_errors": {
      const passed = result.errors.length === 0;
      return {
        assertion,
        passed,
        message: passed
          ? `no_errors: no errors occurred`
          : `no_errors: ${result.errors.length} error(s) - ${result.errors.map((e) => e.message).join("; ")}`,
      };
    }

    case "blocker_respected": {
      // The blocked issue should not have started before the blocker completed
      const blockerCompleted = result.events.find(
        (e) =>
          e.type === "run_completed" &&
          e.message.includes(assertion.blockerIssueId),
      );
      const blockedStarted = result.events.find(
        (e) =>
          e.type === "run_started" &&
          e.message.includes(assertion.blockedIssueId),
      );
      if (!blockedStarted) {
        // Blocked issue never started - that's fine, blocker respected
        return {
          assertion,
          passed: true,
          message: `blocker_respected: ${assertion.blockedIssueId} never started (blocker respected)`,
        };
      }
      if (!blockerCompleted) {
        // Blocker never completed but blocked started -> violation
        return {
          assertion,
          passed: false,
          message: `blocker_respected: ${assertion.blockedIssueId} started but blocker ${assertion.blockerIssueId} never completed`,
        };
      }
      const passed = new Date(blockerCompleted.at) <= new Date(blockedStarted.at);
      return {
        assertion,
        passed,
        message: passed
          ? `blocker_respected: ${assertion.blockerIssueId} completed before ${assertion.blockedIssueId} started`
          : `blocker_respected: ${assertion.blockedIssueId} started before ${assertion.blockerIssueId} completed`,
      };
    }

    case "concurrency_cap": {
      // Check that no snapshot had more running issues than the cap
      let maxConcurrent = 0;
      for (const snapshot of result.snapshots) {
        maxConcurrent = Math.max(maxConcurrent, snapshot.running.length);
      }
      const passed = maxConcurrent <= assertion.maxConcurrent;
      return {
        assertion,
        passed,
        message: passed
          ? `concurrency_cap: max concurrent ${maxConcurrent} <= ${assertion.maxConcurrent}`
          : `concurrency_cap: max concurrent ${maxConcurrent} > ${assertion.maxConcurrent}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Parametrization Helpers
// ---------------------------------------------------------------------------

/** Parameter space definition for scenario generation. */
export interface ParamSpace {
  /** Range of issue counts to try. */
  issueCounts?: number[];
  /** Priority values to vary. */
  priorities?: number[];
  /** Chaos failure rates to try. */
  chaosRates?: number[];
  /** Tick counts to try. */
  tickCounts?: number[];
  /** Tick delay values (ms). */
  tickDelays?: number[];
  /** Max concurrency settings to try. */
  concurrencyLimits?: number[];
  /** Latency values (ms) for runner or chaos. */
  latencies?: number[];
}

/** A single parameter combination from crossProduct. */
export interface ParamCombination {
  issueCount?: number;
  priority?: number;
  chaosRate?: number;
  tickCount?: number;
  tickDelay?: number;
  concurrencyLimit?: number;
  latency?: number;
}

/**
 * Generate all combinations of parameter values (cross-product).
 * Each key in ParamSpace produces one dimension; yields all combinations.
 */
export function crossProduct(space: ParamSpace): ParamCombination[] {
  const keys = Object.keys(space) as (keyof ParamSpace)[];
  const paramToField: Record<keyof ParamSpace, keyof ParamCombination> = {
    issueCounts: "issueCount",
    priorities: "priority",
    chaosRates: "chaosRate",
    tickCounts: "tickCount",
    tickDelays: "tickDelay",
    concurrencyLimits: "concurrencyLimit",
    latencies: "latency",
  };

  // Filter to keys that have values
  const activeKeys = keys.filter((k) => space[k] && space[k]!.length > 0);

  if (activeKeys.length === 0) return [{}];

  const results: ParamCombination[] = [];

  function recurse(idx: number, current: ParamCombination): void {
    if (idx >= activeKeys.length) {
      results.push({ ...current });
      return;
    }
    const key = activeKeys[idx]!;
    const values = space[key]!;
    const field = paramToField[key];
    for (const value of values) {
      (current as Record<string, number>)[field] = value;
      recurse(idx + 1, current);
    }
    delete (current as Record<string, number | undefined>)[field];
  }

  recurse(0, {});
  return results;
}

/**
 * Pick a random sample of N items from an array.
 * Uses Fisher-Yates partial shuffle for efficiency.
 */
export function randomSample<T>(items: T[], n: number): T[] {
  const copy = [...items];
  const count = Math.min(n, copy.length);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, count);
}

/**
 * Generate N scenario variants from a base scenario by varying parameters.
 * Each ParamCombination produces one scenario variant.
 */
export function generateScenarioVariants(
  base: Omit<SandboxScenario, "issues"> & { issues?: Issue[] },
  params: ParamCombination[],
): SandboxScenario[] {
  return params.map((combo) => {
    const issueCount = combo.issueCount ?? (base.issues?.length ?? 3);
    const issues: Issue[] = [];
    for (let i = 0; i < issueCount; i++) {
      issues.push(
        makeIssue(`gen-${i}`, `GEN-${i}`, {
          priority: combo.priority ?? 2,
        }),
      );
    }

    const settingsOverrides: Record<string, unknown> = { ...(base.settingsOverrides ?? {}) };
    if (combo.concurrencyLimit !== undefined) {
      settingsOverrides.agent = {
        ...((settingsOverrides.agent as Record<string, unknown>) ?? {}),
        maxConcurrentAgents: combo.concurrencyLimit,
      };
    }

    const chaosConfig: ChaosConfig = { ...(base.chaosConfig ?? {}) };
    if (combo.chaosRate !== undefined) {
      chaosConfig.failureRate = combo.chaosRate;
    }
    if (combo.latency !== undefined) {
      chaosConfig.latencyMs = combo.latency;
    }

    const runnerConfig: FakeRunnerConfig = { ...(base.runnerConfig ?? {}) };
    if (combo.latency !== undefined && runnerConfig.defaultBehavior) {
      runnerConfig.defaultBehavior = {
        ...runnerConfig.defaultBehavior,
        latencyPerTurnMs: combo.latency,
      };
    }

    return {
      ...base,
      issues,
      settingsOverrides,
      chaosConfig,
      runnerConfig,
      pollTicks: combo.tickCount ?? base.pollTicks ?? 1,
      tickDelayMs: combo.tickDelay ?? base.tickDelayMs ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// JSON Scenario Parsing (for CLI)
// ---------------------------------------------------------------------------

/** JSON-serializable scenario definition for the CLI. */
export interface JsonScenarioDefinition {
  issues: Array<Record<string, unknown>>;
  settingsOverrides?: Record<string, unknown>;
  chaosConfig?: { failureRate?: number; latencyMs?: number; intermittentErrorIds?: string[] };
  runnerConfig?: {
    defaultBehavior?: FakeRunnerIssueBehavior;
    byId?: Record<string, FakeRunnerIssueBehavior>;
  };
  pollTicks?: number;
  tickDelayMs?: number;
  waitForRuns?: boolean;
  timedMutations?: Array<{ afterMs: number; mutate: MutationDescriptor }>;
  assertions?: Assertion[];
}

/** Parse a JSON scenario definition into a SandboxScenario. */
export function parseJsonScenario(def: JsonScenarioDefinition): SandboxScenario {
  const issues = def.issues.map((raw) => {
    const id = (raw.id as string) ?? `issue-${Math.random().toString(36).slice(2, 8)}`;
    const identifier = (raw.identifier as string) ?? id.toUpperCase();
    return makeIssue(id, identifier, raw);
  });

  const chaosConfig: ChaosConfig = {};
  if (def.chaosConfig) {
    chaosConfig.failureRate = def.chaosConfig.failureRate;
    chaosConfig.latencyMs = def.chaosConfig.latencyMs;
    if (def.chaosConfig.intermittentErrorIds) {
      chaosConfig.intermittentErrorIds = new Set(def.chaosConfig.intermittentErrorIds);
    }
  }

  const runnerConfig: FakeRunnerConfig = {};
  if (def.runnerConfig) {
    runnerConfig.defaultBehavior = def.runnerConfig.defaultBehavior;
    runnerConfig.byId = def.runnerConfig.byId;
  }

  const timedMutations: TimedMutation[] = (def.timedMutations ?? []).map((tm) => ({
    afterMs: tm.afterMs,
    mutate: tm.mutate,
  }));

  return {
    issues,
    settingsOverrides: def.settingsOverrides,
    chaosConfig,
    runnerConfig,
    pollTicks: def.pollTicks,
    tickDelayMs: def.tickDelayMs,
    waitForRuns: def.waitForRuns,
    timedMutations,
    assertions: def.assertions,
  };
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function cloneIssue(issue: Issue): Issue {
  return {
    ...issue,
    labels: [...issue.labels],
    blockers: issue.blockers.map((b) => ({ ...b })),
  };
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

/** Serialize SandboxResult to a JSON-friendly format (errors -> strings). */
function serializeResult(result: SandboxResult): Record<string, unknown> {
  return {
    ticksExecuted: result.ticksExecuted,
    clientCallCount: result.clientCallCount,
    events: result.events,
    errors: result.errors.map((e) => ({ message: e.message })),
    finalSnapshot: result.finalSnapshot,
    snapshotCount: result.snapshots.length,
  };
}

async function cliMain(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    process.stderr.write("Usage: npx tsx demo/sandbox.ts <scenario-file.json>\n");
    process.stderr.write("       npx tsx demo/sandbox.ts --inline '<json>'\n");
    process.exit(1);
  }

  let rawJson: string;

  if (args[0] === "--inline") {
    if (!args[1]) {
      process.stderr.write("Error: --inline requires a JSON argument\n");
      process.exit(1);
    }
    rawJson = args[1];
    process.stderr.write(`Running inline scenario...\n`);
  } else {
    const filePath = args[0]!;
    const fs = await import("node:fs");
    const path = await import("node:path");

    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      process.stderr.write(`Error: file not found: ${resolved}\n`);
      process.exit(1);
    }

    try {
      rawJson = fs.readFileSync(resolved, "utf-8");
    } catch (err) {
      process.stderr.write(`Error reading file: ${err}\n`);
      process.exit(1);
    }
    process.stderr.write(`Running scenario from ${resolved}...\n`);
  }

  let scenarioDef: JsonScenarioDefinition;
  try {
    scenarioDef = JSON.parse(rawJson) as JsonScenarioDefinition;
  } catch (err) {
    process.stderr.write(`Error parsing JSON: ${err}\n`);
    process.exit(1);
  }

  const scenario = parseJsonScenario(scenarioDef);

  process.stderr.write(`  Issues: ${scenario.issues.length}, Ticks: ${scenario.pollTicks ?? 1}\n`);

  const result = await runScenario(scenario);

  // Check assertions if present
  const assertions = scenario.assertions ?? [];
  const assertionResults = assertions.length > 0 ? checkAssertions(result, assertions) : [];

  const allPassed = assertionResults.every((r) => r.passed);
  const output = {
    success: assertions.length === 0 || allPassed,
    result: serializeResult(result),
    assertions: assertionResults.map((r) => ({
      type: r.assertion.type,
      passed: r.passed,
      message: r.message,
    })),
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");

  if (!output.success) {
    const failCount = assertionResults.filter((r) => !r.passed).length;
    process.stderr.write(`FAILED: ${failCount}/${assertionResults.length} assertion(s) failed\n`);
    process.exit(1);
  } else {
    process.stderr.write(
      assertions.length > 0
        ? `PASSED: all ${assertionResults.length} assertion(s) passed\n`
        : `DONE: scenario completed (no assertions defined)\n`,
    );
    process.exit(0);
  }
}

// Run CLI when executed directly (not imported as a module)
const isDirectExecution =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("sandbox.ts") || process.argv[1].endsWith("sandbox.js"));

if (isDirectExecution) {
  cliMain().catch((err) => {
    process.stderr.write(`Fatal error: ${err}\n`);
    process.exit(1);
  });
}
