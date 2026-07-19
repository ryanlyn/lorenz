import { settingsForIssueState } from "@lorenz/config";
import { issueIsActive } from "@lorenz/dispatch";
import type { AgentMcpEndpointLease } from "@lorenz/mcp";
import { ensembleSize } from "@lorenz/issue";
import { buildPrompt, continuationPrompt, issueEventsPrompt } from "@lorenz/prompt";
import {
  boundTrackerIssueEventText,
  errorMessage,
  trackerIssueEventsBytes,
  type AgentExecutor,
  type AgentSession,
  type AgentUpdate,
  type HookExecutionMessage,
  type Issue,
  type Settings,
  type TrackerIssueEvent,
  type TrackerIssueEventPage,
  type TrackerIssueEventQuery,
  type WorkflowDefinition,
} from "@lorenz/domain";

const workerSetupTimeoutGraceMs = 1_000;
const workspaceCreateStage = "workspace.create_for_issue";
const beforeRunHookStage = "workspace.run_before_run_hook";
const afterRunHookStage = "workspace.run_after_run_hook";
const issueEventsFeedStage = "tracker.fetch_issue_events";
const maxBufferedIssueEventBytes = 64 * 1024;
const maxRecoveredIssueEvents = 1_000;

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
  activated: boolean;
  activate(): void;
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
  fetchIssueEvents?: (
    sinceTs: string,
    query: TrackerIssueEventQuery,
  ) => Promise<TrackerIssueEventPage>;
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
    let bufferedIssueEventBytes = 0;
    let issueEventBufferOverflow = false;
    const bufferIssueEvents = (events: TrackerIssueEvent[]): void => {
      for (const event of events) {
        const bounded = boundTrackerIssueEventText(event, maxBufferedIssueEventBytes);
        if (!bounded) {
          issueEventBufferOverflow = true;
          continue;
        }
        const eventBytes = trackerIssueEventsBytes([bounded]);
        if (bufferedIssueEventBytes + eventBytes > maxBufferedIssueEventBytes) {
          issueEventBufferOverflow = true;
          continue;
        }
        bufferedIssueEvents.push(bounded);
        bufferedIssueEventBytes += eventBytes;
      }
    };
    let receiveIssueEvents = (events: TrackerIssueEvent[]): void => {
      bufferIssueEvents(events);
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
    let autonomousTurnCount = 0;
    let runError: unknown;
    let stopError: unknown;
    let stopSession: (() => Promise<void>) | undefined;
    let stopSteeringRecovery: (() => void) | undefined;
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
        Boolean(input.fetchIssueEvents) &&
        typeof issue.issueEventCursor === "string";
      let steeringDeliveryClosed = false;
      const steeringRecoveryController = new AbortController();
      const steeringRecoverySignal = input.abortSignal
        ? AbortSignal.any([input.abortSignal, steeringRecoveryController.signal])
        : steeringRecoveryController.signal;
      stopSteeringRecovery = () => {
        steeringDeliveryClosed = true;
        steeringRecoveryController.abort();
      };
      const fetchSteeringIssueEvents = async (sinceTs: string): Promise<TrackerIssueEventPage> => {
        if (!input.fetchIssueEvents || !steeringRecoveryAvailable) {
          return { events: [], hasMore: false };
        }
        const page = await runSetupStage(
          issueEventsFeedStage,
          steeringFeedTimeoutMs(runtime),
          async ({ abortSignal }) =>
            input.fetchIssueEvents?.(sinceTs, {
              maxEvents: maxRecoveredIssueEvents,
              maxBytes: maxBufferedIssueEventBytes,
              abortSignal,
            }) ?? { events: [], hasMore: false },
          steeringRecoverySignal,
        );
        validateIssueEventPage(page, maxRecoveredIssueEvents, maxBufferedIssueEventBytes);
        return page;
      };
      const steeringSnapshotCursorTs = issue.issueEventCursor;
      if (
        steeringSnapshotCursorTs !== null &&
        steeringSnapshotCursorTs !== undefined &&
        !decimalOrderingKey(steeringSnapshotCursorTs)
      ) {
        throw new Error(`invalid tracker issue event ordering key: ${steeringSnapshotCursorTs}`);
      }
      let steeringRecoveryCursorTs = steeringSnapshotCursorTs ?? "0";
      let steeringReady = false;
      let steeringTurnCount = 0;
      const seenSteeringEventTs = new Set<string>();
      const reportSteeringFailure = (stage: string, error: unknown): void => {
        input.onUpdate?.({
          type: "stderr",
          workspacePath: workspace,
          message: `Ignoring steering ${stage} failure: ${errorMessage(error)}`,
        });
      };
      const queueIssueEvents = (
        events: TrackerIssueEvent[],
        includeBuffered = true,
      ): {
        acceptedThrough: string | null;
        failed: boolean;
      } => {
        if (steeringDeliveryClosed) return { acceptedThrough: null, failed: false };
        if (!steeringReady) {
          bufferIssueEvents(events);
          return { acceptedThrough: null, failed: false };
        }
        if (!session?.queueTurn) {
          return { acceptedThrough: null, failed: false };
        }
        const candidates = includeBuffered ? [...bufferedIssueEvents, ...events] : events;
        if (includeBuffered) {
          bufferedIssueEvents = [];
          bufferedIssueEventBytes = 0;
        }
        const { fresh, invalidTs } = freshSteeringEvents(
          candidates,
          seenSteeringEventTs,
          steeringSnapshotCursorTs,
        );
        if (invalidTs.length > 0) {
          reportSteeringFailure(
            "event validation",
            new Error(`invalid ordering keys: ${invalidTs.join(", ")}`),
          );
        }
        let acceptedThrough: string | null = null;
        let offset = 0;
        while (offset < fresh.length && steeringTurnCount < runtime.agent.maxTurns) {
          const chunk = steeringEventChunk(fresh, offset, maxBufferedIssueEventBytes);
          const prompt = issueEventsPrompt(chunk.promptEvents);
          const activity = { sawToolCall: false };
          pendingStreamActivities.push(activity);
          let releaseActivation: (() => void) | undefined;
          const startWhen = new Promise<void>((resolve) => {
            releaseActivation = resolve;
          });
          let outcome: Promise<TurnOutcome>;
          try {
            outcome = session
              .queueTurn(prompt, { startWhen })
              .then<TurnOutcome, TurnOutcome>(
                (updates) => ({ updates }),
                (error: unknown) => ({ error }),
              )
              .then((turnOutcome) => {
                if ("error" in turnOutcome) stopSteeringRecovery?.();
                return turnOutcome;
              });
          } catch (error) {
            removePendingActivity(pendingStreamActivities, activity);
            bufferIssueEvents(fresh.slice(offset));
            reportSteeringFailure("queue", error);
            return { acceptedThrough, failed: true };
          }
          const queuedTurn: QueuedTurn = {
            outcome,
            activity,
            activated: false,
            activate() {
              if (queuedTurn.activated) return;
              queuedTurn.activated = true;
              releaseActivation?.();
            },
          };
          queuedTurns.push(queuedTurn);
          steeringTurnCount += 1;
          for (const event of chunk.sourceEvents) seenSteeringEventTs.add(event.ts);
          acceptedThrough = maxSteeringTs(chunk.sourceEvents, acceptedThrough ?? "0");
          offset += chunk.sourceEvents.length;
        }
        return {
          acceptedThrough,
          failed: false,
        };
      };
      const recoverSteering = async (required: boolean): Promise<void> => {
        try {
          const page = steeringRecoveryAvailable
            ? await fetchSteeringIssueEvents(steeringRecoveryCursorTs)
            : { events: [], hasMore: false };
          const queued = queueIssueEvents(page.events, !page.hasMore);
          if (
            queued.acceptedThrough !== null &&
            compareSteeringTs(queued.acceptedThrough, steeringRecoveryCursorTs) > 0
          ) {
            steeringRecoveryCursorTs = queued.acceptedThrough;
          }
          if (
            page.hasMore &&
            queued.acceptedThrough === null &&
            steeringTurnCount < runtime.agent.maxTurns
          ) {
            throw new Error("steering recovery page made no progress");
          }
          if (queued.failed) throw new Error("steering_event_queue_failed");
        } catch (error) {
          if (steeringRecoveryController.signal.aborted && !input.abortSignal?.aborted) return;
          throwIfAborted(input.abortSignal);
          if (required) throw error;
          reportSteeringFailure("recovery", error);
        }
      };
      let steeringFlushTail = Promise.resolve();
      let optionalSteeringFlushQueued = false;
      const enqueueSteeringFlush = async (required: boolean): Promise<void> => {
        const scheduled = steeringFlushTail.then(async () => recoverSteering(required));
        steeringFlushTail = scheduled.catch(() => {});
        return scheduled;
      };
      const scheduleOptionalSteeringFlush = (): void => {
        if (optionalSteeringFlushQueued) return;
        optionalSteeringFlushQueued = true;
        const scheduled = steeringFlushTail.then(async () => {
          optionalSteeringFlushQueued = false;
          await recoverSteering(false);
        });
        steeringFlushTail = scheduled.catch(() => {});
      };
      const initializeSteering = async (): Promise<void> => {
        steeringReady = true;
        if (issueEventBufferOverflow) {
          reportSteeringFailure(
            "buffer",
            new Error("pending issue messages exceeded the live-delivery buffer"),
          );
          issueEventBufferOverflow = false;
        }
        await enqueueSteeringFlush(false);
      };

      receiveIssueEvents = (events) => {
        bufferIssueEvents(events);
        if (issueEventBufferOverflow) {
          reportSteeringFailure(
            "buffer",
            new Error("pending issue messages exceeded the live-delivery buffer"),
          );
          issueEventBufferOverflow = false;
        }
        if (steeringReady) scheduleOptionalSteeringFlush();
      };

      while (autonomousTurnCount < runtime.agent.maxTurns || queuedTurns.length > 0) {
        throwIfAborted(input.abortSignal);
        await steeringFlushTail;
        let queuedTurn = queuedTurns[0];
        if (queuedTurn && !queuedTurn.activated) {
          if (!input.fetchIssue) {
            reportSteeringFailure("issue refresh", new Error("issue refresh is unavailable"));
            break;
          } else {
            try {
              issue = await input.fetchIssue(issue);
            } catch (error) {
              throwIfAborted(input.abortSignal);
              await steeringFlushTail;
              reportSteeringFailure("issue refresh", error);
              break;
            }
            await steeringFlushTail;
            const activeIssue = issueIsActive(issue, settings);
            if (!activeIssue) break;
            const refreshed = settingsForIssueState(settings, issue.state);
            const backendChanged =
              refreshed.agent.kind !== runtime.agent.kind ||
              backendProfile(refreshed) !== backendProfile(runtime);
            if (backendChanged) break;
            runtime = refreshed;
            queuedTurns[0]?.activate();
          }
        }
        queuedTurn = queuedTurns.shift();
        if (!queuedTurn && autonomousTurnCount >= runtime.agent.maxTurns) break;
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
            autonomousTurnCount === 0
              ? await buildPrompt(
                  input.workflow.parsedPromptTemplate ?? input.workflow.promptTemplate,
                  issue,
                  {
                    attempt: input.attempt ?? null,
                    slotIndex,
                    ensembleSize: size,
                  },
                )
              : continuationPrompt(autonomousTurnCount + 1, runtime.agent.maxTurns);
          pendingStreamActivities.push(turnActivity);
          currentNormalActivity = turnActivity;
          try {
            const turnOutcome = runTurnWithAbort(
              executor,
              session,
              prompt,
              issue,
              stopSession,
              input.abortSignal,
            )
              .then<TurnOutcome, TurnOutcome>(
                (updates) => ({ updates }),
                (error: unknown) => ({ error }),
              )
              .then((outcome) => {
                if ("error" in outcome) stopSteeringRecovery?.();
                return outcome;
              });
            autonomousTurnCount += 1;
            if (autonomousTurnCount === 1) {
              const initialization = initializeSteering();
              const first = await Promise.race([
                turnOutcome.then((outcome) => ({ kind: "turn", outcome }) as const),
                initialization.then(() => ({ kind: "steering" }) as const),
              ]);
              if (first.kind === "turn" && "error" in first.outcome) {
                stopSteeringRecovery();
                await initialization;
                throw first.outcome.error;
              }
              await initialization;
              const outcome = first.kind === "turn" ? first.outcome : await turnOutcome;
              if ("error" in outcome) throw outcome.error;
              turnUpdates = outcome.updates;
            } else {
              const outcome = await turnOutcome;
              if ("error" in outcome) throw outcome.error;
              turnUpdates = outcome.updates;
            }
          } finally {
            currentNormalActivity = undefined;
            removePendingActivity(pendingStreamActivities, turnActivity);
            if (activeStreamActivity === turnActivity) activeStreamActivity = undefined;
          }
        }
        turnCount += 1;

        // ACP turn continuation is derived from its event vocabulary. The signal
        // primarily comes from streamed updates because the returned batch may be
        // bounded for very long turns, which can omit an early tool call.
        const completedWithoutTools =
          !queuedTurn &&
          turnCount > 1 &&
          runtime.agents[runtime.agent.kind]?.executor === "acp" &&
          !turnActivity.sawToolCall &&
          !turnUpdates.some(isToolCallNotification);

        if (completedWithoutTools && !steeringRecoveryAvailable) {
          await steeringFlushTail;
          if (queuedTurns.length === 0) break;
        }
        if (!input.fetchIssue) {
          if (queuedTurns.length > 0) {
            reportSteeringFailure("issue refresh", new Error("issue refresh is unavailable"));
          }
          break;
        }
        try {
          issue = await input.fetchIssue(issue);
        } catch (error) {
          throwIfAborted(input.abortSignal);
          await steeringFlushTail;
          if (queuedTurns.length > 0) {
            reportSteeringFailure("issue refresh", error);
            break;
          }
          if (queuedTurn) break;
          throw error;
        }
        await steeringFlushTail;
        const activeIssue = issueIsActive(issue, settings);
        if (!activeIssue) break;
        const refreshed = settingsForIssueState(settings, issue.state);
        const backendChanged =
          refreshed.agent.kind !== runtime.agent.kind ||
          backendProfile(refreshed) !== backendProfile(runtime);
        if (backendChanged) break;
        runtime = refreshed;
        if (queuedTurns.length > 0) {
          queuedTurns[0]?.activate();
          continue;
        }
        await enqueueSteeringFlush(
          completedWithoutTools || autonomousTurnCount >= runtime.agent.maxTurns,
        );
        if (queuedTurns.length > 0) {
          queuedTurns[0]?.activate();
          continue;
        }
        if (completedWithoutTools && queuedTurns.length === 0) break;
      }
    } catch (error) {
      runError = error;
    } finally {
      stopSteeringRecovery?.();
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
  snapshotCursorTs: string | null | undefined,
): { fresh: TrackerIssueEvent[]; invalidTs: string[] } {
  const batchTs = new Set<string>();
  const invalidTs: string[] = [];
  const fresh = events
    .filter((event) => {
      if (!decimalOrderingKey(event.ts)) {
        invalidTs.push(event.ts);
        return false;
      }
      if (
        snapshotCursorTs !== null &&
        snapshotCursorTs !== undefined &&
        compareSteeringTs(event.ts, snapshotCursorTs) <= 0
      ) {
        return false;
      }
      if (seenTs.has(event.ts) || batchTs.has(event.ts)) return false;
      batchTs.add(event.ts);
      return true;
    })
    .sort((left, right) => compareSteeringTs(left.ts, right.ts));
  return { fresh, invalidTs };
}

