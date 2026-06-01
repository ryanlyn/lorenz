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
import { AGENT_UPDATE_TYPES } from "@symphony/domain";
import type {
  AgentKind,
  AgentUpdate,
  AgentUpdateType,
  DispatchBlockEntry,
  Issue,
  RunningEntry,
  RuntimeTrackerClient,
  UsageTotals,
  WorkflowDefinition,
} from "@symphony/domain";

export type RuntimeRunner = (input: Parameters<typeof runAgentAttempt>[0]) => Promise<RunResult>;

export type RuntimeAppStatus = "starting" | "idle" | "polling" | "running" | "stopping" | "error";
export type RuntimePollStatus = "idle" | "checking" | "error";
export const RUNTIME_RUN_OUTCOMES = ["success", "failed", "stalled", "canceled"] as const;
export type RuntimeRunOutcome = (typeof RUNTIME_RUN_OUTCOMES)[number];
export {
  RUNTIME_RECONCILIATION_REASONS,
  type RuntimeReconciliationReason,
} from "@symphony/policies/reconciliation";
export type RuntimeResumeInvalidationReason =
  | "failure"
  | "stalled"
  | "missing"
  | RuntimeReconciliationReason;
export const RUNTIME_EVENT_TYPES = [
  ...AGENT_UPDATE_TYPES,
  "dry_run",
  "poll_error",
  "dispatch_skipped",
  "run_started",
  "dispatch_refresh_failed",
  "run_completed",
  "run_failed",
  "workflow_reloaded",
  "workflow_reload_failed",
  "reconcile_refresh_failed",
  "workspace_cleanup",
  "run_reconciled",
  "run_stalled",
  "startup_workspace_cleanup",
  "startup_workspace_cleanup_failed",
  "resume_state_invalidated",
  "resume_state_invalidation_failed",
  "retry_timer_due",
  "retry_timer_error",
  "refresh_error",
] as const;
export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];
export type RuntimeRunLastEvent = AgentUpdateType | "agent_stalled";

export interface RuntimeEvent {
  type: RuntimeEventType;
  message: string;
  at: string;
}

export interface RuntimeRunHistoryEntry {
  id: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle?: string | null | undefined;
  state?: string | null | undefined;
  slotIndex: number;
  ensembleSize?: number | undefined;
  agentKind: AgentKind;
  outcome: RuntimeRunOutcome;
  turnCount: number;
  sessionId?: string | null | undefined;
  resumeId?: string | null | undefined;
  executorPid?: string | null | undefined;
  workspace?: string | null | undefined;
  workerHost?: string | null | undefined;
  usageTotals?: UsageTotals | undefined;
  startedAt: string;
  endedAt: string;
  durationMs?: number | undefined;
  error?: string | undefined;
  lastEvent?: RuntimeRunLastEvent | null | undefined;
  lastMessage?: unknown;
  lastEventAt?: string | null | undefined;
  retryAttempt?: number | null | undefined;
}

export interface RuntimeRunningEntry {
  runId?: string | undefined;
  issueId: string;
  issueIdentifier: string;
  title: string;
  state: string;
  slotIndex: number;
  ensembleSize: number;
  agentKind: AgentKind;
  sessionId?: string | null | undefined;
  resumeId?: string | null | undefined;
  executorPid?: string | null | undefined;
  workerHost?: string | null | undefined;
  turnCount: number;
  startedAt: string;
  lastEvent?: AgentUpdateType | null | undefined;
  lastMessage?: unknown;
  lastEventAt?: string | null | undefined;
  workspacePath?: string | null | undefined;
  usageTotals: UsageTotals;
  retryAttempt?: number | null | undefined;
}

export interface RuntimeRetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtIso: string;
  monotonicDeadlineMs: number;
  error?: string | undefined;
  slotIndex?: number | undefined;
  workerHost?: string | null | undefined;
  workspacePath?: string | null | undefined;
}

export type RuntimeBlockedEntry = DispatchBlockEntry;

