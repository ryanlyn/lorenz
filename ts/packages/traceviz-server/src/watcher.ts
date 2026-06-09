/**
 * TraceWatcher: polls a trace directory for per-ticket subdirectories, each
 * containing a `trace.jsonl` file with one JSON line per AgentUpdate event
 * emitted by the TraceEmitter.
 *
 * Directory layout:
 *   traceDir/
 *     CAN-123/
 *       trace.jsonl
 *     CAN-456/
 *       trace.jsonl
 */

import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { DisplayEvent } from "./models/display-events.js";
import type { TicketInfo } from "./models/api.js";
import { parseTraceLines } from "./parser.js";

const DEFAULT_POLL_INTERVAL_MS = 500;
const READ_CHUNK_SIZE = 64 * 1024;

interface FileState {
  issueId: string;
  issueIdentifier: string;
  lineCount: number;
  lastModified: number;
  fileSize: number;
  filePath: string;
  cachedTicketInfo: TicketInfo;
  turnStartedCount: number;
  turnCompletedCount: number;
  hasFailed: boolean;
  startedAt: string | undefined;
}

interface TraceSummary {
  issueId: string;
  issueIdentifier: string;
  lineCount: number;
  turnStartedCount: number;
  turnCompletedCount: number;
  hasFailed: boolean;
  startedAt: string | undefined;
}

export type WatcherCallback = (issueId: string, ticket: TicketInfo) => void;

function createInitialSummary(issueId: string): TraceSummary {
  return {
    issueId,
    issueIdentifier: issueId,
    lineCount: 0,
    turnStartedCount: 0,
    turnCompletedCount: 0,
    hasFailed: false,
    startedAt: undefined,
  };
}

function summaryFromState(state: FileState): TraceSummary {
  return {
    issueId: state.issueId,
    issueIdentifier: state.issueIdentifier,
    lineCount: state.lineCount,
    turnStartedCount: state.turnStartedCount,
    turnCompletedCount: state.turnCompletedCount,
    hasFailed: state.hasFailed,
    startedAt: state.startedAt,
  };
}

function updateSummaryFromLine(summary: TraceSummary, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  summary.lineCount++;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const record = parsed as Record<string, unknown>;

    if (typeof record.issueId === "string" && record.issueId.length > 0) {
      summary.issueId = record.issueId;
    }
    if (typeof record.issueIdentifier === "string" && record.issueIdentifier.length > 0) {
      summary.issueIdentifier = record.issueIdentifier;
    }

    const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;
    if (record.type === "turn_started") {
      summary.turnStartedCount++;
      if (summary.startedAt === undefined) summary.startedAt = timestamp;
    } else if (record.type === "turn_completed") {
      summary.turnCompletedCount++;
    } else if (record.type === "turn_failed") {
      summary.hasFailed = true;
    }
  } catch {
    // Ignore malformed trace lines while still counting the observed line.
  }
}

function computeTicketInfo(state: TraceSummary): TicketInfo {
  let status: TicketInfo["status"] = "idle";
  if (state.hasFailed) {
    status = "failed";
  } else if (state.turnStartedCount > 0 && state.turnCompletedCount >= state.turnStartedCount) {
    status = "completed";
  } else if (state.turnStartedCount > 0) {
    status = "running";
  }

  return {
    issueId: state.issueId,
    identifier: state.issueIdentifier,
    turnCount: state.turnStartedCount,
    status,
    startedAt: state.startedAt,
  };
}

export class TraceWatcher {
  private readonly traceDir: string;
  private readonly pollIntervalMs: number;
  private fileStates = new Map<string, FileState>();
  private fileStateIssueIdsByPath = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private scanning = false;

  constructor(traceDir: string, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
    this.traceDir = traceDir;
    this.pollIntervalMs = pollIntervalMs;
  }

