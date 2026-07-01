import type { RunningEntry, UsageTotals, WorkflowDefinition } from "@lorenz/domain";
import type { OrchestratorSnapshot } from "@lorenz/orchestrator";
import { ProjectionActor } from "@lorenz/projections";
import type {
  RuntimeAppStatus,
  RuntimeEvent,
  RuntimePollStatus,
  RuntimeRunHistoryEntry,
  RuntimeSnapshot,
} from "@lorenz/runtime-events";

import { runtimeRetryEntry, runtimeRunningEntry } from "./snapshotEntries.js";

interface RuntimePollProjectionState {
  status: RuntimePollStatus;
  candidates: number;
  eligible: number;
  lastPollAt: string | null;
  nextPollAt: string | null;
  lastError: string | null;
}

export interface RuntimeSnapshotProjectionInput {
  appStatus: RuntimeAppStatus;
  workflow: WorkflowDefinition;
  now: Date;
  poll: RuntimePollProjectionState;
  orchestration: OrchestratorSnapshot;
  runIdForSlot(issueId: string, slotIndex: number): string | undefined;
}

export class RuntimeSnapshotProjector {
  private readonly projection = new ProjectionActor();

  recordEvent(event: RuntimeEvent): void {
    this.projection.recordEvent(event);
  }

  recordRunHistory(entry: RuntimeRunHistoryEntry): void {
    this.projection.recordRunHistory(entry);
  }

  snapshot(input: RuntimeSnapshotProjectionInput): RuntimeSnapshot {
    return this.projection.snapshot({
      appStatus: input.appStatus,
      workflowPath: input.workflow.path,
      poll: { ...input.poll },
      running: input.orchestration.running.map((entry) =>
        runtimeRunningEntry(entry, input.runIdForSlot(entry.issue.id, entry.slotIndex)),
      ),
      reserving: input.orchestration.reserving.map((entry) => ({ ...entry })),
      retrying: input.orchestration.retrying.map(runtimeRetryEntry),
      blocked: input.orchestration.blocked.map((entry) => ({ ...entry })),
      usageTotals: liveSnapshotUsageTotals(
        input.orchestration.usageTotals,
        input.orchestration.running,
        input.now,
      ),
      rateLimits: input.orchestration.rateLimits,
      claimStore: input.orchestration.claimStore,
      logFile: input.workflow.settings.logging.logFile,
    });
  }
}

function liveSnapshotUsageTotals(
  usageTotals: UsageTotals,
  running: RunningEntry[],
  now: Date,
): UsageTotals {
  const activeSeconds = running.reduce(
    (total, entry) => total + Math.max(0, (now.getTime() - entry.startedAt.getTime()) / 1000),
    0,
  );
  return {
    ...usageTotals,
    secondsRunning: usageTotals.secondsRunning + activeSeconds,
  };
}
