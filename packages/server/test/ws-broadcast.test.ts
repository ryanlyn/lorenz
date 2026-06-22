import { describe, it, expect, vi } from "vitest";
import { TraceWatcher } from "@lorenz/traceviz-server";
import { settle } from "@lorenz/test-utils";

describe("TraceWatcher broadcast callback", () => {
  it("invokes callback with issueId and compact ticket info when lines change", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = join(tmpdir(), `ws-test-${Date.now()}`);
    mkdirSync(join(dir, "WS-1"), { recursive: true });
    writeFileSync(
      join(dir, "WS-1", "trace.jsonl"),
      [
        JSON.stringify({
          type: "turn_started",
          issueId: "ws-id-1",
          issueIdentifier: "WS-1",
          timestamp: "2026-01-01T00:00:00Z",
        }),
        JSON.stringify({
          type: "session_notification",
          issueId: "ws-id-1",
          issueIdentifier: "WS-1",
          timestamp: "2026-01-01T00:00:01Z",
          message: {
            sessionId: "s1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } },
          },
        }),
      ].join("\n") + "\n",
    );

    const watcher = new TraceWatcher(dir, 50);
    const callback = vi.fn();

    watcher.start(callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    watcher.stop();

    expect(callback).toHaveBeenCalledTimes(1);
    const [issueId, ticket] = callback.mock.calls[0]!;
    expect(issueId).toBe("ws-id-1");
    expect(Array.isArray(ticket)).toBe(false);
    expect(ticket).toMatchObject({
      issueId: "ws-id-1",
      identifier: "WS-1",
      status: "running",
      turnCount: 1,
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it("does not callback when file has not changed", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = join(tmpdir(), `ws-test-nocb-${Date.now()}`);
    mkdirSync(join(dir, "WS-2"), { recursive: true });
    writeFileSync(
      join(dir, "WS-2", "trace.jsonl"),
      JSON.stringify({
        type: "turn_started",
        issueId: "ws-id-2",
        issueIdentifier: "WS-2",
        timestamp: "2026-01-01T00:00:00Z",
      }) + "\n",
    );

    const watcher = new TraceWatcher(dir, 50);
    const callback = vi.fn();

    watcher.start(callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalled());
    const initialCount = callback.mock.calls.length;

    // Wait without modifying the file. This asserts an absence (no further
    // callbacks), which cannot be polled for, so settle briefly across several
    // scan intervals and confirm the count held steady.
    await settle(150);
    watcher.stop();

    expect(callback.mock.calls.length).toBe(initialCount);

    rmSync(dir, { recursive: true, force: true });
  });
});
