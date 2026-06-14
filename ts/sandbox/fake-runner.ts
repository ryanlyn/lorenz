import type { AgentUpdate, Issue, RunResult, UsageTotals } from "@symphony/cli";
import type { ClockPort } from "@symphony/domain";
import type { RuntimeRunner } from "@symphony/runtime";

import { sleep } from "./fixtures.js";

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
 *
 * When a `clock` is provided, per-turn latency waits on that clock instead of
 * the wall clock, so a sandbox scenario driving a {@link FakeClock} can advance
 * runner latency in virtual time. Without a clock it falls back to real sleeps.
 */
export function createFakeAgentRunner(
  config: FakeRunnerConfig = {},
  clock?: ClockPort,
): RuntimeRunner {
  const waitMs = clock
    ? (ms: number): Promise<void> => new Promise((resolve) => clock.setTimeout(resolve, ms))
    : sleep;
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
    if (config.byId && config.byId[issue.id]) {
      return { ...defaultBehavior, ...config.defaultBehavior, ...config.byId[issue.id] };
    }
    if (config.byPattern) {
      for (const { pattern, behavior } of config.byPattern) {
        if (pattern.test(issue.id) || pattern.test(issue.identifier)) {
          return { ...defaultBehavior, ...config.defaultBehavior, ...behavior };
        }
      }
    }
    return { ...defaultBehavior, ...config.defaultBehavior };
  }

  const runner: RuntimeRunner = async (input) => {
    const { issue, onUpdate, abortSignal } = input;
    const behavior = resolveBehavior(issue);
    const workspace = `/tmp/sandbox_workspaces/${issue.identifier}`;
    const allUpdates: AgentUpdate[] = [];

    const workspaceUpdate: AgentUpdate = {
      type: "workspace_prepared",
      message: `workspace prepared at ${workspace}`,
      workspacePath: workspace,
    };
    onUpdate?.(workspaceUpdate);
    allUpdates.push(workspaceUpdate);

    const sessionUpdate: AgentUpdate = {
      type: "session_started",
      message: `session started (fake-session-${issue.id})`,
      sessionId: `fake-session-${issue.id}`,
    };
    onUpdate?.(sessionUpdate);
    allUpdates.push(sessionUpdate);

    if (behavior.stall) {
      return new Promise<RunResult>((_resolve, reject) => {
        if (!abortSignal) return;
        const abort = () => reject(new Error("FakeAgentRunner: aborted"));
        if (abortSignal.aborted) {
          abort();
          return;
        }
        abortSignal.addEventListener("abort", abort, { once: true });
      });
    }

    for (const update of behavior.customUpdates) {
      onUpdate?.(update);
      allUpdates.push(update);
    }

    let completedTurns = 0;
    for (let turn = 1; turn <= behavior.turnCount; turn++) {
      if (abortSignal?.aborted) {
        throw new Error("FakeAgentRunner: aborted");
      }

      if (behavior.latencyPerTurnMs > 0) {
        await waitMs(behavior.latencyPerTurnMs);
      }

      if (behavior.crashMidTurn && turn === behavior.crashAtTurn) {
        const crashUpdate: AgentUpdate = {
          type: "turn_failed",
          message: "session crash",
        };
        onUpdate?.(crashUpdate);
        allUpdates.push(crashUpdate);
        throw new Error("FakeAgentRunner: session crashed mid-turn");
      }

      const turnStarted: AgentUpdate = {
        type: "turn_started",
        message: `turn ${turn}`,
      };
      onUpdate?.(turnStarted);
      allUpdates.push(turnStarted);

      if (behavior.usagePerTurn) {
        const usageUpdate: AgentUpdate = {
          type: "usage",
          usage: { ...behavior.usagePerTurn },
        };
        onUpdate?.(usageUpdate);
        allUpdates.push(usageUpdate);
      }

      const turnCompleted: AgentUpdate = {
        type: "turn_completed",
        sessionId: `fake-session-${issue.id}`,
        usage: { ...behavior.usagePerTurn },
      };
      onUpdate?.(turnCompleted);
      allUpdates.push(turnCompleted);

      completedTurns += 1;
    }

    if (!behavior.shouldSucceed) {
      throw new Error(behavior.errorMessage);
    }

    return {
      workspace,
      turnCount: completedTurns,
      updates: allUpdates,
      agentKind: "codex",
    };
  };

  return runner;
}
