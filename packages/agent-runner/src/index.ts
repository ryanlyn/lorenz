import { settingsForIssueState } from "@lorenz/config";
import { issueIsActive } from "@lorenz/dispatch";
import type { AgentMcpEndpointLease } from "@lorenz/mcp";
import { ensembleSize } from "@lorenz/issue";
import { buildPrompt, continuationPrompt, issueEventsPrompt } from "@lorenz/prompt";
import {
  errorMessage,
  type AgentExecutor,
  type AgentSession,
  type AgentUpdate,
  type HookExecutionMessage,
  type Issue,
  type Settings,
  type TrackerIssueEvent,
  type WorkflowDefinition,
} from "@lorenz/domain";

const workerSetupTimeoutGraceMs = 1_000;
const workspaceCreateStage = "workspace.create_for_issue";
const beforeRunHookStage = "workspace.run_before_run_hook";
const afterRunHookStage = "workspace.run_after_run_hook";
const issueEventsFeedStage = "tracker.fetch_issue_events";

interface SetupStageSignalOptions {
  abortSignal?: AbortSignal | undefined;
  hookName?: HookExecutionMessage["hookName"] | undefined;
  onHookEvent?: ((message: HookExecutionMessage) => void) | undefined;
}

export interface RunAgentAttemptAdapters {
  createWorkspaceForIssue(
    settings: Settings,
    issue: Issue,
    options: {
      slotIndex: number;
      ensembleSize: number;
      workerHost: string | null;
      forceSlotSuffix?: boolean;
      abortSignal?: AbortSignal | undefined;
      onHookEvent?: ((message: HookExecutionMessage) => void) | undefined;
    },
  ): Promise<string>;
  runHook(
    command: string,
    workspace: string,
    hooks: Settings["hooks"],
    workerHost: string | null,
    options?: SetupStageSignalOptions,
    issue?: Issue,
  ): Promise<void>;
  executorFactory(settings: Settings): Promise<AgentExecutor> | AgentExecutor;
}

/**
 * The executor `startSession` input EXTENDED with the optional per-run
 * `mcpEndpoint` lease. The base is the shared `AgentExecutor.startSession`
 * parameter (so every required field stays in lockstep with the interface); the
 * extra optional `mcpEndpoint` is carried through to the acp executor's widened
 * input. Building the call argument as this type keeps the value assignable to
 * the narrower interface param without an excess-property error on a fresh
 * literal.
 */
type StartSessionInput = Parameters<AgentExecutor["startSession"]>[0] & {
  mcpEndpoint?: AgentMcpEndpointLease | null;
};

export interface RunResult {
  workspace: string;
  turnCount: number;
  agentKind: string;
  finalIssue?: Issue | undefined;
}

type TurnOutcome = { updates: AgentUpdate[] } | { error: unknown };

interface TurnActivity {
  sawToolCall: boolean;
}

interface QueuedTurn {
  outcome: Promise<TurnOutcome>;
  activity: TurnActivity;
}

export interface RunAgentAttemptInput {
  issue: Issue;
  workflow: WorkflowDefinition;
  settings?: Settings;
  workerHost?: string | null;
  slotIndex?: number;
  attempt?: number | null;
  /**
   * The dispatch coordinator's per-run MCP endpoint lease for THIS run, threaded
   * straight into `executor.startSession`. When present (non-null) the acp executor
   * USES it and skips acquiring/releasing its own endpoint (the coordinator owns
   * the whole lease). Absent / null on the local / non-pool path, where acp
   * acquires AND releases its own endpoint byte-for-byte.
   */
  mcpEndpoint?: AgentMcpEndpointLease | null;
  /**
   * Gated co-residence override for the workspace layout. When `true` the slot
   * suffix is applied UNCONDITIONALLY (so two solo runs of one issue co-residing on
   * one machine get distinct `<issue>/<slotIndex>` dirs instead of sharing the bare
   * path); the coordinator/runtime sets it only when `slotsPerMachine > 1`
   * co-residence is active. Absent / `false` (the default) keeps the single-slot
   * bare layout byte-identical.
   */
  forceSlotSuffix?: boolean;
  onUpdate?: (update: AgentUpdate) => void;
  fetchIssue?: (issue: Issue) => Promise<Issue>;
  /** Subscribe to live human-authored events for this run's issue. */
  subscribeIssueEvents?: (listener: (events: TrackerIssueEvent[]) => void) => () => void;
  /** Recover issue events missed by the live subscription. */
  fetchIssueEvents?: (sinceTs: string, abortSignal?: AbortSignal) => Promise<TrackerIssueEvent[]>;
  abortSignal?: AbortSignal | undefined;
  adapters?: Partial<RunAgentAttemptAdapters> | undefined;
}

