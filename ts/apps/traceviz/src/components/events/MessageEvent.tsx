import { MessageSquare } from "lucide-react";

import type { MessageEvent as MessageEventType } from "../../api/types";
import { formatTimestamp } from "../../lib/utils";

interface MessageEventProps {
  event: MessageEventType;
}

export function MessageEvent({ event }: MessageEventProps) {
  return (
    <div className="border-l-4 border-accent-blue rounded-r-md bg-background/50 p-3">
      <div className="flex items-start gap-2">
        <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-accent-blue" />
        <div className="min-w-0 flex-1">
          <span className="text-xs text-muted">{formatTimestamp(event.timestamp)}</span>
          <p className="mt-1 whitespace-pre-wrap text-sm">{event.text}</p>
        </div>
      </div>
    </div>
  );
}
