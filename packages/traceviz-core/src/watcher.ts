/**
 * TraceWatcher: polls a trace directory for per-ticket subdirectories, each
 * containing a `trace.jsonl` file with one JSON line per AgentUpdate event
 * emitted by the TraceEmitter.
 *
 * Directory layout:
 *   traceDir/
 *     <issue storage key>/
 *       trace.jsonl
 *     <issue storage key>/
 *       trace.jsonl
 */

import { closeSync, createReadStream, openSync, readSync, realpathSync } from "node:fs";
import { access, lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { DisplayEvent } from "./models/display-events.js";
import type { TicketInfo } from "./models/api.js";
import { parseTraceLines } from "./parser.js";

const DEFAULT_POLL_INTERVAL_MS = 500;
const READ_CHUNK_SIZE = 64 * 1024;

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

interface EventCache {
  events: DisplayEvent[];
  subscribers: number;
}

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
    if (summary.startedAt === undefined && timestamp !== undefined) {
      summary.startedAt = timestamp;
    }

    if (record.type === "turn_started") {
      summary.turnStartedCount++;
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
  private fileStatesByPath = new Map<string, FileState>();
  private eventCaches = new Map<string, EventCache>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private scanning = false;

  constructor(traceDir: string, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
    this.traceDir = traceDir;
    this.pollIntervalMs = pollIntervalMs;
  }

  start(callback: WatcherCallback): void {
    if (this.timer !== null) return;
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
    const cached = this.eventCaches.get(issueId);
    if (cached) return cached.events;

    const state = this.fileStates.get(issueId);
    if (!state) return [];
    return this.readAndParseSync(state.filePath);
  }

  /**
   * Register a subscriber for this ticket's event cache.
   *
   * While subscribers > 0 the parsed events stay in memory, so reads never
   * touch disk. Each change detected by the scan loop still replaces the
   * cache with a full re-read and re-parse of the trace file: streamed
   * chunks merge into earlier events, so the parse cannot be incremental.
   */
  subscribe(issueId: string): void {
    const existing = this.eventCaches.get(issueId);
    if (existing) {
      existing.subscribers++;
      return;
    }
    const state = this.fileStates.get(issueId);
    const events = state ? this.readAndParseSync(state.filePath) : [];
    this.eventCaches.set(issueId, { events, subscribers: 1 });
  }

  /**
   * Unregister a subscriber. When no subscribers remain the cache is freed.
   */
  unsubscribe(issueId: string): void {
    const cached = this.eventCaches.get(issueId);
    if (!cached) return;
    cached.subscribers--;
    if (cached.subscribers <= 0) {
      this.eventCaches.delete(issueId);
    }
  }

  /** Refresh the event cache for a subscribed ticket (called after scan detects changes). */
  refreshCache(issueId: string): void {
    const cached = this.eventCaches.get(issueId);
    if (!cached) return;
    const state = this.fileStates.get(issueId);
    if (!state) return;
    cached.events = this.readAndParseSync(state.filePath);
  }

  private readAndParseSync(filePath: string): DisplayEvent[] {
    try {
      const realTraceDir = realpathSync(this.traceDir);
      const realFilePath = realpathSync(filePath);
      if (!isWithinRoot(realFilePath, realTraceDir)) return [];

      const lines = this.readLinesSync(realFilePath);
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
      let realTraceDir: string;
      try {
        realTraceDir = await realpath(this.traceDir);
      } catch {
        return;
      }

      for (const entry of entries) {
        const dirPath = path.join(this.traceDir, entry);

        const resolvedDirPath = path.resolve(dirPath);
        if (!resolvedDirPath.startsWith(resolvedDir + path.sep)) continue;

        try {
          const dirStat = await lstat(dirPath);
          if (dirStat.isSymbolicLink()) continue;
          if (!dirStat.isDirectory()) continue;

          const realDirPath = await realpath(dirPath);
          if (!isWithinRoot(realDirPath, realTraceDir)) continue;

          const filePath = path.join(dirPath, "trace.jsonl");
          const realFilePath = await realpath(filePath);
          if (!isWithinRoot(realFilePath, realTraceDir)) continue;

          const fileStat = await stat(realFilePath);
          const existing = this.fileStatesByPath.get(realFilePath);

          if (
            existing &&
            fileStat.mtimeMs <= existing.lastModified &&
            fileStat.size === existing.fileSize
          ) {
            continue;
          }

          const result = await this.readFile(realFilePath, entry, {
            mtimeMs: fileStat.mtimeMs,
            size: fileStat.size,
            existing,
          });
          if (result) {
            const previousLineCount = existing?.lineCount ?? 0;
            this.setFileState(realFilePath, result.state);
            if (result.state.lineCount !== previousLineCount) {
              this.refreshCache(result.state.issueId);
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

  private setFileState(filePath: string, state: FileState): void {
    const previous = this.fileStatesByPath.get(filePath);
    if (previous && previous.issueId !== state.issueId) {
      this.fileStates.delete(previous.issueId);
    }
    this.fileStates.set(state.issueId, state);
    this.fileStatesByPath.set(filePath, state);
  }

  private async readFile(
    filePath: string,
    issueId: string,
    fileStat: { mtimeMs: number; size: number; existing?: FileState | undefined },
  ): Promise<{ state: FileState } | null> {
    try {
      const realTraceDir = await realpath(this.traceDir);
      const realFilePath = await realpath(filePath);
      if (!isWithinRoot(realFilePath, realTraceDir)) return null;

      const { existing } = fileStat;
      const canReadAppend = existing && fileStat.size > existing.fileSize;
      const summary =
        canReadAppend && existing ? summaryFromState(existing) : createInitialSummary(issueId);
      const start = canReadAppend && existing ? existing.fileSize : 0;

      await this.readLines(realFilePath, start, fileStat.size, (line) => {
        updateSummaryFromLine(summary, line);
      });

      const state: FileState = {
        issueId: summary.issueId,
        issueIdentifier: summary.issueIdentifier,
        lineCount: summary.lineCount,
        lastModified: fileStat.mtimeMs,
        fileSize: fileStat.size,
        filePath: realFilePath,
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
