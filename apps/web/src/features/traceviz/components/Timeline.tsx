import { memo, useState, useMemo, useCallback, useEffect } from "react";
import {
  ChevronsUpDown,
  ChevronsDownUp,
  ChevronRight,
  ArrowUpDown,
  ArrowUp,
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
}

type TimelineDisplayEvent = Exclude<DisplayEvent, { kind: "turn_started" }>;

interface TimelineEventItem {
  event: TimelineDisplayEvent;
  sourceIndex: number;
}

function assertNever(event: never): never {
  throw new Error(`Unhandled display event: ${JSON.stringify(event)}`);
}

function eventKey(item: TimelineEventItem): string {
  return `${item.sourceIndex}-${item.event.kind}`;
}

const TimelineEventRow = memo(function TimelineEventRow({
  event,
}: {
  event: TimelineDisplayEvent;
}) {
  switch (event.kind) {
    case "thought":
      return <ThoughtEvent event={event} />;
    case "message":
      return <MessageEvent event={event} />;
    case "tool_call":
      return <ToolCallEvent event={event} />;
    case "turn_completed":
      return <TurnCompletedEvent event={event} />;
    case "turn_failed":
    case "notification":
      return <NotificationEvent event={event} />;
    case "unknown":
      return <UnknownEvent event={event} />;
    default:
      return assertNever(event);
  }
});

interface TurnGroup {
  turnIndex: number;
  events: TimelineEventItem[];
}

function groupByTurn(events: DisplayEvent[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let currentTurn = 0;
  let currentEvents: TimelineEventItem[] = [];

  for (const [sourceIndex, event] of events.entries()) {
    if (event.kind === "turn_started") {
      if (currentEvents.length > 0) {
        groups.push({ turnIndex: currentTurn, events: currentEvents });
      }
      currentTurn = event.turnIndex;
      currentEvents = [];
    } else {
      currentEvents.push({ event, sourceIndex });
    }
  }
  if (currentEvents.length > 0) {
    groups.push({ turnIndex: currentTurn, events: currentEvents });
  }
  return groups;
}

export function Timeline({ events, loading }: TimelineProps) {
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

  // Trace events only update while loading, following, or catching up, so a
  // newest-first latest turn should open without depending on scroll state.
  const latestTurnIndex = grouped[0]?.turnIndex;
  useEffect(() => {
    if (sortNewest && latestTurnIndex != null) {
      setExpandedTurns((prev) => {
        if (prev.has(latestTurnIndex)) return prev;
        const next = new Set(prev);
        next.add(latestTurnIndex);
        return next;
      });
    }
  }, [sortNewest, latestTurnIndex]);

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

  if (loading && events.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
        <span className="ml-2 text-sm text-muted">Loading events...</span>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card p-8 text-center">
        <p className="text-sm text-muted">No events recorded yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-muted">Timeline ({events.length} events)</h2>
          {loading && (
            <Loader2 aria-label="Loading events" className="h-3.5 w-3.5 animate-spin text-accent" />
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSortNewest((p) => !p)}
            className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-xs text-muted transition-colors hover:border-border-strong hover:text-foreground"
          >
            <ArrowUpDown className="h-3 w-3" />
            {sortNewest ? "Newest first" : "Oldest first"}
          </button>
          <button
            onClick={toggleAll}
            className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-xs text-muted transition-colors hover:border-border-strong hover:text-foreground"
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
            className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-xs text-muted transition-colors hover:border-border-strong hover:text-foreground"
          >
            <ArrowUp className="h-3 w-3" />
            Go to top
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card/70 backdrop-blur-md">
        {grouped.map((group) => {
          const isExpanded = expandedTurns.has(group.turnIndex);
          return (
            <div key={group.turnIndex} className="border-b border-border/80 last:border-b-0">
              <button
                onClick={() => toggleTurn(group.turnIndex)}
                aria-expanded={isExpanded}
                className={cn(
                  "flex w-full items-center gap-2.5 bg-surface/30 px-4 py-1.5 text-left",
                  "hover:bg-accent/[0.05] transition-colors",
                )}
              >
                <span className="grid h-5 min-w-5 place-items-center rounded-md bg-accent/10 px-1.5 font-mono text-[11px] font-medium text-accent">
                  {group.turnIndex}
                </span>
                <span className="text-[13px] font-medium">Turn {group.turnIndex}</span>
                <span className="rounded-full bg-surface px-2 py-px text-[11px] tabular-nums text-faint">
                  {group.events.length} events
                </span>
                <ChevronRight
                  className={cn(
                    "ml-auto h-3.5 w-3.5 text-muted transition-transform",
                    isExpanded && "rotate-90",
                  )}
                />
              </button>
              <div
                className={cn(
                  "grid transition-[grid-template-rows,opacity] duration-200",
                  isExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                )}
              >
                <div className="overflow-hidden">
                  {group.events.map((item) => (
                    <TimelineEventRow key={eventKey(item)} event={item.event} />
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