export async function runAgentAttempt(input: RunAgentAttemptInput): Promise<RunResult> {
  return new RunController(input).run();
}

class RunController {
  constructor(private readonly input: RunAgentAttemptInput) {}

  async run(): Promise<RunResult> {
    const input = this.input;
    let issue = input.issue;
    const settings = input.settings ?? input.workflow.settings;
    let runtime = settingsForIssueState(settings, issue.state);
    const size = ensembleSize(issue) ?? settings.agent.ensembleSize;
    const slotIndex = input.slotIndex ?? 0;
    const workerHost = input.workerHost ?? null;
    let bufferedIssueEvents: TrackerIssueEvent[] = [];
    let receiveIssueEvents = (events: TrackerIssueEvent[]): void => {
      bufferedIssueEvents.push(...events);
    };
    let unsubscribeIssueEvents = input.subscribeIssueEvents?.((events) =>
      receiveIssueEvents(events),
    );
    let workspace: string;
    try {
      workspace = await runSetupStage(
        workspaceCreateStage,
        workspaceCreateTimeoutMs(runtime),
        async ({ abortSignal }) =>
          createWorkspaceForIssue(input.adapters, runtime, issue, {
            slotIndex,
            ensembleSize: size,
            workerHost,
            // Gated co-residence: force the slot suffix so two solo same-issue runs
            // that co-reside on one machine get distinct dirs. Default false keeps
            // the single-slot bare layout byte-identical.
            forceSlotSuffix: input.forceSlotSuffix ?? false,
            abortSignal,
            onHookEvent: (message) => this.emitHookUpdate(message),
          }),
        input.abortSignal,
      );
    } catch (error) {
      unsubscribeIssueEvents?.();
      throw error;
    }
    input.onUpdate?.({
      type: "workspace_prepared",
      workspacePath: workspace,
      message: `workspace prepared at ${workspace}`,
    });
    let session: AgentSession | null = null;

    let turnCount = 0;
    let submittedTurnCount = 0;
    let runError: unknown;
    let stopError: unknown;
    let stopSession: (() => Promise<void>) | undefined;
    let removeSessionAbortListener: (() => void) | undefined;
    try {
      const beforeRun = runtime.hooks.beforeRun;
      if (beforeRun) {
        await runSetupStage(
          beforeRunHookStage,
          hookStageTimeoutMs(runtime),
          async ({ abortSignal }) =>
            runHook(
              input.adapters,
              beforeRun,
              workspace,
              runtime.hooks,
              workerHost,
              {
                abortSignal,
                hookName: "before_run",
                onHookEvent: (message) => this.emitHookUpdate(message),
              },
              issue,
            ),
          input.abortSignal,
        );
      }

      const executor = await executorFor(input.adapters, runtime);
      const queuedTurns: QueuedTurn[] = [];
      const pendingStreamActivities: TurnActivity[] = [];
      let activeStreamActivity: TurnActivity | undefined;
      let currentNormalActivity: TurnActivity | undefined;
      // Thread the coordinator's per-run endpoint (or null on the local/non-pool
      // path) into the executor: the acp executor consumes a non-null lease and
      // skips its own acquire+release. Built as a typed value so the optional
      // `mcpEndpoint` field is carried to the executor's widened input without
      // tripping the excess-property check on the narrower `AgentExecutor`
      // interface. The field is a DECLARED optional on `StartSessionInput`, and
      // the executor reads an absent value as null, so the explicit `null` is the
      // deliberate, pinned disabled-path contract (a strict adapter rejecting a
      // declared optional field would be its own bug) - we keep it rather than
      // omit the key.
      const startSessionInput: StartSessionInput = {
        workspace,
        workerHost,
        issue,
        settings: runtime,
        mcpEndpoint: input.mcpEndpoint ?? null,
        // Stream updates through WITHOUT retaining them: a long-lived agent
        // session emits an unbounded stream of (potentially large) updates, and
        // accumulating them for the run's lifetime leaks memory in a daemon
        // whose runs can live for hours (the full history already goes to the
        // log file / trace emitter via onUpdate). Turn continuation only needs
        // to know whether the turn issued a tool call, so that single bit is
        // folded out of the stream here.
        onUpdate: (update) => {
          if (update.type === "turn_started") {
            activeStreamActivity = pendingStreamActivities.shift();
          }
          if (isToolCallNotification(update)) {
            const activity = activeStreamActivity ?? currentNormalActivity;
            if (activity) activity.sawToolCall = true;
          }
          input.onUpdate?.(update);
        },
      };
      session = await executor.startSession(startSessionInput);
      const startedSession = session;
      let stopPromise: Promise<void> | undefined;
      stopSession = async () => (stopPromise ??= startedSession.stop());
      if (input.abortSignal) {
        const stopOnAbort = (): void => {
          void stopSession?.().catch((error) => {
            process.stderr.write(`session.stop failed: ${error}\n`);
          });
        };
        input.abortSignal.addEventListener("abort", stopOnAbort, { once: true });
        removeSessionAbortListener = () =>
          input.abortSignal?.removeEventListener("abort", stopOnAbort);
        throwIfAborted(input.abortSignal);
      }

      if (!session.queueTurn) {
        unsubscribeIssueEvents?.();
        unsubscribeIssueEvents = undefined;
        bufferedIssueEvents = [];
        receiveIssueEvents = () => {};
      }
      const steeringRecoveryAvailable =
        typeof session.queueTurn === "function" &&
        Boolean(input.fetchIssue) &&
        Boolean(input.fetchIssueEvents) &&
        typeof issue.issueEventCursor === "string";
      const fetchSteeringIssueEvents = async (sinceTs: string): Promise<TrackerIssueEvent[]> => {
        if (!input.fetchIssueEvents || !steeringRecoveryAvailable) return [];
        return runSetupStage(
          issueEventsFeedStage,
          steeringFeedTimeoutMs(runtime),
          async ({ abortSignal }) => input.fetchIssueEvents?.(sinceTs, abortSignal) ?? [],
          input.abortSignal,
        );
      };
      let steeringRecoveryCursorTs = issue.issueEventCursor ?? "0";
      let steeringReady = false;
      const seenSteeringEventTs = new Set<string>();
      const reportSteeringFailure = (stage: string, error: unknown): void => {
        input.onUpdate?.({
          type: "stderr",
          workspacePath: workspace,
          message: `Ignoring steering ${stage} failure: ${errorMessage(error)}`,
        });
      };
      const queueIssueEvents = (events: TrackerIssueEvent[]): void => {
        if (!steeringReady) {
          bufferedIssueEvents.push(...events);
          return;
        }
        if (!session?.queueTurn) return;
        const candidates = [...bufferedIssueEvents, ...events];
        bufferedIssueEvents = [];
        let fresh: TrackerIssueEvent[];
        try {
          fresh = freshSteeringEvents(candidates, seenSteeringEventTs);
        } catch (error) {
          reportSteeringFailure("queue", error);
          return;
        }
        if (fresh.length === 0) return;
        if (submittedTurnCount >= runtime.agent.maxTurns) {
          bufferedIssueEvents = fresh;
          return;
        }
        try {
          const prompt = issueEventsPrompt(fresh);
          const activity = { sawToolCall: false };
          pendingStreamActivities.push(activity);
          let outcome: Promise<TurnOutcome>;
          try {
            outcome = session.queueTurn(prompt).then<TurnOutcome, TurnOutcome>(
              (updates) => ({ updates }),
              (error: unknown) => ({ error }),
            );
          } catch (error) {
            removePendingActivity(pendingStreamActivities, activity);
            throw error;
          }
          const queuedTurn = { outcome, activity };
          queuedTurns.push(queuedTurn);
          submittedTurnCount += 1;
          for (const event of fresh) seenSteeringEventTs.add(event.ts);
        } catch (error) {
          bufferedIssueEvents = fresh;
          reportSteeringFailure("queue", error);
        }
      };
      const initializeSteering = (): void => {
        const buffered = bufferedIssueEvents;
        bufferedIssueEvents = [];
        steeringReady = true;
        queueIssueEvents(buffered);
      };
      const recoverSteering = async (): Promise<void> => {
        if (!steeringRecoveryAvailable || submittedTurnCount >= runtime.agent.maxTurns) {
          return;
        }
        try {
          const recovered = await fetchSteeringIssueEvents(steeringRecoveryCursorTs);
          queueIssueEvents(recovered);
          steeringRecoveryCursorTs = maxSteeringTs(recovered, steeringRecoveryCursorTs);
        } catch (error) {
          throwIfAborted(input.abortSignal);
          reportSteeringFailure("recovery", error);
        }
      };

      receiveIssueEvents = queueIssueEvents;

      while (turnCount < runtime.agent.maxTurns) {
        throwIfAborted(input.abortSignal);
        const queuedTurn = queuedTurns.shift();
        if (!queuedTurn && submittedTurnCount >= runtime.agent.maxTurns) break;
        let turnUpdates: AgentUpdate[];
        let turnActivity: TurnActivity;
        if (queuedTurn) {
          turnActivity = queuedTurn.activity;
          const outcome = await queuedTurnWithAbort(
            queuedTurn.outcome,
            stopSession,
            input.abortSignal,
          );
          if ("error" in outcome) throw outcome.error;
          turnUpdates = outcome.updates;
          removePendingActivity(pendingStreamActivities, turnActivity);
          if (activeStreamActivity === turnActivity) activeStreamActivity = undefined;
        } else {
          turnActivity = { sawToolCall: false };
          const prompt =
            turnCount === 0
              ? await buildPrompt(
                  input.workflow.parsedPromptTemplate ?? input.workflow.promptTemplate,
                  issue,
                  {
                    attempt: input.attempt ?? null,
                    slotIndex,
                    ensembleSize: size,
                  },
                )
              : continuationPrompt(turnCount + 1, runtime.agent.maxTurns);
          pendingStreamActivities.push(turnActivity);
          currentNormalActivity = turnActivity;
          try {
            const turnPromise = runTurnWithAbort(
              executor,
              session,
              prompt,
              issue,
              stopSession,
              input.abortSignal,
            );
            submittedTurnCount += 1;
            if (turnCount === 0) initializeSteering();
            turnUpdates = await turnPromise;
          } finally {
            currentNormalActivity = undefined;
            removePendingActivity(pendingStreamActivities, turnActivity);
            if (activeStreamActivity === turnActivity) activeStreamActivity = undefined;
          }
        }
        turnCount += 1;

        // Known seam leak: turn-continuation is decided from ACP event vocabulary here
        // instead of an executor-owned hook. Generalize onto the session contract (a
        // provider-supplied "has more work" classifier) when a second executor lands.
        // The signal is primarily derived from the STREAMED updates (see onUpdate
        // above): the returned batch may be bounded for very long turns (see
        // AgentExecutor.runTurn), so an early tool call could be missing from it.
        const completedWithoutTools =
          turnCount > 1 &&
          queuedTurns.length === 0 &&
          runtime.agents[runtime.agent.kind]?.executor === "acp" &&
          !turnActivity.sawToolCall &&
          !turnUpdates.some(isToolCallNotification);

        if (completedWithoutTools && !steeringRecoveryAvailable) break;
        if (!input.fetchIssue) {
          if (queuedTurns.length > 0) continue;
          break;
        }
        issue = await input.fetchIssue(issue);
        if (!issueIsActive(issue, settings)) break;
        const refreshed = settingsForIssueState(settings, issue.state);
        if (
          refreshed.agent.kind !== runtime.agent.kind ||
          backendProfile(refreshed) !== backendProfile(runtime)
        ) {
          break;
        }
        runtime = refreshed;
        queueIssueEvents([]);
        await recoverSteering();
        if (completedWithoutTools && queuedTurns.length === 0) break;
      }
    } catch (error) {
      runError = error;
    } finally {
      removeSessionAbortListener?.();
      unsubscribeIssueEvents?.();
      if (stopSession) {
        try {
          await stopSession();
        } catch (error) {
          stopError = error;
        }
      }
      await this.runAfterRunHook(runtime, workspace, workerHost, issue);
    }

    if (runError) throw toError(runError);
    if (stopError) throw toError(stopError);
    if (!session) throw new Error("agent_runner_session_missing");

    return {
      workspace,
      turnCount,
      agentKind: runtime.agent.kind,
      finalIssue: issue,
    };
  }

