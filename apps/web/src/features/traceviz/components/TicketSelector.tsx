import { ChevronDown, ExternalLink } from "lucide-react";

import type { TicketInfo } from "../api/types";
import { cn } from "../../../lib/utils";
import { SafeExternalLink } from "../../../shared/components/SafeExternalLink";

interface TicketSelectorProps {
  tickets: TicketInfo[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

function statusColor(status: TicketInfo["status"]): string {
  switch (status) {
    case "completed":
      return "bg-accent";
    case "running":
      return "bg-accent-cyan animate-pulse";
    case "failed":
      return "bg-accent-coral";
    default:
      return "bg-muted";
  }
}

export function TicketSelector({ tickets, selectedId, onSelect }: TicketSelectorProps) {
  const selectedTicket = tickets.find((t) => t.issueId === selectedId);

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <label
          htmlFor="ticket-selector"
          className="absolute w-px h-px p-0 -m-px overflow-hidden [clip:rect(0,0,0,0)] whitespace-nowrap border-0"
        >
          Select an issue
        </label>
        <select
          id="ticket-selector"
          value={selectedId ?? ""}
          onChange={(e) => onSelect(e.target.value || null)}
          className={cn(
            "appearance-none rounded-lg border border-border bg-card px-3 py-1.5 pr-16 text-sm",
            "focus:outline-none focus:ring-2 focus:ring-accent/50",
            "cursor-pointer min-w-[240px]",
          )}
        >
          <option value="">Select an issue...</option>
          {tickets.map((ticket) => (
            <option key={ticket.issueId} value={ticket.issueId}>
              {ticket.identifier}
              {ticket.title ? ` - ${ticket.title}` : ""}
              {` (${ticket.turnCount} turns)`}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
        />
        {selectedId && (
          <span
            role="img"
            aria-label={selectedTicket?.status ?? "idle"}
            className={cn(
              "absolute right-10 top-1/2 -translate-y-1/2 h-2 w-2 rounded-full",
              statusColor(selectedTicket?.status ?? "idle"),
            )}
          />
        )}
      </div>
      {selectedTicket?.url && (
        <SafeExternalLink
          href={selectedTicket.url}
          omitUnsafe
          className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-border-strong hover:text-foreground"
          title="Open in Linear"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Linear
        </SafeExternalLink>
      )}
    </div>
  );
}
