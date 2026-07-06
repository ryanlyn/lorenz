import { ExternalLink } from "lucide-react";

import { cn } from "../../lib/utils";

import { SafeExternalLink } from "./SafeExternalLink";

/** Miniature line chart rendered from a plain series of values. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const width = 84;
  const height = 28;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - 3 - ((v - min) / span) * (height - 6);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      className={cn("h-7 w-[84px]", className)}
      fill="none"
    >
      <polyline
        points={points}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Unboxed hero figure with a color-keyed label, optional caption and chart. */
export function HeroStat({
  label,
  value,
  sub,
  dotClass,
  chart,
  valueClass = "text-[34px]",
}: {
  label: string;
  value: string;
  sub?: string;
  dotClass: string;
  chart?: React.ReactNode;
  valueClass?: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className={cn("h-2 w-2 rounded-[3px]", dotClass)} />
        {label}
      </div>
      <div className="mt-1 flex items-end gap-3">
        <div className={cn("font-semibold leading-none tracking-tight tabular-nums", valueClass)}>
          {value}
        </div>
        {chart}
      </div>
      {sub && <div className="mt-1.5 text-xs text-faint">{sub}</div>}
    </div>
  );
}

export function HeroDivider() {
  return (
    <div className="w-px self-stretch bg-gradient-to-b from-transparent via-border-strong to-transparent" />
  );
}

/** Bordered section container with a colored marker, title, and count badge. */
export function SectionCard({
  title,
  count,
  dotClass,
  children,
}: {
  title: string;
  count: number;
  dotClass: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card/70 backdrop-blur-md">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
        <span className={cn("h-2 w-2 rounded-[3px]", dotClass)} />
        <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
        <span className="rounded-full bg-surface px-2 py-px text-[11px] tabular-nums text-muted">
          {count}
        </span>
      </div>
      {children}
    </section>
  );
}

export function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="bg-surface/40 px-4 py-1.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.09em] text-faint">
      {children}
    </th>
  );
}

export function EmptyRow({ label }: { label: string }) {
  return <div className="px-4 py-6 text-center text-sm text-faint">{label}</div>;
}

/** Mono issue identifier linking to its trace, with an optional tracker link. */
export function IssueLink({
  issueId,
  identifier,
  url,
}: {
  issueId: string;
  identifier: string;
  url: string | null;
}) {
  return (
    <div className="flex items-center gap-2">
      <a
        href={`#/trace/${encodeURIComponent(issueId)}`}
        className="font-mono text-[12.5px] font-medium text-accent hover:underline"
        title="View trace"
      >
        {identifier}
      </a>
      {url && (
        <SafeExternalLink
          href={url}
          omitUnsafe
          className="inline-flex items-center text-faint transition-colors hover:text-foreground"
          title="Open in tracker"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </SafeExternalLink>
      )}
    </div>
  );
}

export function AgentChip({ kind }: { kind: string }) {
  const isClaude = kind.toLowerCase().includes("claude");
  return (
    <span
      className={cn(
        "rounded-md px-2 py-0.5 font-mono text-[11px]",
        isClaude
          ? "bg-accent-amber/10 text-accent-amber shadow-[inset_0_0_0_1px_rgba(242,163,60,0.25)]"
          : "bg-accent-cyan/10 text-accent-cyan shadow-[inset_0_0_0_1px_rgba(76,192,224,0.25)]",
      )}
    >
      {kind}
    </span>
  );
}

export function Pill({
  children,
  color,
}: {
  children: React.ReactNode;
  color: "teal" | "amber" | "coral";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11.5px]",
        color === "teal" && "bg-accent/10 text-accent",
        color === "amber" && "bg-accent-amber/10 text-accent-amber",
        color === "coral" && "bg-accent-coral/10 text-accent-coral",
      )}
    >
      <span className="h-[5px] w-[5px] rounded-full bg-current" />
      {children}
    </span>
  );
}
