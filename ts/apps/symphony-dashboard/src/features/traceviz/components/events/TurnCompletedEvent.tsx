import { CheckCircle } from "lucide-react";

import type { TurnCompletedEvent as TurnCompletedEventType } from "../../api/types";
import { formatTimestamp, formatNumber, formatDuration } from "../../../../lib/utils";

interface TurnCompletedEventProps {
  event: TurnCompletedEventType;
}

export function TurnCompletedEvent({ event }: TurnCompletedEventProps) {
  return (
    <div className="border-l-4 border-accent-green rounded-r-md bg-background/50 p-3">
      <div className="flex items-start gap-2">
        <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-accent-green" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">{formatTimestamp(event.timestamp)}</span>
            <span className="text-xs font-medium text-accent-green">Turn completed</span>
          </div>
          <div className="mt-1 flex items-center gap-3 text-xs text-muted">
            {event.usage && (
              <>
                <span>
                  In:{" "}
                  <span className="text-foreground">{formatNumber(event.usage.inputTokens)}</span>{" "}
                  tokens
                </span>
                <span>
                  Out:{" "}
                  <span className="text-foreground">{formatNumber(event.usage.outputTokens)}</span>{" "}
                  tokens
                </span>
              </>
            )}
            {event.durationMs != null && (
              <span>
                Duration:{" "}
                <span className="text-foreground">{formatDuration(event.durationMs)}</span>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
