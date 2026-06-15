import { issueHasOpenBlockers, issueIsActive, routedToThisWorker, slotKey } from "@lorenz/dispatch";
import { reconciliationStopReason } from "@lorenz/policies/reconciliation";
import { isTerminalState } from "@lorenz/issue";
import { Orchestrator, type SlotReservation } from "@lorenz/orchestrator";
import { settingsForIssueState, validateDispatchConfig } from "@lorenz/config";
import { runAgentAttempt, type RunResult } from "@lorenz/agent-runner";
import { ProjectionActor } from "@lorenz/projections";
import { RetryScheduler } from "@lorenz/retry-scheduler";
import { workflowFileChanged, workflowStampsEqual } from "@lorenz/workflow";
import {
  durationMs,
  errorMessage,
  systemClock,
  withDerivedMaxInFlight,
  type ClockPort,
} from "@lorenz/domain";
import type {
  RuntimeAppStatus,
  RuntimeEventType,
  RuntimePollStatus,
  RuntimeRetryEntry,
  RuntimeRunHistoryEntry,
  RuntimeRunOutcome,
  RuntimeRunningEntry,
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
  WorkflowDefinition,
} from "@lorenz/domain";
import type { WorkerOutcome, WorkerPool } from "@lorenz/worker-pool";
import {
  checkSlotsPerMachineGate,
  createDispatchCoordinator,
  nullEndpointManager,
  type AcquireRunSlotResult,
  type DispatchCoordinator,
  type RunSlot,
} from "@lorenz/dispatch-coordinator";

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
   * `finally`. Absent (default) preserves the existing local / `sshHosts` behavior byte-for-byte.
   *
   * A bare `workerPool` is wrapped internally in a null-endpoint passthrough
   * {@link DispatchCoordinator} (see {@link LorenzRuntimeOptions.coordinator}), so every run
   * drives the coordinator uniformly while a bare pool injection stays byte-identical at the
   * runtime boundary (default `slotsPerMachine=1` + `mcpEndpoint=null`). Prefer threading a
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

type RetrySnapshotEntry = ReturnType<Orchestrator["snapshot"]>["retrying"][number];

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

class ActiveRunHandle {
  readonly controller = new AbortController();
  /**
   * Set when the run is force-finished externally (e.g. a stall reconciliation aborts it). The
   * worker pool reads this so a stall-finished run poisons its worker even though the runner surfaces a
   * generic `agent_run_aborted` (which would otherwise classify as healthy).
   */
  reason: "stalled" | null = null;

