/**
 * Linear sandbox: exercises SymphonyRuntime against a REAL Linear project.
 *
 * Unlike the in-memory sandbox (sandbox.ts), this variant:
 * - Creates real Linear issues via the API as test fixtures
 * - Uses the real LinearClient as the RuntimeTrackerClient
 * - Uses the real runAgentAttempt (RunController) with a fake AgentExecutor
 * - Mirrors production wiring: clientFactory, full runner adapters
 * - Cleans up (archives) all created issues on completion
 *
 * Requires: LINEAR_API_KEY and LINEAR_PROJECT_SLUG environment variables.
 *
 * Usage:
 *   LINEAR_API_KEY=... LINEAR_PROJECT_SLUG=... npx tsx sandbox/linear-sandbox.ts
 */

import { LinearClient, parseConfig } from "@symphony/cli";
import {
  runAgentAttempt as runAgentAttemptCore,
  type RunAgentAttemptAdapters,
  type RunAgentAttemptInput,
  type RunResult,
} from "@symphony/agent-runner";
import { SymphonyRuntime } from "@symphony/runtime";
import type { Issue, Settings, WorkflowDefinition, AgentExecutor, AgentSession } from "@symphony/cli";
import type {
  RuntimeRunner,
  RuntimeSnapshot,
  RuntimeEvent,
  SymphonyRuntimeOptions,
} from "@symphony/runtime";
import type { LinearProject, LinearTeam, LinearState } from "@symphony/linear-tracker";

import { sleep } from "./sandbox.js";
import type { FakeRunnerConfig, FakeRunnerIssueBehavior, Assertion } from "./sandbox.js";
import { checkAssertions } from "./sandbox.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LinearSandboxContext {
  client: LinearClient;
  settings: Settings;
  project: LinearProject;
  team: LinearTeam;
  states: { todo: LinearState; inProgress: LinearState; done: LinearState };
  viewerId: string;
}

export interface LinearSandboxScenario {
  /** Issue definitions to create in Linear. Each needs at minimum a title. */
  issues: Array<{
    title: string;
    description?: string;
    priority?: number;
    labels?: string[];
  }>;
  /** Fake runner behavior configuration. */
  runnerConfig?: FakeRunnerConfig;
  /** Number of poll ticks to execute. Default 3. */
  pollTicks?: number;
  /** Delay (ms) between poll ticks. Default 2000 (gives Linear time to propagate). */
  tickDelayMs?: number;
  /** If true, wait for all in-flight runs after each tick. Default true. */
  waitForRuns?: boolean;
  /** Max concurrent agents. Default 5. */
  maxConcurrentAgents?: number;
  /** Assertions to check after scenario completes. */
  assertions?: Assertion[];
  /** Optional hook invoked after each poll tick, before the inter-tick delay. */
  afterPoll?: (context: LinearSandboxPollHookContext) => Promise<void> | void;
}

export interface LinearSandboxPollHookContext {
  tick: number;
  ctx: LinearSandboxContext;
  createdIssues: Issue[];
  snapshots: RuntimeSnapshot[];
  events: RuntimeEvent[];
}

export interface LinearSandboxResult {
  snapshots: RuntimeSnapshot[];
  events: RuntimeEvent[];
  errors: Error[];
  finalSnapshot: RuntimeSnapshot;
  ticksExecuted: number;
  /** Included for SandboxResult compatibility (not meaningful for real API). */
  clientCallCount: number;
  /** Linear issue IDs created during setup. */
  createdIssueIds: string[];
  /** Issues as fetched from Linear after creation. */
  createdIssues: Issue[];
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export async function setupLinearSandbox(): Promise<LinearSandboxContext> {
  const apiKey = process.env.LINEAR_API_KEY;
  const projectSlug = process.env.LINEAR_PROJECT_SLUG;
  if (!apiKey) throw new Error("LINEAR_API_KEY is required");
  if (!projectSlug) throw new Error("LINEAR_PROJECT_SLUG is required");

  const settings = parseConfig(
    {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_API_KEY",
        project_slug: "$LINEAR_PROJECT_SLUG",
        active_states: ["Todo", "In Progress"],
        terminal_states: ["Done", "Canceled", "Cancelled", "Duplicate", "Closed"],
        assignee: "me",
      },
      polling: { intervalMs: 2000 },
      workspace: { root: "/tmp/linear-sandbox-workspaces" },
      agent: {
        kind: "codex",
        maxConcurrentAgents: 5,
        maxTurns: 10,
        maxRetryBackoffMs: 5000,
        ensembleSize: 1,
      },
      codex: {
        command: "echo codex",
        turnTimeoutMs: 60_000,
        stallTimeoutMs: 30_000,
      },
    },
    process.env,
    { tmpdir: "/tmp", cwd: "/tmp" },
  );

