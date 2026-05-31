import { Info } from "lucide-react";

import type { NotificationEvent as NotificationEventType } from "../../api/types";
import { formatTimestamp } from "../../lib/utils";

interface NotificationEventProps {
  event: NotificationEventType;
}

export function NotificationEvent({ event }: NotificationEventProps) {
  return (
    <div className="border-l-4 border-muted rounded-r-md bg-background/50 p-3">
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <span className="text-xs text-muted">{formatTimestamp(event.timestamp)}</span>
          <p className="mt-1 text-sm">{event.text}</p>
        </div>
      </div>
    </div>
  );
}
