import { CircleHelp } from "lucide-react";

import type { UnknownEvent as UnknownEventType } from "../../api/types";
import { formatTimestamp } from "../../../../lib/utils";

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
  return (
    <div className="border-l-4 border-muted rounded-r-md bg-background/50 p-3">
      <div className="flex items-start gap-2">
        <CircleHelp aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">{formatTimestamp(event.timestamp)}</span>
            <span className="text-xs font-medium text-muted">Unknown event</span>
          </div>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-2 text-xs font-mono text-foreground/80">
            {formatRawPayload(event.raw)}
          </pre>
        </div>
      </div>
    </div>
  );
}
