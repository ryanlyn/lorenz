import { slotKey } from "@lorenz/dispatch";
import { Orchestrator, type ClaimStoreLike, type SlotReservation } from "@lorenz/orchestrator";
import { validateDispatchConfig } from "@lorenz/config";
import { runAgentAttempt, type RunResult } from "@lorenz/agent-runner";
import {
  durationMs,
  errorMessage,
  systemClock,
  withDerivedMaxInFlight,
  type ClockPort,
  type TimerHandle,
} from "@lorenz/domain";
import type {
  RuntimeAppStatus,
  RuntimeEventType,
  RuntimePollStatus,
  RuntimeRunHistoryEntry,
  RuntimeSnapshot,
} from "@lorenz/runtime-events";
import type {
  AgentKind,
  AgentUpdate,
  WorkerPoolSettings,
  HookExecutionMessage,
  Issue,
  RunningEntry,
  RuntimeTrackerClient,
  TrackerChangeStream,
  WorkflowDefinition,
} from "@lorenz/domain";
import type { WorkerOutcome, WorkerPool } from "@lorenz/worker-pool";
import {
  createDispatchCoordinator,
  nullEndpointManager,
  type AcquireRunSlotResult,
  type DispatchCoordinator,
  type RunSlot,
} from "@lorenz/dispatch-coordinator";

import { RuntimeStartupCleaner } from "./cleanup.js";
import { RuntimeDispatcher } from "./dispatcher.js";
import { RuntimeEventLog } from "./events.js";
import {
  agentUpdateRuntimeMessage,
  buildRunHistoryEntry,
  hookExecutionRuntimeMessage,
} from "./history.js";
import { RuntimeReconciler } from "./reconciliation.js";
import { RuntimeWorkflowReloader } from "./reload.js";
import { RuntimeRetryTimers } from "./retryTimers.js";
import { RuntimeSnapshotProjector } from "./snapshot.js";

export type RuntimeRunner = (input: Parameters<typeof runAgentAttempt>[0]) => Promise<RunResult>;

export { RUNTIME_EVENT_TYPES, RUNTIME_RUN_OUTCOMES } from "@lorenz/runtime-events";
export type {
  RuntimeAppStatus,
  RuntimeBlockedEntry,
  RuntimeEvent,
  RuntimeEventType,
  RuntimePollStatus,
  RuntimeReservingEntry,
  RuntimeRetryEntry,
  RuntimeRunHistoryEntry,
  RuntimeRunLastEvent,
  RuntimeRunningEntry,
  RuntimeRunOutcome,
  RuntimeSnapshot,
} from "@lorenz/runtime-events";
export {
  RUNTIME_RECONCILIATION_REASONS,
  type RuntimeReconciliationReason,
} from "@lorenz/policies/reconciliation";

export interface LorenzRuntimeOptions {
  workflow: WorkflowDefinition;
  client?: RuntimeTrackerClient | undefined;
  clientFactory?: ((settings: WorkflowDefinition["settings"]) => RuntimeTrackerClient) | undefined;
  reloadWorkflow?: (() => Promise<WorkflowDefinition>) | undefined;
  orchestrator?: Orchestrator | undefined;
  /**
   * Optional claim store for the runtime-owned orchestrator. Defaults to an in-memory
   * store; ignored when a pre-built `orchestrator` is supplied.
   */
  claimStore?: ClaimStoreLike | undefined;
  runner?: RuntimeRunner | undefined;
  removeIssueWorkspaces?:
    | ((
        settings: WorkflowDefinition["settings"],
        issueIdentifier?: string | null,
        workerHost?: string | null,
        issue?: Issue,
        options?: { onHookEvent?: ((event: HookExecutionMessage) => void) | undefined },
      ) => Promise<void>)
    | undefined;
  listIssueWorkspaces?:
    | ((settings: WorkflowDefinition["settings"]) => Promise<string[]>)
    | undefined;
  appendLogEvent?: ((logFile: string, event: Record<string, unknown>) => Promise<void>) | undefined;
  onAgentUpdate?: ((issue: Issue, update: AgentUpdate) => void) | undefined;
  onIssueDispatched?: ((issue: Issue) => void) | undefined;
  clock?: ClockPort | undefined;
  /**
   * Settings validation run before each poll, after any workflow reload. The composition
   * root binds this to its registries; the default validates against the process-wide ones.
   */
  validateDispatch?: ((settings: WorkflowDefinition["settings"]) => void) | undefined;
  /**
   * Optional embedded worker pool. When present, the orchestrator is constructed with a capacity
   * probe backed by the pool's `canAcquire` (bypassing the static `sshHosts` selection), and
   * each run acquires a {@link RunSlot} before the runner and releases/fails it in the run's
   * `finally`. Absent (default) preserves the local and `sshHosts` behavior.
   *
   * A bare `workerPool` is wrapped internally in a null-endpoint passthrough
   * {@link DispatchCoordinator} (see {@link LorenzRuntimeOptions.coordinator}), so every run
   * drives the coordinator uniformly while a bare pool injection keeps the default runtime
   * boundary unchanged (`slotsPerMachine=1` + `mcpEndpoint=null`). Prefer threading a
   * pre-built `coordinator`; `workerPool` is the low-churn path that keeps existing injection
   * sites unchanged. When BOTH are supplied, `coordinator` wins.
   */
  workerPool?: WorkerPool | undefined;
  /**
   * Optional embedded dispatch coordinator wrapping a machine {@link WorkerPool} plus an injected
   * per-run MCP endpoint manager. When present it governs capacity and mints a {@link RunSlot}
   * per run exactly as a wrapped {@link LorenzRuntimeOptions.workerPool} would; the daemon builds
   * it once (a reload-surviving singleton) via `buildDispatchCoordinator`. Takes precedence over
   * `workerPool` when both are supplied.
   */
  coordinator?: DispatchCoordinator | undefined;
}

/**
 * Classifies a run error into a worker outcome. Returns `poison` ONLY for typed worker-transport faults
 * (the worker is bad and must be recycled); everything else is `healthy` (a local/config/agent fault
 * that left the worker reusable). Matches typed PREFIXES, not arbitrary substrings, so that
 * `invalid_ssh_timeout` (a local config fault) is never mistaken for the `ssh_timeout` transport
 * fault even though one is a substring of the other.
 */
