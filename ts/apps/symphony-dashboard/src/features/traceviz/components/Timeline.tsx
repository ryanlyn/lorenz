import { useState, useMemo, useCallback, useEffect } from "react";
import {
  ChevronsUpDown,
  ChevronsDownUp,
  ChevronRight,
  ArrowUpDown,
  ArrowUp,
  ChevronUp,
  Loader2,
} from "lucide-react";

import type { DisplayEvent } from "../api/types";
import { cn } from "../../../lib/utils";

import { ThoughtEvent } from "./events/ThoughtEvent";
import { MessageEvent } from "./events/MessageEvent";
import { ToolCallEvent } from "./events/ToolCallEvent";
import { TurnCompletedEvent } from "./events/TurnCompletedEvent";
import { NotificationEvent } from "./events/NotificationEvent";
import { UnknownEvent } from "./events/UnknownEvent";

interface TimelineProps {
  events: DisplayEvent[];
  loading: boolean;
  following?: boolean;
}

type TimelineDisplayEvent = Exclude<DisplayEvent, { kind: "turn_started" }>;

function assertNever(event: never): never {
  throw new Error(`Unhandled display event: ${JSON.stringify(event)}`);
}

function eventKey(event: TimelineDisplayEvent, index: number): string {
  return `${event.kind}-${event.timestamp}-${index}`;
}

function renderEvent(event: TimelineDisplayEvent, index: number) {
  const key = eventKey(event, index);
  switch (event.kind) {
    case "thought":
      return <ThoughtEvent key={key} event={event} />;
    case "message":
      return <MessageEvent key={key} event={event} />;
    case "tool_call":
      return <ToolCallEvent key={key} event={event} />;
    case "turn_completed":
      return <TurnCompletedEvent key={key} event={event} />;
    case "turn_failed":
    case "notification":
      return <NotificationEvent key={key} event={event} />;
    case "unknown":
      return <UnknownEvent key={key} event={event} />;
    default:
      return assertNever(event);
  }
}

interface TurnGroup {
  turnIndex: number;
  events: TimelineDisplayEvent[];
}

function groupByTurn(events: DisplayEvent[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let currentTurn = 0;
  let currentEvents: TimelineDisplayEvent[] = [];

  for (const event of events) {
    if (event.kind === "turn_started") {
      if (currentEvents.length > 0) {
        groups.push({ turnIndex: currentTurn, events: currentEvents });
      }
      currentTurn = event.turnIndex;
      currentEvents = [];
    } else {
      currentEvents.push(event);
    }
  }
  if (currentEvents.length > 0) {
    groups.push({ turnIndex: currentTurn, events: currentEvents });
  }
  return groups;
}

export function Timeline({ events, loading, following = false }: TimelineProps) {
  const [sortNewest, setSortNewest] = useState(true);
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set());

  const grouped = useMemo(() => {
    const groups = groupByTurn(events);
    if (sortNewest) {
      return [...groups].reverse().map((g) => ({
        ...g,
        events: [...g.events].reverse(),
      }));
    }
    return groups;
  }, [events, sortNewest]);

  // Auto-expand the latest turn in follow mode
  const latestTurnIndex = grouped[0]?.turnIndex;
  useEffect(() => {
    if (following && sortNewest && latestTurnIndex != null) {
      setExpandedTurns((prev) => {
        if (prev.has(latestTurnIndex)) return prev;
        const next = new Set(prev);
        next.add(latestTurnIndex);
        return next;
      });
    }
  }, [following, sortNewest, latestTurnIndex]);

  const allExpanded = useMemo(
    () => grouped.length > 0 && grouped.every((g) => expandedTurns.has(g.turnIndex)),
    [grouped, expandedTurns],
  );

  const toggleTurn = (turn: number) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turn)) next.delete(turn);
      else next.add(turn);
      return next;
    });
  };

  const toggleAll = () => {
    if (allExpanded) {
      setExpandedTurns(new Set());
    } else {
      setExpandedTurns(new Set(grouped.map((g) => g.turnIndex)));
    }
  };

  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-accent-purple" />
        <span className="ml-2 text-sm text-muted">Loading events...</span>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <p className="text-sm text-muted">No events recorded yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted">Timeline ({events.length} events)</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSortNewest((p) => !p)}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-foreground transition-colors"
          >
            <ArrowUpDown className="h-3 w-3" />
            {sortNewest ? "Newest first" : "Oldest first"}
          </button>
          <button
            onClick={toggleAll}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-foreground transition-colors"
          >
            {allExpanded ? (
              <ChevronsDownUp className="h-3 w-3" />
            ) : (
              <ChevronsUpDown className="h-3 w-3" />
            )}
            {allExpanded ? "Collapse all" : "Expand all"}
          </button>
          <button
            onClick={scrollToTop}
            aria-label="Scroll to top"
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-foreground transition-colors"
          >
            <ArrowUp className="h-3 w-3" />
            Go to top
          </button>
        </div>
      </div>

      {grouped.map((group) => {
        const isExpanded = expandedTurns.has(group.turnIndex);
        return (
          <div
            key={group.turnIndex}
            className="rounded-lg border border-border bg-card overflow-hidden"
          >
            <button
              onClick={() => toggleTurn(group.turnIndex)}
              aria-expanded={isExpanded}
              className={cn(
                "flex w-full items-center justify-between px-4 py-2.5 text-left",
                "hover:bg-muted/20 transition-colors",
              )}
            >
              <span className="text-sm font-medium">
                Turn {group.turnIndex}
                <span className="ml-2 text-xs text-muted">({group.events.length} events)</span>
              </span>
              <ChevronRight
                className={cn("h-4 w-4 text-muted transition-transform", isExpanded && "rotate-90")}
              />
            </button>
            <div
              className={cn(
                "grid transition-[grid-template-rows,opacity] duration-200",
                isExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
              )}
            >
              <div className="overflow-hidden">
                <div className="space-y-2 px-4 pb-3">
                  {group.events.map((event, idx) => renderEvent(event, idx))}
                  <button
                    onClick={() => toggleTurn(group.turnIndex)}
                    className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-foreground transition-colors"
                  >
                    <ChevronUp className="h-3 w-3" />
                    Collapse turn
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
