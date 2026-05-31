import { Activity } from "lucide-react";

import { useTraceData } from "./hooks/useTraceData";
import { TicketSelector } from "./components/TicketSelector";
import { Dashboard } from "./components/Dashboard";
import { Timeline } from "./components/Timeline";

export function App() {
  const { tickets, selectedTicketId, setSelectedTicketId, events, stats, loading, wsStatus } =
    useTraceData();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-accent-purple" />
            <h1 className="text-lg font-semibold">TraceViz</h1>
          </div>
          <TicketSelector
            tickets={tickets}
            selectedId={selectedTicketId}
            onSelect={setSelectedTicketId}
          />
          <div className="ml-auto flex items-center gap-2">
            <div
              className={`h-2 w-2 rounded-full ${
                wsStatus === "connected"
                  ? "bg-accent-green"
                  : wsStatus === "connecting"
                    ? "bg-accent-orange animate-pulse"
                    : "bg-accent-red"
              }`}
            />
            <span className="text-xs text-muted">
              {wsStatus === "connected"
                ? "Live"
                : wsStatus === "connecting"
                  ? "Connecting"
                  : "Offline"}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        {selectedTicketId ? (
          <div className="space-y-6">
            {stats && <Dashboard stats={stats} />}
            <Timeline key={selectedTicketId} events={events} loading={loading} />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-32 text-center">
            <Activity className="mb-4 h-12 w-12 text-muted" />
            <h2 className="text-xl font-medium text-foreground">Select a ticket to view traces</h2>
            <p className="mt-2 text-sm text-muted">
              Choose a Linear ticket from the dropdown above to see its agent execution trace.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