const POISON_WORKER_ERROR_PREFIXES = [
  "ssh_timeout:",
  "remote_home_lookup_failed:",
  "workspace_prepare_failed:",
  // A REMOTE workspace hook (run over SSH against the worker's workerHost) that exits
  // non-zero throws `workspace hook failed with status N: ...`. That is a worker-side
  // fault, so it poisons the worker. The LOCAL hook failure string is
  // `hook failed with status N` (no `workspace ` prefix) and stays healthy.
  "workspace hook failed with status ",
] as const;

const CLAIM_OWNER_HEARTBEAT_INTERVAL_MS = 10_000;

export function classifyWorkerOutcome(error: unknown): WorkerOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return POISON_WORKER_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))
    ? "poison"
    : "healthy";
}

export interface RuntimeStartOptions {
  once?: boolean | undefined;
  dryRun?: boolean | undefined;
}

export interface PollOptions {
  dryRun?: boolean | undefined;
  waitForRuns?: boolean | undefined;
}

interface PollIntent {
  dryRun: boolean;
  waitForRuns: boolean;
}

function pollIntent(options: PollOptions = {}): PollIntent {
  return {
    dryRun: options.dryRun === true,
    waitForRuns: options.waitForRuns === true,
  };
}

function pollOptionsFromIntent(intent: PollIntent): PollOptions {
  const options: PollOptions = {};
  if (intent.dryRun) options.dryRun = true;
  if (intent.waitForRuns) options.waitForRuns = true;
  return options;
}

function pollOptionsCover(active: PollOptions, requested: PollOptions): boolean {
  const activeIntent = pollIntent(active);
  const requestedIntent = pollIntent(requested);
  return (
    (!activeIntent.dryRun || requestedIntent.dryRun) &&
    (activeIntent.waitForRuns || !requestedIntent.waitForRuns)
  );
}

function mergePollOptions(existing: PollOptions | null, requested: PollOptions): PollOptions {
  if (!existing) return pollOptionsFromIntent(pollIntent(requested));
  const existingIntent = pollIntent(existing);
  const requestedIntent = pollIntent(requested);
  return pollOptionsFromIntent({
    dryRun: existingIntent.dryRun && requestedIntent.dryRun,
    waitForRuns: existingIntent.waitForRuns || requestedIntent.waitForRuns,
  });
}

class ClaimStoreRuntimeError extends Error {
  constructor(
    readonly reason: string,
    readonly original: unknown,
  ) {
    super(errorMessage(original));
  }
}

function throwRuntimeError(error: Error): never {
  throw error;
}

class ActiveRunHandle {
  readonly controller = new AbortController();
  /**
   * Set when the run is force-finished externally (e.g. a stall reconciliation aborts it). The
   * worker pool reads this so a stall-finished run poisons its worker even though the runner surfaces a
   * generic `agent_run_aborted` (which would otherwise classify as healthy).
   */
  reason: "stalled" | null = null;
  abandonClaimOnSettlement = false;

  constructor(
    readonly issueId: string,
    readonly slotIndex: number,
    readonly key: string,
    readonly runId: string,
    private readonly activeRuns: Map<string, ActiveRunHandle>,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isActive(): boolean {
    return this.activeRuns.get(this.key) === this;
  }

  abort(): void {
    this.controller.abort();
  }

  finishExternally(
    reason: "stalled" | null = null,
    options: { abandonClaimOnSettlement?: boolean | undefined } = {},
  ): void {
    if (reason) this.reason = reason;
    if (options.abandonClaimOnSettlement) this.abandonClaimOnSettlement = true;
    this.abort();
    this.release();
  }

  release(): void {
    if (this.isActive) this.activeRuns.delete(this.key);
  }
}

export class LorenzRuntime {
  private client: RuntimeTrackerClient;
  private readonly orchestrator: Orchestrator;
  private readonly runner: RuntimeRunner;
  private readonly clock: ClockPort;
  private readonly validateDispatch: (settings: WorkflowDefinition["settings"]) => void;
  private readonly listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  private readonly snapshotProjector = new RuntimeSnapshotProjector();
  private readonly eventLog: RuntimeEventLog;
  private readonly retryTimers: RuntimeRetryTimers;
  private readonly workflowReloader: RuntimeWorkflowReloader;
  private readonly startupCleaner: RuntimeStartupCleaner;
  private readonly reconciler: RuntimeReconciler;
  private readonly dispatcher: RuntimeDispatcher<ActiveRunHandle>;
  private readonly inFlight = new Set<Promise<void>>();
  private stopped = false;
  private appStatus: RuntimeAppStatus = "starting";
  private pollStatus: RuntimePollStatus = "idle";
  private candidates = 0;
  private eligible = 0;
  private lastPollAt: string | null = null;
  private nextPollAt: string | null = null;
  private lastError: string | null = null;
  private readonly activeRuns = new Map<string, ActiveRunHandle>();
  private nextRunNumber = 1;
  private pollInProgress: Promise<void> | null = null;
  private activePollOptions: PollOptions | null = null;
  private pendingPollOptions: PollOptions | null = null;
  private workerPoolDrained = false;
  private claimOwnerHeartbeatTimer: TimerHandle | null = null;
  private pendingStoppedClaimSettlements = 0;
  /**
   * Live tracker push subscription (see {@link RuntimeTrackerClient.watch}), opened once in the
   * recurring `start()` loop and closed on `stop()`. `undefined` for pull-only trackers and the
   * `--once` path. A tracker that pushes (e.g. Slack Socket Mode) nudges an immediate poll so
   * new work dispatches without waiting out `polling.intervalMs`.
   */
  private changeStream: TrackerChangeStream | undefined;
  private changeStreamOpening = false;
  /**
   * The reload-surviving coordinator singleton. Built here from either the
   * pre-built `input.coordinator` (preferred), or a null-endpoint passthrough
   * wrapping a bare `input.workerPool`, which keeps the default runtime boundary unchanged.
   * `undefined` when neither is supplied, which uses the static/local path.
   */
  private readonly coordinator: DispatchCoordinator | undefined;

