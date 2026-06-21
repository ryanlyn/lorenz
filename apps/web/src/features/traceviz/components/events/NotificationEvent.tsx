import { Info, AlertTriangle } from "lucide-react";

import type { NotificationEvent as NotificationEventType, TurnFailedEvent } from "../../api/types";
import { cn, formatTimestamp } from "../../../../lib/utils";

interface NotificationEventProps {
  event: NotificationEventType | TurnFailedEvent;
}

export function NotificationEvent({ event }: NotificationEventProps) {
  const isFailed = event.kind === "turn_failed";
  return (
    <div
      className={cn(
        "border-l-4 rounded-r-md bg-background/50 p-3",
        isFailed ? "border-accent-red" : "border-muted",
      )}
    >
      <div className="flex items-start gap-2">
        {isFailed ? (
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-accent-red" />
        ) : (
          <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
        )}
        <div className="min-w-0 flex-1">
          <span className="text-xs text-muted">{formatTimestamp(event.timestamp)}</span>
          <p className="mt-1 text-sm">{event.text}</p>
        </div>
      </div>
    </div>
  );
}
