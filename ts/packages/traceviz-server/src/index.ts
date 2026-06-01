/**
 * Public API for @symphony/traceviz-server.
 *
 * This package exposes trace-parsing utilities and the file-watching engine
 * as a pure library (no HTTP framework dependency).
 */

export { TraceWatcher } from "./watcher.js";
export type { WatcherCallback } from "./watcher.js";

export { parseTraceLines, extractTicketMetadata, detectToolCategory } from "./parser.js";

export { computeStats } from "./stats.js";

export type {
  TicketInfo,
  TicketsResponse,
  TicketTraceResponse,
  ToolBreakdownEntry,
  TraceStats,
  HealthResponse,
} from "./models/api.js";

export type {
  DisplayEvent,
  ThoughtDisplayEvent,
  MessageDisplayEvent,
  ToolCallDisplayEvent,
  TurnCompletedDisplayEvent,
  TurnStartedDisplayEvent,
  TurnFailedDisplayEvent,
  NotificationDisplayEvent,
  UnknownDisplayEvent,
  ToolCategory,
  TokenUsage,
} from "./models/display-events.js";

export { TOOL_CATEGORIES } from "./models/display-events.js";
