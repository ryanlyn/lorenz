import { describe, it, expect, vi } from "vitest";
import { TraceWatcher } from "@symphony/traceviz-server";

describe("TraceWatcher broadcast callback", () => {
  it("invokes callback with issueId and full events array when lines change", async () => {
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
          type: "notification",
          issueId: "ws-id-1",
          issueIdentifier: "WS-1",
          timestamp: "2026-01-01T00:00:01Z",
          message: {
            method: "item/completed",
            params: { item: { type: "agentMessage", text: "Hi" } },
          },
        }),
      ].join("\n") + "\n",
    );

    const watcher = new TraceWatcher(dir, 50);
    const callback = vi.fn();

    watcher.start(callback);
    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    expect(callback).toHaveBeenCalledTimes(1);
    const [issueId, events] = callback.mock.calls[0]!;
    expect(issueId).toBe("ws-id-1");
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e: { kind: string }) => e.kind === "turn_started")).toBe(true);
    expect(events.some((e: { kind: string }) => e.kind === "message")).toBe(true);

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
    await new Promise((r) => setTimeout(r, 150));
    const initialCount = callback.mock.calls.length;

    // Wait without modifying
    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    expect(callback.mock.calls.length).toBe(initialCount);

    rmSync(dir, { recursive: true, force: true });
  });
});