  constructor(private readonly input: LorenzRuntimeOptions) {
    this.client =
      input.client ?? input.clientFactory?.(input.workflow.settings) ?? missingRuntimeClient();
    this.clock = input.clock ?? systemClock;
    // Prefer the pre-built coordinator; otherwise wrap a bare workerPool in a
    // null-endpoint passthrough so `acquireRunSlot`/`governs`/`canAcquire`/
    // `reconcile`/`drain` drive a uniform surface (default slotsPerMachine=1 +
    // mcpEndpoint=null make this a 1:1 passthrough over the pool). Built once: a
    // reload reconciles it in place, never reconstructs it.
    this.coordinator =
      input.coordinator ?? wrapWorkerPoolInCoordinator(input.workerPool, input.workflow.settings);
    const coordinator = this.coordinator;
    this.orchestrator =
      input.orchestrator ??
      new Orchestrator(
        input.workflow.settings,
        this.clock,
        input.claimStore,
        // The coordinator IS the orchestrator's capacity authority (it satisfies
        // the CapacityProbe shape directly). It is installed for the orchestrator's
        // lifetime whenever it exists, but a reload can disable the underlying pool
        // (draining it to zero) without tearing the authority down. `governs`
        // tracks whether the live pool still governs capacity so a disabled pool
        // falls through to static/local execution instead of permanently blocking
        // dispatch as worker_host_capacity. The coordinator is a reload-surviving
        // singleton (stable identity across reconcile) re-reading live pool state
        // on each call.
        coordinator,
      );
    // Poll nudge: when the pool frees capacity (a worker lands warm after the FIFO
    // waiters had first claim), re-poll promptly so a capacity-skipped issue
    // re-dispatches without waiting out polling.intervalMs.
    coordinator?.onCapacityAvailable(() => this.nudgePollForFreedCapacity());
    this.runner = input.runner ?? runAgentAttempt;
    this.validateDispatch = input.validateDispatch ?? validateDispatchConfig;
    this.appStatus = "idle";
    this.eventLog = new RuntimeEventLog({
      clock: this.clock,
      getWorkflow: () => this.workflow,
      appendLogEvent: input.appendLogEvent,
      recordEvent: (event) => this.snapshotProjector.recordEvent(event),
      emit: () => this.emit(),
    });
    this.retryTimers = new RuntimeRetryTimers({
      clock: this.clock,
      getRetryForIssue: (issueId) => this.orchestrator.retryingForIssue(issueId)[0],
      getRetriesForIssues: (issueIds) => this.orchestrator.retryingByIssueIds(issueIds),
      addEvent: (type, message) => this.addEvent(type, message),
      markRuntimeError: (message) => this.markRuntimeError(message),
      pollInProgress: () => this.pollInProgress !== null,
      queuePoll: (force) => this.queuePendingPoll({}, force),
      pollOnce: async () => this.pollOnce(),
    });
    this.workflowReloader = new RuntimeWorkflowReloader({
      workflow: () => this.workflow,
      reloadWorkflow: input.reloadWorkflow,
      clientWasInjected: () => input.client !== undefined,
      clientFactory: input.clientFactory,
      setWorkflow: (workflow) => {
        this.input.workflow = workflow;
      },
      setClient: (client) => {
        this.client = client;
      },
      orchestrator: this.orchestrator,
      coordinator: this.coordinator,
      addEvent: (type, message) => this.addEvent(type, message),
    });
    this.startupCleaner = new RuntimeStartupCleaner({
      workflow: () => this.workflow,
      client: () => this.client,
      listIssueWorkspaces: input.listIssueWorkspaces,
      removeIssueWorkspaces: async (workspace) =>
        this.removeIssueWorkspaces(
          workspace.settings,
          workspace.issueIdentifier,
          workspace.workerHost,
          workspace.issue,
        ),
      addEvent: (type, message) => this.addEvent(type, message),
    });
    this.reconciler = new RuntimeReconciler({
      workflow: () => this.workflow,
      client: () => this.client,
      orchestrator: this.orchestrator,
      clock: this.clock,
      activeRuns: this.activeRuns,
      addEvent: (type, message) => this.addEvent(type, message),
      abortIssueRuns: (issueId) => this.abortIssueRuns(issueId),
      clearRetryTimer: (issueId) => this.clearRetryTimer(issueId),
      syncRetryTimerSafely: (issueId) => this.syncRetryTimerSafely(issueId),
      removeIssueWorkspaces: async (workspace) =>
        this.removeIssueWorkspaces(
          workspace.settings,
          workspace.issueIdentifier,
          workspace.workerHost,
          workspace.issue,
        ),
      recordHistory: (entry) => this.recordHistory(entry),
      recordClaimStoreFailure: (reason, error) => this.recordClaimStoreFailure(reason, error),
    });
    this.dispatcher = new RuntimeDispatcher({
      client: () => this.client,
      orchestrator: this.orchestrator,
      activeRuns: this.activeRuns,
      inFlight: this.inFlight,
      nextRunId: () => {
        const runId = `run-${this.nextRunNumber}`;
        this.nextRunNumber += 1;
        return runId;
      },
      createHandle: (issueId, slotIndex, key, runId) =>
        new ActiveRunHandle(issueId, slotIndex, key, runId, this.activeRuns),
      syncRetryTimer: (issueId) => this.syncRetryTimer(issueId),
      startClaimOwnerHeartbeat: async () => this.startClaimOwnerHeartbeat(),
      stopClaimOwnerHeartbeatIfIdle: () => this.stopClaimOwnerHeartbeatIfIdle(),
      updateAppStatusFromInFlight: () => this.updateAppStatusFromInFlight(),
      emit: () => this.emit(),
      addEvent: (type, message) => this.addEvent(type, message),
      onIssueDispatched: input.onIssueDispatched,
      runClaim: async (issue, slotIndex, agentKind, runId, workerHost, handle, slot = null) =>
        this.runClaim(issue, slotIndex, agentKind, runId, workerHost, handle, slot),
      runReservedClaim: async (issue, reservation, runId, handle) =>
        this.runReservedClaim(issue, reservation, runId, handle),
    });
  }

  get workflow(): WorkflowDefinition {
    return this.input.workflow;
  }

  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): RuntimeSnapshot {
    const orchestration = this.orchestrator.snapshot();
    const now = this.clock.now();
    return this.snapshotProjector.snapshot({
      appStatus: this.appStatus,
      workflow: this.workflow,
      now,
      poll: {
        status: this.pollStatus,
        candidates: this.candidates,
        eligible: this.eligible,
        lastPollAt: this.lastPollAt,
        nextPollAt: this.nextPollAt,
        lastError: this.lastError,
      },
      orchestration,
      runIdForSlot: (issueId, slotIndex) => this.activeRuns.get(slotKey(issueId, slotIndex))?.runId,
    });
  }

