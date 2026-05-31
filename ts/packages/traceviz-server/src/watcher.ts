/**
 * TraceWatcher: polls a trace directory for JSONL trace files and maintains
 * parsed event state per ticket (issue).
 *
 * Each file in the trace directory is named `{issueId}.jsonl` and contains
 * one JSON line per AgentUpdate event emitted by the TraceEmitter.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
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
    // Initial scan
    void this.scan(callback);
    // Set up polling
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

  /**
   * Get summary info for all tracked tickets.
   */
  getTickets(): TicketInfo[] {
    const tickets: TicketInfo[] = [];
    for (const state of this.fileStates.values()) {
      const turnStartedCount = state.events.filter((e) => e.kind === "turn_started").length;
      const turnCompletedCount = state.events.filter((e) => e.kind === "turn_completed").length;
      const hasFailed = state.events.some(
        (e) => e.kind === "notification" && e.text.startsWith("Turn turn_failed"),
      );

      let status: TicketInfo["status"] = "idle";
      if (hasFailed) {
        status = "failed";
      } else if (turnStartedCount > 0 && turnCompletedCount >= turnStartedCount) {
        status = "completed";
      } else if (turnStartedCount > 0) {
        status = "running";
      }

      // Determine startedAt from first event
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

  /**
   * Get all parsed display events for a specific ticket/issue.
   */
  getEventsForTicket(issueId: string): DisplayEvent[] {
    const state = this.fileStates.get(issueId);
    return state ? state.events : [];
  }

  /**
   * Force re-read of a single file by issueId.
   */
  async refresh(issueId: string): Promise<DisplayEvent[]> {
    const filePath = path.resolve(this.traceDir, `${issueId}.jsonl`);
    const resolvedDir = path.resolve(this.traceDir);
    if (!filePath.startsWith(resolvedDir + path.sep)) return [];
    if (!existsSync(filePath)) return [];
    const state = await this.readFile(filePath, issueId);
    if (state) {
      this.fileStates.set(issueId, state);
      return state.events;
    }
    return [];
  }

  private async scan(callback: WatcherCallback): Promise<void> {
    if (this.stopped) return;
    if (this.scanning) return; // Skip if previous scan is still in progress
    if (!existsSync(this.traceDir)) return;

    this.scanning = true;
    try {
      let entries: string[];
      try {
        entries = await readdir(this.traceDir);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const filePath = path.join(this.traceDir, entry);
        const issueId = entry.slice(0, -6); // strip .jsonl

        try {
          const fileStat = await stat(filePath);
          const existing = this.fileStates.get(issueId);

          // Skip if file has not been modified since last read
          if (existing && fileStat.mtimeMs <= existing.lastModified) {
            continue;
          }

          const state = await this.readFile(filePath, issueId, fileStat.mtimeMs);
          if (state && state.lineCount !== (existing?.lineCount ?? 0)) {
            this.fileStates.set(issueId, state);
            callback(issueId, state.events);
          } else if (state) {
            // Update lastModified even if line count is same (file may have been touched)
            this.fileStates.set(issueId, state);
          }
        } catch {
          // Skip files we cannot read
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
