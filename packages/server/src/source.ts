import type { Settings } from "@lorenz/domain";
import type { RuntimeSnapshot } from "@lorenz/runtime-events";

/** The live runtime surface the observability server and its WS push transport read from. */
export interface RuntimeServerSource {
  workflow?: { settings?: Settings } | undefined;
  snapshot(): RuntimeSnapshot;
  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void;
  requestRefresh(): Record<string, unknown>;
}