function steeringEventChunk(
  events: readonly TrackerIssueEvent[],
  start: number,
  maxBytes: number,
): { sourceEvents: TrackerIssueEvent[]; promptEvents: TrackerIssueEvent[] } {
  const candidates: TrackerIssueEvent[] = [];
  let bytes = 0;
  for (let index = start; index < events.length; index += 1) {
    const event = events[index]!;
    const eventBytes = trackerIssueEventsBytes([event]);
    if (candidates.length === 0 && eventBytes > maxBytes)
      return shortenedEventChunk(event, maxBytes);
    if (bytes + eventBytes > maxBytes) break;
    candidates.push(event);
    bytes += eventBytes;
  }
  if (candidates.length === 0) return { sourceEvents: [], promptEvents: [] };
  if (issueEventsPromptBytes(candidates) <= maxBytes) {
    return { sourceEvents: candidates, promptEvents: candidates };
  }
  if (issueEventsPromptBytes([candidates[0]!]) > maxBytes) {
    return shortenedEventChunk(candidates[0]!, maxBytes);
  }

  let lower = 1;
  let upper = candidates.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (issueEventsPromptBytes(candidates.slice(0, middle)) <= maxBytes) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  const sourceEvents = candidates.slice(0, lower);
  return { sourceEvents, promptEvents: sourceEvents };
}

