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

import { readFileSync, realpathSync } from "node:fs";
import { access, lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { DisplayEvent } from "./models/display-events.js";
import type { TicketInfo } from "./models/api.js";
import { parseTraceLines, extractTicketMetadata } from "./parser.js";

const DEFAULT_POLL_INTERVAL_MS = 500;

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

interface FileState {
  issueId: string;
  issueIdentifier: string;
  lineCount: number;
  lastModified: number;
  filePath: string;
  cachedTicketInfo: TicketInfo;
}

export type WatcherCallback = (issueId: string, events: DisplayEvent[]) => void;

function computeTicketInfo(state: {
  issueId: string;
  issueIdentifier: string;
  events: DisplayEvent[];
}): TicketInfo {
  let turnStartedCount = 0;
  let turnCompletedCount = 0;
  let hasFailed = false;
  let startedAt: string | undefined;

  for (const e of state.events) {
    if (e.kind === "turn_started") {
      turnStartedCount++;
      if (startedAt === undefined) startedAt = e.timestamp;
    } else if (e.kind === "turn_completed") {
      turnCompletedCount++;
    } else if (e.kind === "turn_failed") {
      hasFailed = true;
    }
  }

  if (startedAt === undefined && state.events.length > 0) {
    startedAt = state.events[0]!.timestamp;
  }

  let status: TicketInfo["status"] = "idle";
  if (hasFailed) {
    status = "failed";
  } else if (turnStartedCount > 0 && turnCompletedCount >= turnStartedCount) {
    status = "completed";
  } else if (turnStartedCount > 0) {
    status = "running";
  }

  return {
    issueId: state.issueId,
    identifier: state.issueIdentifier,
    turnCount: turnStartedCount,
    status,
    startedAt,
  };
}

export class TraceWatcher {
  private readonly traceDir: string;
  private readonly pollIntervalMs: number;
  private fileStates = new Map<string, FileState>();
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
    const state = this.fileStates.get(issueId);
    if (!state) return [];
    return this.readAndParseSync(state.filePath);
  }

  private readAndParseSync(filePath: string): DisplayEvent[] {
    try {
      const realTraceDir = realpathSync(this.traceDir);
      const realFilePath = realpathSync(filePath);
      if (!isWithinRoot(realFilePath, realTraceDir)) return [];

      const content = readFileSync(realFilePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
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
          const existing = this.fileStates.get(entry);

          if (existing && fileStat.mtimeMs <= existing.lastModified) {
            continue;
          }

          const result = await this.readFile(realFilePath, entry, fileStat.mtimeMs);
          if (result) {
            const canonicalKey = result.state.issueId;
            const existingByKey = this.fileStates.get(canonicalKey);
            if (result.state.lineCount !== (existingByKey?.lineCount ?? 0)) {
              this.fileStates.set(canonicalKey, result.state);
              callback(canonicalKey, result.events);
            } else {
              this.fileStates.set(canonicalKey, result.state);
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

  private async readFile(
    filePath: string,
    issueId: string,
    mtimeMs?: number,
  ): Promise<{ state: FileState; events: DisplayEvent[] } | null> {
    try {
      const realTraceDir = await realpath(this.traceDir);
      const realFilePath = await realpath(filePath);
      if (!isWithinRoot(realFilePath, realTraceDir)) return null;

      const content = await readFile(realFilePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      const lastModified = mtimeMs ?? (await stat(realFilePath)).mtimeMs;
      const events = parseTraceLines(lines);
      const metadata = extractTicketMetadata(lines);
      const resolvedIssueId = metadata?.issueId ?? issueId;
      const resolvedIdentifier = metadata?.issueIdentifier ?? issueId;

      const state: FileState = {
        issueId: resolvedIssueId,
        issueIdentifier: resolvedIdentifier,
        lineCount: lines.length,
        lastModified,
        filePath: realFilePath,
        cachedTicketInfo: computeTicketInfo({
          issueId: resolvedIssueId,
          issueIdentifier: resolvedIdentifier,
          events,
        }),
      };

      return { state, events };
    } catch {
      return null;
    }
  }
}