  async start(options: RuntimeStartOptions = {}): Promise<void> {
    this.stopped = false;
    // Open the tracker's push subscription (if any) so a real backend event re-polls
    // immediately instead of waiting out polling.intervalMs. Skipped for --once (which polls
    // exactly once and exits) and for pull-only trackers that do not implement watch().
    if (!options.once) await this.openChangeStream();
    do {
      if (options.once) {
        await this.pollOnce({ dryRun: options.dryRun, waitForRuns: true });
        break;
      }
      // A thrown poll (e.g. tracker fetchCandidateIssues rejecting) must not
      // terminate the recurring daemon loop. pollOnceUnlocked already records a
      // poll_error event and surfaces the error on the snapshot before rethrowing,
      // so swallow the rejection here and continue to the next interval.
      try {
        await this.pollOnce({ dryRun: options.dryRun });
      } catch {
        // Intentionally ignored: the error is already logged as poll_error.
      }
      await delay(this.clock, this.workflow.settings.polling.intervalMs, () => this.stopped);
    } while (!this.stopped);
  }

  stop(): void {
    this.stopped = true;
    this.appStatus = "stopping";
    this.pendingPollOptions = null;
    // Fire-and-forget: stop() stays synchronous like its sibling abort sites. The stream's
    // close() is idempotent, so an in-flight openChangeStream that resolves after this still
    // closes the freshly-opened stream (it observes this.stopped).
    void this.closeChangeStream();
    // finishExternally (abort + release) mirrors the other abort sites and clears
    // isActive, so the resulting agent_run_aborted rejection is treated as a clean
    // shutdown in runClaim rather than recorded as a failed run. Durable claims are
    // abandoned only after the runner settles; until then a shared store must still
    // show the slot as owned.
    for (const handle of [...this.activeRuns.values()]) {
      this.markStoppedClaimSettlementPending(handle);
      handle.finishExternally(null, { abandonClaimOnSettlement: true });
    }
    this.stopClaimOwnerHeartbeatIfIdle();
    this.retryTimers.stop();
    this.emit();
  }

  /**
   * Drains the worker pool once (idempotent). `stop()` stays synchronous (it only flips `stopped` and
   * aborts handles), so this is invoked by the daemon's `finally` AFTER `start()` resolves to
   * destroy paid cloud workers before process exit. A no-op when no pool is configured.
   */
  async drainWorkerPool(): Promise<void> {
    if (this.workerPoolDrained) return;
    this.workerPoolDrained = true;
    const deadlineMs = this.workflow.settings.worker.workerPool?.drainDeadlineMs ?? 30_000;
    await this.coordinator?.drain({ deadlineMs });
  }

  async pollOnce(options: PollOptions = {}): Promise<void> {
    if (this.pollInProgress) {
      this.queuePendingPoll(options);
      return this.pollInProgress;
    }
    const poll = this.pollUntilQueueDrained(options);
    this.pollInProgress = poll;
    try {
      await poll;
    } finally {
      if (this.pollInProgress === poll) {
        this.pollInProgress = null;
        this.activePollOptions = null;
        this.pendingPollOptions = null;
      }
    }
  }

  private async pollUntilQueueDrained(options: PollOptions): Promise<void> {
    let nextOptions = options;
    while (true) {
      this.activePollOptions = nextOptions;
      await this.pollOnceUnlocked(nextOptions);
      this.activePollOptions = null;
      const pending = this.pendingPollOptions;
      this.pendingPollOptions = null;
      if (!pending) return;
      nextOptions = pending;
    }
  }

  /**
   * Requests a prompt re-poll after the worker pool freed capacity. The pool fires the
   * hook synchronously inside its settle/reconcile paths (under a per-worker mutex), so
   * the nudge is deferred a microtask to never re-enter them on the same stack. A
   * poll already in progress gets a FORCED follow-up poll queued (merged via the
   * pendingPollOptions machinery) because the freed capacity may post-date that
   * poll's eligibility pass.
   */
  private nudgePollForFreedCapacity(): void {
    queueMicrotask(() => {
      if (this.stopped) return;
      if (this.pollInProgress) {
        this.queuePendingPoll({}, true);
        return;
      }
      this.pollOnce().catch(() => {
        // Intentionally ignored: pollOnceUnlocked already recorded poll_error.
      });
    });
  }

  /**
   * Opens the tracker's push subscription (when {@link RuntimeTrackerClient.watch} is
   * implemented) so a real backend event triggers an immediate poll. Idempotent and
   * fail-soft: a watch() that rejects (or is absent) leaves the runtime on interval polling
   * alone, surfaced as a `tracker_watch_error` event rather than aborting startup. A stop()
   * that races an in-flight open is honored by closing the freshly-opened stream.
   */
  private async openChangeStream(): Promise<void> {
    if (!this.client.watch || this.changeStream || this.changeStreamOpening) return;
    this.changeStreamOpening = true;
    try {
      const stream = await this.client.watch(() => this.nudgePollForTrackerChange());
      // A null stream means the tracker has no push for this config (e.g. credential unset); stay
      // on interval polling silently rather than logging it as a failure.
      if (!stream) return;
      if (this.stopped) {
        await stream.close();
        return;
      }
      this.changeStream = stream;
      this.addEvent("tracker_watch_started", this.workflow.settings.tracker.kind ?? "tracker");
    } catch (error) {
      this.addEvent("tracker_watch_error", errorMessage(error));
    } finally {
      this.changeStreamOpening = false;
    }
  }

  private async closeChangeStream(): Promise<void> {
    const stream = this.changeStream;
    this.changeStream = undefined;
    if (!stream) return;
    try {
      await stream.close();
    } catch (error) {
      this.addEvent("tracker_watch_error", errorMessage(error));
    }
  }

  /**
   * Re-poll promptly after the tracker pushed a change. Mirrors {@link nudgePollForFreedCapacity}:
   * a poll already running gets a FORCED follow-up queued so a change that post-dates the active
   * poll's fetch is not lost, and a burst of pushes collapses into a single follow-up. The
   * interval poll remains the safety net, so a dropped push is at worst recovered next interval.
   */
  private nudgePollForTrackerChange(): void {
    if (this.stopped) return;
    this.addEvent("tracker_push", this.workflow.settings.tracker.kind ?? "tracker");
    if (this.pollInProgress) {
      this.queuePendingPoll({}, true);
      return;
    }
    this.pollOnce().catch(() => {
      // Intentionally ignored: pollOnceUnlocked already recorded poll_error.
    });
  }

