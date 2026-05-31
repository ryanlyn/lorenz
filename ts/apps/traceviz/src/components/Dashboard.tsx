import type { ReactNode } from "react";
import {
  Clock,
  RotateCcw,
  ArrowDownToLine,
  ArrowUpFromLine,
  Wrench,
  AlertTriangle,
} from "lucide-react";

import type { Stats } from "../api/types";
import { formatDuration, formatNumber, cn } from "../lib/utils";

interface DashboardProps {
  stats: Stats;
}

interface StatCardProps {
  label: string;
  value: string;
  icon: ReactNode;
  color: string;
}

function StatCard({ label, value, icon, color }: StatCardProps) {
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

export function Dashboard({ stats }: DashboardProps) {
  const totalToolCalls = stats.toolBreakdown.reduce((sum, v) => sum + v.count, 0);
  const totalErrors = stats.toolBreakdown.reduce((sum, v) => sum + v.errorCount, 0);

  const cards: StatCardProps[] = [
    {
      label: "Duration",
      value: formatDuration(stats.durationMs),
      icon: <Clock className="h-4 w-4" />,
      color: "text-accent-blue",
    },
    {
      label: "Turns",
      value: stats.totalTurns.toString(),
      icon: <RotateCcw className="h-4 w-4" />,
      color: "text-accent-purple",
    },
    {
      label: "Input Tokens",
      value: formatNumber(stats.tokenUsage.inputTokens),
      icon: <ArrowDownToLine className="h-4 w-4" />,
      color: "text-accent-green",
    },
    {
      label: "Output Tokens",
      value: formatNumber(stats.tokenUsage.outputTokens),
      icon: <ArrowUpFromLine className="h-4 w-4" />,
      color: "text-accent-orange",
    },
    {
      label: "Tool Calls",
      value: totalToolCalls.toString(),
      icon: <Wrench className="h-4 w-4" />,
      color: "text-foreground",
    },
    {
      label: "Errors",
      value: totalErrors.toString(),
      icon: <AlertTriangle className="h-4 w-4" />,
      color: totalErrors > 0 ? "text-accent-red" : "text-muted",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((card) => (
        <StatCard key={card.label} {...card} />
      ))}
    </div>
  );
}
