import { useState } from "react";
import { MessageSquare } from "lucide-react";

import type { MessageEvent as MessageEventType } from "../../api/types";
import { formatTimestamp } from "../../../../lib/utils";
import { Markdown } from "../Markdown";

import { EventRow } from "./EventRow";

const LONG_MESSAGE_CHARS = 160;

interface MessageEventProps {
  event: MessageEventType;
}

export function MessageEvent({ event }: MessageEventProps) {
  const [expanded, setExpanded] = useState(false);
  const isLong = event.text.length > LONG_MESSAGE_CHARS;

  return (
    <EventRow
      dotClass="bg-accent-cyan"
      time={formatTimestamp(event.timestamp)}
      icon={<MessageSquare className="h-3.5 w-3.5 text-accent-cyan" />}
      title={
        isLong ? (
          <span className="text-[13px] text-foreground/90">{event.text}</span>
        ) : (
          <Markdown className="text-[13px]">{event.text}</Markdown>
        )
      }
      expandable={isLong}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
      ariaLabel="Toggle message details"
      detail={isLong ? <Markdown className="text-[13px]">{event.text}</Markdown> : undefined}
    />
  );
}
