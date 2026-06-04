import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { Brain, ChevronDown } from "lucide-react";

import type { ThoughtEvent as ThoughtEventType } from "../../api/types";
import { formatTimestamp, cn } from "../../../../lib/utils";
import { Markdown } from "../Markdown";

import { eventTargetIsAnchor, isActivationKey } from "./interactiveRow";

interface ThoughtEventProps {
  event: ThoughtEventType;
}

export function ThoughtEvent({ event }: ThoughtEventProps) {
  const [expanded, setExpanded] = useState(false);
  const isLong = event.text.length > 200;
  const toggleExpanded = () => setExpanded((value) => !value);

  const handleToggleClick = (clickEvent: MouseEvent<HTMLDivElement>) => {
    if (eventTargetIsAnchor(clickEvent.target)) return;
    toggleExpanded();
  };

  const handleToggleKeyDown = (keyboardEvent: KeyboardEvent<HTMLDivElement>) => {
    if (eventTargetIsAnchor(keyboardEvent.target)) return;
    if (!isActivationKey(keyboardEvent.key)) return;
    keyboardEvent.preventDefault();
    toggleExpanded();
  };

  return (
    <div className="border-l-4 border-accent-purple rounded-r-md bg-background/50 p-3">
      {isLong ? (
        <div
          role="button"
          tabIndex={0}
          className="flex w-full cursor-pointer items-start gap-2 bg-transparent p-0 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-purple/60"
          aria-expanded={expanded}
          aria-label="Toggle thought details"
          onClick={handleToggleClick}
          onKeyDown={handleToggleKeyDown}
        >
          <Brain aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-accent-purple" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">{formatTimestamp(event.timestamp)}</span>
              <ChevronDown
                className={cn("h-3 w-3 text-muted transition-transform", expanded && "rotate-180")}
              />
            </div>
            <div className={cn("mt-1", !expanded && "line-clamp-3")}>
              <Markdown className="text-sm italic text-foreground/80">{event.text}</Markdown>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <Brain aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-accent-purple" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">{formatTimestamp(event.timestamp)}</span>
            </div>
            <div className="mt-1">
              <Markdown className="text-sm italic text-foreground/80">{event.text}</Markdown>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
