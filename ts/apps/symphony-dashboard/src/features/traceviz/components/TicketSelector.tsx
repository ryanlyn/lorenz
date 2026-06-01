import { ChevronDown } from "lucide-react";

import type { TicketInfo } from "../api/types";
import { cn } from "../../../lib/utils";

interface TicketSelectorProps {
  tickets: TicketInfo[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

function statusColor(status: TicketInfo["status"]): string {
  switch (status) {
    case "completed":
      return "bg-accent-green";
    case "running":
      return "bg-accent-blue animate-pulse";
    case "failed":
      return "bg-accent-red";
    default:
      return "bg-muted";
  }
}

export function TicketSelector({ tickets, selectedId, onSelect }: TicketSelectorProps) {
  return (
    <div className="relative">
      <select
        value={selectedId ?? ""}
        onChange={(e) => onSelect(e.target.value || null)}
        className={cn(
          "appearance-none rounded-lg border border-border bg-card px-3 py-1.5 pr-8 text-sm",
          "focus:outline-none focus:ring-2 focus:ring-accent-purple/50",
          "cursor-pointer min-w-[240px]",
        )}
      >
        <option value="">Select a ticket...</option>
        {tickets.map((ticket) => (
          <option key={ticket.issueId} value={ticket.issueId}>
            {ticket.identifier}
            {ticket.title ? ` - ${ticket.title}` : ""}
            {` (${ticket.turnCount} turns)`}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      {selectedId && (
        <span
          className={cn(
            "absolute right-10 top-1/2 -translate-y-1/2 h-2 w-2 rounded-full",
            statusColor(tickets.find((t) => t.issueId === selectedId)?.status ?? "idle"),
          )}
        />
      )}
    </div>
  );
}
