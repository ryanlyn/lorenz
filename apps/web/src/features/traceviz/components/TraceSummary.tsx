import type { Stats } from "../api/types";
import { formatDuration, formatNumber } from "../../../lib/utils";
import { HeroStat, HeroDivider } from "../../../shared/components/ui";

interface TraceSummaryProps {
  stats: Stats;
}

export function TraceSummary({ stats }: TraceSummaryProps) {
  const totalToolCalls = stats.toolBreakdown.reduce((sum, v) => sum + v.count, 0);
  const totalErrors = stats.toolBreakdown.reduce((sum, v) => sum + v.errorCount, 0);

  const cards = [
    { label: "Duration", value: formatDuration(stats.durationMs), dotClass: "bg-accent-cyan" },
    { label: "Turns", value: stats.totalTurns.toString(), dotClass: "bg-accent" },
    {
      label: "Input tokens",
      value: formatNumber(stats.tokenUsage.inputTokens),
      dotClass: "bg-accent",
    },
    {
      label: "Output tokens",
      value: formatNumber(stats.tokenUsage.outputTokens),
      dotClass: "bg-accent-amber",
    },
    { label: "Tool calls", value: totalToolCalls.toString(), dotClass: "bg-faint" },
    {
      label: "Errors",
      value: totalErrors.toString(),
      dotClass: totalErrors > 0 ? "bg-accent-coral" : "bg-surface",
    },
  ];

  return (
    <div className="flex flex-wrap items-stretch gap-x-8 gap-y-4 px-1 py-1">
      {cards.map((card, i) => (
        <div key={card.label} className="contents">
          {i > 0 && <HeroDivider />}
          <HeroStat {...card} valueClass="text-2xl" />
        </div>
      ))}
    </div>
  );
}
