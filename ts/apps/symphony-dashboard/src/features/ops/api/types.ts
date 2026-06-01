export interface OpsRunningEntry {
  issue_id: string;
  issue_identifier: string;
  agent_kind: string;
  worker_host: string | null;
  turn_count: number;
  tokens: { input_tokens: number; output_tokens: number; total_tokens: number };
  session_id: string | null;
  last_event: string | null;
}

export interface OpsRetryEntry {
  issue_id: string;
  issue_identifier: string;
  attempt: number;
  due_at: string;
  worker_host: string | null;
  workspace_path: string | null;
  error: string | null;
}

export interface OpsBlockedEntry {
  issue_id: string;
  issue_identifier: string;
  reason: string;
  label: string;
  worker_host: string | null;
}

export interface OpsState {
  running: OpsRunningEntry[];
  retrying: OpsRetryEntry[];
  blocked: OpsBlockedEntry[];
  counts: { running: number; retrying: number; blocked: number };
  usage_totals: { input_tokens: number; output_tokens: number; total_tokens: number };
}
