import { useState } from "react";
import { Info, AlertTriangle } from "lucide-react";

import type { NotificationEvent as NotificationEventType, TurnFailedEvent } from "../../api/types";
import { cn, formatTimestamp } from "../../../../lib/utils";

import { EventRow } from "./EventRow";

const LONG_NOTIFICATION_CHARS = 160;

interface NotificationEventProps {
  event: NotificationEventType | TurnFailedEvent;
}

export function NotificationEvent({ event }: NotificationEventProps) {
  const [expanded, setExpanded] = useState(false);
  const isFailed = event.kind === "turn_failed";
  const isLong = event.text.length > LONG_NOTIFICATION_CHARS;

  return (
    <EventRow
      dotClass={isFailed ? "bg-accent-coral" : "bg-faint"}
      time={formatTimestamp(event.timestamp)}
      icon={
        isFailed ? (
          <AlertTriangle className="h-3.5 w-3.5 text-accent-coral" />
        ) : (
          <Info className="h-3.5 w-3.5 text-faint" />
        )
      }
      title={
        <span className={cn("text-[13px]", isFailed ? "text-accent-coral" : "text-muted")}>
          {event.text}
        </span>
      }
      expandable={isLong}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
      ariaLabel="Toggle notification details"
      detail={
        isLong ? (
          <p className={cn("text-[13px]", isFailed ? "text-accent-coral" : "text-muted")}>
            {event.text}
          </p>
        ) : undefined
      }
    />
  );
}