  private queuePendingPoll(options: PollOptions = {}, force = false): void {
    if (
      !force &&
      ((this.activePollOptions && pollOptionsCover(this.activePollOptions, options)) ||
        (this.pendingPollOptions && pollOptionsCover(this.pendingPollOptions, options)))
    ) {
      return;
    }
    this.pendingPollOptions = mergePollOptions(this.pendingPollOptions, options);
  }

  private async pollOnceUnlocked(options: PollOptions = {}): Promise<void> {
    this.pollStatus = "checking";
    this.appStatus = this.inFlight.size > 0 ? "running" : "polling";
    this.lastPollAt = this.clock.now().toISOString();
    this.lastError = null;

    const dispatched: Array<Promise<void>> = [];
    try {
      this.emit();
      await this.reloadWorkflowIfConfigured();
      this.validateDispatch(this.workflow.settings);
      await this.cleanupTerminalWorkspacesOnce();
      await this.reconcileStalledRuns();
      await this.reconcileTrackedIssues();
      const issues = await this.client.fetchCandidateIssues();
      const eligibleIssues = await this.orchestrator.eligibleIssuesAsync(issues);
      if (!options.dryRun) this.syncRetryTimersForIssues(issues);
      this.candidates = issues.length;
      this.eligible = eligibleIssues.length;

      if (options.dryRun) {
        this.addEvent("dry_run", `eligible=${eligibleIssues.length} candidates=${issues.length}`);
      } else {
        for (const issue of eligibleIssues) {
          dispatched.push(...(await this.maybeDispatch(issue)));
        }
      }

      if (options.waitForRuns) {
        await Promise.allSettled(dispatched);
      }

      this.pollStatus = "idle";
      this.updateAppStatusFromInFlight();
      this.nextPollAt = new Date(
        this.clock.now().getTime() + this.workflow.settings.polling.intervalMs,
      ).toISOString();
    } catch (error) {
      this.pollStatus = "error";
      this.appStatus = "error";
      this.lastError = errorMessage(error);
      this.addEvent("poll_error", this.lastError);
      throw error;
    } finally {
      this.emit();
    }
  }

  private async maybeDispatch(issue: Issue): Promise<Array<Promise<void>>> {
    return this.dispatcher.maybeDispatch(issue);
  }

  private async startClaimOwnerHeartbeat(): Promise<void> {
    await this.orchestrator.heartbeatClaimOwnerAsync();
    if (this.claimOwnerHeartbeatTimer) return;
    this.claimOwnerHeartbeatTimer = this.clock.setTimeout(() => {
      void this.heartbeatClaimOwnerWhileActive();
    }, CLAIM_OWNER_HEARTBEAT_INTERVAL_MS);
    this.claimOwnerHeartbeatTimer.unref?.();
  }

  private async heartbeatClaimOwnerWhileActive(): Promise<void> {
    this.claimOwnerHeartbeatTimer = null;
    if (this.activeRuns.size === 0 && this.pendingStoppedClaimSettlements === 0) return;
    try {
      await this.orchestrator.heartbeatClaimOwnerAsync();
    } catch (error) {
      this.handleClaimOwnerHeartbeatFailure(error);
    }
    if (this.activeRuns.size === 0 && this.pendingStoppedClaimSettlements === 0) return;
    this.claimOwnerHeartbeatTimer = this.clock.setTimeout(() => {
      void this.heartbeatClaimOwnerWhileActive();
    }, CLAIM_OWNER_HEARTBEAT_INTERVAL_MS);
    this.claimOwnerHeartbeatTimer.unref?.();
  }

  private handleClaimOwnerHeartbeatFailure(error: unknown): void {
    const message = `claim_owner_heartbeat_failed ${errorMessage(error)}`;
    this.stopped = true;
    this.appStatus = "error";
    this.lastError = message;
    for (const handle of [...this.activeRuns.values()]) {
      this.markStoppedClaimSettlementPending(handle);
      handle.finishExternally(null, { abandonClaimOnSettlement: true });
    }
    this.retryTimers.stop();
    this.addEvent("poll_error", message);
  }

  private stopClaimOwnerHeartbeatIfIdle(): void {
    if (this.activeRuns.size > 0) return;
    if (this.pendingStoppedClaimSettlements > 0) return;
    this.stopClaimOwnerHeartbeat();
  }

  private stopClaimOwnerHeartbeat(): void {
    if (!this.claimOwnerHeartbeatTimer) return;
    this.clock.clearTimeout(this.claimOwnerHeartbeatTimer);
    this.claimOwnerHeartbeatTimer = null;
  }

  private updateAppStatusFromInFlight(): void {
    if (this.appStatus === "error") return;
    this.appStatus = this.inFlight.size > 0 ? "running" : "idle";
  }