function shortenedEventChunk(
  event: TrackerIssueEvent,
  maxBytes: number,
): { sourceEvents: TrackerIssueEvent[]; promptEvents: TrackerIssueEvent[] } {
  const emptyEvent: TrackerIssueEvent = {
    ts: "",
    ...(event.author === undefined ? {} : { author: "" }),
    text: "",
  };
  const contentBudget = Math.max(0, maxBytes - issueEventsPromptBytes([emptyEvent]));
  return {
    sourceEvents: [event],
    promptEvents: [shortenIssueEvent(event, contentBudget)],
  };
}

function shortenIssueEvent(event: TrackerIssueEvent, maxBytes: number): TrackerIssueEvent {
  const marker =
    "\n[message shortened for live delivery; the complete message remains on the issue]\n";
  const metadataBudget = Math.max(0, maxBytes - Buffer.byteLength(marker));
  const fieldBudget = Math.floor(metadataBudget / 3);
  const ts = shortenIssueEventField(event.ts, fieldBudget);
  const author =
    event.author === undefined ? undefined : shortenIssueEventField(event.author, fieldBudget);
  const metadataBytes =
    Buffer.byteLength(ts) + Buffer.byteLength(author ?? "") + Buffer.byteLength(marker);
  const availableTextBytes = Math.max(0, maxBytes - metadataBytes);
  const eventTextBytes = Buffer.byteLength(event.text);
  if (eventTextBytes <= availableTextBytes) {
    return {
      ts,
      ...(author === undefined ? {} : { author }),
      text: `${event.text}${marker}`,
    };
  }
  const textBytes = Math.min(eventTextBytes, availableTextBytes);
  const prefixBytes = Math.ceil(textBytes / 2);
  const suffixBytes = Math.floor(textBytes / 2);
  return {
    ts,
    ...(author === undefined ? {} : { author }),
    text: `${utf8Prefix(event.text, prefixBytes)}${marker}${utf8Suffix(event.text, suffixBytes)}`,
  };
}

