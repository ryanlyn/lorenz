import { acpExecutorProvider } from "@symphony/acp";
import { defaultAgentExecutorRegistry } from "@symphony/agent-sdk";
import { registerMemoryTracker } from "@symphony/memory-tracker";
import { SymphonyRuntime } from "@symphony/runtime";
import type { Issue, IssueStateType, Settings, WorkflowDefinition } from "@symphony/cli";
import type { RuntimeEvent, RuntimeSnapshot, SymphonyRuntimeOptions } from "@symphony/runtime";

import { ChaosLinearClient, type ChaosConfig } from "./chaos-client.js";
import { createFakeClock, type FakeClock } from "./fake-clock.js";
import { createFakeAgentRunner, type FakeRunnerConfig } from "./fake-runner.js";
import { makeIssue, makeSettings, sleep } from "./fixtures.js";
import type { Assertion } from "./assertions.js";

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
  /** Delay after the last poll tick before runtime shutdown. Default 0. */
  postRunDelayMs?: number;
  /** Assertions to check after scenario completes. */
  assertions?: Assertion[];
  /**
   * Clock mode. Defaults to "fake": all retry/backoff/latency/tick timing runs
   * in virtual time via an injected clock, so scenarios complete near-instantly
   * and deterministically. Use "real" for wall-clock timing (e.g. the sandbox
   * CLI driving a live chaos demo).
   */
  clockMode?: "real" | "fake";
}

/**
 * The sandbox harness is its own composition root: the runtime validates dispatch
 * config against the process-default registries on every poll. Scenario settings
 * always dispatch on the memory tracker, so that backend and the ACP executor must
 * be registered before a scenario runs. Idempotent.
 */
function registerSandboxBackends(): void {
  registerMemoryTracker();
  if (defaultAgentExecutorRegistry.get(acpExecutorProvider.executor) === undefined) {
    defaultAgentExecutorRegistry.register(acpExecutorProvider);
  }
}

/**
 * Run a sandbox scenario: sets up the runtime with the chaos client and fake
 * runner, executes poll ticks, collects all events and snapshots, and returns
 * the full history.
 */