  start(callback: WatcherCallback): void {
    this.stopped = false;
    void this.scan(callback);
    this.timer = setInterval(() => {
      void this.scan(callback);
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getTickets(): TicketInfo[] {
    return Array.from(this.fileStates.values(), (s) => s.cachedTicketInfo);
  }

  getTicketInfo(issueId: string): TicketInfo | undefined {
    return this.fileStates.get(issueId)?.cachedTicketInfo;
  }

  hasTicket(issueId: string): boolean {
    return this.fileStates.has(issueId);
  }

  getEventsForTicket(issueId: string): DisplayEvent[] {
    const state = this.fileStates.get(issueId);
    if (!state) return [];
    return this.readAndParseSync(state.filePath);
  }

  private readAndParseSync(filePath: string): DisplayEvent[] {
    try {
      const lines = this.readLinesSync(filePath);
      return parseTraceLines(lines);
    } catch {
      return [];
    }
  }

  private async scan(callback: WatcherCallback): Promise<void> {
    if (this.stopped) return;
    if (this.scanning) return;
    try {
      await access(this.traceDir);
    } catch {
      return;
    }

    this.scanning = true;
    try {
      let entries: string[];
      try {
        entries = await readdir(this.traceDir);
      } catch {
        return;
      }

      const resolvedDir = path.resolve(this.traceDir);

      for (const entry of entries) {
        const dirPath = path.join(this.traceDir, entry);

        const resolvedDirPath = path.resolve(dirPath);
        if (!resolvedDirPath.startsWith(resolvedDir + path.sep)) continue;

        const filePath = path.join(dirPath, "trace.jsonl");

        try {
          const dirStat = await stat(dirPath);
          if (!dirStat.isDirectory()) continue;

          const fileStat = await stat(filePath);
          const existing = this.getFileStateByPath(filePath);

          if (
            existing &&
            fileStat.mtimeMs <= existing.lastModified &&
            fileStat.size === existing.fileSize
          ) {
            continue;
          }

          const result = await this.readFile(filePath, entry, {
            mtimeMs: fileStat.mtimeMs,
            size: fileStat.size,
            existing,
          });
          if (result) {
            const previousLineCount = existing?.lineCount ?? 0;
            this.setFileState(result.state);
            if (result.state.lineCount !== previousLineCount) {
              callback(result.state.issueId, result.state.cachedTicketInfo);
            }
          }
        } catch {
          // Skip entries we cannot read
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  private getFileStateByPath(filePath: string): FileState | undefined {
    const issueId = this.fileStateIssueIdsByPath.get(filePath);
    return issueId ? this.fileStates.get(issueId) : undefined;
  }

  private setFileState(state: FileState): void {
    const previousIssueId = this.fileStateIssueIdsByPath.get(state.filePath);
    if (previousIssueId && previousIssueId !== state.issueId) {
      this.fileStates.delete(previousIssueId);
    }
    this.fileStates.set(state.issueId, state);
    this.fileStateIssueIdsByPath.set(state.filePath, state.issueId);
  }

  private async readFile(
    filePath: string,
    issueId: string,
    fileStat: { mtimeMs: number; size: number; existing?: FileState | undefined },
  ): Promise<{ state: FileState } | null> {
    try {
      const { existing } = fileStat;
      const canReadAppend = existing && fileStat.size > existing.fileSize;
      const summary =
        canReadAppend && existing ? summaryFromState(existing) : createInitialSummary(issueId);
      const start = canReadAppend && existing ? existing.fileSize : 0;

      await this.readLines(filePath, start, fileStat.size, (line) => {
        updateSummaryFromLine(summary, line);
      });

      const state: FileState = {
        issueId: summary.issueId,
        issueIdentifier: summary.issueIdentifier,
        lineCount: summary.lineCount,
        lastModified: fileStat.mtimeMs,
        fileSize: fileStat.size,
        filePath,
        cachedTicketInfo: computeTicketInfo(summary),
        turnStartedCount: summary.turnStartedCount,
        turnCompletedCount: summary.turnCompletedCount,
        hasFailed: summary.hasFailed,
        startedAt: summary.startedAt,
      };

      return { state };
    } catch {
      return null;
    }
  }

  private async readLines(
    filePath: string,
    start: number,
    endExclusive: number,
    onLine: (line: string) => void,
  ): Promise<void> {
    if (endExclusive <= start) return;

    let pending = "";
    const stream = createReadStream(filePath, {
      encoding: "utf8",
      start,
      end: endExclusive - 1,
      highWaterMark: READ_CHUNK_SIZE,
    });

    for await (const chunk of stream) {
      pending += chunk;
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
        onLine(line);
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf("\n");
      }
    }

    if (pending.trim().length > 0) {
      onLine(pending.replace(/\r$/, ""));
    }
  }

  private readLinesSync(filePath: string): string[] {
    const fd = openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_SIZE);
    const lines: string[] = [];
    let pending = "";

    try {
      for (;;) {
        const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;

        pending += buffer.toString("utf8", 0, bytesRead);
        let newlineIndex = pending.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
          if (line.trim().length > 0) lines.push(line);
          pending = pending.slice(newlineIndex + 1);
          newlineIndex = pending.indexOf("\n");
        }
      }

      if (pending.trim().length > 0) {
        lines.push(pending.replace(/\r$/, ""));
      }
    } finally {
      closeSync(fd);
    }

    return lines;
  }
}