function shortenIssueEventField(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const marker = "[field shortened for live delivery]";
  const markerBytes = Buffer.byteLength(marker);
  if (markerBytes >= maxBytes) return utf8Prefix(marker, maxBytes);
  const contentBytes = maxBytes - markerBytes;
  return `${utf8Prefix(value, Math.ceil(contentBytes / 2))}${marker}${utf8Suffix(
    value,
    Math.floor(contentBytes / 2),
  )}`;
}

function utf8Prefix(value: string, maxBytes: number): string {
  const parts: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    parts.push(character);
    bytes += characterBytes;
  }
  return parts.join("");
}

function utf8Suffix(value: string, maxBytes: number): string {
  const parts: string[] = [];
  let bytes = 0;
  for (let end = value.length; end > 0; ) {
    let start = end - 1;
    const trailing = value.charCodeAt(start);
    if (trailing >= 0xdc00 && trailing <= 0xdfff && start > 0) start -= 1;
    const character = value.slice(start, end);
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    parts.push(character);
    bytes += characterBytes;
    end = start;
  }
  return parts.reverse().join("");
}

function maxSteeringTs(events: TrackerIssueEvent[], current: string): string {
  let max = current;
  for (const event of events) {
    if (!decimalOrderingKey(event.ts)) continue;
    if (compareSteeringTs(event.ts, max) > 0) max = event.ts;
  }
  return max;
}

function validateIssueEventPage(
  page: TrackerIssueEventPage,
  maxEvents: number,
  maxBytes: number,
): void {
  if (page.events.length > maxEvents) {
    throw new Error(
      `tracker issue event page exceeds event limit: ${page.events.length} > ${maxEvents}`,
    );
  }
  const pageBytes = trackerIssueEventsBytes(page.events);
  if (pageBytes > maxBytes) {
    throw new Error(`tracker issue event page exceeds byte limit: ${pageBytes} > ${maxBytes}`);
  }
  if (page.hasMore && page.events.length === 0) {
    throw new Error("tracker issue event page cannot report more events without making progress");
  }
}

function issueEventsPromptBytes(events: readonly TrackerIssueEvent[]): number {
  return Buffer.byteLength(issueEventsPrompt(events));
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
