import { daemonLockIsStale, type DaemonEndpoint, type DaemonLockRecord } from "./daemonLock.js";

export interface DaemonStatusPayload {
  owner_id: string;
  pid: number;
  hostname: string;
  started_at: string;
  workflow_path: string;
  workspace_root: string;
  lock_path: string;
  endpoint: DaemonEndpoint;
  heartbeat_at: string;
  heartbeat_age_ms: number | null;
  stale: boolean;
}

export function daemonStatusPayload(
  record: DaemonLockRecord,
  now = new Date(),
  staleAfterMs = 60_000,
): DaemonStatusPayload {
  const heartbeatMs = Date.parse(record.heartbeatAt);
  const heartbeatAgeMs = Number.isFinite(heartbeatMs)
    ? Math.max(0, now.getTime() - heartbeatMs)
    : null;
  return {
    owner_id: record.ownerId,
    pid: record.pid,
    hostname: record.hostname,
    started_at: record.startedAt,
    workflow_path: record.workflowPath,
    workspace_root: record.workspaceRoot,
    lock_path: record.lockPath,
    endpoint: { ...record.endpoint },
    heartbeat_at: record.heartbeatAt,
    heartbeat_age_ms: heartbeatAgeMs,
    stale: daemonLockIsStale(record, now, staleAfterMs),
  };
}
