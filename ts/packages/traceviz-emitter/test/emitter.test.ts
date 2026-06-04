import path from "node:path";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

    const filePath = path.join(traceDir, "ENG-1", "trace.jsonl");
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

    const filePath = path.join(traceDir, "ENG-1", "trace.jsonl");
    const content = readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed).not.toHaveProperty("issueTitle");
    expect(parsed).not.toHaveProperty("issueUrl");
  });

  it("appends multiple events to the same file", async () => {
    emitter.emit("id-1", "ENG-1", makeUpdate({ type: "turn_started" }));
    emitter.emit("id-1", "ENG-1", makeUpdate({ type: "turn_completed" }));
    await emitter.drain();

    const filePath = path.join(traceDir, "ENG-1", "trace.jsonl");
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).type).toBe("turn_started");
    expect(JSON.parse(lines[1]!).type).toBe("turn_completed");
  });

  it("sanitizes issue identifiers for directory names", async () => {
    emitter.emit("id-1", "ENG/1..2", makeUpdate());
    await emitter.drain();

    const sanitizedDir = path.join(traceDir, "ENG_1__2");
    expect(existsSync(sanitizedDir)).toBe(true);
  });

  it("clear removes issue directory", async () => {
    emitter.emit("id-1", "ENG-1", makeUpdate());
    await emitter.drain();

    const issueDir = path.join(traceDir, "ENG-1");
    expect(existsSync(issueDir)).toBe(true);

    emitter.clear("ENG-1");
    expect(existsSync(issueDir)).toBe(false);
  });
});
