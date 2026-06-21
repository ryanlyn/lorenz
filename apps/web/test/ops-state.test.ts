import { afterEach, expect, test, vi } from "vitest";
import { settle } from "@lorenz/test-utils";

import type { OpsState } from "../src/features/ops/api/types";
import type { WsMessage } from "../src/shared/hooks/useWebSocket";

interface RenderResult {
  hook: { state: OpsState | null; connected: boolean };
  stateUpdates: unknown[];
  cleanup: () => void;
}

afterEach(() => {
  vi.doUnmock("react");
  vi.doUnmock("../src/shared/hooks/useWebSocket");
  vi.resetModules();
  vi.unstubAllGlobals();
});

async function renderUseOpsState(ws: {
  status: "connecting" | "connected" | "disconnected";
  lastMessage: WsMessage | null;
}): Promise<RenderResult> {
  const cleanupEffects: Array<() => void> = [];
  const stateUpdates: unknown[] = [];
  let stateHookIndex = 0;

  vi.doMock("react", () => ({
    useCallback: (callback: () => void) => callback,
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect();
      if (cleanup) cleanupEffects.push(cleanup);
    },
    useRef: <T>(initial: T) => ({ current: initial }),
    useState: <T>(initial: T) => {
      const hookIndex = stateHookIndex;
      stateHookIndex += 1;
      const setter = vi.fn((value: T) => {
        if (hookIndex === 0) stateUpdates.push(value);
      });
      return [initial, setter] as const;
    },
  }));
  vi.doMock("../src/shared/hooks/useWebSocket", () => ({
    useWebSocket: () => ws,
  }));

  const { useOpsState } = await import("../src/features/ops/hooks/useOpsState");
  return {
    hook: useOpsState(),
    stateUpdates,
    cleanup: () => {
      for (const cleanup of cleanupEffects) cleanup();
    },
  };
}

test("useOpsState applies ops_state messages from the shared WebSocket", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
  const payload = opsStateFixture();

  const { hook, stateUpdates, cleanup } = await renderUseOpsState({
    status: "connected",
    lastMessage: { type: "ops_state", state: payload },
  });

  try {
    expect(hook.connected).toBe(true);
    expect(stateUpdates).toEqual([payload]);
  } finally {
    cleanup();
  }
});

test("useOpsState ignores trace messages and reports a disconnected stream", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

  const { hook, stateUpdates, cleanup } = await renderUseOpsState({
    status: "connecting",
    lastMessage: { type: "init", tickets: [] },
  });

  try {
    // Asserting an absence (a trace message must not seed ops state) after the
    // rejected fetch settles — flush one macrotask, then confirm nothing changed.
    await settle(0);
    expect(hook.connected).toBe(false);
    expect(stateUpdates).toEqual([]);
  } finally {
    cleanup();
  }
});

test("useOpsState seeds state from the initial REST fetch", async () => {
  const payload = opsStateFixture();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));

  const { stateUpdates, cleanup } = await renderUseOpsState({
    status: "disconnected",
    lastMessage: null,
  });

  try {
    await vi.waitFor(() => expect(stateUpdates).toEqual([payload]));
  } finally {
    cleanup();
  }
});

test("useOpsState initial fetch failure does not emit an unhandled rejection", async () => {
  const unhandledReasons: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledReasons.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

  const { stateUpdates, cleanup } = await renderUseOpsState({
    status: "disconnected",
    lastMessage: null,
  });

  try {
    // Asserting an absence (no unhandled rejection, no state seeded) after the
    // rejected fetch settles — flush one macrotask, then confirm nothing changed.
    await settle(0);
    expect(unhandledReasons).toEqual([]);
    expect(stateUpdates).toEqual([]);
  } finally {
    cleanup();
    process.off("unhandledRejection", onUnhandledRejection);
  }
});

function opsStateFixture(): OpsState {
  return {
    generated_at: "2026-05-05T00:00:00.000Z",
    counts: { running: 1, retrying: 0, blocked: 0 },
    blocked_by_reason: {},
    running: [
      {
        issue_id: "issue-1",
        issue_identifier: "MONO-314",
        issue_url: null,
        state: "In Progress",
        slot_index: 0,
        ensemble_size: 1,
        worker_host: "local",
        workspace_path: null,
        session_id: "thread-1",
        turn_count: 3,
        agent_kind: "codex",
        executor_pid: null,
        usage_totals: { input_tokens: 10, output_tokens: 5, total_tokens: 15, seconds_running: 2 },
        last_event: "agent_message_chunk",
        last_message: null,
        started_at: "2026-05-05T00:00:00.000Z",
        last_event_at: null,
        tokens: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    ],
    retrying: [],
    blocked: [],
    usage_totals: { input_tokens: 10, output_tokens: 5, total_tokens: 15, seconds_running: 2 },
    rate_limits: null,
  };
}
