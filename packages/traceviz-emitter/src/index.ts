import { mkdirSync, rmSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";

import type { AgentUpdate, TraceEvent } from "@lorenz/domain";

export class TraceEmitter {
  private readonly traceDir: string;
  private initialized = new Set<string>();
  /** Per-file write queues to avoid unbounded concurrent writes. */
  private writeQueues = new Map<string, Promise<void>>();
  private writeFailures: Error[] = [];

  constructor(traceDir: string) {
    this.traceDir = traceDir;
  }

  emit(issueId: string, issueIdentifier: string, update: AgentUpdate): void {
    const { dirPath, filePath } = this.issueTracePaths(issueId);
    const payload: TraceEvent = {
      type: update.type,
      issueId,
      issueIdentifier,
      timestamp: update.timestamp ? update.timestamp.toISOString() : null,
      message: update.message ?? null,
      usage: update.usage ?? null,
      workspacePath: update.workspacePath ?? null,
      sessionId: update.sessionId ?? null,
      executorPid: update.executorPid ?? null,
    } as TraceEvent;
    const line = JSON.stringify(payload);

    this.enqueue(
      filePath,
      async () => {
        if (!this.initialized.has(dirPath)) {
          mkdirSync(dirPath, { recursive: true });
          this.initialized.add(dirPath);
        }
        await appendFile(filePath, line + "\n");
      },
      `[TraceEmitter] Failed to write trace for issue ${issueIdentifier}:`,
    );
  }

  async drain(): Promise<void> {
    await Promise.all([...this.writeQueues.values()]);
    const failures = this.writeFailures.splice(0);
    if (failures.length === 1) {
      throw failures[0]!;
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Failed to write trace events");
    }
  }

  clear(issueId: string): void {
    const { dirPath, filePath } = this.issueTracePaths(issueId);
    const clearIssueDir = (): void => {
      rmSync(dirPath, { recursive: true, force: true });
      this.initialized.delete(dirPath);
    };

    if (!this.writeQueues.has(filePath)) {
      clearIssueDir();
      return;
    }

    this.enqueue(
      filePath,
      clearIssueDir,
      `[TraceEmitter] Failed to clear trace for issue ${issueId}:`,
    );
  }

  private enqueue(
    filePath: string,
    operation: () => void | Promise<void>,
    errorMessage: string,
  ): void {
    const prev = this.writeQueues.get(filePath) ?? Promise.resolve();
    const next = prev.then(operation).catch((err: unknown) => {
      const error = this.asError(err, errorMessage);
      this.writeFailures.push(error);
      console.error(error.message, err);
    });
    this.writeQueues.set(filePath, next);

    void next.finally(() => {
      if (this.writeQueues.get(filePath) === next) {
        this.writeQueues.delete(filePath);
      }
    });
  }

  private asError(err: unknown, message: string): Error {
    if (err instanceof Error) {
      return new Error(`${message} ${err.message}`, { cause: err });
    }
    return new Error(`${message} ${String(err)}`);
  }

  private issueTracePaths(issueId: string): { dirPath: string; filePath: string } {
    return TraceEmitter.resolveIssueTracePaths(this.traceDir, issueId);
  }

  private static issueDirPath(traceDir: string, issueId: string): string {
    const storageKey = encodeURIComponent(issueId);
    const resolved = path.resolve(traceDir, storageKey);
    const resolvedDir = path.resolve(traceDir);
    if (!resolved.startsWith(resolvedDir + path.sep)) {
      throw new Error(`Invalid issueId: path traversal detected`);
    }
    return resolved;
  }

  private static resolveIssueTracePaths(
    traceDir: string,
    issueId: string,
  ): { dirPath: string; filePath: string } {
    const dirPath = TraceEmitter.issueDirPath(traceDir, issueId);
    return { dirPath, filePath: path.join(dirPath, "trace.jsonl") };
  }

  static tracePathForIssue(traceDir: string, issueId: string): string {
    return TraceEmitter.resolveIssueTracePaths(traceDir, issueId).filePath;
  }
}
