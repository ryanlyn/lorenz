import { Activity, RefreshCw, AlertOctagon, Coins } from "lucide-react";

import { useOpsStream } from "../hooks/useOpsStream";
import { cn, formatNumber } from "../lib/utils";
import type { OpsSessionEntry } from "../api/types";

interface MetricCardProps {
  label: string;
  value: string;
  icon: React.ReactNode;
  color: string;
}

function MetricCard({ label, value, icon, color }: MetricCardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-4",
        "transition-colors hover:border-muted",
      )}
    >
      <div className="flex items-center gap-2">
        <div className={cn("text-sm", color)}>{icon}</div>
        <span className="text-xs text-muted">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
    </div>
  );
}

function SessionTable({
  title,
  sessions,
  emptyText,
}: {
  title: string;
  sessions: OpsSessionEntry[];
  emptyText: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
      </div>
      {sessions.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted">{emptyText}</div>
      ) : (
        <div className="divide-y divide-border">
          {sessions.map((session) => (
            <div key={session.issueId} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <a
                href={`#/trace/${encodeURIComponent(session.issueId)}`}
                className="font-mono text-accent-blue hover:underline"
              >
                {session.identifier ?? session.issueId}
              </a>
              {session.title && (
                <span className="truncate text-muted">{session.title}</span>
              )}
              {session.agentKind && (
                <span className="ml-auto rounded bg-surface px-2 py-0.5 text-xs text-muted">
                  {session.agentKind}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function OpsOverview() {
  const { state, connected } = useOpsStream();

  const running = state?.running ?? [];
  const retrying = state?.retrying ?? [];
  const blocked = state?.blocked ?? [];
  const counts = state?.counts ?? { running: 0, retrying: 0, blocked: 0 };
  const usageTotals = state?.usage_totals ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

  const metrics: MetricCardProps[] = [
    {
      label: "Running",
      value: counts.running.toString(),
      icon: <Activity className="h-4 w-4" />,
      color: "text-accent-green",
    },
    {
      label: "Retrying",
      value: counts.retrying.toString(),
      icon: <RefreshCw className="h-4 w-4" />,
      color: "text-accent-orange",
    },
    {
      label: "Blocked",
      value: counts.blocked.toString(),
      icon: <AlertOctagon className="h-4 w-4" />,
      color: "text-accent-red",
    },
    {
      label: "Total Tokens",
      value: formatNumber(usageTotals.total_tokens),
      icon: <Coins className="h-4 w-4" />,
      color: "text-accent-purple",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Connection indicator */}
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "h-2 w-2 rounded-full",
            connected ? "bg-accent-green" : "bg-accent-red animate-pulse",
          )}
        />
        <span className="text-xs text-muted">
          {connected ? "Stream connected" : "Connecting..."}
        </span>
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {metrics.map((m) => (
          <MetricCard key={m.label} {...m} />
        ))}
      </div>

      {/* Session tables */}
      <div className="grid gap-6 lg:grid-cols-3">
        <SessionTable
          title="Running Sessions"
          sessions={running}
          emptyText="No active sessions"
        />
        <SessionTable
          title="Retry Queue"
          sessions={retrying}
          emptyText="No pending retries"
        />
        <SessionTable
          title="Blocked Issues"
          sessions={blocked}
          emptyText="No blocked issues"
        />
      </div>
    </div>
  );
}