  constructor(
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

  finishExternally(reason: "stalled" | null = null): void {
    if (reason) this.reason = reason;
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
  private readonly retryScheduler: RetryScheduler;
  private readonly inFlight = new Set<Promise<void>>();
  private stopped = false;
  private appStatus: RuntimeAppStatus = "starting";
  private pollStatus: RuntimePollStatus = "idle";
  private candidates = 0;
  private eligible = 0;
  private lastPollAt: string | null = null;
  private nextPollAt: string | null = null;
  private lastError: string | null = null;
  private readonly projection = new ProjectionActor();
  private readonly activeRuns = new Map<string, ActiveRunHandle>();
  private startupCleanupDone = false;
  private nextRunNumber = 1;
  private pollInProgress: Promise<void> | null = null;
  private activePollOptions: PollOptions | null = null;
  private pendingPollOptions: PollOptions | null = null;
  private workerPoolDrained = false;
  /**
   * The reload-surviving coordinator singleton. Built ONCE here: either the
   * pre-built `input.coordinator` (preferred), or a null-endpoint passthrough
   * wrapping a bare `input.workerPool` (the low-churn path that keeps every existing
   * workerPool-injecting site byte-identical at the runtime boundary). `undefined`
   * when neither is supplied (the static/local path, byte-identical to today).
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
        undefined,
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
    this.retryScheduler = new RetryScheduler(this.clock);
    this.appStatus = "idle";
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
    return this.projection.snapshot({
      appStatus: this.appStatus,
      workflowPath: this.workflow.path,
      poll: {
        status: this.pollStatus,
        candidates: this.candidates,
        eligible: this.eligible,
        lastPollAt: this.lastPollAt,
        nextPollAt: this.nextPollAt,
        lastError: this.lastError,
      },
      running: orchestration.running.map((entry) =>
        runtimeRunningEntry(
          entry,
          this.activeRuns.get(slotKey(entry.issue.id, entry.slotIndex))?.runId,
        ),
      ),
      // In-acquire slots, surfaced honestly (host-less) instead of appearing in
      // `running` with a placeholder host.
      reserving: orchestration.reserving.map((entry) => ({ ...entry })),
      retrying: orchestration.retrying.map(runtimeRetryEntry),
      blocked: orchestration.blocked.map((entry) => ({ ...entry })),
      usageTotals: orchestration.usageTotals,
      rateLimits: orchestration.rateLimits,
      logFile: this.workflow.settings.logging.logFile,
    });
  }

  async start(options: RuntimeStartOptions = {}): Promise<void> {
    this.stopped = false;
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
    // finishExternally (abort + release) mirrors the other abort sites and clears
    // isActive, so the resulting agent_run_aborted rejection is treated as a clean
    // shutdown in runClaim rather than recorded as a failed run.
    for (const handle of [...this.activeRuns.values()]) handle.finishExternally();
    this.retryScheduler.stop();
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
    this.emit();

    const dispatched: Array<Promise<void>> = [];
    try {
      await this.reloadWorkflowIfConfigured();
      this.validateDispatch(this.workflow.settings);
      await this.cleanupTerminalWorkspacesOnce();
      this.reconcileStalledRuns();
      await this.reconcileTrackedIssues();
      const issues = await this.client.fetchCandidateIssues();
      const eligibleIssues = this.orchestrator.eligibleIssues(issues);
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
      this.appStatus = this.inFlight.size > 0 ? "running" : "idle";
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
    const refreshed = await this.fetchIssueForDispatch(issue);
    if (!refreshed) {
      this.addEvent("dispatch_skipped", `${issue.identifier} missing_before_dispatch`);
      return [];
    }

    const claim = this.orchestrator.claim(refreshed);
    if (!claim) {
      this.addEvent("dispatch_skipped", `${refreshed.identifier} stale_before_dispatch`);
      return [];
    }
    this.syncRetryTimer(refreshed.id);
    const slotIndex =
      claim.kind === "running" ? claim.entry.slotIndex : claim.reservation.slotIndex;
    const key = slotKey(refreshed.id, slotIndex);
    const runId = `run-${this.nextRunNumber}`;
    this.nextRunNumber += 1;
    // The handle is registered for the WHOLE run lifecycle - including the reserved
    // path's acquire window - so stop()/reconcile abort an in-acquire run (the
    // signal reaches the pool's FIFO waiter) exactly as they abort a running one.
    const handle = new ActiveRunHandle(key, runId, this.activeRuns);
    this.activeRuns.set(key, handle);
    // On the static/local path the run starts immediately. On the pool-governed
    // path run_reserving marks dispatch intent and run_started moves AFTER
    // bindReservation (inside runReservedClaim): a capacity-refused dispatch
    // never emits a phantom run_started.
    if (claim.kind === "running") {
      this.addEvent("run_started", `${refreshed.identifier} slot=${slotIndex}`);
    } else {
      this.addEvent("run_reserving", `${refreshed.identifier} slot=${slotIndex}`);
    }
    this.input.onIssueDispatched?.(refreshed);

    const run =
      claim.kind === "running"
        ? this.runClaim(
            refreshed,
            claim.entry.slotIndex,
            claim.entry.agentKind,
            runId,
            claim.entry.workerHost ?? null,
            handle,
          )
        : this.runReservedClaim(refreshed, claim.reservation, runId, handle);
    this.inFlight.add(run);
    void run.finally(() => {
      this.inFlight.delete(run);
      this.appStatus = this.inFlight.size > 0 ? "running" : "idle";
      this.emit();
    });
    this.emit();
    return [run];
  }

  private async fetchIssueForDispatch(issue: Issue): Promise<Issue | null> {
    try {
      const refreshed = await this.client.fetchIssuesByIds([issue.id]);
      return refreshed[0] ?? null;
    } catch (error) {
      this.addEvent("dispatch_refresh_failed", `${issue.identifier} ${errorMessage(error)}`);
      return null;
    }
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
      this.orchestrator.cancelReservation(reservation);
      handle.release();
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
      this.orchestrator.cancelReservation(reservation);
      this.syncRetryTimer(issue.id);
      handle.release();
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
      this.orchestrator.cancelReservation(reservation);
      this.syncRetryTimer(issue.id);
      handle.release();
      return;
    }
    const slot = acquired.slot;
    const entry = this.orchestrator.bindReservation(reservation, slot.workerHost);
    if (!entry) {
      // The reservation was cancelled/expired during the acquire (cleanup, stop,
      // or the expiry sweep): release the bound worker back to warm inventory (the
      // slot's settled-once guard makes this exactly-once) and skip the run.
      await slot.release("healthy");
      this.addEvent("dispatch_skipped", `${issue.identifier} reservation_lapsed`);
      handle.release();
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
        onUpdate: (update) => {
          heartbeatSlot?.heartbeat();
          this.orchestrator.applyUpdate(issue.id, slotIndex, update);
          this.addEvent(update.type, agentUpdateRuntimeMessage(issue.identifier, update));
          this.input.onAgentUpdate?.(issue, update);
        },
        fetchIssue: async (current) => {
          const refreshed = await this.client.fetchIssuesByIds([current.id]);
          return refreshed[0] ?? current;
        },
        abortSignal: handle.signal,
      });
      if (!handle.isActive) return;
      const finalIssue = result.finalIssue ?? (await this.fetchIssueOrSelf(issue));
      if (!handle.isActive) return;
      const entry = this.runningEntry(issue.id, slotIndex);
      this.orchestrator.finish(issue.id, slotIndex, true, undefined, "continuation");
      this.syncRetryTimer(issue.id);
      this.recordHistory(
        buildRunHistoryEntry({
          id: runId,
          issue,
          state: finalIssue.state,
          slotIndex,
          agentKind,
          outcome: "success",
          turnCount: result.turnCount,
          runningEntry: entry,
          workspacePath: result.workspace,
          startedAt,
          endedAt: this.clock.now().toISOString(),
          durationMs: durationMs(startedAt, this.clock.now().toISOString()),
        }),
      );
      this.addEvent("run_completed", `${issue.identifier} turns=${result.turnCount}`);
    } catch (error) {
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
      const entry = this.runningEntry(issue.id, slotIndex);
      if (!handle.isActive) return;
      this.orchestrator.finish(issue.id, slotIndex, true, errorMessage(error), "failure");
      this.syncRetryTimer(issue.id);
      this.recordHistory(
        buildRunHistoryEntry({
          id: runId,
          issue,
          slotIndex,
          agentKind,
          outcome: "failed",
          turnCount: entry?.turnCount ?? 0,
          runningEntry: entry,
          startedAt,
          endedAt: this.clock.now().toISOString(),
          durationMs: durationMs(startedAt, this.clock.now().toISOString()),
          error: errorMessage(error),
          fallbackLastEvent: "turn_failed",
        }),
      );
      this.addEvent("run_failed", `${issue.identifier} ${errorMessage(error)}`);
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
    }
  }

  private async fetchIssueOrSelf(issue: Issue): Promise<Issue> {
    const refreshed = await this.client.fetchIssuesByIds([issue.id]);
    return refreshed[0] ?? issue;
  }

  private async reloadWorkflowIfConfigured(): Promise<void> {
    if (!this.input.reloadWorkflow) return;
    const prevWorkerPool = this.input.workflow.settings.worker.workerPool;
    try {
      if (!(await workflowFileChanged(this.input.workflow))) return;
      const previous = this.input.workflow;
      const workflow = await this.input.reloadWorkflow();
      if (workflow === previous || workflowStampsEqual(previous.stamp, workflow.stamp)) return;
      // Enforce the SAME slots-per-machine co-residence gate the daemon runs at
      // startup. The startup gate runs ONCE; without this a live daemon could
      // reload max_in_flight 1 -> >1 WITHOUT the per-run-endpoint capability OR the
      // co_residence opt-in, silently widening the shared-machine blast radius the
      // startup gate rejects. Throwing here lands in the catch below: last-good
      // settings are KEPT (not applied, the live pool is NOT reconciled onto the
      // unsafe settings) and a workflow_reload_failed event carries the gate's
      // message - mirroring the anti-double-capacity guard behavior.
      const gateMessage = checkSlotsPerMachineGate(
        workflow.settings.worker.workerPool,
        this.coordinator?.capabilities,
      );
      if (gateMessage !== null) throw new Error(gateMessage);
      // TRANSACTIONAL reload: run EVERY throwing side effect FIRST (the gate above,
      // then the coordinator/pool reconcile), and ONLY swap the runtime settings
      // (this.input.workflow + this.orchestrator.settings + the client) AFTER they
      // ALL succeed. If reconcile throws (e.g. driver unavailable / invalid
      // driverOptions) the catch below leaves BOTH the runtime settings AND the
      // pool/coordinator state on the PREVIOUS config - last-good is never partially
      // applied, so dispatch can never use settings that do not match the live pool.
      //
      // The coordinator (and its pool) is a reload-surviving singleton: diff
      // prev-vs-next worker-pool settings instead of being reconstructed. When the
      // reload REMOVES the worker_pool block entirely (next === undefined), reconcile
      // to a disabled-equivalent of the prior settings so the live pool drains to
      // zero instead of leaking its (paid) workers unmanaged. A present block (even
      // one with `enabled: false`) keeps the existing path: reconcile handles the
      // disable-and-drain itself.
      if (this.coordinator) {
        const next =
          workflow.settings.worker.workerPool ?? disabledWorkerPoolSettings(prevWorkerPool);
        // Awaited: reconcile is async so the coordinator's injected driverLoader
        // can dynamic-import an out-of-tree driver module BEFORE the (still
        // synchronous) pool reconcile. A rejection lands in the catch below,
        // keeping last-good settings and emitting workflow_reload_failed.
        if (next) await this.coordinator.reconcile(next);
      }
      this.input.workflow = workflow;
      this.orchestrator.settings = workflow.settings;
      if (!this.input.client && this.input.clientFactory) {
        this.client = this.input.clientFactory(workflow.settings);
      }
      this.addEvent("workflow_reloaded", workflow.path);
    } catch (error) {
      // Keeps last-good settings. errorMessage(error) already surfaces the
      // anti-double-capacity guard message so operators learn why a reload that
      // tried to enable the pool alongside ssh_hosts did not take effect.
      this.addEvent("workflow_reload_failed", errorMessage(error));
    }
  }

  private async reconcileTrackedIssues(): Promise<void> {
    const snapshot = this.orchestrator.snapshot();
    const tracked = new Map<
      string,
      {
        identifier: string;
        workerHost?: string | null | undefined;
        workspacePath?: string | null | undefined;
      }
    >();
    // Reserving (in-acquire) slots are tracked host-less so an issue that goes
    // terminal mid-acquire is still aborted and cleaned up; running/retrying
    // entries below override with their richer metadata when present.
    for (const entry of snapshot.reserving)
      tracked.set(entry.issueId, {
        identifier: entry.identifier,
        workerHost: null,
        workspacePath: null,
      });
    for (const entry of snapshot.running)
      tracked.set(entry.issue.id, {
        identifier: entry.issue.identifier,
        workerHost: entry.workerHost,
        workspacePath: entry.workspacePath,
      });
    for (const entry of snapshot.retrying)
      tracked.set(entry.issueId, {
        identifier: entry.identifier,
        workerHost: entry.workerHost,
        workspacePath: entry.workspacePath,
      });
    if (tracked.size === 0) return;

    let refreshed: Issue[];
    try {
      refreshed = await this.client.fetchIssuesByIds([...tracked.keys()]);
    } catch (error) {
      this.addEvent("reconcile_refresh_failed", errorMessage(error));
      return;
    }
    const refreshedIds = new Set(refreshed.map((issue) => issue.id));
    for (const issue of refreshed) {
      if (
        issueIsActive(issue, this.workflow.settings) &&
        routedToThisWorker(issue, this.workflow.settings) &&
        !issueHasOpenBlockers(issue, this.workflow.settings)
      ) {
        this.orchestrator.refreshRunningIssue(issue);
        continue;
      }
      this.abortIssueRuns(issue.id);
      this.orchestrator.cleanupIssue(issue.id);
      this.clearRetryTimer(issue.id);
      const reason = reconciliationStopReason(issue, this.workflow.settings);
      if (isTerminalState(issue.state, this.workflow.settings.tracker.terminalStates)) {
        await this.removeIssueWorkspaces(
          this.workflow.settings,
          issue.identifier || tracked.get(issue.id)?.identifier,
          tracked.get(issue.id)?.workerHost,
          issue,
        );
        this.addEvent("workspace_cleanup", `${issue.identifier} ${reason}`);
      } else {
        this.addEvent("run_reconciled", `${issue.identifier} ${reason}`);
      }
    }
    for (const [issueId, meta] of tracked.entries()) {
      if (refreshedIds.has(issueId)) continue;
      this.abortIssueRuns(issueId);
      this.orchestrator.cleanupIssue(issueId);
      this.clearRetryTimer(issueId);
      this.addEvent("run_reconciled", `${meta.identifier} missing`);
    }
  }

  private reconcileStalledRuns(): void {
    for (const snapshotEntry of this.orchestrator.snapshot().running) {
      const currentEntry = this.runningEntry(snapshotEntry.issue.id, snapshotEntry.slotIndex);
      if (!currentEntry) continue;
      const effective = settingsForIssueState(this.workflow.settings, currentEntry.issue.state);
      const agent = effective.agents[currentEntry.agentKind];
      if (!agent) throw new Error(`agents.${currentEntry.agentKind} is required`);
      const timeoutMs = agent.stallTimeoutMs;
      if (timeoutMs <= 0) continue;
      const lastActivity = currentEntry.lastAgentTimestamp ?? currentEntry.startedAt;
      const elapsedMs = this.clock.now().getTime() - lastActivity.getTime();
      if (elapsedMs <= timeoutMs) continue;

      const key = slotKey(currentEntry.issue.id, currentEntry.slotIndex);
      const activeHandle = this.activeRuns.get(key);
      const runId =
        activeHandle?.runId ?? `stalled-${currentEntry.issue.id}-${currentEntry.slotIndex}`;
      const error = `agent_stalled after ${timeoutMs}ms`;
      const entry = this.runningEntry(snapshotEntry.issue.id, snapshotEntry.slotIndex);
      if (!entry) continue;
      this.orchestrator.finish(entry.issue.id, entry.slotIndex, true, error, "failure");
      this.syncRetryTimer(entry.issue.id);
      activeHandle?.finishExternally("stalled");
      const endedAt = this.clock.now().toISOString();
      this.recordHistory(
        buildRunHistoryEntry({
          id: runId,
          issue: entry.issue,
          issueIdentifier: entry.identifier,
          slotIndex: entry.slotIndex,
          agentKind: entry.agentKind,
          outcome: "stalled",
          turnCount: entry.turnCount,
          runningEntry: entry,
          startedAt: entry.startedAt.toISOString(),
          endedAt,
          durationMs: durationMs(entry.startedAt.toISOString(), endedAt),
          error,
          fallbackLastEvent: "agent_stalled",
        }),
      );
      this.addEvent("run_stalled", `${entry.identifier} ${error}`);
    }
  }

  private runningEntry(issueId: string, slotIndex: number): RunningEntry | undefined {
    return this.orchestrator
      .snapshot()
      .running.find((entry) => entry.issue.id === issueId && entry.slotIndex === slotIndex);
  }

  // Cleanup is driven by what is actually on disk: list existing per-issue workspace
  // directories and look up just those issues, instead of enumerating every terminal
  // issue the tracker has ever seen (which scales with project history, not with
  // leftover workspaces, and can blow the tracker request budget on large projects).
  private async cleanupTerminalWorkspacesOnce(): Promise<void> {
    if (this.startupCleanupDone) return;
    this.startupCleanupDone = true;
    if (!this.input.listIssueWorkspaces) return;
    try {
      const identifiers = await this.input.listIssueWorkspaces(this.workflow.settings);
      if (identifiers.length === 0) return;
      const issues = await this.client.fetchIssuesByIds(identifiers);
      let cleaned = 0;
      for (const issue of issues) {
        if (!isTerminalState(issue.state, this.workflow.settings.tracker.terminalStates)) continue;
        await this.removeIssueWorkspaces(
          this.workflow.settings,
          issue.identifier,
          undefined,
          issue,
        );
        cleaned += 1;
      }
      if (cleaned > 0) this.addEvent("startup_workspace_cleanup", `terminal=${cleaned}`);
    } catch (error) {
      this.addEvent("startup_workspace_cleanup_failed", errorMessage(error));
    }
  }

  private abortIssueRuns(issueId: string): void {
    for (const [key, handle] of this.activeRuns.entries()) {
      if (!key.startsWith(`${issueId}:`)) continue;
      handle.finishExternally();
    }
  }

  private syncRetryTimer(issueId: string): void {
    const retry = this.orchestrator.snapshot().retrying.find((entry) => entry.issueId === issueId);
    this.syncRetryTimerEntry(issueId, retry);
  }

  private syncRetryTimerEntry(issueId: string, retry: RetrySnapshotEntry | undefined): void {
    if (!retry) {
      this.clearRetryTimer(issueId);
      return;
    }
    this.retryScheduler.sync(runtimeRetryEntry(retry), (scheduled) => {
      const current = this.orchestrator
        .snapshot()
        .retrying.find((entry) => entry.issueId === scheduled.issueId);
      if (
        !current ||
        current.attempt !== scheduled.attempt ||
        current.dueAtIso !== scheduled.dueAtIso
      ) {
        return;
      }
      this.addEvent("retry_timer_due", `${scheduled.issueIdentifier} attempt=${scheduled.attempt}`);
      if (this.pollInProgress) {
        this.queuePendingPoll({}, true);
        return;
      }
      this.pollOnce().catch((error) => {
        this.lastError = errorMessage(error);
        this.addEvent("retry_timer_error", this.lastError);
      });
    });
  }

  private clearRetryTimer(issueId: string): void {
    this.retryScheduler.clear(issueId);
  }

  private syncRetryTimersForIssues(issues: Issue[]): void {
    const retryByIssueId = new Map<string, RetrySnapshotEntry>();
    for (const retry of this.orchestrator.snapshot().retrying) {
      if (!retryByIssueId.has(retry.issueId)) retryByIssueId.set(retry.issueId, retry);
    }
    for (const issue of issues) this.syncRetryTimerEntry(issue.id, retryByIssueId.get(issue.id));
  }

  private recordHistory(entry: RuntimeRunHistoryEntry): void {
    this.projection.recordRunHistory(entry);
  }

  private addEvent(type: RuntimeEventType, message: string): void {
    const event = { type, message, at: this.clock.now().toISOString() };
    this.projection.recordEvent(event);
    void this.appendLogEvent(this.workflow.settings.logging.logFile, {
      at: event.at,
      event: type,
      message,
    }).catch((err) => {
      process.stderr.write(`appendLogEvent failed: ${err}\n`);
    });
    this.emit();
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

  private async appendLogEvent(
    logFile: string | null | undefined,
    event: Record<string, unknown>,
  ): Promise<void> {
    if (!logFile) return;
    if (this.input.appendLogEvent) return this.input.appendLogEvent(logFile, event);
  }

  private emit(): void {
    const snapshot = this.snapshot();
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

interface BuildRunHistoryEntryInput {
  id: string;
  issue: Issue;
  issueIdentifier?: string | undefined;
  state?: RuntimeRunHistoryEntry["state"];
  slotIndex: number;
  agentKind: AgentKind;
  outcome: RuntimeRunOutcome;
  turnCount: number;
  runningEntry?: RunningEntry | undefined;
  workspacePath?: RuntimeRunHistoryEntry["workspacePath"];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  error?: string | undefined;
  fallbackLastEvent?: RuntimeRunHistoryEntry["lastEvent"];
}

function buildRunHistoryEntry(input: BuildRunHistoryEntryInput): RuntimeRunHistoryEntry {
  const entry = input.runningEntry;
  const workspacePath = "workspacePath" in input ? input.workspacePath : entry?.workspacePath;

  return {
    id: input.id,
    issueId: input.issue.id,
    issueIdentifier: input.issueIdentifier ?? input.issue.identifier,
    issueTitle: input.issue.title,
    state: "state" in input ? input.state : input.issue.state,
    slotIndex: input.slotIndex,
    ensembleSize: entry?.ensembleSize,
    agentKind: input.agentKind,
    outcome: input.outcome,
    turnCount: input.turnCount,
    sessionId: entry?.sessionId,
    executorPid: entry?.executorPid,
    workspacePath,
    workerHost: entry?.workerHost,
    usageTotals: entry?.usageTotals,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: input.durationMs,
    ...(input.error !== undefined ? { error: input.error } : {}),
    lastEvent: entry?.lastAgentEvent ?? input.fallbackLastEvent,
    lastMessage: entry?.lastAgentMessage,
    lastEventAt: entry?.lastAgentTimestamp?.toISOString() ?? null,
    retryAttempt: entry?.retryAttempt,
  };
}

function runtimeRunningEntry(entry: RunningEntry, runId: string | undefined): RuntimeRunningEntry {
  return {
    runId,
    issueId: entry.issue.id,
    issueIdentifier: entry.identifier,
    issueUrl: entry.issue.url ?? null,
    issueTitle: entry.issue.title,
    state: entry.issue.state,
    slotIndex: entry.slotIndex,
    ensembleSize: entry.ensembleSize,
    agentKind: entry.agentKind,
    sessionId: entry.sessionId,
    executorPid: entry.executorPid,
    workerHost: entry.workerHost,
    turnCount: entry.turnCount,
    startedAt: entry.startedAt.toISOString(),
    lastEvent: entry.lastAgentEvent,
    lastMessage: entry.lastAgentMessage,
    lastEventAt: entry.lastAgentTimestamp?.toISOString() ?? null,
    workspacePath: entry.workspacePath,
    usageTotals: { ...entry.usageTotals },
    retryAttempt: entry.retryAttempt,
  };
}

function runtimeRetryEntry(entry: {
  issueId: string;
  identifier: string;
  issueUrl?: string | null | undefined;
  attempt: number;
  dueAtIso: string;
  monotonicDeadlineMs: number;
  error?: string | undefined;
  slotIndex?: number | undefined;
  workerHost?: string | null | undefined;
  workspacePath?: string | null | undefined;
}): RuntimeRetryEntry {
  return {
    issueId: entry.issueId,
    issueIdentifier: entry.identifier,
    issueUrl: entry.issueUrl ?? null,
    attempt: entry.attempt,
    dueAtIso: entry.dueAtIso,
    monotonicDeadlineMs: entry.monotonicDeadlineMs,
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    ...(entry.slotIndex !== undefined ? { slotIndex: entry.slotIndex } : {}),
    ...(entry.workerHost !== undefined ? { workerHost: entry.workerHost } : {}),
    ...(entry.workspacePath !== undefined ? { workspacePath: entry.workspacePath } : {}),
  };
}

function agentUpdateRuntimeMessage(issueIdentifier: string, update: AgentUpdate): string {
  if (update.type !== "hook_execution") return `${issueIdentifier} ${update.type}`;
  return hookExecutionRuntimeMessage(issueIdentifier, update.message);
}

function hookExecutionRuntimeMessage(
  issueIdentifier: string,
  message: HookExecutionMessage,
): string {
  const hookName = message.hookName ?? "hook";
  const parts = [
    `${issueIdentifier} ${hookName} hook ${message.status}`,
    `command=${inlineLogValue(message.command)}`,
  ];
  if (message.exitCode !== undefined) parts.push(`exit_code=${message.exitCode ?? "unknown"}`);
  if (message.error) {
    const suffix = message.errorTruncated ? " (truncated)" : "";
    parts.push(`error=${inlineLogValue(message.error)}${suffix}`);
  }
  if (message.output) {
    const suffix = message.outputTruncated ? " (truncated)" : "";
    parts.push(`output=${inlineLogValue(message.output)}${suffix}`);
  }
  return parts.join(" ");
}

function inlineLogValue(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, " ").trim());
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
 * Builds a disabled-equivalent of the prior worker-pool settings so a reload that REMOVES the
 * `worker.worker_pool` block (next === undefined) can still reconcile the live pool to a drain
 * rather than leaking it. Preserves `drainDeadlineMs` from the prior settings so the drain
 * honors the operator's configured deadline. Returns `undefined` when there were no prior
 * settings (nothing to drain).
 */
function disabledWorkerPoolSettings(
  prev: WorkerPoolSettings | undefined,
): WorkerPoolSettings | undefined {
  if (!prev) return undefined;
  // A bare spread would copy the enumerable `maxInFlight` getter as a plain data property that
  // could drift from `slotsPerMachine`; strip it and re-install the derived accessor, matching
  // the config package's parse/clone paths.
  const { maxInFlight: _maxInFlight, ...rest } = prev;
  return withDerivedMaxInFlight({ ...rest, enabled: false });
}

/**
 * Wraps a bare {@link WorkerPool} in a null-endpoint passthrough {@link DispatchCoordinator} so the
 * runtime drives every run through the uniform coordinator surface while a bare-pool injection
 * stays byte-identical at the runtime boundary. STEP 1's null manager mints nothing
 * (`perRunEndpoint=false`, every `RunSlot.mcpEndpoint=null`), so this is a 1:1 passthrough over
 * the pool: `acquireRunSlot` delegates to `pool.acquire`, settle delegates straight to the
 * `WorkerLease`, and `reconcile`/`drain`/`governs`/`canAcquire` forward verbatim. Returns
 * `undefined` when no pool is supplied (the static/local path).
 *
 * `settings` only needs to satisfy the coordinator's constructor; in STEP 1 the coordinator does
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
