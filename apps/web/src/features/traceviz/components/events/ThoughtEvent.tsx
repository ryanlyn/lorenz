import { useState } from "react";
import { Brain } from "lucide-react";

import type { ThoughtEvent as ThoughtEventType } from "../../api/types";
import { formatTimestamp } from "../../../../lib/utils";
import { Markdown } from "../Markdown";

import { EventRow } from "./EventRow";

const LONG_THOUGHT_CHARS = 160;

interface ThoughtEventProps {
  event: ThoughtEventType;
}

export function ThoughtEvent({ event }: ThoughtEventProps) {
  const [expanded, setExpanded] = useState(false);
  const isLong = event.text.length > LONG_THOUGHT_CHARS;

  return (
    <EventRow
      dotClass="bg-accent/50"
      time={formatTimestamp(event.timestamp)}
      icon={<Brain className="h-3.5 w-3.5 text-accent/60" />}
      title={
        isLong ? (
          <span className="text-[13px] italic text-foreground/70">{event.text}</span>
        ) : (
          <Markdown className="text-[13px] italic text-foreground/70">{event.text}</Markdown>
        )
      }
      expandable={isLong}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
      ariaLabel="Toggle thought details"
      detail={
        isLong ? (
          <Markdown className="text-[13px] italic text-foreground/75">{event.text}</Markdown>
        ) : undefined
      }
    />
  );
}