  const client = new LinearClient(settings);
  const viewer = await client.viewer();
  settings.tracker.assignee = viewer.id;

  const project = await client.projectBySlug();
  const team = project.teams[0];
  if (!team) throw new Error("Linear project has no teams");

  const todo =
    team.states.find((s) => s.name === "Todo") ?? team.states.find((s) => s.type === "unstarted");
  const inProgress =
    team.states.find((s) => s.name === "In Progress") ??
    team.states.find((s) => s.type === "started");
  const done =
    team.states.find((s) => s.name === "Done") ?? team.states.find((s) => s.type === "completed");

  if (!todo) throw new Error("No Todo/unstarted state found");
  if (!inProgress) throw new Error("No In Progress/started state found");
  if (!done) throw new Error("No Done/completed state found");

  return {
    client,
    settings,
    project,
    team,
    states: { todo, inProgress, done },
    viewerId: viewer.id,
  };
}

// ---------------------------------------------------------------------------
// Scenario Runner
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Production-faithful runner: uses real runAgentAttempt with a fake executor
// ---------------------------------------------------------------------------

function createSandboxExecutor(config: FakeRunnerConfig): AgentExecutor {
  const defaultBehavior: Required<FakeRunnerIssueBehavior> = {
    shouldSucceed: true,
    errorMessage: "FakeExecutor: simulated failure",
    turnCount: 1,
    latencyPerTurnMs: 0,
    stall: false,
    usagePerTurn: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    crashMidTurn: false,
    crashAtTurn: 1,
    customUpdates: [],
  };

  function resolveBehavior(issue: Issue | undefined): Required<FakeRunnerIssueBehavior> {
    if (!issue) return { ...defaultBehavior, ...config.defaultBehavior };
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

  const turnsBySession = new Map<string, number>();

  return {
    kind: "codex" as const,
    async startSession(input) {
      const sessionId = `sandbox-session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const session: AgentSession = {
        agentKind: "codex",
        sessionId,
        resumeId: input.resumeId ?? null,
        executorPid: null,
        async stop() {
          turnsBySession.delete(sessionId);
        },
      };
      turnsBySession.set(sessionId, 0);
      input.onUpdate?.({ type: "session_started", message: `session started (${sessionId})`, sessionId });
      return session;
    },
    async runTurn(session, _prompt, issue) {
      const behavior = resolveBehavior(issue);
      const sessionId = session.sessionId!;
      const currentTurn = (turnsBySession.get(sessionId) ?? 0) + 1;
      turnsBySession.set(sessionId, currentTurn);

      if (behavior.stall) {
        return new Promise<never>(() => {});
      }

      if (behavior.crashMidTurn && currentTurn === behavior.crashAtTurn) {
        throw new Error("FakeExecutor: crash mid-turn");
      }

      if (behavior.latencyPerTurnMs > 0) {
        await sleep(behavior.latencyPerTurnMs);
      }

      if (!behavior.shouldSucceed) {
        throw new Error(behavior.errorMessage);
      }

      return [];
    },
  };
}

function createSandboxRunnerAdapters(executor: AgentExecutor): RunAgentAttemptAdapters {
  let workspaceCounter = 0;
  return {
    async createWorkspaceForIssue(_settings, issue, _options) {
      workspaceCounter += 1;
      return `/tmp/linear-sandbox-workspaces/${issue.identifier}-${workspaceCounter}`;
    },
    async runHook() {},
    async readResumeState() {
      return { status: "missing" as const };
    },
    resumeStateMatches() {
      return false;
    },
    async writeResumeState() {},
    executorFactory: () => executor,
  };
}

function createSandboxRunner(config: FakeRunnerConfig): RuntimeRunner {
  const executor = createSandboxExecutor(config);
  const adapters = createSandboxRunnerAdapters(executor);

  return async (input: RunAgentAttemptInput): Promise<RunResult> => {
    return runAgentAttemptCore({ ...input, adapters });
  };
}

export async function runLinearScenario(
  ctx: LinearSandboxContext,
  scenario: LinearSandboxScenario,
): Promise<LinearSandboxResult> {
  const marker = `linear-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createdIssueIds: string[] = [];
  const createdIssues: Issue[] = [];

  try {
    // Seed issues in Linear
    for (const def of scenario.issues) {
      const issue = await ctx.client.createIssue({
        teamId: ctx.team.id,
        projectId: ctx.project.id,
        stateId: ctx.states.todo.id,
        title: `[${marker}] ${def.title}`,
        description: def.description ?? `Sandbox test issue. Marker: ${marker}`,
        assigneeId: ctx.viewerId,
        priority: def.priority,
      });
      createdIssueIds.push(issue.id);
      createdIssues.push(issue);
    }

    // Wait for Linear to propagate
    await sleep(1000);

    // Configure settings with concurrency and turn-limit overrides
    const settings = { ...ctx.settings };
    if (scenario.maxConcurrentAgents !== undefined) {
      settings.agent = { ...settings.agent, maxConcurrentAgents: scenario.maxConcurrentAgents };
    }
    if (scenario.runnerConfig?.defaultBehavior?.turnCount !== undefined) {
      settings.agent = { ...settings.agent, maxTurns: scenario.runnerConfig.defaultBehavior.turnCount };
    }

    const runner = createSandboxRunner(scenario.runnerConfig ?? {});

    const workflow: WorkflowDefinition = {
      path: "/tmp/linear-sandbox-workflow.md",
      config: {},
      promptTemplate: "Fix issue {{ issue.identifier }}: {{ issue.title }}",
      settings,
    };

    const snapshots: RuntimeSnapshot[] = [];
    const events: RuntimeEvent[] = [];
    const errors: Error[] = [];

    const runtimeOptions: SymphonyRuntimeOptions = {
      workflow,
      clientFactory: () => ctx.client,
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
          !events.some(
            (e) => e.at === event.at && e.type === event.type && e.message === event.message,
          )
        ) {
          events.push(event);
        }
      }
    });

    const ticks = scenario.pollTicks ?? 3;
    const tickDelayMs = scenario.tickDelayMs ?? 2000;
    const waitForRuns = scenario.waitForRuns ?? true;
    let ticksExecuted = 0;

    try {
      for (let tick = 0; tick < ticks; tick++) {
        try {
          await runtime.pollOnce({ waitForRuns });
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
        ticksExecuted += 1;

        if (scenario.afterPoll) {
          try {
            await scenario.afterPoll({
              tick,
              ctx,
              createdIssues,
              snapshots,
              events,
            });
          } catch (err) {
            errors.push(err instanceof Error ? err : new Error(String(err)));
          }
        }

        if (tick < ticks - 1) {
          await sleep(tickDelayMs);
        }
      }
    } finally {
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
      clientCallCount: 0,
      createdIssueIds,
      createdIssues,
    };
  } finally {
    // Cleanup: move all created issues to Done and archive them
    for (const id of createdIssueIds) {
      try {
        await ctx.client.updateIssueState(id, ctx.states.done.id);
        await ctx.client.archiveIssue(id);
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

async function cliMain(): Promise<void> {
  process.stderr.write("Linear Sandbox: setting up...\n");

  const ctx = await setupLinearSandbox();
  process.stderr.write(`  Authenticated as viewer: ${ctx.viewerId}\n`);
  process.stderr.write(`  Project: ${ctx.project.name} (${ctx.project.slugId})\n`);
  process.stderr.write(`  Team: ${ctx.team.key} (${ctx.team.name})\n`);
  process.stderr.write(`  States: Todo=${ctx.states.todo.id}, Done=${ctx.states.done.id}\n\n`);

  const scenario: LinearSandboxScenario = {
    issues: [
      { title: "Hello World script", description: "Create hello_world.py" },
      { title: "Fibonacci function", description: "Create fibonacci.py" },
      { title: "Add README", description: "Create README.md" },
    ],
    pollTicks: 3,
    tickDelayMs: 2000,
    maxConcurrentAgents: 3,
    assertions: [{ type: "no_errors" }, { type: "concurrency_cap", maxConcurrent: 3 }],
  };

  process.stderr.write(
    `Running scenario: ${scenario.issues.length} issues, ${scenario.pollTicks} ticks\n`,
  );

  const result = await runLinearScenario(ctx, scenario);

  const assertionResults = scenario.assertions ? checkAssertions(result, scenario.assertions) : [];
  const allPassed = assertionResults.every((r) => r.passed);

  const output = {
    success: assertionResults.length === 0 || allPassed,
    ticksExecuted: result.ticksExecuted,
    createdIssues: result.createdIssues.map((i) => ({
      id: i.id,
      identifier: i.identifier,
      title: i.title,
    })),
    eventCount: result.events.length,
    snapshotCount: result.snapshots.length,
    errors: result.errors.map((e) => e.message),
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
      assertionResults.length > 0
        ? `PASSED: all ${assertionResults.length} assertion(s) passed\n`
        : `DONE: scenario completed (no assertions defined)\n`,
    );
  }
}

const isDirectExecution =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("linear-sandbox.ts") || process.argv[1].endsWith("linear-sandbox.js"));

if (isDirectExecution) {
  cliMain().catch((err) => {
    process.stderr.write(`Fatal error: ${err}\n`);
    process.exit(1);
  });
}
