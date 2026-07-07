import { z } from "zod";

// Zod is the single source of truth for the observability wire shapes: the presenter builds
// payloads, validates them on serialization, and the CLI client parses them back through the same
// schemas. Every exported `*Payload` type is derived from its schema via `z.infer`, so consumers
// (the dashboard, the CLI) keep importing the same type names.

export const tokensPayloadSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  total_tokens: z.number(),
});
export type TokensPayload = z.infer<typeof tokensPayloadSchema>;

export const usageTotalsPayloadSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  total_tokens: z.number(),
  seconds_running: z.number(),
});
export type UsageTotalsPayload = z.infer<typeof usageTotalsPayloadSchema>;

export const runningEntryPayloadSchema = z.object({
  issue_id: z.string(),
  issue_identifier: z.string(),
  issue_url: z.string().nullable(),
  state: z.string(),
  slot_index: z.number(),
  ensemble_size: z.number(),
  worker_host: z.string().nullable(),
  workspace_path: z.string().nullable(),
  session_id: z.string().nullable(),
  turn_count: z.number(),
  agent_kind: z.string(),
  executor_pid: z.string().nullable(),
  usage_totals: usageTotalsPayloadSchema,
  last_event: z.string().nullable(),
  last_message: z.string().nullable(),
  started_at: z.string(),
  last_event_at: z.string().nullable(),
  tokens: tokensPayloadSchema,
});
export type RunningEntryPayload = z.infer<typeof runningEntryPayloadSchema>;

export const retryEntryPayloadSchema = z.object({
  issue_id: z.string(),
  issue_identifier: z.string(),
  issue_url: z.string().nullable(),
  attempt: z.number(),
  due_at: z.string(),
  error: z.string().nullable(),
  worker_host: z.string().nullable(),
  workspace_path: z.string().nullable(),
});
export type RetryEntryPayload = z.infer<typeof retryEntryPayloadSchema>;

export const blockedEntryPayloadSchema = z.object({
  issue_id: z.string(),
  issue_identifier: z.string(),
  issue_url: z.string().nullable(),
  state: z.string(),
  reason: z.string(),
  label: z.string(),
  worker_host: z.string().nullable(),
});
export type BlockedEntryPayload = z.infer<typeof blockedEntryPayloadSchema>;

export const claimStorePayloadSchema = z.object({
  kind: z.string(),
  owner_id: z.string(),
  capabilities: z.object({
    crash_recovery: z.boolean(),
    shared_across_processes: z.boolean(),
    retry_durability: z.boolean(),
  }),
  hydrated_at: z.string(),
  transactions_applied: z.number(),
  last_operation: z.string().nullable(),
  last_checkpoint_at: z.string().nullable(),
});
export type ClaimStorePayload = z.infer<typeof claimStorePayloadSchema>;

export const daemonEndpointSchema = z.object({
  kind: z.enum(["http", "socket", "none"]),
  address: z.string(),
});

export const daemonPayloadSchema = z.object({
  owner_id: z.string(),
  pid: z.number(),
  hostname: z.string(),
  started_at: z.string(),
  workflow_path: z.string(),
  workspace_root: z.string(),
  lock_path: z.string(),
  endpoint: daemonEndpointSchema,
  heartbeat_at: z.string(),
  heartbeat_age_ms: z.number().nullable(),
  stale: z.boolean(),
  leadership_store_kind: z.string(),
});
export type DaemonPayload = z.infer<typeof daemonPayloadSchema>;

export const opsStatePayloadSchema = z.object({
  generated_at: z.string(),
  counts: z.object({
    running: z.number(),
    retrying: z.number(),
    blocked: z.number(),
  }),
  blocked_by_reason: z.record(z.string(), z.number()),
  running: z.array(runningEntryPayloadSchema),
  retrying: z.array(retryEntryPayloadSchema),
  blocked: z.array(blockedEntryPayloadSchema),
  usage_totals: usageTotalsPayloadSchema,
  rate_limits: z.unknown(),
  claim_store: claimStorePayloadSchema.nullable(),
  daemon: daemonPayloadSchema.nullable(),
});
export type OpsStatePayload = z.infer<typeof opsStatePayloadSchema>;

// --- Runs views ---