export interface RuntimeSnapshot {
  appStatus: RuntimeAppStatus;
  workflowPath: string;
  poll: {
    status: RuntimePollStatus;
    candidates: number;
    eligible: number;
    lastPollAt: string | null;
    nextPollAt: string | null;
    lastError: string | null;
  };
  running: RuntimeRunningEntry[];
  retrying: RuntimeRetryEntry[];
  blocked: RuntimeBlockedEntry[];
  runHistory: RuntimeRunHistoryEntry[];
  usageTotals: UsageTotals;
  rateLimits: unknown;
  logFile: string | null;
  recentEvents: RuntimeEvent[];
}

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
  now?: (() => Date) | undefined;
}

export interface RuntimeStartOptions {
  once?: boolean | undefined;
  dryRun?: boolean | undefined;
}

export interface PollOptions {
  dryRun?: boolean | undefined;
  waitForRuns?: boolean | undefined;
}

class ActiveRunHandle {
  readonly controller = new AbortController();

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

  finishExternally(): void {
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

  constructor(private readonly input: SymphonyRuntimeOptions) {
    this.client =
      input.client ?? input.clientFactory?.(input.workflow.settings) ?? missingRuntimeClient();
    this.orchestrator = input.orchestrator ?? new Orchestrator(input.workflow.settings);
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
    for (const handle of this.activeRuns.values()) handle.abort();
    this.retryScheduler.stop();
    this.emit();
  }

  async pollOnce(options: PollOptions = {}): Promise<void> {
    if (this.pollInProgress) {
      return this.pollInProgress;
    }
    const poll = this.pollOnceUnlocked(options);
    this.pollInProgress = poll;
    try {
      await poll;
    } finally {
      if (this.pollInProgress === poll) this.pollInProgress = null;
    }
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
    const key = slotKey(refreshed.id, claim.slotIndex);
    const runId = `run-${this.nextRunNumber}`;
    this.nextRunNumber += 1;
    const handle = new ActiveRunHandle(key, runId, this.activeRuns);
    this.activeRuns.set(key, handle);
    this.addEvent("run_started", `${refreshed.identifier} slot=${claim.slotIndex}`);

    const run = this.runClaim(
      refreshed,
      claim.slotIndex,
      claim.agentKind,
      runId,
      claim.workerHost ?? null,
      handle,
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
  ): Promise<void> {
    const startedAt = this.now().toISOString();
    try {
      const result = await this.runner({
        issue,
        workflow: this.workflow,
        workerHost,
        slotIndex,
        onUpdate: (update) => {
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
      const entry = this.orchestrator
        .snapshot()
        .running.find((item) => item.issue.id === issue.id && item.slotIndex === slotIndex);
      this.orchestrator.finish(issue.id, slotIndex, true, undefined, "continuation");
      this.syncRetryTimer(issue.id);
      this.recordHistory({
        id: runId,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueTitle: issue.title,
        state: finalIssue.state,
        slotIndex,
        ensembleSize: entry?.ensembleSize,
        agentKind,
        outcome: "success",
        turnCount: result.turnCount,
        sessionId: entry?.sessionId,
        resumeId: result.resumeId,
        executorPid: entry?.executorPid,
        workspace: result.workspace,
        workerHost: entry?.workerHost,
        usageTotals: entry?.usageTotals,
        startedAt,
        endedAt: this.now().toISOString(),
        durationMs: durationMs(startedAt, this.now().toISOString()),
        lastEvent: entry?.lastAgentEvent,
        lastMessage: entry?.lastAgentMessage,
        lastEventAt: entry?.lastAgentTimestamp?.toISOString() ?? null,
        retryAttempt: entry?.retryAttempt,
      });
      this.addEvent("run_completed", `${issue.identifier} turns=${result.turnCount}`);
    } catch (error) {
      if (!handle.isActive) return;
      const entry = this.orchestrator
        .snapshot()
        .running.find((item) => item.issue.id === issue.id && item.slotIndex === slotIndex);
      await this.invalidateResumeStateForRunningEntry(entry, "failure");
      if (!handle.isActive) return;
      this.orchestrator.finish(issue.id, slotIndex, true, errorMessage(error), "failure");
      this.syncRetryTimer(issue.id);
      this.recordHistory({
        id: runId,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueTitle: issue.title,
        state: issue.state,
        slotIndex,
        ensembleSize: entry?.ensembleSize,
        agentKind,
        outcome: "failed",
        turnCount: entry?.turnCount ?? 0,
        sessionId: entry?.sessionId,
        resumeId: entry?.resumeId,
        executorPid: entry?.executorPid,
        workspace: entry?.workspacePath,
        workerHost: entry?.workerHost,
        usageTotals: entry?.usageTotals,
        startedAt,
        endedAt: this.now().toISOString(),
        durationMs: durationMs(startedAt, this.now().toISOString()),
        error: errorMessage(error),
        lastEvent: entry?.lastAgentEvent ?? "turn_failed",
        lastMessage: entry?.lastAgentMessage,
        lastEventAt: entry?.lastAgentTimestamp?.toISOString() ?? null,
        retryAttempt: entry?.retryAttempt,
      });
      this.addEvent("run_failed", `${issue.identifier} ${errorMessage(error)}`);
    } finally {
      handle.release();
    }
  }

  private async fetchIssueOrSelf(issue: Issue): Promise<Issue> {
    const refreshed = await this.client.fetchIssuesByIds([issue.id]);
    return refreshed[0] ?? issue;
  }

  private async reloadWorkflowIfConfigured(): Promise<void> {
    if (!this.input.reloadWorkflow) return;
    try {
      const workflow = await this.input.reloadWorkflow();
      this.input.workflow = workflow;
      this.orchestrator.settings = workflow.settings;
      if (!this.input.client && this.input.clientFactory) {
        this.client = this.input.clientFactory(workflow.settings);
      }
      this.addEvent("workflow_reloaded", workflow.path);
    } catch (error) {
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
      const timeoutMs =
        currentEntry.agentKind === "claude"
          ? effective.claude.stallTimeoutMs
          : effective.codex.stallTimeoutMs;
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
      activeHandle?.finishExternally();
      await this.invalidateResumeStateForRunningEntry(currentEntry, "stalled");
      this.recordHistory({
        id: runId,
        issueId: entry.issue.id,
        issueIdentifier: entry.identifier,
        issueTitle: entry.issue.title,
        state: entry.issue.state,
        slotIndex: entry.slotIndex,
        ensembleSize: entry.ensembleSize,
        agentKind: entry.agentKind,
        outcome: "stalled",
        turnCount: entry.turnCount,
        sessionId: entry.sessionId,
        resumeId: entry.resumeId,
        executorPid: entry.executorPid,
        workspace: entry.workspacePath,
        workerHost: entry.workerHost,
        usageTotals: entry.usageTotals,
        startedAt: entry.startedAt.toISOString(),
        endedAt: this.now().toISOString(),
        durationMs: Math.max(0, this.now().getTime() - entry.startedAt.getTime()),
        error,
        lastEvent: entry.lastAgentEvent ?? "agent_stalled",
        lastMessage: entry.lastAgentMessage,
        lastEventAt: entry.lastAgentTimestamp?.toISOString() ?? null,
        retryAttempt: entry.retryAttempt,
      });
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
      if (this.pollInProgress) return;
      this.addEvent("retry_timer_due", `${scheduled.identifier} attempt=${scheduled.attempt}`);
      this.pollOnce().catch((error) => {
        this.lastError = errorMessage(error);
        this.addEvent("retry_timer_error", this.lastError);
      });
    });
  }

  private clearRetryTimer(issueId: string): void {
    this.retryScheduler.clear(issueId);
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

function runtimeRunningEntry(entry: RunningEntry, runId: string | undefined): RuntimeRunningEntry {
  return {
    runId,
    issueId: entry.issue.id,
    issueIdentifier: entry.identifier,
    title: entry.issue.title,
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
    identifier: entry.identifier,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function durationMs(startedAt: string, endedAt: string): number {
  return Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());
}
