import { ChevronLeft, ChevronRight } from "lucide-react";

import type { TicketInfo } from "../api/types";
import { cn } from "../../../lib/utils";

interface TraceNavigatorProps {
  tickets: TicketInfo[];
  selectedId: string;
  onSelect: (id: string) => void;
}

export function TraceNavigator({ tickets, selectedId, onSelect }: TraceNavigatorProps) {
  if (tickets.length <= 1) return null;

  const currentIndex = tickets.findIndex((t) => t.issueId === selectedId);
  if (currentIndex === -1) return null;

  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < tickets.length - 1;

  return (
    <div className="flex items-center gap-2">
      <button
        disabled={!hasPrev}
        onClick={() => hasPrev && onSelect(tickets[currentIndex - 1].issueId)}
        className={cn(
          "rounded-md border border-border p-1 transition-colors",
          hasPrev
            ? "hover:border-muted hover:text-foreground text-muted"
            : "text-muted/30 cursor-not-allowed",
        )}
        aria-label="Previous trace"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="text-xs text-muted tabular-nums">
        {currentIndex + 1} / {tickets.length}
      </span>
      <button
        disabled={!hasNext}
        onClick={() => hasNext && onSelect(tickets[currentIndex + 1].issueId)}
        className={cn(
          "rounded-md border border-border p-1 transition-colors",
          hasNext
            ? "hover:border-muted hover:text-foreground text-muted"
            : "text-muted/30 cursor-not-allowed",
        )}
        aria-label="Next trace"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
