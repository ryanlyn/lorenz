import type { OpsState } from "./types";

export async function fetchOpsState(): Promise<OpsState | null> {
  try {
    const res = await fetch("/api/v1/state");
    if (!res.ok) return null;
    return (await res.json()) as OpsState;
  } catch {
    return null;
  }
}
