import { useMemo, useRef } from "react";

import { cn, formatNumber, formatTimestamp } from "../../../lib/utils";
import {
  SectionCard,
  Th,
  EmptyRow,
  IssueLink,
  AgentChip,
  Pill,
  HeroStat,
  HeroDivider,
  Sparkline,
} from "../../../shared/components/ui";
import type { OpsState, OpsRunningEntry, OpsRetryEntry, OpsBlockedEntry } from "../api/types";

import { RecentIssues } from "./RecentIssues";

const MAX_SPARK_SAMPLES = 40;
const MAX_ATTEMPT_DOTS = 5;

interface SparkSample {
  generatedAt: string;
  running: number;
  retrying: number;
  blocked: number;
  tokens: number;
}

/** Two-segment input/output token split with a 2px surface gap between fills. */
function TokenSplitBar({ input, output }: { input: number; output: number }) {
  const total = input + output;
  if (total === 0) return null;
  const inPct = (input / total) * 100;
  return (
    <div
      className="flex h-1.5 w-full gap-[2px] overflow-hidden rounded-full"
      aria-hidden="true"
      title={`${formatNumber(input)} in · ${formatNumber(output)} out`}
    >
      <span className="rounded-full bg-accent-cyan" style={{ width: `${inPct}%` }} />
      <span className="rounded-full bg-accent-cyan/35" style={{ width: `${100 - inPct}%` }} />
    </div>
  );
}

/** Thin proportional meter for comparing magnitudes within a table column. */
function MiniMeter({ value, max, className }: { value: number; max: number; className: string }) {
  const pct = max > 0 ? Math.max((value / max) * 100, 4) : 0;
  return (
    <span
      className="mt-1 block h-[3px] w-16 overflow-hidden rounded-full bg-surface"
      aria-hidden="true"
    >
      <span className={cn("block h-full rounded-full", className)} style={{ width: `${pct}%` }} />
    </span>
  );
}

function AttemptDots({ attempt }: { attempt: number }) {
  const dots = Array.from({ length: MAX_ATTEMPT_DOTS }, (_, i) => i < attempt);
  return (
    <span
      className="inline-flex items-center gap-[3px]"
      aria-label={`attempt ${attempt}`}
      title={`attempt ${attempt}`}
    >
      {dots.map((on, i) => (
        <span
          key={i}
          className={cn("h-1.5 w-1.5 rounded-[2px]", on ? "bg-accent-amber" : "bg-surface")}
        />
      ))}
      {attempt > MAX_ATTEMPT_DOTS && (
        <span className="ml-1 font-mono text-[11px] text-accent-amber">{attempt}</span>
      )}
    </span>
  );
}

const rowClass = "border-b border-border/60 last:border-b-0 hover:bg-accent/[0.03]";
const cellClass = "px-4 py-2 align-middle";

