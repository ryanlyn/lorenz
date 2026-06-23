import type { RuntimeDaemonStatus } from "@lorenz/runtime-events";
import { daemonPayload, type DaemonPayload } from "@lorenz/presenter";

import { daemonLockIsStale, type DaemonLockRecord } from "./daemonLock.js";

export type DaemonStatusPayload = DaemonPayload;

export function daemonStatusPayload(
  record: DaemonLockRecord,
  now = new Date(),
  staleAfterMs = 60_000,
  leadershipStoreKind = "local-file",
): DaemonStatusPayload {
  const payload = daemonPayload(
    runtimeDaemonStatus(record, now, staleAfterMs, leadershipStoreKind),
  );
  if (payload === null) throw new Error("daemon_status_payload_unavailable");
  return payload;
}

export function runtimeDaemonStatus(
  record: DaemonLockRecord,
  now = new Date(),
  staleAfterMs = 60_000,
  leadershipStoreKind = "local-file",
): RuntimeDaemonStatus {
  const heartbeatMs = Date.parse(record.heartbeatAt);
  const heartbeatAgeMs = Number.isFinite(heartbeatMs)
    ? Math.max(0, now.getTime() - heartbeatMs)
    : null;
  return {
    ownerId: record.ownerId,
    pid: record.pid,
    hostname: record.hostname,
    startedAt: record.startedAt,
    workflowPath: record.workflowPath,
    workspaceRoot: record.workspaceRoot,
    lockPath: record.lockPath,
    endpoint: { ...record.endpoint },
    heartbeatAt: record.heartbeatAt,
    heartbeatAgeMs,
    stale: daemonLockIsStale(record, now, staleAfterMs),
    leadershipStoreKind,
  };
}
