import { dispatchBlockReasonLabel, type DispatchBlockReason } from "@lorenz/domain";
import { statePayload } from "@lorenz/cli";
import type { RuntimeSnapshot } from "@lorenz/runtime-events";
import { assert } from "@lorenz/test-utils";
import { formatDashboard } from "@lorenz/tui";
import { test } from "vitest";

import { topBlockedReasonLabel } from "../apps/web/src/features/ops/components/OpsOverview";

const KNOWN_REASON_LABELS = {
  global_concurrency_cap: "global concurrency cap",
  local_concurrency_cap: "local state concurrency cap",
  worker_host_capacity: "worker host capacity",
} as const satisfies Record<DispatchBlockReason, string>;

test.each(Object.entries(KNOWN_REASON_LABELS))(
  "uses the canonical label for %s across presenter, TUI, and dashboard",
  (reason, label) => {
    assertSurfaceParity(reason, label);
  },
);

test("uses the same safe fallback across presenter, TUI, and dashboard", () => {
  assertSurfaceParity("future_capacity_guard", "future capacity guard");
  assertSurfaceParity("constructor", "constructor");
  assert.equal(dispatchBlockReasonLabel(""), "unknown");
});

function assertSurfaceParity(reason: string, expectedLabel: string): void {
  const snapshot = snapshotWithBlockReason(reason);
  const payload = statePayload(snapshot, "2026-07-18T00:00:00.000Z");
  const tui = formatDashboard(snapshot, {
    ansi: false,
    columns: 140,
    now: "2026-07-18T00:00:00.000Z",
  });

  assert.equal(payload.blocked[0]?.label, expectedLabel);
  assert.match(tui, new RegExp(`${expectedLabel}\\s*$`, "m"));
  assert.equal(topBlockedReasonLabel(payload), expectedLabel);
  assert.equal(payload.blocked[0]?.reason, reason);
  assert.deepEqual(payload.blocked_by_reason, { [reason]: 1 });
}

function snapshotWithBlockReason(reason: string): RuntimeSnapshot {
  return {
    appStatus: "running",
    workflowPath: "/tmp/WORKFLOW.md",
    poll: {
      status: "idle",
      candidates: 1,
      eligible: 1,
      lastPollAt: null,
      nextPollAt: null,
      lastError: null,
    },
    running: [],
    retrying: [],
    blocked: [
      {
        issueId: "blocked-1",
        identifier: "MT-BLOCK",
        state: "Todo",
        reason: reason as DispatchBlockReason,
      },
    ],
    runHistory: [],
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    rateLimits: null,
    logFile: null,
    recentEvents: [],
  };
}