  /**
   * Phase 1 -> negotiation -> phase 2 for a pool-governed (reserved) claim: drive the
   * coordinator's acquire inside this detached per-run promise (a cold provision never blocks
   * the poll thread), then either bind the reservation to the CONCRETE `slot.workerHost` and run,
   * or cancel the reservation (restoring the consumed retry entry) on a capacity refusal /
   * acquire fault. `run_started` is only emitted after a successful bind.
   */
  private async runReservedClaim(
    issue: Issue,
    reservation: SlotReservation,
    runId: string,
    handle: ActiveRunHandle,
  ): Promise<void> {
    const coordinator = this.coordinator;
    if (!coordinator) {
      // A reservation can only be minted while a capacity probe governs, which in
      // production implies a coordinator. An injected probe without one (test
      // wiring) is treated like an acquire fault: cancel and skip, never strand.
      this.addEvent(
        "dispatch_skipped",
        `${issue.identifier} worker_pool_acquire_error coordinator_missing`,
      );
      await this.cancelReservationAfterSkippedAcquire(issue, reservation, handle, {
        syncRetryTimer: true,
      });
      return;
    }
    let acquired: AcquireRunSlotResult;
    try {
      acquired = await coordinator.acquireRunSlot({
        issueId: issue.id,
        slotIndex: reservation.slotIndex,
        labels: issue.labels,
        // Sticky retry affinity travels on the reservation (the prior run's
        // CONCRETE host from the consumed retry entry).
        affinityKey: reservation.affinityHost,
        timeoutMs: this.workflow.settings.worker.workerPool?.acquireTimeoutMs ?? 30_000,
        signal: handle.signal,
        // Thread the FULL workflow Settings (with server.port) so the per-run
        // endpoint manager can build the remote endpoint; the WorkerPoolSettings the
        // coordinator holds has no server.port and would fail every acquire.
        settings: this.workflow.settings,
        // The ACP executor - the only executor - consumes the per-run MCP
        // endpoint over the reverse tunnel, so every run needs one. The flag
        // stays on the request so a future executor that runs its tools
        // in-process can skip minting the endpoint (and its tunnel-ceiling
        // reservation) without an API change.
        needsMcpEndpoint: true,
      });
    } catch (error) {
      // acquireRunSlot() REJECTED outside the no_capacity result path (ledger /
      // filesystem / driver / endpoint-open fault). Handle it like a failed
      // dispatch rather than letting the rejection strand the reservation: cancel
      // it (restoring the consumed retry entry) so the slot is re-evaluated next
      // poll, release the active handle, surface a clear error event (never
      // swallowed), and return WITHOUT running or recording history. The
      // coordinator already settled any just-bound lease healthy before throwing,
      // so there is nothing to settle here.
      this.addEvent(
        "dispatch_skipped",
        `${issue.identifier} worker_pool_acquire_error ${errorMessage(error)}`,
      );
      await this.cancelReservationAfterSkippedAcquire(issue, reservation, handle, {
        syncRetryTimer: true,
      });
      return;
    }
    if (acquired.status !== "bound") {
      // No capacity within the acquire window (EVERY typed no_capacity reason maps
      // to the SAME event - no per-reason differentiation, matching today): cancel
      // the reservation with NO backoff. The consumed retry entry is RESTORED (its
      // deadline already passed) so the issue is immediately re-eligible with its
      // affinity and attempt counter intact; never record history for a run that
      // did not start.
      this.addEvent("dispatch_skipped", `${issue.identifier} worker_host_capacity`);
      await this.cancelReservationAfterSkippedAcquire(issue, reservation, handle, {
        syncRetryTimer: true,
      });
      return;
    }
    const slot = acquired.slot;
    let entry: Awaited<ReturnType<Orchestrator["bindReservationAsync"]>>;
    try {
      entry = await this.orchestrator.bindReservationAsync(reservation, slot.workerHost);
    } catch (error) {
      const bindError = errorMessage(error);
      let releaseErrorMessage: string | null = null;
      try {
        await slot.release("healthy");
      } catch (releaseError) {
        releaseErrorMessage = errorMessage(releaseError);
      }
      handle.release();
      const bindFailureMessage = `claim_bind_failed ${bindError}`;
      this.markRuntimeError(bindFailureMessage);
      let retrySyncError: string | null = null;
      if (handle.abandonClaimOnSettlement) {
        await this.settleStoppedClaim(handle, issue.id, reservation.slotIndex);
      } else {
        try {
          await this.orchestrator.abandonClaimAsync(issue.id, reservation.slotIndex);
          retrySyncError = this.syncRetryTimerSafely(issue.id);
        } catch {
          // Preserve the bind failure event; if the backend is unavailable, abandon may fail too.
        }
      }
      this.stopClaimOwnerHeartbeatIfIdle();
      this.addEvent("dispatch_skipped", `${issue.identifier} bind_reservation_error ${bindError}`);
      if (releaseErrorMessage) {
        this.addEvent(
          "dispatch_skipped",
          `${issue.identifier} bind_reservation_release_error ${releaseErrorMessage}`,
        );
      }
      this.addEvent("poll_error", bindFailureMessage);
      if (retrySyncError) this.addEvent("poll_error", retrySyncError);
      return;
    }
    if (!entry) {
      // The reservation was cancelled/expired during the acquire (cleanup, stop,
      // or the expiry sweep): release the bound worker back to warm inventory (the
      // slot's settled-once guard makes this exactly-once) and skip the run.
      await slot.release("healthy");
      this.addEvent("dispatch_skipped", `${issue.identifier} reservation_lapsed`);
      handle.release();
      await this.settleStoppedClaim(handle, issue.id, reservation.slotIndex);
      return;
    }
    this.addEvent("run_started", `${issue.identifier} slot=${reservation.slotIndex}`);
    await this.runClaim(
      issue,
      reservation.slotIndex,
      reservation.agentKind,
      runId,
      slot.workerHost,
      handle,
      slot,
    );
  }

  private async cancelReservationAfterSkippedAcquire(
    issue: Issue,
    reservation: SlotReservation,
    handle: ActiveRunHandle,
    options: { syncRetryTimer?: boolean | undefined } = {},
  ): Promise<void> {
    let cancelled = false;
    let cancelError: unknown;
    try {
      await this.orchestrator.cancelReservationAsync(reservation);
      cancelled = true;
    } catch (error) {
      cancelError = error;
    } finally {
      handle.release();
      await this.settleStoppedClaim(handle, issue.id, reservation.slotIndex);
      this.stopClaimOwnerHeartbeatIfIdle();
    }
    if (cancelled && options.syncRetryTimer) {
      const retrySyncError = this.syncRetryTimerSafely(issue.id);
      if (retrySyncError) this.addEvent("poll_error", retrySyncError);
    }
    if (!cancelError) return;
    const message = `claim_cancel_failed ${errorMessage(cancelError)}`;
    if (this.appStatus !== "error") {
      this.appStatus = "error";
      this.lastError = message;
    }
    this.addEvent("poll_error", message);
  }

