import type { OpsState } from "./types";

export async function fetchOpsState(): Promise<OpsState | null> {
  const res = await fetch("/api/v1/state");
  if (!res.ok) return null;
  return res.json() as Promise<OpsState>;
}