function RunningTable({ sessions }: { sessions: OpsRunningEntry[] }) {
  const maxTokens = Math.max(...sessions.map((s) => s.tokens.total_tokens), 0);
  return (
    <SectionCard title="Running sessions" count={sessions.length} dotClass="bg-accent">
      {sessions.length === 0 ? (
        <EmptyRow label="No active sessions" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Issue</Th>
                <Th>Agent</Th>
                <Th>Worker</Th>
                <Th>Turns</Th>
                <Th>Tokens</Th>
                <Th>Session</Th>
                <Th>Last event</Th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.issue_id} className={rowClass}>
                  <td className={cellClass}>
                    <IssueLink
                      issueId={s.issue_id}
                      identifier={s.issue_identifier}
                      url={s.issue_url}
                    />
                  </td>
                  <td className={cellClass}>
                    <AgentChip kind={s.agent_kind} />
                  </td>
                  <td className={cn(cellClass, "text-muted")}>{s.worker_host ?? "local"}</td>
                  <td className={cn(cellClass, "font-mono text-[12.5px] tabular-nums")}>
                    {s.turn_count}
                  </td>
                  <td className={cn(cellClass, "font-mono text-[12.5px] tabular-nums")}>
                    {formatNumber(s.tokens.total_tokens)}
                    <MiniMeter
                      value={s.tokens.total_tokens}
                      max={maxTokens}
                      className="bg-accent-cyan/70"
                    />
                  </td>
                  <td className={cn(cellClass, "font-mono text-[12.5px] text-faint")}>
                    {s.session_id ?? "n/a"}
                  </td>
                  <td className={cellClass}>
                    {s.last_event ? (
                      <Pill color="teal">{s.last_event}</Pill>
                    ) : (
                      <span className="text-faint">n/a</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function RetryTable({ entries }: { entries: OpsRetryEntry[] }) {
  return (
    <SectionCard title="Retry queue" count={entries.length} dotClass="bg-accent-amber">
      {entries.length === 0 ? (
        <EmptyRow label="No pending retries" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Issue</Th>
                <Th>Attempt</Th>
                <Th>Due</Th>
                <Th>Worker</Th>
                <Th>Error</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.issue_id} className={rowClass}>
                  <td className={cellClass}>
                    <IssueLink
                      issueId={e.issue_id}
                      identifier={e.issue_identifier}
                      url={e.issue_url}
                    />
                  </td>
                  <td className={cellClass}>
                    <AttemptDots attempt={e.attempt} />
                  </td>
                  <td className={cellClass}>
                    <Pill color="amber">
                      <span className="font-mono tabular-nums">{formatTimestamp(e.due_at)}</span>
                    </Pill>
                  </td>
                  <td className={cn(cellClass, "text-muted")}>{e.worker_host ?? "local"}</td>
                  <td className={cn(cellClass, "text-[12.5px] text-muted")}>{e.error ?? "n/a"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function BlockedTable({ entries }: { entries: OpsBlockedEntry[] }) {
  return (
    <SectionCard title="Blocked issues" count={entries.length} dotClass="bg-accent-coral">
      {entries.length === 0 ? (
        <EmptyRow label="No blocked issues" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Issue</Th>
                <Th>Reason</Th>
                <Th>Worker</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.issue_id} className={rowClass}>
                  <td className={cellClass}>
                    <IssueLink
                      issueId={e.issue_id}
                      identifier={e.issue_identifier}
                      url={e.issue_url}
                    />
                  </td>
                  <td className={cellClass}>
                    <Pill color="coral">{e.label}</Pill>
                  </td>
                  <td className={cn(cellClass, "text-muted")}>{e.worker_host ?? "n/a"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function workerCount(sessions: OpsRunningEntry[]): number {
  return new Set(sessions.map((s) => s.worker_host ?? "local")).size;
}

function nextDue(entries: OpsRetryEntry[]): string | null {
  if (entries.length === 0) return null;
  const soonest = entries.reduce((min, e) => (e.due_at < min.due_at ? e : min));
  return formatTimestamp(soonest.due_at);
}

function topBlockedReason(state: OpsState | null): string | null {
  const byReason = Object.entries(state?.blocked_by_reason ?? {});
  if (byReason.length === 0) return null;
  byReason.sort((a, b) => b[1] - a[1]);
  return byReason[0][0].replaceAll("_", " ");
}

interface OpsOverviewProps {
  state: OpsState | null;
  connected: boolean;
}

export function OpsOverview({ state }: OpsOverviewProps) {
  const running = state?.running ?? [];
  const retrying = state?.retrying ?? [];
  const blocked = state?.blocked ?? [];
  const counts = state?.counts ?? { running: 0, retrying: 0, blocked: 0 };
  const usageTotals = state?.usage_totals ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

  // Rolling client-side history of stream samples backing the hero sparklines.
  const historyRef = useRef<SparkSample[]>([]);
  const history = useMemo(() => {
    const samples = historyRef.current;
    if (state && samples[samples.length - 1]?.generatedAt !== state.generated_at) {
      samples.push({
        generatedAt: state.generated_at,
        running: state.counts.running,
        retrying: state.counts.retrying,
        blocked: state.counts.blocked,
        tokens: state.usage_totals.total_tokens,
      });
      if (samples.length > MAX_SPARK_SAMPLES) samples.splice(0, samples.length - MAX_SPARK_SAMPLES);
    }
    return [...samples];
  }, [state]);

  const workers = workerCount(running);
  const due = nextDue(retrying);
  const blockedReason = topBlockedReason(state);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-stretch gap-x-10 gap-y-5 px-1 py-2">
        <HeroStat
          label="Running"
          value={counts.running.toString()}
          sub={
            counts.running > 0 ? `across ${workers} worker${workers === 1 ? "" : "s"}` : "all quiet"
          }
          dotClass="bg-accent"
          chart={<Sparkline values={history.map((s) => s.running)} className="text-accent" />}
        />
        <HeroDivider />
        <HeroStat
          label="Retrying"
          value={counts.retrying.toString()}
          sub={due ? `next due ${due}` : "queue empty"}
          dotClass="bg-accent-amber"
          chart={
            <Sparkline values={history.map((s) => s.retrying)} className="text-accent-amber" />
          }
        />
        <HeroDivider />
        <HeroStat
          label="Blocked"
          value={counts.blocked.toString()}
          sub={blockedReason ?? "nothing held"}
          dotClass="bg-accent-coral"
          chart={<Sparkline values={history.map((s) => s.blocked)} className="text-accent-coral" />}
        />
        <HeroDivider />
        <div className="min-w-52">
          <HeroStat
            label="Total tokens"
            value={formatNumber(usageTotals.total_tokens)}
            sub={`${formatNumber(usageTotals.input_tokens)} in · ${formatNumber(usageTotals.output_tokens)} out`}
            dotClass="bg-accent-cyan"
            chart={<Sparkline values={history.map((s) => s.tokens)} className="text-accent-cyan" />}
          />
          <div className="mt-2">
            <TokenSplitBar input={usageTotals.input_tokens} output={usageTotals.output_tokens} />
          </div>
        </div>
      </div>

      <RunningTable sessions={running} />
      <RetryTable entries={retrying} />

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <BlockedTable entries={blocked} />
        <RecentIssues />
      </div>
    </div>
  );
}