  private async runClaim(
    issue: Issue,
    slotIndex: number,
    agentKind: AgentKind,
    runId: string,
    workerHost: string | null,
    handle: ActiveRunHandle,
    slot: RunSlot | null = null,
  ): Promise<void> {
    const startedAt = this.clock.now().toISOString();
    const effectiveWorkerHost = workerHost;
    let workerOutcome: WorkerOutcome = "healthy";
    const heartbeatSlot = slot;
    let claimStoreRuntimeError: ClaimStoreRuntimeError | null = null;
    let updateQueue: Promise<void> = Promise.resolve();
    const enqueueUpdate = (update: AgentUpdate): void => {
      const next = updateQueue.then(async () => {
        heartbeatSlot?.heartbeat();
        await this.orchestrator.applyUpdateAsync(issue.id, slotIndex, update);
        this.addEvent(update.type, agentUpdateRuntimeMessage(issue.identifier, update));
        this.input.onAgentUpdate?.(issue, update);
      });
      updateQueue = next.catch((error) => {
        claimStoreRuntimeError ??= new ClaimStoreRuntimeError("claim_update_failed", error);
        handle.abort();
      });
    };
    try {
      const result = await this.runner({
        issue,
        workflow: this.workflow,
        workerHost: effectiveWorkerHost,
        slotIndex,
        // Thread the bound slot's per-run MCP endpoint (or null on the local /
        // non-pool / null-manager path) into the runner so the ACP executor
        // consumes it and SKIPS its own acquire+release. The coordinator owns the
        // whole lease and closes it via slot.release in this run's finally.
        mcpEndpoint: slot?.mcpEndpoint ?? null,
        // With more than one run slot per machine, two solo runs of the SAME
        // issue could land on one worker and would otherwise share a workspace
        // path; force the per-slot suffix whenever co-residence is possible.
        // Single-tenant (default) keeps the bare path.
        forceSlotSuffix: (this.workflow.settings.worker.workerPool?.slotsPerMachine ?? 1) > 1,
        onUpdate: enqueueUpdate,
        fetchIssue: async (current) => {
          const refreshed = await this.client.fetchIssuesByIds([current.id]);
          return refreshed[0] ?? current;
        },
        abortSignal: handle.signal,
      });
      await updateQueue;
      if (claimStoreRuntimeError) throwRuntimeError(claimStoreRuntimeError);
      if (!handle.isActive) return;
      const finalIssue = result.finalIssue ?? (await this.fetchIssueOrSelf(issue));
      if (!handle.isActive) return;
      let finished: RunningEntry | null;
      try {
        finished = await this.orchestrator.finishAsync(
          issue.id,
          slotIndex,
          true,
          undefined,
          "continuation",
        );
      } catch (error) {
        this.recordClaimStoreFailure("claim_finish_failed", error);
        return;
      }
      if (!finished) {
        this.addEvent("dispatch_skipped", `${issue.identifier} claim_lost_before_finish`);
        return;
      }
      this.recordHistory(
        buildRunHistoryEntry({
          id: runId,
          issue,
          state: finalIssue.state,
          slotIndex,
          agentKind,
          outcome: "success",
          turnCount: result.turnCount,
          runningEntry: finished,
          workspacePath: result.workspace,
          startedAt,
          endedAt: this.clock.now().toISOString(),
          durationMs: durationMs(startedAt, this.clock.now().toISOString()),
        }),
      );
      const retrySyncError = this.syncRetryTimerSafely(issue.id);
      this.addEvent("run_completed", `${issue.identifier} turns=${result.turnCount}`);
      if (retrySyncError) this.addEvent("poll_error", retrySyncError);
    } catch (error) {
      await updateQueue;
      const runtimeError = error instanceof ClaimStoreRuntimeError ? error : claimStoreRuntimeError;
      if (runtimeError) {
        this.recordClaimStoreFailure(runtimeError.reason, runtimeError.original);
        try {
          await this.orchestrator.abandonClaimAsync(issue.id, slotIndex);
        } catch (abandonError) {
          this.recordClaimStoreFailure("claim_abandon_failed", abandonError);
        }
        return;
      }
      // Classify the worker outcome BEFORE any early return so a run finished
      // externally (e.g. a stall reconciliation aborted it -> the runner throws
      // `agent_run_aborted`) still poisons the worker: a stall-finished run is
      // treated as poison via `handle.reason`, otherwise typed transport faults.
      workerOutcome = handle.reason === "stalled" ? "poison" : classifyWorkerOutcome(error);
      // Skip runs that are no longer active: superseded, finished externally, or
      // released by stop() during shutdown. In the shutdown case the runner
      // rejects with agent_run_aborted; recording it as a failure would emit a
      // run_failed event the TUI renders as a red error banner on Ctrl+C.
      if (!handle.isActive) return;
      let finished: RunningEntry | null;
      try {
        finished = await this.orchestrator.finishAsync(
          issue.id,
          slotIndex,
          true,
          errorMessage(error),
          "failure",
        );
      } catch (finishError) {
        this.recordClaimStoreFailure("claim_finish_failed", finishError);
        return;
      }
      if (!finished) {
        this.addEvent("dispatch_skipped", `${issue.identifier} claim_lost_before_finish`);
        return;
      }
      this.recordHistory(
        buildRunHistoryEntry({
          id: runId,
          issue,
          slotIndex,
          agentKind,
          outcome: "failed",
          turnCount: finished.turnCount,
          runningEntry: finished,
          startedAt,
          endedAt: this.clock.now().toISOString(),
          durationMs: durationMs(startedAt, this.clock.now().toISOString()),
          error: errorMessage(error),
          fallbackLastEvent: "turn_failed",
        }),
      );
      const retrySyncError = this.syncRetryTimerSafely(issue.id);
      this.addEvent("run_failed", `${issue.identifier} ${errorMessage(error)}`);
      if (retrySyncError) this.addEvent("poll_error", retrySyncError);
    } finally {
      handle.release();
      if (slot) {
        // A stall reconciliation force-finished this run (handle.reason='stalled').
        // The CATCH path already poisons on a rejected runner, but a runner that
        // ignores the abort - or races to a SUCCESSFUL resolve after finishExternally -
        // takes the success path's early return with workerOutcome still 'healthy'. Poison
        // the worker here, BEFORE settling, whenever the run was stall-finished,
        // independent of whether the runner resolved or rejected: a stalled worker must
        // never be released healthy and reused.
        if (handle.reason === "stalled") workerOutcome = "poison";
        // Settle the slot exactly once: close THIS slot's endpoint (a no-op in
        // STEP 1's null-endpoint passthrough) THEN settle the wrapped lease. Lease
        // ops are leaseId + settled + worker-state guarded inside the pool, so a stale
        // generation's late resolve is a no-op that never touches inFlight.
        if (workerOutcome === "poison") {
          await slot.fail("worker_poisoned");
        } else {
          await slot.release("healthy");
        }
      }
      await this.settleStoppedClaim(handle, issue.id, slotIndex);
    }
  }

  private markStoppedClaimSettlementPending(handle: ActiveRunHandle): void {
    if (handle.abandonClaimOnSettlement) return;
    this.pendingStoppedClaimSettlements += 1;
  }

  private async settleStoppedClaim(
    handle: ActiveRunHandle,
    issueId: string,
    slotIndex: number,
  ): Promise<void> {
    if (!handle.abandonClaimOnSettlement) return;
    handle.abandonClaimOnSettlement = false;
    try {
      await this.orchestrator.abandonClaimAsync(issueId, slotIndex);
    } catch (error) {
      const message = `claim_abandon_failed ${errorMessage(error)}`;
      if (this.appStatus !== "error") {
        this.appStatus = "error";
        this.lastError = message;
      }
      this.addEvent("poll_error", message);
    } finally {
      this.pendingStoppedClaimSettlements = Math.max(0, this.pendingStoppedClaimSettlements - 1);
      this.stopClaimOwnerHeartbeatIfIdle();
    }
  }

