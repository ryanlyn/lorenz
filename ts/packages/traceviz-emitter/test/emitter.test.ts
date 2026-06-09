import path from "node:path";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AgentUpdate } from "@symphony/domain";

import { TraceEmitter } from "../src/index.js";

function makeTempDir(): string {
  const dir = path.join(
    tmpdir(),
    `emitter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeUpdate(overrides: Partial<AgentUpdate> = {}): AgentUpdate {
  return {
    type: "turn_started",
    timestamp: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as AgentUpdate;
}

describe("TraceEmitter", () => {
  let traceDir: string;
  let emitter: TraceEmitter;

  beforeEach(() => {
    traceDir = makeTempDir();
    emitter = new TraceEmitter(traceDir);
  });

  afterEach(() => {
    rmSync(traceDir, { recursive: true, force: true });
  });

  it("writes a trace line to the correct directory", async () => {
    emitter.emit("id-1", "ENG-1", makeUpdate());
    await emitter.drain();

    const filePath = TraceEmitter.tracePathForIssue(traceDir, "id-1");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.issueId).toBe("id-1");
    expect(parsed.issueIdentifier).toBe("ENG-1");
    expect(parsed.type).toBe("turn_started");
    expect(parsed.timestamp).toBe("2026-01-01T00:00:00.000Z");
  });

  it("does not write issueTitle or issueUrl fields", async () => {
    emitter.emit("id-1", "ENG-1", makeUpdate());
    await emitter.drain();

    const filePath = TraceEmitter.tracePathForIssue(traceDir, "id-1");
    const content = readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed).not.toHaveProperty("issueTitle");
    expect(parsed).not.toHaveProperty("issueUrl");
  });

  it("appends multiple events to the same file", async () => {
    emitter.emit("id-1", "ENG-1", makeUpdate({ type: "turn_started" }));
    emitter.emit("id-1", "ENG-1", makeUpdate({ type: "turn_completed" }));
    await emitter.drain();

    const filePath = TraceEmitter.tracePathForIssue(traceDir, "id-1");
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).type).toBe("turn_started");
    expect(JSON.parse(lines[1]!).type).toBe("turn_completed");
  });

  it("encodes issue ids for directory names", async () => {
    emitter.emit("id/1", "ENG/1..2", makeUpdate());
    await emitter.drain();

    const filePath = TraceEmitter.tracePathForIssue(traceDir, "id/1");
    expect(filePath).toBe(path.join(traceDir, "id%2F1", "trace.jsonl"));
    expect(existsSync(filePath)).toBe(true);
  });

  it("keeps colliding issue identifiers in separate trace files", async () => {
    emitter.emit("uuid-a", "ENG/1", makeUpdate({ type: "turn_started" }));
    emitter.emit("uuid-b", "ENG_1", makeUpdate({ type: "turn_completed" }));
    await emitter.drain();

    const oldCollisionPath = path.join(traceDir, "ENG_1", "trace.jsonl");
    expect(existsSync(oldCollisionPath)).toBe(false);

    const slashTracePath = TraceEmitter.tracePathForIssue(traceDir, "uuid-a");
    const underscoreTracePath = TraceEmitter.tracePathForIssue(traceDir, "uuid-b");
    expect(slashTracePath).not.toBe(underscoreTracePath);

    const slashLines = readFileSync(slashTracePath, "utf-8").trim().split("\n");
    const underscoreLines = readFileSync(underscoreTracePath, "utf-8").trim().split("\n");

    expect(slashLines).toHaveLength(1);
    expect(JSON.parse(slashLines[0]!).issueId).toBe("uuid-a");
    expect(JSON.parse(slashLines[0]!).issueIdentifier).toBe("ENG/1");
    expect(underscoreLines).toHaveLength(1);
    expect(JSON.parse(underscoreLines[0]!).issueId).toBe("uuid-b");
    expect(JSON.parse(underscoreLines[0]!).issueIdentifier).toBe("ENG_1");

    emitter.clear("uuid-a");
    expect(existsSync(slashTracePath)).toBe(false);
    expect(existsSync(underscoreTracePath)).toBe(true);
  });

  it("clear removes issue directory", async () => {
    emitter.emit("id-1", "ENG-1", makeUpdate());
    await emitter.drain();

    const issueDir = path.dirname(TraceEmitter.tracePathForIssue(traceDir, "id-1"));
    expect(existsSync(issueDir)).toBe(true);

    emitter.clear("id-1");
    expect(existsSync(issueDir)).toBe(false);
  });

  it("does not keep queued events from before clear", async () => {
    emitter.emit("id-1", "ENG-1", makeUpdate({ type: "turn_started" }));
    emitter.clear("id-1");
    emitter.emit("id-1", "ENG-1", makeUpdate({ type: "turn_completed" }));
    await emitter.drain();

    const filePath = TraceEmitter.tracePathForIssue(traceDir, "id-1");
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).type).toBe("turn_completed");
  });

  it("rejects drain when queued writes fail", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      emitter.emit("id-1", "ENG-1", makeUpdate());
      const filePath = TraceEmitter.tracePathForIssue(traceDir, "id-1");
      mkdirSync(path.dirname(filePath), { recursive: true });
      mkdirSync(filePath, { recursive: true });

      await expect(emitter.drain()).rejects.toThrow(/Failed to write trace/);
    } finally {
      consoleError.mockRestore();
    }
  });
});
