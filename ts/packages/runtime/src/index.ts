import {
  issueHasOpenBlockers,
  issueIsActive,
  routedToThisWorker,
  slotKey,
} from "@symphony/dispatch";
import {
  reconciliationStopReason,
  type RuntimeReconciliationReason,
} from "@symphony/policies/reconciliation";
import { isTerminalState } from "@symphony/issue";
import { Orchestrator } from "@symphony/orchestrator";
import { settingsForIssueState, validateDispatchConfig } from "@symphony/config";
import { runAgentAttempt, type RunResult } from "@symphony/agent-runner";
import { ProjectionActor } from "@symphony/projections";
import { RetryScheduler } from "@symphony/retry-scheduler";
import { workflowFileChanged, workflowStampsEqual } from "@symphony/workflow";
import { durationMs, errorMessage, withDerivedMaxInFlight } from "@symphony/domain";
import type {
  RuntimeAppStatus,
  RuntimeEventType,
  RuntimePollStatus,
  RuntimeRetryEntry,
  RuntimeRunHistoryEntry,
  RuntimeRunOutcome,
  RuntimeRunningEntry,
  RuntimeSnapshot,
} from "@symphony/runtime-events";
import type {
  AgentKind,
  AgentUpdate,
  BoxPoolSettings,
  Issue,
  RunningEntry,
  RuntimeTrackerClient,
  WorkflowDefinition,
} from "@symphony/domain";
import type { BoxOutcome, BoxPool } from "@symphony/worker-box-pool";
import {
  checkSlotsPerMachineGate,
  createDispatchCoordinator,
  nullEndpointManager,
  type AcquireRunSlotResult,
  type DispatchCoordinator,
  type RunSlot,
} from "@symphony/dispatch-coordinator";

export type RuntimeRunner = (input: Parameters<typeof runAgentAttempt>[0]) => Promise<RunResult>;

export { RUNTIME_EVENT_TYPES, RUNTIME_RUN_OUTCOMES } from "@symphony/runtime-events";
export type {
  RuntimeAppStatus,
  RuntimeBlockedEntry,
  RuntimeEvent,
  RuntimeEventType,
  RuntimePollStatus,
  RuntimeRetryEntry,
  RuntimeRunHistoryEntry,
  RuntimeRunLastEvent,
  RuntimeRunningEntry,
  RuntimeRunOutcome,
  RuntimeSnapshot,
} from "@symphony/runtime-events";
export {
  RUNTIME_RECONCILIATION_REASONS,
  type RuntimeReconciliationReason,
} from "@symphony/policies/reconciliation";
export type RuntimeResumeInvalidationReason =
  | "failure"
  | "stalled"
  | "missing"
  | RuntimeReconciliationReason;

export interface SymphonyRuntimeOptions {
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
      ) => Promise<void>)
    | undefined;
  deleteResumeState?:
    | ((workspace: string, workerHost?: string | null, timeoutMs?: number) => Promise<void>)
    | undefined;
  appendLogEvent?: ((logFile: string, event: Record<string, unknown>) => Promise<void>) | undefined;
  onAgentUpdate?: ((issue: Issue, update: AgentUpdate) => void) | undefined;
  onIssueDispatched?: ((issue: Issue) => void) | undefined;
  now?: (() => Date) | undefined;
  /**
   * Optional embedded box pool. When present, the orchestrator is constructed with a capacity
   * probe backed by the pool's `canAcquire` (bypassing the static `sshHosts` selection), and
   * each run acquires a {@link RunSlot} before the runner and releases/fails it in the run's
   * `finally`. Absent (default) preserves the existing local / `sshHosts` behavior byte-for-byte.
   *
   * A bare `boxPool` is wrapped internally in a null-endpoint passthrough
   * {@link DispatchCoordinator} (see {@link SymphonyRuntimeOptions.coordinator}), so every run
   * drives the coordinator uniformly while a bare pool injection stays byte-identical at the
   * runtime boundary (default `slotsPerMachine=1` + `mcpEndpoint=null`). Prefer threading a
   * pre-built `coordinator`; `boxPool` is the low-churn path that keeps existing injection
   * sites unchanged. When BOTH are supplied, `coordinator` wins.
   */
  boxPool?: BoxPool | undefined;
  /**
   * Optional embedded dispatch coordinator wrapping a machine {@link BoxPool} plus an injected
   * per-run MCP endpoint manager. When present it governs capacity and mints a {@link RunSlot}
   * per run exactly as a wrapped {@link SymphonyRuntimeOptions.boxPool} would; the daemon builds
   * it once (a reload-surviving singleton) via `buildDispatchCoordinator`. Takes precedence over
   * `boxPool` when both are supplied.
   */
  coordinator?: DispatchCoordinator | undefined;
}

