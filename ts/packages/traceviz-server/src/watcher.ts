/**
 * TraceWatcher: polls a trace directory for JSONL trace files and maintains
 * parsed event state per ticket (issue).
 *
 * Each file in the trace directory is named `{issueId}.jsonl` and contains
 * one JSON line per AgentUpdate event emitted by the TraceEmitter.
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
  /** Maps filename (without extension) to the canonical issueId key used in fileStates. */
  private fileKeyToCanonical = new Map<string, string>();
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
      const hasFailed = state.events.some((e) => e.kind === "turn_failed");

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

  private async scan(callback: WatcherCallback): Promise<void> {
    if (this.stopped) return;
    if (this.scanning) return; // Skip if previous scan is still in progress
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
        if (!entry.endsWith(".jsonl")) continue;
        const filePath = path.join(this.traceDir, entry);

        // Guard against path traversal from filenames like "../../etc/passwd.jsonl"
        const resolvedFilePath = path.resolve(filePath);
        if (!resolvedFilePath.startsWith(resolvedDir + path.sep)) continue;

        const fileKey = entry.slice(0, -6); // strip .jsonl

        try {
          const fileStat = await stat(filePath);

          // Look up existing state: either by filename key or via the canonical mapping
          const canonicalForFile = this.fileKeyToCanonical.get(fileKey);
          const existing = this.fileStates.get(canonicalForFile ?? fileKey);

          // Skip if file has not been modified since last read
          if (existing && fileStat.mtimeMs <= existing.lastModified) {
            continue;
          }

          const state = await this.readFile(filePath, fileKey, fileStat.mtimeMs);
          if (state) {
            // Use the metadata-derived issueId as the canonical map key
            const canonicalKey = state.issueId;
            this.fileKeyToCanonical.set(fileKey, canonicalKey);

            // If metadata issueId differs from filename, remove stale entry keyed by filename
            if (canonicalKey !== fileKey) {
              this.fileStates.delete(fileKey);
            }

            const existingByCanonical = this.fileStates.get(canonicalKey);
            if (state.lineCount !== (existingByCanonical?.lineCount ?? 0)) {
              this.fileStates.set(canonicalKey, state);
              callback(canonicalKey, state.events);
            } else {
              // Update lastModified even if line count is same (file may have been touched)
              this.fileStates.set(canonicalKey, state);
            }
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
