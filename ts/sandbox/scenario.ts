import { SymphonyRuntime } from "@symphony/runtime";
import type { Issue, IssueStateType, WorkflowDefinition } from "@symphony/cli";
import type {
  RuntimeEvent,
  RuntimeSnapshot,
  SymphonyRuntimeOptions,
} from "@symphony/runtime";

import { ChaosLinearClient, type ChaosConfig } from "./chaos-client.js";
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

  const unsubscribe = runtime.subscribe((snapshot) => {
    snapshots.push(snapshot);
    for (const event of snapshot.recentEvents) {
      if (
        !events.some((e) => e.at === event.at && e.type === event.type && e.message === event.message)
      ) {
        events.push(event);
      }
    }
  });

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
    if (scenario.postRunDelayMs && scenario.postRunDelayMs > 0) {
      await sleep(scenario.postRunDelayMs);
    }
  } finally {
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
