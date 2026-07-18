import { slotKey } from "@lorenz/dispatch";
import type { Orchestrator, SlotReservation } from "@lorenz/orchestrator";
import type { RunSlot } from "@lorenz/dispatch-coordinator";
import {
  errorMessage,
  type AgentKind,
  type Issue,
  type RuntimeTrackerClient,
} from "@lorenz/domain";
import type { RuntimeEventType } from "@lorenz/runtime-events";

type RuntimeDispatchOrchestrator = Pick<Orchestrator, "claimAsync" | "abandonClaimAsync">;

export interface RuntimeDispatchHandle {
  release(): void;
}

export interface RuntimeDispatcherOptions<THandle extends RuntimeDispatchHandle> {
  client(): RuntimeTrackerClient;
  orchestrator: RuntimeDispatchOrchestrator;
  activeRuns: Map<string, THandle>;
  inFlight: Set<Promise<void>>;
  nextRunId(): string;
  createHandle(issueId: string, slotIndex: number, key: string, runId: string): THandle;
  syncRetryTimer(issueId: string): void;
  startClaimOwnerHeartbeat(): Promise<void>;
  stopClaimOwnerHeartbeatIfIdle(): void;
  updateAppStatusFromInFlight(): void;
  emit(): void;
  addEvent(type: RuntimeEventType, message: string): void;
  onIssueDispatched?: ((issue: Issue) => void) | undefined;
  runClaim(
    issue: Issue,
    slotIndex: number,
    agentKind: AgentKind,
    runId: string,
    workerHost: string | null,
    handle: THandle,
    slot?: RunSlot | null,
  ): Promise<void>;
  runReservedClaim(
    issue: Issue,
    reservation: SlotReservation,
    runId: string,
    handle: THandle,
  ): Promise<void>;
}

export class RuntimeDispatcher<THandle extends RuntimeDispatchHandle> {
  constructor(private readonly options: RuntimeDispatcherOptions<THandle>) {}

  async maybeDispatch(issue: Issue): Promise<Array<Promise<void>>> {
    const refreshed = await this.fetchIssueForDispatch(issue);
    if (!refreshed) {
      this.options.addEvent("dispatch_skipped", `${issue.identifier} missing_before_dispatch`);
      return [];
    }

    const claim = await this.options.orchestrator.claimAsync(refreshed);
    if (!claim) {
      this.options.addEvent("dispatch_skipped", `${refreshed.identifier} stale_before_dispatch`);
      return [];
    }
    const slotIndex =
      claim.kind === "running" ? claim.entry.slotIndex : claim.reservation.slotIndex;
    const key = slotKey(refreshed.id, slotIndex);
    const runId = this.options.nextRunId();
    const handle = this.options.createHandle(refreshed.id, slotIndex, key, runId);
    this.options.activeRuns.set(key, handle);
    try {
      this.options.syncRetryTimer(refreshed.id);
      await this.options.startClaimOwnerHeartbeat();
      if (claim.kind === "running") {
        this.options.addEvent("run_started", `${refreshed.identifier} slot=${slotIndex}`);
      } else {
        this.options.addEvent("run_reserving", `${refreshed.identifier} slot=${slotIndex}`);
      }
      this.options.onIssueDispatched?.(refreshed);
    } catch (error) {
      try {
        await this.options.orchestrator.abandonClaimAsync(refreshed.id, slotIndex);
      } catch {
        // Preserve the original dispatch setup failure.
      } finally {
        handle.release();
        this.options.stopClaimOwnerHeartbeatIfIdle();
      }
      throw error;
    }

    const run =
      claim.kind === "running"
        ? this.options.runClaim(
            refreshed,
            claim.entry.slotIndex,
            claim.entry.agentKind,
            runId,
            claim.entry.workerHost ?? null,
            handle,
          )
        : this.options.runReservedClaim(refreshed, claim.reservation, runId, handle);
    this.options.inFlight.add(run);
    void run.finally(() => {
      this.options.inFlight.delete(run);
      this.options.stopClaimOwnerHeartbeatIfIdle();
      this.options.updateAppStatusFromInFlight();
      this.options.emit();
    });
    this.options.emit();
    return [run];
  }

  private async fetchIssueForDispatch(issue: Issue): Promise<Issue | null> {
    try {
      const refreshed = await this.options.client().fetchIssuesByIds([issue.id]);
      return refreshed[0] ?? null;
    } catch (error) {
      this.options.addEvent(
        "dispatch_refresh_failed",
        `${issue.identifier} ${errorMessage(error)}`,
      );
      return null;
    }
  }
}