export const runPayloadSchema = z.object({
  id: z.string(),
  issue_id: z.string(),
  issue_identifier: z.string(),
  issue_title: z.string().nullable(),
  state: z.string().nullable(),
  slot_index: z.number(),
  ensemble_size: z.number(),
  agent_kind: z.string(),
  outcome: z.string(),
  retry_attempt: z.number(),
  worker_host: z.string().nullable(),
  workspace_path: z.string().nullable(),
  session_id: z.string().nullable(),
  executor_pid: z.string().nullable(),
  usage_totals: usageTotalsPayloadSchema,
  turn_count: z.number(),
  failure_reason: z.string().nullable(),
  last_event: z.string().nullable(),
  last_message: z.string().nullable(),
  last_event_at: z.string().nullable(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  duration_ms: z.number().nullable(),
  cost: z.object({ estimated_cost_usd: z.number().nullable() }),
  tokens: tokensPayloadSchema,
  log_hints: z.object({
    lorenz_log_file: z.string().nullable(),
    workspace_path: z.string().nullable(),
    session_id: z.string().nullable(),
    issue_identifier: z.string(),
  }),
});
export type RunPayload = z.infer<typeof runPayloadSchema>;

export const runsSummaryPayloadSchema = z.object({
  total: z.number(),
  running: z.number(),
  success: z.number(),
  failed: z.number(),
  stalled: z.number(),
  canceled: z.number(),
});

export const runsListPayloadSchema = z.object({
  generated_at: z.string(),
  view: z.literal("runs"),
  summary: runsSummaryPayloadSchema,
  runs: z.array(runPayloadSchema),
});

export const runDetailPayloadSchema = z.object({
  generated_at: z.string(),
  view: z.literal("run"),
  run: runPayloadSchema,
  related_runs: z.array(runPayloadSchema),
});

export const costSummaryPayloadSchema = z.object({
  generated_at: z.string(),
  view: z.literal("cost"),
  summary: z.object({
    totals: z.object({
      run_count: z.number(),
      total_tokens: z.number(),
      estimated_cost_usd: z.number().nullable(),
    }),
    by_agent: z.array(
      z.object({
        agent_kind: z.string(),
        run_count: z.number(),
        completed_count: z.number(),
        input_tokens: z.number(),
        output_tokens: z.number(),
        total_tokens: z.number(),
        average_total_tokens_per_run: z.number(),
        estimated_cost_usd: z.number().nullable(),
      }),
    ),
    top_runs: z.array(runPayloadSchema),
  }),
});

export const retriesPayloadSchema = z.object({
  generated_at: z.string(),
  view: z.literal("retries"),
  issues: z.array(
    z.object({
      issue_identifier: z.string(),
      issue_id: z.string().nullable(),
      issue_title: z.string().nullable(),
      attempts: z.number(),
      latest_outcome: z.string(),
      total_tokens: z.number(),
      latest_run_id: z.string().nullable(),
      latest_failure_reason: z.string().nullable(),
    }),
  ),
});

export const runsResultPayloadSchema = z.union([
  runsListPayloadSchema,
  runDetailPayloadSchema,
  costSummaryPayloadSchema,
  retriesPayloadSchema,
]);
export type RunsResultPayload = z.infer<typeof runsResultPayloadSchema>;

// --- Issue view ---

export const issuePayloadSchema = z.object({
  issue_identifier: z.string(),
  issue_id: z.string().nullable(),
  status: z.enum(["running", "retrying"]),
  workspace: z.object({
    path: z.string().nullable(),
    host: z.string().nullable(),
  }),
  attempts: z.object({
    restart_count: z.number(),
    current_retry_attempt: z.number(),
  }),
  running: z
    .object({
      slot_index: z.number(),
      ensemble_size: z.number(),
      retry_attempt: z.number(),
      worker_host: z.string().nullable(),
      workspace_path: z.string().nullable(),
      session_id: z.string().nullable(),
      turn_count: z.number(),
      agent_kind: z.string(),
      executor_pid: z.string().nullable(),
      usage_totals: usageTotalsPayloadSchema,
      state: z.string(),
      started_at: z.string(),
      last_event: z.string().nullable(),
      last_message: z.string().nullable(),
      last_event_at: z.string().nullable(),
      tokens: tokensPayloadSchema,
    })
    .nullable(),
  retry: z
    .object({
      attempt: z.number(),
      due_at: z.string(),
      error: z.string().nullable(),
      worker_host: z.string().nullable(),
      workspace_path: z.string().nullable(),
    })
    .nullable(),
  logs: z.object({ codex_session_logs: z.array(z.unknown()) }),
  recent_events: z.array(
    z.object({
      at: z.string(),
      event: z.string().nullable(),
      message: z.string().nullable(),
    }),
  ),
  last_error: z.string().nullable(),
  tracked: z.record(z.string(), z.unknown()),
});
export type IssuePayload = z.infer<typeof issuePayloadSchema>;
