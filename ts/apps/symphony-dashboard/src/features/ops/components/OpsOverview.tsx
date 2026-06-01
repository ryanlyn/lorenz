import { Activity, RefreshCw, AlertOctagon, Coins } from "lucide-react";

import { useOpsStream } from "../hooks/useOpsStream";
import { cn, formatNumber, formatTimestamp } from "../../../lib/utils";
import type { OpsRunningEntry, OpsRetryEntry, OpsBlockedEntry } from "../api/types";

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

function RunningTable({ sessions }: { sessions: OpsRunningEntry[] }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium text-foreground">Running Sessions</h3>
      </div>
      {sessions.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted">No active sessions</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="px-4 py-2 font-medium">Issue</th>
                <th className="px-4 py-2 font-medium">Agent</th>
                <th className="px-4 py-2 font-medium">Worker</th>
                <th className="px-4 py-2 font-medium">Turns</th>
                <th className="px-4 py-2 font-medium">Tokens</th>
                <th className="px-4 py-2 font-medium">Session</th>
                <th className="px-4 py-2 font-medium">Event</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sessions.map((s) => (
                <tr key={s.issue_id} className="hover:bg-surface">
                  <td className="px-4 py-2">
                    <a
                      href={`#/trace/${encodeURIComponent(s.issue_id)}`}
                      className="font-mono text-accent-blue hover:underline"
                    >
                      {s.issue_identifier}
                    </a>
                  </td>
                  <td className="px-4 py-2">
                    <span className="rounded bg-surface px-2 py-0.5 text-xs text-muted">
                      {s.agent_kind}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-muted">{s.worker_host ?? "local"}</td>
                  <td className="px-4 py-2 font-mono">{s.turn_count}</td>
                  <td className="px-4 py-2 font-mono">{formatNumber(s.tokens.total_tokens)}</td>
                  <td className="px-4 py-2 font-mono text-muted">{s.session_id ?? "n/a"}</td>
                  <td className="px-4 py-2 text-muted">{s.last_event ?? "n/a"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RetryTable({ entries }: { entries: OpsRetryEntry[] }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium text-foreground">Retry Queue</h3>
      </div>
      {entries.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted">No pending retries</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="px-4 py-2 font-medium">Issue</th>
                <th className="px-4 py-2 font-medium">Attempt</th>
                <th className="px-4 py-2 font-medium">Due</th>
                <th className="px-4 py-2 font-medium">Worker</th>
                <th className="px-4 py-2 font-medium">Workspace</th>
                <th className="px-4 py-2 font-medium">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {entries.map((e) => (
                <tr key={e.issue_id} className="hover:bg-surface">
                  <td className="px-4 py-2">
                    <a
                      href={`#/trace/${encodeURIComponent(e.issue_id)}`}
                      className="font-mono text-accent-blue hover:underline"
                    >
                      {e.issue_identifier}
                    </a>
                  </td>
                  <td className="px-4 py-2 font-mono">{e.attempt}</td>
                  <td className="px-4 py-2 font-mono">{formatTimestamp(e.due_at)}</td>
                  <td className="px-4 py-2 text-muted">{e.worker_host ?? "local"}</td>
                  <td className="px-4 py-2 font-mono text-muted">{e.workspace_path ?? "n/a"}</td>
                  <td className="px-4 py-2 text-muted">{e.error ?? "n/a"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BlockedTable({ entries }: { entries: OpsBlockedEntry[] }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium text-foreground">Blocked Issues</h3>
      </div>
      {entries.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted">No blocked issues</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="px-4 py-2 font-medium">Issue</th>
                <th className="px-4 py-2 font-medium">Reason</th>
                <th className="px-4 py-2 font-medium">Worker</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {entries.map((e) => (
                <tr key={e.issue_id} className="hover:bg-surface">
                  <td className="px-4 py-2">
                    <a
                      href={`#/trace/${encodeURIComponent(e.issue_id)}`}
                      className="font-mono text-accent-blue hover:underline"
                    >
                      {e.issue_identifier}
                    </a>
                  </td>
                  <td className="px-4 py-2 text-muted">{e.label}</td>
                  <td className="px-4 py-2 text-muted">{e.worker_host ?? "n/a"}</td>
                </tr>
              ))}
            </tbody>
          </table>
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

      {/* Detail tables */}
      <div className="space-y-6">
        <RunningTable sessions={running} />
        <RetryTable entries={retrying} />
        <BlockedTable entries={blocked} />
      </div>
    </div>
  );
}
