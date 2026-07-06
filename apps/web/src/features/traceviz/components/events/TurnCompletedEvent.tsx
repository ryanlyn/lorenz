import { CheckCircle } from "lucide-react";

import type { TurnCompletedEvent as TurnCompletedEventType } from "../../api/types";
import { formatTimestamp, formatNumber, formatDuration } from "../../../../lib/utils";

import { EventRow } from "./EventRow";

interface TurnCompletedEventProps {
  event: TurnCompletedEventType;
}

export function TurnCompletedEvent({ event }: TurnCompletedEventProps) {
  return (
    <EventRow
      dotClass="bg-accent"
      time={formatTimestamp(event.timestamp)}
      icon={<CheckCircle className="h-3.5 w-3.5 text-accent" />}
      title={<span className="text-xs font-medium text-accent">Turn completed</span>}
      meta={
        <span className="flex items-center gap-3 text-[11px] text-faint">
          {event.usage && (
            <>
              <span>
                In{" "}
                <span className="tabular-nums text-muted">
                  {formatNumber(event.usage.inputTokens)}
                </span>
              </span>
              <span>
                Out{" "}
                <span className="tabular-nums text-muted">
                  {formatNumber(event.usage.outputTokens)}
                </span>
              </span>
            </>
          )}
          {event.durationMs != null && (
            <span className="tabular-nums text-muted">{formatDuration(event.durationMs)}</span>
          )}
        </span>
      }
    />
  );
}