/**
 * Classifies a run error into a box outcome. Returns `poison` ONLY for typed box-transport faults
 * (the box is bad and must be recycled); everything else is `healthy` (a local/config/agent fault
 * that left the box reusable). Matches typed PREFIXES, not arbitrary substrings, so that
 * `invalid_ssh_timeout` (a local config fault) is never mistaken for the `ssh_timeout` transport
 * fault even though one is a substring of the other.
 */
const POISON_BOX_ERROR_PREFIXES = [
  "ssh_timeout:",
  "remote_home_lookup_failed:",
  "workspace_prepare_failed:",
  // A REMOTE workspace hook (run over SSH against the box's workerHost) that exits
  // non-zero throws `workspace hook failed with status N: ...`. That is a box-side
  // fault, so it poisons the box. The LOCAL hook failure string is
  // `hook failed with status N` (no `workspace ` prefix) and stays healthy.
  "workspace hook failed with status ",
] as const;

export function classifyBoxOutcome(error: unknown): BoxOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return POISON_BOX_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))
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
   * box pool reads this so a stall-finished run poisons its box even though the runner surfaces a
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

export class SymphonyRuntime {
  private client: RuntimeTrackerClient;
  private readonly orchestrator: Orchestrator;
  private readonly runner: RuntimeRunner;
  private readonly now: () => Date;
  private readonly listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  private readonly retryScheduler = new RetryScheduler();
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
  private boxPoolDrained = false;
  /**
   * The reload-surviving coordinator singleton. Built ONCE here: either the
   * pre-built `input.coordinator` (preferred), or a null-endpoint passthrough
   * wrapping a bare `input.boxPool` (the low-churn path that keeps every existing
   * boxPool-injecting site byte-identical at the runtime boundary). `undefined`
   * when neither is supplied (the static/local path, byte-identical to today).
   */
  private readonly coordinator: DispatchCoordinator | undefined;

