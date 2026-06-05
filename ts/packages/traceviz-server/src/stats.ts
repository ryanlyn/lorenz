/**
 * Compute aggregate statistics from a list of DisplayEvents for a single ticket trace.
 */

import type { DisplayEvent } from "./models/display-events.js";
import type { TraceStats, ToolBreakdownEntry } from "./models/api.js";

export function computeStats(events: DisplayEvent[]): TraceStats {
  if (events.length === 0) {
    return emptyStats();
  }

  // Duration: time between first and last event
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const event of events) {
    const ms = new Date(event.timestamp).getTime();
    if (!Number.isNaN(ms)) {
      if (ms < minTs) minTs = ms;
      if (ms > maxTs) maxTs = ms;
    }
  }
  const durationMs = Number.isFinite(minTs) && Number.isFinite(maxTs) ? maxTs - minTs : 0;

  // Count turns
  const totalTurns = events.filter((e) => e.kind === "turn_started").length;

  // Aggregate token usage
  let inputTokens = 0;
  let outputTokens = 0;
  for (const event of events) {
    if (event.kind === "turn_completed" && event.usage) {
      inputTokens += event.usage.inputTokens;
      outputTokens += event.usage.outputTokens;
    }
  }
  const totalTokens = inputTokens + outputTokens;

  // Tool breakdown by tool name
  const toolMap = new Map<string, { count: number; errorCount: number; totalDurationMs: number }>();
  for (const event of events) {
    if (event.kind === "tool_call") {
      const existing = toolMap.get(event.toolName);
      if (existing) {
        existing.count++;
        if (event.isError) existing.errorCount++;
        if (event.durationMs != null) existing.totalDurationMs += event.durationMs;
      } else {
        toolMap.set(event.toolName, {
          count: 1,
          errorCount: event.isError ? 1 : 0,
          totalDurationMs: event.durationMs ?? 0,
        });
      }
    }
  }

  const toolBreakdown: ToolBreakdownEntry[] = [];
  for (const [toolName, data] of toolMap) {
    toolBreakdown.push({
      toolName,
      count: data.count,
      errorCount: data.errorCount,
      totalDurationMs: data.totalDurationMs,
    });
  }
  toolBreakdown.sort((a, b) => b.count - a.count);

  return {
    durationMs,
    totalEvents: events.length,
    totalTurns,
    tokenUsage: { inputTokens, outputTokens, totalTokens },
    toolBreakdown,
  };
}

function emptyStats(): TraceStats {
  return {
    durationMs: 0,
    totalEvents: 0,
    totalTurns: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    toolBreakdown: [],
  };
}
