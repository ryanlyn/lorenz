import { useEffect } from "react";
import { ArrowLeft } from "lucide-react";

import { useTraceData } from "../hooks/useTraceData";

import { TicketSelector } from "./TicketSelector";
import { Dashboard } from "./Dashboard";
import { Timeline } from "./Timeline";

interface TraceViewProps {
  issueId: string;
  onBack: () => void;
}

export function TraceView({ issueId, onBack }: TraceViewProps) {
  const { tickets, selectedTicketId, setSelectedTicketId, events, stats, loading } = useTraceData();

  // Pre-select the issueId from the URL
  useEffect(() => {
    if (issueId && selectedTicketId !== issueId) {
      setSelectedTicketId(issueId);
    }
  }, [issueId, selectedTicketId, setSelectedTicketId]);

  return (
    <div className="space-y-6">
      {/* Navigation bar */}
      <div className="flex items-center gap-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-muted transition-colors hover:border-muted hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Overview
        </button>
        <TicketSelector
          tickets={tickets}
          selectedId={selectedTicketId}
          onSelect={(id) => {
            if (id) {
              window.location.hash = `#/trace/${encodeURIComponent(id)}`;
            }
          }}
        />
      </div>

      {/* Trace content */}
      {selectedTicketId ? (
        <div className="space-y-6">
          {stats && <Dashboard stats={stats} />}
          <Timeline key={selectedTicketId} events={events} loading={loading} />
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm text-muted">Loading trace data...</p>
        </div>
      )}
    </div>
  );
}