  constructor(private readonly input: SymphonyRuntimeOptions) {
    this.client =
      input.client ?? input.clientFactory?.(input.workflow.settings) ?? missingRuntimeClient();
    // Prefer the pre-built coordinator; otherwise wrap a bare boxPool in a
    // null-endpoint passthrough so `acquireRunSlot`/`capacityProbe`/`reconcile`/
    // `drain` drive a uniform surface (default slotsPerMachine=1 + mcpEndpoint=null
    // make this a 1:1 passthrough over the pool). Built once: a reload reconciles
    // it in place, never reconstructs it.
    this.coordinator =
      input.coordinator ?? wrapBoxPoolInCoordinator(input.boxPool, input.workflow.settings);
    const coordinator = this.coordinator;
    this.orchestrator =
      input.orchestrator ??
      new Orchestrator(
        input.workflow.settings,
        undefined,
        undefined,
        // The probe is installed for the orchestrator's lifetime whenever a coordinator exists,
        // but a reload can disable the underlying pool (draining it to zero) without tearing the
        // probe down. `governs` tracks whether the live pool still governs capacity so a disabled
        // pool falls through to static/local execution instead of permanently blocking dispatch as
        // worker_host_capacity. The coordinator builds its probe ONCE (stable identity across
        // reconcile) and re-reads live pool state each call.
        coordinator?.capacityProbe(),
      );
    this.runner = input.runner ?? runAgentAttempt;
    this.now = input.now ?? (() => new Date());
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
      await delay(this.workflow.settings.polling.intervalMs, () => this.stopped);
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
   * Drains the box pool once (idempotent). `stop()` stays synchronous (it only flips `stopped` and
   * aborts handles), so this is invoked by the daemon's `finally` AFTER `start()` resolves to
   * destroy paid cloud boxes before process exit. A no-op when no pool is configured.
   */
  async drainBoxPool(): Promise<void> {
    if (this.boxPoolDrained) return;
    this.boxPoolDrained = true;
    const deadlineMs = this.workflow.settings.worker.boxPool?.drainDeadlineMs ?? 30_000;
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
    this.lastPollAt = this.now().toISOString();
    this.lastError = null;
    this.emit();

    const dispatched: Array<Promise<void>> = [];
    try {
      await this.reloadWorkflowIfConfigured();
      validateDispatchConfig(this.workflow.settings);
      await this.cleanupTerminalWorkspacesOnce();
      await this.reconcileStalledRuns();
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
        this.now().getTime() + this.workflow.settings.polling.intervalMs,
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
    const key = slotKey(refreshed.id, claim.slotIndex);
    const runId = `run-${this.nextRunNumber}`;
    this.nextRunNumber += 1;
    const handle = new ActiveRunHandle(key, runId, this.activeRuns);
    this.activeRuns.set(key, handle);
    this.addEvent("run_started", `${refreshed.identifier} slot=${claim.slotIndex}`);
    this.input.onIssueDispatched?.(refreshed);

    const run = this.runClaim(
      refreshed,
      claim.slotIndex,
      claim.agentKind,
      runId,
      claim.workerHost ?? null,
      handle,
      claim.affinityHost ?? null,
    );
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

  private async runClaim(
    issue: Issue,
    slotIndex: number,
    agentKind: AgentKind,
    runId: string,
    workerHost: string | null,
    handle: ActiveRunHandle,
    affinityHost: string | null = null,
  ): Promise<void> {
    const startedAt = this.now().toISOString();
    let effectiveWorkerHost = workerHost;
    let slot: RunSlot | null = null;
    let boxOutcome: BoxOutcome = "healthy";
    // Only acquire a slot while the coordinator's pool is actually ENABLED (governing capacity). A
    // reload can disable the pool (draining it to zero) without tearing the probe down; once
    // disabled the orchestrator's claim takes the static/local path (a real host or null), so here
    // we skip the acquire entirely and run with that workerHost rather than abandoning the claim
    // against a pool that will only ever report no_capacity.
    if (this.coordinator && this.coordinator.isEnabled()) {
      let acquired: AcquireRunSlotResult;
      try {
        acquired = await this.coordinator.acquireRunSlot({
          issueId: issue.id,
          slotIndex,
          labels: issue.labels,
          affinityKey: affinityHost,
          timeoutMs: this.workflow.settings.worker.boxPool?.acquireTimeoutMs ?? 30_000,
          signal: handle.signal,
          // Thread the FULL workflow Settings (with server.port) so the per-run
          // endpoint manager can build the remote endpoint; the BoxPoolSettings the
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
        // filesystem / provider / endpoint-open fault). Handle it like a failed
        // dispatch rather than letting the rejection strand the claim: abandon the
        // claim so the slot is re-evaluated next poll, release the active handle,
        // surface a clear error event (never swallowed), and return WITHOUT running
        // or recording history. No slot was bound, so there is nothing to settle.
        this.addEvent(
          "dispatch_skipped",
          `${issue.identifier} box_pool_acquire_error ${errorMessage(error)}`,
        );
        this.orchestrator.abandonClaim(issue.id, slotIndex);
        handle.release();
        return;
      }
      if (acquired.status !== "bound") {
        // No capacity within the acquire window (EVERY typed no_capacity reason
        // maps to the SAME event - no per-reason differentiation, matching today):
        // un-claim the slot (NO retry/backoff) so the next poll re-evaluates
        // capacity via canAcquire(); never record history for a run that did not
        // start.
        this.addEvent("dispatch_skipped", `${issue.identifier} worker_host_capacity`);
        this.orchestrator.abandonClaim(issue.id, slotIndex);
        handle.release();
        return;
      }
      slot = acquired.slot;
      effectiveWorkerHost = slot.workerHost;
      // Overwrite the pending:// sentinel with the real slot address BEFORE the
      // runner so the snapshot/history downstream see the real worker host.
      this.orchestrator.setWorkerHost(issue.id, slotIndex, effectiveWorkerHost);
    }
    const heartbeatSlot = slot;
    try {
      const result = await this.runner({
        issue,
        workflow: this.workflow,
        workerHost: effectiveWorkerHost,
        slotIndex,
        // Thread the bound slot's per-run MCP endpoint (or null on the local /
        // non-pool / null-manager path) into the runner so acp consumes it and
        // SKIPS its own acquire+release; codex ignores it. The coordinator owns the
        // whole lease and closes it via slot.release in this run's finally.
        mcpEndpoint: slot?.mcpEndpoint ?? null,
        onUpdate: (update) => {
          heartbeatSlot?.heartbeat();
          this.orchestrator.applyUpdate(issue.id, slotIndex, update);
          this.addEvent(update.type, `${issue.identifier} ${update.type}`);
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
          resumeId: result.resumeId,
          workspacePath: result.workspace,
          startedAt,
          endedAt: this.now().toISOString(),
          durationMs: durationMs(startedAt, this.now().toISOString()),
        }),
      );
      this.addEvent("run_completed", `${issue.identifier} turns=${result.turnCount}`);
    } catch (error) {
      // Classify the box outcome BEFORE any early return so a run finished
      // externally (e.g. a stall reconciliation aborted it -> the runner throws
      // `agent_run_aborted`) still poisons the box: a stall-finished run is
      // treated as poison via `handle.reason`, otherwise typed transport faults.
      boxOutcome = handle.reason === "stalled" ? "poison" : classifyBoxOutcome(error);
      // Skip runs that are no longer active: superseded, finished externally, or
      // released by stop() during shutdown. In the shutdown case the runner
      // rejects with agent_run_aborted; recording it as a failure would emit a
      // run_failed event the TUI renders as a red error banner on Ctrl+C.
      if (!handle.isActive) return;
      const entry = this.runningEntry(issue.id, slotIndex);
      await this.invalidateResumeStateForRunningEntry(entry, "failure");
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
          endedAt: this.now().toISOString(),
          durationMs: durationMs(startedAt, this.now().toISOString()),
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
        // takes the success path's early return with boxOutcome still 'healthy'. Poison
        // the box here, BEFORE settling, whenever the run was stall-finished,
        // independent of whether the runner resolved or rejected: a stalled box must
        // never be released healthy and reused.
        if (handle.reason === "stalled") boxOutcome = "poison";
        // Settle the slot exactly once: close THIS slot's endpoint (a no-op in
        // STEP 1's null-endpoint passthrough) THEN settle the wrapped lease. Lease
        // ops are leaseId + settled + box-state guarded inside the pool, so a stale
        // generation's late resolve is a no-op that never touches inFlight.
        if (boxOutcome === "poison") {
          await slot.fail("box_poisoned");
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
    const prevBoxPool = this.input.workflow.settings.worker.boxPool;
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
        workflow.settings.worker.boxPool,
        this.coordinator?.capabilities,
      );
      if (gateMessage !== null) throw new Error(gateMessage);
      // TRANSACTIONAL reload: run EVERY throwing side effect FIRST (the gate above,
      // then the coordinator/pool reconcile), and ONLY swap the runtime settings
      // (this.input.workflow + this.orchestrator.settings + the client) AFTER they
      // ALL succeed. If reconcile throws (e.g. provider unavailable / invalid
      // providerOptions) the catch below leaves BOTH the runtime settings AND the
      // pool/coordinator state on the PREVIOUS config - last-good is never partially
      // applied, so dispatch can never use settings that do not match the live pool.
      //
      // The coordinator (and its pool) is a reload-surviving singleton: diff
      // prev-vs-next box-pool settings instead of being reconstructed. When the
      // reload REMOVES the box_pool block entirely (next === undefined), reconcile
      // to a disabled-equivalent of the prior settings so the live pool drains to
      // zero instead of leaking its (paid) boxes unmanaged. A present block (even
      // one with `enabled: false`) keeps the existing path: reconcile handles the
      // disable-and-drain itself.
      if (this.coordinator) {
        const next = workflow.settings.worker.boxPool ?? disabledBoxPoolSettings(prevBoxPool);
        if (next) this.coordinator.reconcile(next);
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
    for (const entry of snapshot.running)
      tracked.set(entry.issue.id, {
        identifier: entry.issue.identifier,
        workerHost: cleanupWorkerHost(entry.workerHost),
        workspacePath: entry.workspacePath,
      });
    for (const entry of snapshot.retrying)
      tracked.set(entry.issueId, {
        identifier: entry.identifier,
        workerHost: cleanupWorkerHost(entry.workerHost),
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
        );
        this.addEvent("workspace_cleanup", `${issue.identifier} ${reason}`);
      } else {
        await this.invalidateResumeStateForPath(tracked.get(issue.id), reason);
        this.addEvent("run_reconciled", `${issue.identifier} ${reason}`);
      }
    }
    for (const [issueId, meta] of tracked.entries()) {
      if (refreshedIds.has(issueId)) continue;
      this.abortIssueRuns(issueId);
      this.orchestrator.cleanupIssue(issueId);
      this.clearRetryTimer(issueId);
      await this.invalidateResumeStateForPath(meta, "missing");
      this.addEvent("run_reconciled", `${meta.identifier} missing`);
    }
  }

  private async reconcileStalledRuns(): Promise<void> {
    for (const snapshotEntry of this.orchestrator.snapshot().running) {
      const currentEntry = this.runningEntry(snapshotEntry.issue.id, snapshotEntry.slotIndex);
      if (!currentEntry) continue;
      const effective = settingsForIssueState(this.workflow.settings, currentEntry.issue.state);
      const agent = effective.agents[currentEntry.agentKind];
      if (!agent) throw new Error(`agents.${currentEntry.agentKind} is required`);
      const timeoutMs = agent.stallTimeoutMs;
      if (timeoutMs <= 0) continue;
      const lastActivity = currentEntry.lastAgentTimestamp ?? currentEntry.startedAt;
      const elapsedMs = this.now().getTime() - lastActivity.getTime();
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
      await this.invalidateResumeStateForRunningEntry(currentEntry, "stalled");
      const endedAt = this.now().toISOString();
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

  private async cleanupTerminalWorkspacesOnce(): Promise<void> {
    if (this.startupCleanupDone) return;
    this.startupCleanupDone = true;
    if (!this.client.fetchIssuesByStates) return;
    try {
      const terminalIssues = await this.client.fetchIssuesByStates(
        this.workflow.settings.tracker.terminalStates,
      );
      let cleaned = 0;
      for (const issue of terminalIssues) {
        await this.removeIssueWorkspaces(this.workflow.settings, issue.identifier);
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

  private async invalidateResumeStateForRunningEntry(
    entry: RunningEntry | undefined,
    reason: RuntimeResumeInvalidationReason,
  ): Promise<void> {
    if (!entry?.workspacePath) return;
    await this.invalidateResumeStateForPath(
      {
        identifier: entry.identifier,
        workerHost: entry.workerHost,
        workspacePath: entry.workspacePath,
      },
      reason,
    );
  }

  private async invalidateResumeStateForPath(
    meta:
      | {
          identifier: string;
          workerHost?: string | null | undefined;
          workspacePath?: string | null | undefined;
        }
      | undefined,
    reason: RuntimeResumeInvalidationReason,
  ): Promise<void> {
    if (!meta?.workspacePath) return;
    try {
      await this.deleteResumeState(
        meta.workspacePath,
        meta.workerHost,
        this.workflow.settings.worker.sshTimeoutMs,
      );
      this.addEvent("resume_state_invalidated", `${meta.identifier} ${reason}`);
    } catch (error) {
      this.addEvent(
        "resume_state_invalidation_failed",
        `${meta.identifier} ${errorMessage(error)}`,
      );
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
    const event = { type, message, at: this.now().toISOString() };
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
  ): Promise<void> {
    if (this.input.removeIssueWorkspaces) {
      return this.input.removeIssueWorkspaces(settings, issueIdentifier, workerHost);
    }
    throw new Error("runtime_adapter_missing: removeIssueWorkspaces");
  }

  private async deleteResumeState(
    workspacePath: string,
    workerHost?: string | null,
    timeoutMs?: number,
  ): Promise<void> {
    if (this.input.deleteResumeState) {
      return this.input.deleteResumeState(workspacePath, workerHost, timeoutMs);
    }
    throw new Error("runtime_adapter_missing: deleteResumeState");
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
      requested_at: this.now().toISOString(),
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
  resumeId?: RuntimeRunHistoryEntry["resumeId"];
  workspacePath?: RuntimeRunHistoryEntry["workspacePath"];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  error?: string | undefined;
  fallbackLastEvent?: RuntimeRunHistoryEntry["lastEvent"];
}

function buildRunHistoryEntry(input: BuildRunHistoryEntryInput): RuntimeRunHistoryEntry {
  const entry = input.runningEntry;
  const resumeId = "resumeId" in input ? input.resumeId : entry?.resumeId;
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
    resumeId,
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
    resumeId: entry.resumeId,
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

async function delay(ms: number, stopped: () => boolean): Promise<void> {
  const stepMs = Math.min(Math.max(ms, 25), 250);
  let remaining = ms;
  while (remaining > 0 && !stopped()) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(stepMs, remaining)));
    remaining -= stepMs;
  }
}

function missingRuntimeClient(): RuntimeTrackerClient {
  throw new Error("runtime tracker client or clientFactory is required");
}

/**
 * Normalizes a worker host for workspace/resume-state cleanup. During the claim->acquire window a
 * box-pool slot carries the `pending://<id>/<slot>` sentinel rather than a real address; the cleanup
 * sink treats any truthy workerHost as a remote box and would SSH to the bogus sentinel host (a
 * wasted, always-failing round-trip). Mapping the sentinel to `null` makes cleanup stay local.
 */
function cleanupWorkerHost(workerHost: string | null | undefined): string | null | undefined {
  return workerHost?.startsWith("pending://") ? null : workerHost;
}

/**
 * Builds a disabled-equivalent of the prior box-pool settings so a reload that REMOVES the
 * `worker.box_pool` block (next === undefined) can still reconcile the live pool to a drain
 * rather than leaking it. Preserves `drainDeadlineMs` from the prior settings so the drain
 * honors the operator's configured deadline. Returns `undefined` when there were no prior
 * settings (nothing to drain).
 */
function disabledBoxPoolSettings(prev: BoxPoolSettings | undefined): BoxPoolSettings | undefined {
  if (!prev) return undefined;
  return { ...prev, enabled: false };
}

/**
 * Wraps a bare {@link BoxPool} in a null-endpoint passthrough {@link DispatchCoordinator} so the
 * runtime drives every run through the uniform coordinator surface while a bare-pool injection
 * stays byte-identical at the runtime boundary. STEP 1's null manager mints nothing
 * (`perRunEndpoint=false`, every `RunSlot.mcpEndpoint=null`), so this is a 1:1 passthrough over
 * the pool: `acquireRunSlot` delegates to `pool.acquire`, settle delegates straight to the
 * `BoxLease`, and `reconcile`/`drain`/`capacityProbe` forward verbatim. Returns `undefined` when
 * no pool is supplied (the static/local path).
 *
 * `settings` only needs to satisfy the coordinator's constructor; in STEP 1 the coordinator does
 * not read it past construction (the pool owns live settings), so the live `worker.boxPool`
 * settings are passed when present and a disabled placeholder otherwise.
 */
function wrapBoxPoolInCoordinator(
  pool: BoxPool | undefined,
  settings: WorkflowDefinition["settings"],
): DispatchCoordinator | undefined {
  if (!pool) return undefined;
  // A bare boxPool is only ever injected alongside a configured `worker.box_pool`
  // block, so its settings are present in practice. The disabled placeholder is a
  // defensive fallback for the never-in-practice case; STEP 1's coordinator does
  // not read `settings` past construction (the pool owns live settings), so the
  // exact values are irrelevant to behavior - only the shape must satisfy the
  // constructor.
  const boxPoolSettings: BoxPoolSettings =
    settings.worker.boxPool ??
    withDerivedMaxInFlight({
      enabled: false,
      provider: "fake",
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
    settings: boxPoolSettings,
  });
}
