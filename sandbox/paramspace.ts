import type { Issue } from "@lorenz/cli";

import type { Assertion } from "./assertions.js";
import type { ChaosConfig } from "./chaos-client.js";
import type { FakeRunnerConfig, FakeRunnerIssueBehavior } from "./fake-runner.js";
import { makeIssue } from "./fixtures.js";
import type { MutationDescriptor, SandboxScenario, TimedMutation } from "./scenario.js";

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
