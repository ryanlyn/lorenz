import { useEffect } from "react";
import { ArrowLeft, Archive, ArrowUp } from "lucide-react";

import type { DisplayEvent, Stats } from "../api/types";
import { useTraceData } from "../hooks/useTraceData";

import { TicketSelector } from "./TicketSelector";
import { TraceList } from "./TraceList";
import { TraceSummary } from "./TraceSummary";
import { Timeline } from "./Timeline";

interface TraceViewProps {
  issueId: string;
  onBack: () => void;
}

export function TraceView({ issueId, onBack }: TraceViewProps) {
  const {
    tickets,
    selectedTicketId,
    setSelectedTicketId,
    events,
    stats,
    loading,
    traceExists,
    following,
    hasNewUpdates,
    scrollToTop,
  } = useTraceData();

  useEffect(() => {
    if (issueId && selectedTicketId !== issueId) {
      setSelectedTicketId(issueId);
    }
  }, [issueId, selectedTicketId, setSelectedTicketId]);

  const navigateToTrace = (id: string) => {
    window.location.hash = `#/trace/${encodeURIComponent(id)}`;
  };

  return (
    <div className="space-y-6">
      {/* Navigation bar */}
      <div className="flex items-center gap-4">
        <button
          onClick={onBack}
          aria-label="Go back to overview"
          className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-muted transition-colors hover:border-muted hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Overview
        </button>
        {selectedTicketId && (
          <>
            <TicketSelector
              tickets={tickets}
              selectedId={selectedTicketId}
              onSelect={(id) => {
                if (id) {
                  navigateToTrace(id);
                } else {
                  window.location.hash = "#/trace";
                }
              }}
            />
          </>
        )}
      </div>

      {/* New updates indicator */}
      {hasNewUpdates && (
        <button
          onClick={scrollToTop}
          className="sticky top-[4.5rem] z-20 mx-auto flex items-center gap-1.5 rounded-full border border-accent-purple/30 bg-accent-purple/10 px-3 py-1.5 text-xs font-medium text-accent-purple backdrop-blur-sm transition-all hover:bg-accent-purple/20 hover:border-accent-purple/50"
        >
          <ArrowUp className="h-3 w-3" />
          New updates available
        </button>
      )}

      {/* Trace content */}
      <div aria-live="polite" aria-atomic="true">
        <TraceContent
          selectedTicketId={selectedTicketId}
          traceExists={traceExists}
          events={events}
          stats={stats}
          loading={loading}
          following={following}
          onSelect={navigateToTrace}
        />
      </div>
    </div>
  );
}

interface TraceContentProps {
  selectedTicketId: string | null;
  traceExists: boolean | null;
  events: DisplayEvent[];
  stats: Stats | null;
  loading: boolean;
  following: boolean;
  onSelect: (id: string) => void;
}

function TraceContent({
  selectedTicketId,
  traceExists,
  events,
  stats,
  loading,
  following,
  onSelect,
}: TraceContentProps) {
  if (!selectedTicketId) {
    return <TraceList onSelect={onSelect} />;
  }

  if (traceExists === false) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Archive aria-hidden="true" className="h-10 w-10 text-muted" />
        <p className="mt-4 text-sm font-medium text-foreground">{selectedTicketId}</p>
        <p className="mt-2 max-w-md text-sm text-muted">
          Trace data has been cleaned up for this issue. This is normal — traces are periodically
          removed to save disk space.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {stats && <TraceSummary stats={stats} />}
      <Timeline key={selectedTicketId} events={events} loading={loading} following={following} />
    </div>
  );
}
