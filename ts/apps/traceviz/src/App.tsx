import { Activity } from "lucide-react";

import { useHashRouter } from "./hooks/useHashRouter";
import { OpsOverview } from "./components/OpsOverview";
import { TraceView } from "./components/TraceView";

export function App() {
  const { route, navigate } = useHashRouter();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-accent-purple" />
            <h1 className="text-lg font-semibold">Symphony</h1>
          </div>
          <nav className="flex items-center gap-1 text-sm">
            <a
              href="#/"
              className={`rounded-md px-3 py-1.5 transition-colors ${
                route.view === "overview"
                  ? "bg-surface text-foreground"
                  : "text-muted hover:text-foreground"
              }`}
            >
              Overview
            </a>
            <a
              href="#/trace/"
              className={`rounded-md px-3 py-1.5 transition-colors ${
                route.view === "trace"
                  ? "bg-surface text-foreground"
                  : "text-muted hover:text-foreground"
              }`}
            >
              Traces
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        {route.view === "overview" && <OpsOverview />}
        {route.view === "trace" && (
          <TraceView issueId={route.issueId} onBack={() => navigate("/")} />
        )}
      </main>
    </div>
  );
}
