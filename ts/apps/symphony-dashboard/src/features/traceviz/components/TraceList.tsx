import { Clock, RotateCcw, Play, CheckCircle, XCircle, Circle } from "lucide-react";

import type { TicketInfo } from "../api/types";
import { cn } from "../../../lib/utils";

interface TraceListProps {
  tickets: TicketInfo[];
  onSelect: (issueId: string) => void;
}

function statusIcon(status: TicketInfo["status"]) {
  switch (status) {
    case "running":
      return <Play className="h-3.5 w-3.5 text-accent-blue" />;
    case "completed":
      return <CheckCircle className="h-3.5 w-3.5 text-accent-green" />;
    case "failed":
      return <XCircle className="h-3.5 w-3.5 text-accent-red" />;
    default:
      return <Circle className="h-3.5 w-3.5 text-muted" />;
  }
}

function statusLabel(status: TicketInfo["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return "Idle";
  }
}

function formatStartedAt(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function TraceList({ tickets, onSelect }: TraceListProps) {
  if (tickets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-sm text-muted">No traces found on disk</p>
        <p className="mt-1 text-xs text-muted/70">
          Traces will appear here once tickets are processed
        </p>
      </div>
    );
  }

  const sorted = [...tickets].sort((a, b) => {
    if (a.startedAt && b.startedAt) return b.startedAt.localeCompare(a.startedAt);
    if (a.startedAt) return -1;
    if (b.startedAt) return 1;
    return 0;
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted">
          {tickets.length} trace{tickets.length !== 1 ? "s" : ""} available
        </h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map((ticket) => (
          <button
            key={ticket.issueId}
            onClick={() => onSelect(ticket.issueId)}
            className={cn(
              "rounded-lg border border-border bg-card p-4 text-left",
              "transition-all hover:border-accent-purple/50 hover:shadow-sm",
              "focus:outline-none focus:ring-2 focus:ring-accent-purple/50",
            )}
          >
            <div className="flex items-start justify-between">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{ticket.identifier}</p>
                {ticket.title && (
                  <p className="mt-0.5 truncate text-xs text-muted">{ticket.title}</p>
                )}
              </div>
              <div className="ml-2 flex items-center gap-1">{statusIcon(ticket.status)}</div>
            </div>
            <div className="mt-3 flex items-center gap-3 text-xs text-muted">
              <span className="flex items-center gap-1">
                <RotateCcw className="h-3 w-3" />
                {ticket.turnCount} turn{ticket.turnCount !== 1 ? "s" : ""}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatStartedAt(ticket.startedAt)}
              </span>
              <span
                className={cn(
                  "ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                  ticket.status === "running" && "bg-accent-blue/10 text-accent-blue",
                  ticket.status === "completed" && "bg-accent-green/10 text-accent-green",
                  ticket.status === "failed" && "bg-accent-red/10 text-accent-red",
                  ticket.status === "idle" && "bg-muted/10 text-muted",
                )}
              >
                {statusLabel(ticket.status)}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
