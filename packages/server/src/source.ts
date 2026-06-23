import type { Settings } from "@lorenz/domain";
import type { RuntimeDaemonStatus, RuntimeSnapshot } from "@lorenz/runtime-events";

/** The live runtime surface the observability server and its WS push transport read from. */
export interface RuntimeServerSource {
  workflow?: { settings?: Settings } | undefined;
  snapshot(): RuntimeSnapshot;
  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void;
  requestRefresh(): Record<string, unknown>;
  requestStop?(): Record<string, unknown>;
  daemonStatus?(): RuntimeDaemonStatus | null;
}

export function snapshotWithDaemonStatus(
  runtime: RuntimeServerSource,
  snapshot: RuntimeSnapshot,
): RuntimeSnapshot {
  const daemon = runtime.daemonStatus?.() ?? snapshot.daemon;
  if (daemon === snapshot.daemon) return snapshot;
  return { ...snapshot, daemon: daemon ?? undefined };
}
