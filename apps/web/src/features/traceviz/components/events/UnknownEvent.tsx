import { useState } from "react";
import { CircleHelp } from "lucide-react";

import type { UnknownEvent as UnknownEventType } from "../../api/types";
import { formatTimestamp } from "../../../../lib/utils";

import { EventRow } from "./EventRow";

interface UnknownEventProps {
  event: UnknownEventType;
}

function formatRawPayload(raw: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    raw,
    (_key, value: unknown) => {
      if (typeof value === "bigint") return value.toString();
      if (typeof value !== "object" || value === null) return value;
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      return value;
    },
    2,
  );
}

export function UnknownEvent({ event }: UnknownEventProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <EventRow
      dotClass="bg-faint"
      time={formatTimestamp(event.timestamp)}
      icon={<CircleHelp className="h-3.5 w-3.5 text-faint" />}
      title={<span className="text-xs font-medium text-muted">Unknown event</span>}
      expandable
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
      ariaLabel="Toggle unknown event details"
      detail={
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/70 p-2.5 font-mono text-xs text-foreground/80">
          {formatRawPayload(event.raw)}
        </pre>
      }
    />
  );
}
