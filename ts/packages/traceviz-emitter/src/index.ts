import { mkdirSync, unlinkSync, existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";

import type { AgentUpdate } from "@symphony/domain";

export class TraceEmitter {
  private readonly traceDir: string;
  private initialized = false;
  /** Per-file write queues to avoid unbounded concurrent writes. */
  private writeQueues = new Map<string, Promise<void>>();

  constructor(traceDir: string) {
    this.traceDir = traceDir;
  }

  emit(issueId: string, issueIdentifier: string, update: AgentUpdate): void {
    if (!this.initialized) {
      mkdirSync(this.traceDir, { recursive: true });
      this.initialized = true;
    }
    const line = JSON.stringify({
      type: update.type,
      issueId,
      issueIdentifier,
      timestamp: update.timestamp ? update.timestamp.toISOString() : null,
      message: update.message ?? null,
      usage: update.usage ?? null,
      workspacePath: update.workspacePath ?? null,
      sessionId: update.sessionId ?? null,
      executorPid: update.executorPid ?? null,
    });
    const filePath = TraceEmitter.tracePathForIssue(this.traceDir, issueId);

    // Chain writes per file to provide backpressure and avoid concurrent file handle exhaustion
    const prev = this.writeQueues.get(filePath) ?? Promise.resolve();
    const next = prev.then(async () =>
      appendFile(filePath, line + "\n").catch((err: unknown) => {
        console.error(`[TraceEmitter] Failed to write trace for issue ${issueId}:`, err);
      }),
    );
    this.writeQueues.set(filePath, next);
  }

  clear(issueId: string): void {
    const filePath = TraceEmitter.tracePathForIssue(this.traceDir, issueId);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }

  static tracePathForIssue(traceDir: string, issueId: string): string {
    const resolved = path.resolve(traceDir, issueId + ".jsonl");
    const resolvedDir = path.resolve(traceDir);
    if (!resolved.startsWith(resolvedDir + path.sep)) {
      throw new Error(`Invalid issueId: path traversal detected`);
    }
    return resolved;
  }
}
