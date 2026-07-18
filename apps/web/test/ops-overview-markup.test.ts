import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import type { OpsState } from "../src/features/ops/api/types";
import { OpsOverview } from "../src/features/ops/components/OpsOverview";

test("ops overview renders exhausted work as a terminal operator lane", () => {
  const state: OpsState = {
    generated_at: "2026-07-19T00:00:00.000Z",
    counts: { running: 0, retrying: 0, exhausted: 1, blocked: 0 },
    blocked_by_reason: {},
    running: [],
    retrying: [],
    exhausted: [
      {
        issue_id: "issue-exhausted",
        issue_identifier: "MT-EXHAUSTED",
        issue_url: null,
        slot_index: 0,
        attempts: 4,
        max_retry_attempts: 3,
        exhausted_at: "2026-07-18T23:59:00.000Z",
        error: "agent exited: final failure",
        worker_host: "worker-1",
        workspace_path: "/tmp/lorenz/MT-EXHAUSTED",
      },
    ],
    blocked: [],
    usage_totals: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      seconds_running: 0,
    },
    rate_limits: null,
    claim_store: null,
    daemon: null,
  };

  const markup = renderToStaticMarkup(createElement(OpsOverview, { state, connected: true }));

  expect(markup).toContain("Exhausted issues");
  expect(markup).toContain("MT-EXHAUSTED");
  expect(markup).toContain("4 total / 3 retries");
  expect(markup).toContain("agent exited: final failure");
});
