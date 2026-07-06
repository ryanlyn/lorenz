import { useState } from "react";
import { Code } from "lucide-react";

import type { ToolCallEvent as ToolCallEventType } from "../../api/types";
import { formatTimestamp, formatDuration, cn } from "../../../../lib/utils";

import { EventRow } from "./EventRow";

interface ToolCallEventProps {
  event: ToolCallEventType;
}

function hasDisplayableInput(input: ToolCallEventType["input"]): boolean {
  return Object.keys(input).length > 0;
}

/** One-line condensed input preview, e.g. `command: git push · cwd: /repo`. */
function inputPreview(input: ToolCallEventType["input"]): string {
  return Object.entries(input)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" · ");
}

export function ToolCallEvent({ event }: ToolCallEventProps) {
  const [expanded, setExpanded] = useState(false);
  const hasInput = hasDisplayableInput(event.input);
  const hasDetail = hasInput || event.output != null;

  return (
    <EventRow
      dotClass={event.isError ? "bg-accent-coral" : "bg-accent-amber"}
      time={formatTimestamp(event.timestamp)}
      icon={
        <Code
          className={cn("h-3.5 w-3.5", event.isError ? "text-accent-coral" : "text-accent-amber")}
        />
      }
      title={
        <span className="flex min-w-0 items-baseline gap-2.5">
          <span className="shrink-0 font-mono text-[12.5px] font-medium">{event.toolName}</span>
          {hasInput && (
            <span className="truncate font-mono text-[11.5px] text-faint">
              {inputPreview(event.input)}
            </span>
          )}
        </span>
      }
      meta={
        <>
          {event.isError && (
            <span className="rounded-full bg-accent-coral/15 px-2 py-px text-[11px] text-accent-coral">
              error
            </span>
          )}
          {event.durationMs != null && (
            <span className="font-mono text-[11px] tabular-nums text-faint">
              {formatDuration(event.durationMs)}
            </span>
          )}
        </>
      }
      expandable={hasDetail}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
      ariaLabel={`Toggle ${event.toolName} details`}
      detail={
        hasDetail ? (
          <div className="space-y-2">
            {hasInput && (
              <div>
                <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-faint">
                  Input
                </span>
                <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-background/70 p-2.5 font-mono text-xs text-foreground/80">
                  {JSON.stringify(event.input, null, 2)}
                </pre>
              </div>
            )}
            {event.output != null && (
              <div>
                <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-faint">
                  Output
                </span>
                <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-background/70 p-2.5 font-mono text-xs text-foreground/80">
                  {typeof event.output === "string"
                    ? event.output
                    : JSON.stringify(event.output, null, 2)}
                </pre>
              </div>
            )}
          </div>
        ) : undefined
      }
    />
  );
}
