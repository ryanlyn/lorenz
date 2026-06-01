import { mkdirSync, existsSync, rmSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";

import type { AgentUpdate } from "@symphony/domain";

/**
 * Notification methods that carry meaningful trace information.
 * Everything else (streaming deltas, config warnings, rate limits, etc.) is dropped.
 * Mirrors the filtering in thib-coding-agent's CodexEventMerger which only keeps
 * item.completed and turn.completed.
 */
const NOTIFICATION_METHOD_ALLOWLIST = new Set(["item/completed", "turn/started", "turn/completed"]);

function shouldEmit(update: AgentUpdate): boolean {
  if (update.type !== "notification") return true;
  const msg = update.message;
  if (typeof msg !== "object" || msg === null) return false;
  const method = (msg as Record<string, unknown>).method;
  if (typeof method !== "string") return false;
  return NOTIFICATION_METHOD_ALLOWLIST.has(method);
}

export class TraceEmitter {
  private readonly traceDir: string;
  private initialized = new Set<string>();
  /** Per-file write queues to avoid unbounded concurrent writes. */
  private writeQueues = new Map<string, Promise<void>>();

  constructor(traceDir: string) {
    this.traceDir = traceDir;
  }

  emit(issueId: string, issueIdentifier: string, update: AgentUpdate): void {
    if (!shouldEmit(update)) return;

    const dirPath = this.issueDirPath(issueIdentifier);
    if (!this.initialized.has(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
      this.initialized.add(dirPath);
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
    const filePath = path.join(dirPath, "trace.jsonl");

    const prev = this.writeQueues.get(filePath) ?? Promise.resolve();
    const next = prev.then(async () =>
      appendFile(filePath, line + "\n").catch((err: unknown) => {
        console.error(`[TraceEmitter] Failed to write trace for issue ${issueIdentifier}:`, err);
      }),
    );
    this.writeQueues.set(filePath, next);
  }

  async drain(): Promise<void> {
    await Promise.all([...this.writeQueues.values()]);
  }

  clear(issueIdentifier: string): void {
    const dirPath = this.issueDirPath(issueIdentifier);
    if (existsSync(dirPath)) {
      rmSync(dirPath, { recursive: true });
      this.initialized.delete(dirPath);
    }
  }

  private issueDirPath(issueIdentifier: string): string {
    const sanitized = issueIdentifier.replace(/[^a-zA-Z0-9_-]/g, "_");
    const resolved = path.resolve(this.traceDir, sanitized);
    const resolvedDir = path.resolve(this.traceDir);
    if (!resolved.startsWith(resolvedDir + path.sep)) {
      throw new Error(`Invalid issueIdentifier: path traversal detected`);
    }
    return resolved;
  }

  static tracePathForIssue(traceDir: string, issueIdentifier: string): string {
    const sanitized = issueIdentifier.replace(/[^a-zA-Z0-9_-]/g, "_");
    const resolved = path.resolve(traceDir, sanitized, "trace.jsonl");
    const resolvedDir = path.resolve(traceDir);
    if (!resolved.startsWith(resolvedDir + path.sep)) {
      throw new Error(`Invalid issueIdentifier: path traversal detected`);
    }
    return resolved;
  }
}