  private async fetchIssueOrSelf(issue: Issue): Promise<Issue> {
    const refreshed = await this.client.fetchIssuesByIds([issue.id]);
    return refreshed[0] ?? issue;
  }

  private async reloadWorkflowIfConfigured(): Promise<void> {
    await this.workflowReloader.reloadIfConfigured();
  }

  private async reconcileTrackedIssues(): Promise<void> {
    await this.reconciler.reconcileTrackedIssues();
  }

  private async reconcileStalledRuns(): Promise<void> {
    await this.reconciler.reconcileStalledRuns();
  }

  // Cleanup is driven by what is actually on disk: list existing per-issue workspace
  // directories and look up just those issues, instead of enumerating every terminal
  // issue the tracker has ever seen (which scales with project history, not with
  // leftover workspaces, and can blow the tracker request budget on large projects).
  private async cleanupTerminalWorkspacesOnce(): Promise<void> {
    await this.startupCleaner.cleanupTerminalWorkspacesOnce();
  }

  private abortIssueRuns(issueId: string): void {
    for (const [key, handle] of this.activeRuns.entries()) {
      if (!key.startsWith(`${issueId}:`)) continue;
      handle.finishExternally();
    }
  }

  private syncRetryTimer(issueId: string): void {
    this.retryTimers.sync(issueId);
  }

  private clearRetryTimer(issueId: string): void {
    this.retryTimers.clear(issueId);
  }

  private syncRetryTimersForIssues(issues: Issue[]): void {
    this.retryTimers.syncForIssues(issues);
  }

  private recordHistory(entry: RuntimeRunHistoryEntry): void {
    this.snapshotProjector.recordRunHistory(entry);
  }

  private recordClaimStoreFailure(reason: string, error: unknown): void {
    const message = `${reason} ${errorMessage(error)}`;
    this.markRuntimeError(message);
    this.addEvent("poll_error", message);
  }

  private syncRetryTimerSafely(issueId: string): string | null {
    return this.retryTimers.syncSafely(issueId);
  }

  private markRuntimeError(message: string): void {
    if (this.appStatus !== "error") {
      this.appStatus = "error";
      this.lastError = message;
    }
  }

  private addEvent(type: RuntimeEventType, message: string): void {
    this.eventLog.add(type, message);
  }

  private async removeIssueWorkspaces(
    settings: WorkflowDefinition["settings"],
    issueIdentifier?: string | null,
    workerHost?: string | null,
    issue?: Issue,
  ): Promise<void> {
    if (this.input.removeIssueWorkspaces) {
      return this.input.removeIssueWorkspaces(settings, issueIdentifier, workerHost, issue, {
        onHookEvent: (message) =>
          this.addEvent(
            "hook_execution",
            hookExecutionRuntimeMessage(issue?.identifier ?? issueIdentifier ?? "unknown", message),
          ),
      });
    }
    throw new Error("runtime_adapter_missing: removeIssueWorkspaces");
  }

  private emit(): void {
    let snapshot: RuntimeSnapshot;
    try {
      snapshot = this.snapshot();
    } catch (error) {
      if (this.appStatus === "error") return;
      throw error;
    }
    for (const listener of this.listeners) listener(snapshot);
  }

  requestRefresh(): {
    requested_at: string;
    queued: boolean;
    coalesced: boolean;
    operations: string[];
  } {
    const coalesced = this.pollStatus === "checking";
    if (!coalesced) {
      this.pollOnce().catch((error) => {
        this.lastError = errorMessage(error);
        this.addEvent("refresh_error", this.lastError);
      });
    }
    return {
      requested_at: this.clock.now().toISOString(),
      queued: true,
      coalesced,
      operations: ["poll", "reconcile"],
    };
  }
}

async function delay(clock: ClockPort, ms: number, stopped: () => boolean): Promise<void> {
  const stepMs = Math.min(Math.max(ms, 25), 250);
  let remaining = ms;
  while (remaining > 0 && !stopped()) {
    await new Promise<void>((resolve) => clock.setTimeout(resolve, Math.min(stepMs, remaining)));
    remaining -= stepMs;
  }
}

function missingRuntimeClient(): RuntimeTrackerClient {
  throw new Error("runtime tracker client or clientFactory is required");
}

/**
 * Wraps a bare {@link WorkerPool} in a null-endpoint passthrough {@link DispatchCoordinator} so the
 * runtime drives every run through the uniform coordinator surface while a bare-pool injection
 * stays byte-identical at the runtime boundary. The null manager mints nothing
 * (`perRunClaimEnforcement=false`, every `RunSlot.mcpEndpoint=null`), so this is a passthrough over
 * the pool: `acquireRunSlot` delegates to `pool.acquire`, settle delegates straight to the
 * `WorkerLease`, and `reconcile`/`drain`/`governs`/`canAcquire` forward verbatim. Returns
 * `undefined` when no pool is supplied (the static/local path).
 *
 * `settings` only needs to satisfy the coordinator's constructor; this wrapper does
 * not read it past construction (the pool owns live settings), so the live `worker.workerPool`
 * settings are passed when present and a disabled placeholder otherwise.
 */
function wrapWorkerPoolInCoordinator(
  pool: WorkerPool | undefined,
  settings: WorkflowDefinition["settings"],
): DispatchCoordinator | undefined {
  if (!pool) return undefined;
  // A bare workerPool is only ever injected alongside a configured `worker.worker_pool`
  // block, so its settings are present in practice. The disabled placeholder is a
  // defensive fallback for the never-in-practice case; STEP 1's coordinator does
  // not read `settings` past construction (the pool owns live settings), so the
  // exact values are irrelevant to behavior - only the shape must satisfy the
  // constructor.
  const workerPoolSettings: WorkerPoolSettings =
    settings.worker.workerPool ??
    withDerivedMaxInFlight({
      enabled: false,
      driver: "fake",
      min: 0,
      max: 0,
      warm: 0,
      slotsPerMachine: 1,
      ttlMs: 0,
      idleReapMs: 0,
      acquireTimeoutMs: 0,
      reapIntervalMs: 0,
      staleHeartbeatMs: 0,
      drainDeadlineMs: 0,
    });
  return createDispatchCoordinator({
    pool,
    mcpEndpointManager: nullEndpointManager,
    settings: workerPoolSettings,
  });
}
