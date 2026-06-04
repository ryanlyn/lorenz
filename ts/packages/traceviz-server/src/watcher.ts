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

import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { DisplayEvent } from "./models/display-events.js";
import type { TicketInfo } from "./models/api.js";
import { parseTraceLines, extractTicketMetadata } from "./parser.js";

const DEFAULT_POLL_INTERVAL_MS = 500;

interface FileState {
  issueId: string;
  issueIdentifier: string;
  lineCount: number;
  lastModified: number;
  events: DisplayEvent[];
}

export type WatcherCallback = (issueId: string, events: DisplayEvent[]) => void;

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
    const tickets: TicketInfo[] = [];
    for (const state of this.fileStates.values()) {
      const turnStartedCount = state.events.filter((e) => e.kind === "turn_started").length;
      const turnCompletedCount = state.events.filter((e) => e.kind === "turn_completed").length;
      const hasFailed = state.events.some((e) => e.kind === "turn_failed");

      let status: TicketInfo["status"] = "idle";
      if (hasFailed) {
        status = "failed";
      } else if (turnStartedCount > 0 && turnCompletedCount >= turnStartedCount) {
        status = "completed";
      } else if (turnStartedCount > 0) {
        status = "running";
      }

      let startedAt: string | undefined;
      if (state.events.length > 0) {
        const firstEvent = state.events[0];
        if (firstEvent !== undefined) {
          startedAt = firstEvent.timestamp;
        }
      }

      tickets.push({
        issueId: state.issueId,
        identifier: state.issueIdentifier,
        turnCount: turnStartedCount,
        status,
        startedAt,
      });
    }
    return tickets;
  }

  hasTicket(issueId: string): boolean {
    return this.fileStates.has(issueId);
  }

  getEventsForTicket(issueId: string): DisplayEvent[] {
    const state = this.fileStates.get(issueId);
    return state ? state.events : [];
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
          const existing = this.fileStates.get(entry);

          if (existing && fileStat.mtimeMs <= existing.lastModified) {
            continue;
          }

          const state = await this.readFile(filePath, entry, fileStat.mtimeMs);
          if (state) {
            const canonicalKey = state.issueId;
            const existingByKey = this.fileStates.get(canonicalKey);
            if (state.lineCount !== (existingByKey?.lineCount ?? 0)) {
              this.fileStates.set(canonicalKey, state);
              callback(canonicalKey, state.events);
            } else {
              this.fileStates.set(canonicalKey, state);
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
  ): Promise<FileState | null> {
    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      const events = parseTraceLines(lines);
      const metadata = extractTicketMetadata(lines);
      const lastModified = mtimeMs ?? (await stat(filePath)).mtimeMs;

      return {
        issueId: metadata?.issueId ?? issueId,
        issueIdentifier: metadata?.issueIdentifier ?? issueId,
        lineCount: lines.length,
        lastModified,
        events,
      };
    } catch {
      return null;
    }
  }
}
