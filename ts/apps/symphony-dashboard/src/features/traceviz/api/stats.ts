import type { DisplayEvent, Stats, ToolBreakdownEntry } from "./types";

export function computeStatsFromEvents(events: DisplayEvent[]): Stats {
  if (events.length === 0) {
    return {
      durationMs: 0,
      totalEvents: 0,
      totalTurns: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      toolBreakdown: [],
    };
  }

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

  const totalTurns = events.filter((e) => e.kind === "turn_started").length;

  let inputTokens = 0;
  let outputTokens = 0;
  for (const event of events) {
    if (event.kind === "turn_completed" && event.usage) {
      inputTokens += event.usage.inputTokens;
      outputTokens += event.usage.outputTokens;
    }
  }

  const categoryMap = new Map<
    string,
    { count: number; errorCount: number; totalDurationMs: number }
  >();
  for (const event of events) {
    if (event.kind === "tool_call") {
      const existing = categoryMap.get(event.category);
      if (existing) {
        existing.count++;
        if (event.isError) existing.errorCount++;
        if (event.durationMs != null) existing.totalDurationMs += event.durationMs;
      } else {
        categoryMap.set(event.category, {
          count: 1,
          errorCount: event.isError ? 1 : 0,
          totalDurationMs: event.durationMs ?? 0,
        });
      }
    }
  }

  const toolBreakdown: ToolBreakdownEntry[] = [];
  for (const [category, data] of categoryMap) {
    toolBreakdown.push({
      category,
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
    tokenUsage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    toolBreakdown,
  };
}
