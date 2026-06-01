import { useState } from "react";
import { Brain, ChevronDown } from "lucide-react";

import type { ThoughtEvent as ThoughtEventType } from "../../api/types";
import { formatTimestamp, cn } from "../../../../lib/utils";

interface ThoughtEventProps {
  event: ThoughtEventType;
}

export function ThoughtEvent({ event }: ThoughtEventProps) {
  const [expanded, setExpanded] = useState(false);
  const isLong = event.text.length > 200;

  return (
    <div className="border-l-4 border-accent-purple rounded-r-md bg-background/50 p-3">
      <div
        className={cn("flex items-start gap-2", isLong && "cursor-pointer")}
        onClick={() => isLong && setExpanded(!expanded)}
      >
        <Brain className="mt-0.5 h-4 w-4 shrink-0 text-accent-purple" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">{formatTimestamp(event.timestamp)}</span>
            {isLong && (
              <ChevronDown
                className={cn("h-3 w-3 text-muted transition-transform", expanded && "rotate-180")}
              />
            )}
          </div>
          <p
            className={cn(
              "mt-1 text-sm italic text-foreground/80",
              !expanded && isLong && "line-clamp-3",
            )}
          >
            {event.text}
          </p>
        </div>
      </div>
    </div>
  );
}