  private async runAfterRunHook(
    runtime: Settings,
    workspace: string,
    workerHost: string | null,
    issue: Issue,
  ): Promise<void> {
    const input = this.input;
    const afterRun = runtime.hooks.afterRun;
    if (!afterRun) return;
    try {
      await runSetupStage(afterRunHookStage, hookStageTimeoutMs(runtime), async ({ abortSignal }) =>
        runHook(
          input.adapters,
          afterRun,
          workspace,
          runtime.hooks,
          workerHost,
          {
            abortSignal,
            hookName: "after_run",
            onHookEvent: (message) => this.emitHookUpdate(message),
          },
          issue,
        ),
      );
    } catch (error) {
      input.onUpdate?.({
        type: "stderr",
        workspacePath: workspace,
        message: `Ignoring after_run hook failure (${afterRunHookStage}): ${errorMessage(error)}`,
      });
    }
  }

  private emitHookUpdate(message: HookExecutionMessage): void {
    this.input.onUpdate?.({
      type: "hook_execution",
      message,
      workspacePath: message.cwd,
      timestamp: new Date(),
    });
  }
}

async function runTurnWithAbort(
  executor: AgentExecutor,
  session: AgentSession,
  prompt: string,
  issue: Issue,
  stopSession: () => Promise<void>,
  abortSignal: AbortSignal | undefined,
): Promise<AgentUpdate[]> {
  if (!abortSignal) return executor.runTurn(session, prompt, issue);
  throwIfAborted(abortSignal);
  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<AgentUpdate[]>((_resolve, reject) => {
    onAbort = () => {
      reject(new Error("agent_run_aborted"));
      void stopSession().catch((err) => {
        process.stderr.write(`session.stop failed: ${err}\n`);
      });
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([executor.runTurn(session, prompt, issue), abortPromise]);
  } finally {
    if (onAbort) abortSignal?.removeEventListener("abort", onAbort);
  }
}

async function queuedTurnWithAbort(
  outcome: Promise<TurnOutcome>,
  stopSession: () => Promise<void>,
  abortSignal: AbortSignal | undefined,
): Promise<TurnOutcome> {
  if (!abortSignal) return outcome;
  throwIfAborted(abortSignal);
  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<TurnOutcome>((_resolve, reject) => {
    onAbort = () => {
      reject(new Error("agent_run_aborted"));
      void stopSession().catch((err) => {
        process.stderr.write(`session.stop failed: ${err}\n`);
      });
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([outcome, abortPromise]);
  } finally {
    if (onAbort) abortSignal.removeEventListener("abort", onAbort);
  }
}

function freshSteeringEvents(
  events: TrackerIssueEvent[],
  seenTs: ReadonlySet<string>,
): TrackerIssueEvent[] {
  const batchTs = new Set<string>();
  return events
    .filter((event) => {
      if (seenTs.has(event.ts) || batchTs.has(event.ts)) return false;
      batchTs.add(event.ts);
      return true;
    })
    .sort((left, right) => compareSteeringTs(left.ts, right.ts));
}

function maxSteeringTs(events: TrackerIssueEvent[], current: string): string {
  let max = current;
  for (const event of events) {
    if (compareSteeringTs(event.ts, max) > 0) max = event.ts;
  }
  return max;
}

function compareSteeringTs(left: string, right: string): number {
  const leftParts = decimalOrderingKey(left);
  const rightParts = decimalOrderingKey(right);
  if (!leftParts || !rightParts) {
    throw new Error(`invalid tracker issue event ordering key: ${!leftParts ? left : right}`);
  }
  if (leftParts.integer.length !== rightParts.integer.length) {
    return leftParts.integer.length - rightParts.integer.length;
  }
  if (leftParts.integer !== rightParts.integer) {
    return leftParts.integer < rightParts.integer ? -1 : 1;
  }
  const width = Math.max(leftParts.fraction.length, rightParts.fraction.length);
  const leftFraction = leftParts.fraction.padEnd(width, "0");
  const rightFraction = rightParts.fraction.padEnd(width, "0");
  if (leftFraction === rightFraction) return 0;
  return leftFraction < rightFraction ? -1 : 1;
}

function decimalOrderingKey(value: string): { integer: string; fraction: string } | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  return {
    integer: match[1]!.replace(/^0+(?=\d)/, ""),
    fraction: (match[2] ?? "").replace(/0+$/, ""),
  };
}

function removePendingActivity(pending: TurnActivity[], activity: TurnActivity): void {
  const index = pending.indexOf(activity);
  if (index !== -1) pending.splice(index, 1);
}

/** True for a streamed ACP session notification describing a tool call. */
function isToolCallNotification(update: AgentUpdate): boolean {
  return (
    update.type === "session_notification" && update.message.update?.sessionUpdate === "tool_call"
  );
}

function throwIfAborted(abortSignal: AbortSignal | undefined): void {
  if (!abortSignal?.aborted) return;
  throw new Error("agent_run_aborted");
}

async function executorFor(
  adapters: Partial<RunAgentAttemptAdapters> | undefined,
  settings: Settings,
): Promise<AgentExecutor> {
  if (adapters?.executorFactory) return adapters.executorFactory(settings);
  throw new Error("agent_runner_adapter_missing: executorFactory");
}

function workspaceCreateTimeoutMs(settings: Settings): number {
  const agent = settings.agents[settings.agent.kind];
  if (!agent) throw new Error(`agents.${settings.agent.kind} is required`);
  return agent.stallTimeoutMs;
}

function hookStageTimeoutMs(settings: Settings): number {
  return settings.hooks.timeoutMs + workerSetupTimeoutGraceMs;
}

function steeringFeedTimeoutMs(settings: Settings): number {
  const agent = settings.agents[settings.agent.kind];
  if (!agent) throw new Error(`agents.${settings.agent.kind} is required`);
  return agent.stallTimeoutMs > 0
    ? Math.min(agent.stallTimeoutMs, agent.turnTimeoutMs)
    : agent.turnTimeoutMs;
}

class SetupStageTimeoutError extends Error {
  constructor(
    readonly stageName: string,
    readonly timeoutMs: number,
  ) {
    super(`agent_runner_timeout: ${stageName} timed out after ${timeoutMs}ms`);
  }
}

async function runSetupStage<T>(
  stageName: string,
  timeoutMs: number,
  fn: (options: { abortSignal: AbortSignal }) => Promise<T>,
  parentAbortSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timeoutError: SetupStageTimeoutError | undefined;
  let abortError: Error | undefined;
  let onParentAbort: (() => void) | undefined;
  const races: Promise<T>[] = [
    Promise.resolve().then(async () => fn({ abortSignal: controller.signal })),
  ];

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    races.push(
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timeoutError = new SetupStageTimeoutError(stageName, timeoutMs);
          controller.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      }),
    );
  }
  if (parentAbortSignal) {
    races.push(
      new Promise<never>((_resolve, reject) => {
        onParentAbort = () => {
          abortError = new Error("agent_run_aborted");
          controller.abort(abortError);
          reject(abortError);
        };
        if (parentAbortSignal.aborted) {
          onParentAbort();
        } else {
          parentAbortSignal.addEventListener("abort", onParentAbort, { once: true });
        }
      }),
    );
  }

  try {
    return await Promise.race(races);
  } catch (error) {
    if (timeoutError) throw timeoutError;
    if (abortError) throw abortError;
    if (error instanceof SetupStageTimeoutError) throw error;
    throw new Error(`agent_runner_setup_crashed: ${stageName}: ${errorMessage(error)}`, {
      cause: error,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onParentAbort) parentAbortSignal?.removeEventListener("abort", onParentAbort);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function backendProfile(settings: Settings): string {
  return JSON.stringify(settings.agents[settings.agent.kind] ?? null);
}

async function createWorkspaceForIssue(
  adapters: Partial<RunAgentAttemptAdapters> | undefined,
  settings: Settings,
  issue: Issue,
  options: {
    slotIndex: number;
    ensembleSize: number;
    workerHost: string | null;
    forceSlotSuffix?: boolean;
    abortSignal?: AbortSignal | undefined;
    onHookEvent?: ((message: HookExecutionMessage) => void) | undefined;
  },
): Promise<string> {
  if (adapters?.createWorkspaceForIssue)
    return adapters.createWorkspaceForIssue(settings, issue, options);
  throw new Error("agent_runner_adapter_missing: createWorkspaceForIssue");
}

async function runHook(
  adapters: Partial<RunAgentAttemptAdapters> | undefined,
  command: string,
  workspacePath: string,
  hooks: Settings["hooks"],
  workerHost: string | null,
  options?: SetupStageSignalOptions,
  issue?: Issue,
): Promise<void> {
  if (adapters?.runHook)
    return adapters.runHook(command, workspacePath, hooks, workerHost, options, issue);
  throw new Error("agent_runner_adapter_missing: runHook");
}