export async function runScenario(scenario: SandboxScenario): Promise<SandboxResult> {
  registerSandboxBackends();
  const settings = makeSettings(scenario.settingsOverrides ?? {});
  const client = new ChaosLinearClient(scenario.issues, scenario.chaosConfig);
  const fakeClock = (scenario.clockMode ?? "fake") === "fake" ? createFakeClock() : undefined;
  const runner = createFakeAgentRunner(scenario.runnerConfig ?? {}, fakeClock);

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
    clock: fakeClock,
    removeIssueWorkspaces: async () => {},
    appendLogEvent: async () => {},
    onAgentUpdate: () => {
      lastAgentActivityAt = Date.now();
    },
  };

  let lastAgentActivityAt = Date.now();
  const runtime = new SymphonyRuntime(runtimeOptions);

  const unsubscribe = runtime.subscribe((snapshot) => {
    snapshots.push(snapshot);
    for (const event of snapshot.recentEvents) {
      if (
        !events.some(
          (e) => e.at === event.at && e.type === event.type && e.message === event.message,
        )
      ) {
        events.push(event);
      }
    }
  });

  const cancelTimedMutations: Array<() => void> = [];
  if (scenario.timedMutations && scenario.timedMutations.length > 0) {
    for (const tm of scenario.timedMutations) {
      const apply = (): void => applyMutationDescriptor(client, tm.mutate);
      if (fakeClock) {
        const handle = fakeClock.setTimeout(apply, tm.afterMs);
        cancelTimedMutations.push(() => fakeClock.clearTimeout(handle));
      } else {
        const handle = setTimeout(apply, tm.afterMs);
        cancelTimedMutations.push(() => clearTimeout(handle));
      }
    }
  }

  const ticks = scenario.pollTicks ?? 1;
  const waitForRuns = scenario.waitForRuns ?? true;
  let ticksExecuted = 0;

  // In fake-clock mode, "waiting" advances virtual time (firing due timers);
  // in real mode it sleeps on the wall clock.
  const waitMs = async (ms: number): Promise<void> => {
    if (fakeClock) {
      await fakeClock.advance(ms);
    } else {
      await sleep(ms);
    }
  };

  try {
    for (let tick = 0; tick < ticks; tick++) {
      const mutationFn = scenario.mutations?.[tick];
      if (mutationFn) {
        mutationFn(client);
      }

      try {
        if (fakeClock) {
          await pollOnceWithFakeClock(runtime, { waitForRuns }, fakeClock, {
            tick,
            timeoutMs: scenarioPollTimeoutMs(settings, waitForRuns),
          });
        } else {
          await pollOnceWithScenarioTimeout(
            runtime,
            { waitForRuns },
            {
              tick,
              timeoutMs: scenarioPollTimeoutMs(settings, waitForRuns),
              lastActivityAt: () => lastAgentActivityAt,
            },
          );
        }
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }

      ticksExecuted += 1;

      if (scenario.tickDelayMs && scenario.tickDelayMs > 0 && tick < ticks - 1) {
        await waitMs(scenario.tickDelayMs);
      }
    }
    if (scenario.postRunDelayMs && scenario.postRunDelayMs > 0) {
      await waitMs(scenario.postRunDelayMs);
    }
  } finally {
    for (const cancel of cancelTimedMutations) {
      cancel();
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

/**
 * Drive an in-progress poll to completion under a fake clock.
 *
 * When the poll waits for in-flight runs, those runs' latency timers live on the
 * fake clock, so nothing advances unless we pump virtual time forward. Each step
 * we first fully drain the real microtask queue (via a real `setTimeout(0)`) so
 * `settled` reflects whether the poll can finish on its own; only if it is still
 * blocked do we fire the earliest pending timer. This guarantees we never skip
 * past work that would have completed without a timer, while still unblocking
 * runner latency / retry timers that the poll is genuinely waiting on.
 *
 * If the poll is blocked with no pending timer at all, the in-flight run is
 * stalled (e.g. a runner that never resolves). We mirror the real-mode stall
 * watchdog: stop the runtime and surface the same "stall timeout" error, just
 * without waiting out the wall clock.
 */
async function pollOnceWithFakeClock(
  runtime: SymphonyRuntime,
  options: { waitForRuns: boolean },
  clock: FakeClock,
  stall: { tick: number; timeoutMs: number },
): Promise<void> {
  if (!options.waitForRuns) {
    await runtime.pollOnce(options);
    return;
  }

  const poll = runtime.pollOnce(options);
  let settled = false;
  void poll.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  // Consecutive full microtask drains with no progress and no pending timer:
  // the run is stalled. A small bound keeps stall detection near-instant while
  // tolerating multi-stage immediately-resolving promise chains.
  let idleFlushes = 0;
  for (let guard = 0; guard < 1_000_000 && !settled; guard++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (settled) break;
    if (clock.hasPending()) {
      idleFlushes = 0;
      await clock.fireNext();
    } else if (++idleFlushes > 3) {
      runtime.stop();
      void poll.catch(() => {});
      throw new Error(
        stall.timeoutMs > 0
          ? `sandbox poll tick ${stall.tick} exceeded stall timeout of ${stall.timeoutMs}ms while waiting for runs`
          : `sandbox poll tick ${stall.tick} stalled with no pending timers`,
      );
    }
  }

  await poll;
}

async function pollOnceWithScenarioTimeout(
  runtime: SymphonyRuntime,
  options: { waitForRuns: boolean },
  timeout: { tick: number; timeoutMs: number; lastActivityAt: () => number },
): Promise<void> {
  if (!options.waitForRuns || timeout.timeoutMs <= 0) {
    await runtime.pollOnce(options);
    return;
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const poll = runtime.pollOnce(options);
  const timeoutError = new Error(
    `sandbox poll tick ${timeout.tick} exceeded stall timeout of ${timeout.timeoutMs}ms while waiting for runs`,
  );
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    const checkForStall = () => {
      const remainingMs = timeout.timeoutMs - (Date.now() - timeout.lastActivityAt());
      if (remainingMs > 0) {
        timeoutHandle = setTimeout(checkForStall, remainingMs);
        return;
      }
      runtime.stop();
      reject(timeoutError);
    };
    timeoutHandle = setTimeout(checkForStall, timeout.timeoutMs);
  });

  try {
    await Promise.race([poll, timeoutPromise]);
  } catch (error) {
    if (error === timeoutError) {
      poll.catch(() => {});
    }
    throw error;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function scenarioPollTimeoutMs(settings: Settings, waitForRuns: boolean): number {
  if (!waitForRuns) return 0;
  return settings.agents[settings.agent.kind]?.stallTimeoutMs ?? 0;
}

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
          {
            id: descriptor.blockerId,
            identifier: descriptor.blockerIdentifier ?? descriptor.blockerId,
            state: "Todo",
          },
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
