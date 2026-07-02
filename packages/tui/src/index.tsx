import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import type { AgentUpdateType } from "@lorenz/domain";
import type { RuntimeSnapshot } from "@lorenz/runtime-events";
import { humanizeAgentMessage } from "@lorenz/humanize";

const REFRESH_INTERVAL_MS = 250;

export interface RuntimeViewSource {
  snapshot(): RuntimeSnapshot;
  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void;
}

export {
  humanizeAgentMessage,
  humanizeCodexMessage,
  humanizeClaudeMessage,
} from "@lorenz/humanize";

type RunningEntry = RuntimeSnapshot["running"][number];

/** Stable identity for one run across snapshots (a re-dispatch is a new run). */
function runKey(run: RunningEntry): string {
  return run.runId ?? `${run.issueId}#${run.startedAt}`;
}

export function RuntimeApp({
  runtime,
  dashboardUrl,
  projectUrl,
}: {
  runtime: RuntimeViewSource;
  dashboardUrl?: string | null | undefined;
  projectUrl?: string | undefined;
}) {
  const runSamplesRef = useRef<Map<string, TokenSample[]>>(new Map());
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(() => {
    const initial = runtime.snapshot();
    recordRunSamples(runSamplesRef.current, initial, Date.now());
    return initial;
  });
  const [throughputState, setThroughputState] = useState<ThroughputState>(() =>
    initialThroughputState(),
  );
  const [now, setNow] = useState<number>(() => Date.now());
  const [snapshotReceivedAt, setSnapshotReceivedAt] = useState<number>(() => Date.now());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const { stdout } = useStdout();
  const { isRawModeSupported } = useStdin();
  const { exit } = useApp();
  const interactive = isRawModeSupported === true;

  useEffect(
    () =>
      runtime.subscribe((nextSnapshot) => {
        const receivedAt = Date.now();
        setSnapshot(nextSnapshot);
        setSnapshotReceivedAt(receivedAt);
        setThroughputState((state) => updateThroughputState(state, nextSnapshot, receivedAt));
        recordRunSamples(runSamplesRef.current, nextSnapshot, receivedAt);
      }),
    [runtime],
  );

  useEffect(() => {
    const id = setInterval(() => {
      const tick = Date.now();
      setNow(tick);
      setThroughputState((state) => updateThroughputState(state, snapshotRef.current, tick));
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  useInput(
    (input, key) => {
      if (input === "q") {
        exit();
        return;
      }
      if (key.escape) {
        setSelectedKey(null);
        return;
      }
      const running = snapshotRef.current.running;
      const digit = Number.parseInt(input, 10);
      if (!Number.isNaN(digit) && digit >= 1 && digit <= running.length) {
        const run = running[digit - 1];
        if (run) setSelectedKey(runKey(run));
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        setSelectedKey((current) => {
          if (current === null || running.length === 0) return current;
          const index = running.findIndex((run) => runKey(run) === current);
          const step = key.leftArrow ? -1 : 1;
          const next = running[(index + step + running.length) % running.length];
          return next ? runKey(next) : null;
        });
      }
    },
    { isActive: interactive },
  );

  const selectedRun =
    selectedKey === null
      ? null
      : (snapshot.running.find((run) => runKey(run) === selectedKey) ?? null);
  const shared = {
    dashboardUrl,
    projectUrl,
    throughputTps: throughputState.currentTps,
    now,
    snapshotReceivedAt,
    columns: stdout?.columns,
    interactive,
    ansi: true,
  };

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        {selectedRun
          ? formatAgentDetail(selectedRun, snapshot, {
              ...shared,
              sparkline: tokenRateSparkline(
                runSamplesRef.current.get(runKey(selectedRun)) ?? [],
                now,
              ),
              runTps: runTokensPerSecond(runSamplesRef.current.get(runKey(selectedRun)) ?? [], now),
            })
          : formatDashboard(snapshot, shared)}
      </Text>
    </Box>
  );
}

export function RuntimeDashboard({
  snapshot,
  throughputTps,
  dashboardUrl,
  projectUrl,
  now,
  snapshotReceivedAt,
  columns,
}: {
  snapshot: RuntimeSnapshot;
  throughputTps?: number | undefined;
  dashboardUrl?: string | null | undefined;
  projectUrl?: string | undefined;
  now?: Date | string | number | undefined;
  snapshotReceivedAt?: Date | string | number | undefined;
  columns?: number | undefined;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        {formatDashboard(snapshot, {
          dashboardUrl,
          projectUrl,
          throughputTps,
          now,
          snapshotReceivedAt,
          columns,
          ansi: true,
        })}
      </Text>
    </Box>
  );
}

// --- Throughput and per-run token-rate sampling -------------------------------

export interface TokenSample {
  timestampMs: number;
  totalTokens: number;
}

interface ThroughputState {
  tokenSamples: TokenSample[];
  lastTpsSecond: number | null;
  lastTpsValue: number;
  currentTps: number;
}

const THROUGHPUT_WINDOW_MS = 5_000;
const SPARKLINE_BUCKETS = 10;
const SPARKLINE_BUCKET_MS = 6_000;
const RUN_SAMPLE_WINDOW_MS = SPARKLINE_BUCKETS * SPARKLINE_BUCKET_MS + 30_000;
const SPARKLINE_LEVELS = "▁▂▃▄▅▆▇█";

/** Track per-run cumulative token samples so detail views can plot a rate histogram. */
function recordRunSamples(
  samples: Map<string, TokenSample[]>,
  snapshot: RuntimeSnapshot,
  nowMs: number,
): void {
  const liveKeys = new Set<string>();
  for (const run of snapshot.running) {
    const key = runKey(run);
    liveKeys.add(key);
    const next = [{ timestampMs: nowMs, totalTokens: run.usageTotals.totalTokens }];
    for (const sample of samples.get(key) ?? []) {
      if (sample.timestampMs >= nowMs - RUN_SAMPLE_WINDOW_MS) next.push(sample);
    }
    samples.set(key, next);
  }
  for (const key of samples.keys()) {
    if (!liveKeys.has(key)) samples.delete(key);
  }
}

/**
 * Token *rate* histogram over the trailing minute: cumulative totals are
 * monotonic and plot as a meaningless ramp, so each glyph is the token delta
 * inside one bucket, scaled to the busiest bucket.
 */
export function tokenRateSparkline(
  samples: TokenSample[],
  nowMs: number,
  buckets = SPARKLINE_BUCKETS,
  bucketMs = SPARKLINE_BUCKET_MS,
): string {
  const flat = (SPARKLINE_LEVELS[0] ?? "▁").repeat(buckets);
  if (samples.length === 0) return flat;
  const sorted = [...samples].sort((a, b) => a.timestampMs - b.timestampMs);
  const tokensAt = (timestampMs: number): number => {
    let value = sorted[0]?.totalTokens ?? 0;
    for (const sample of sorted) {
      if (sample.timestampMs > timestampMs) break;
      value = sample.totalTokens;
    }
    return value;
  };
  const start = nowMs - buckets * bucketMs;
  const deltas: number[] = [];
  for (let index = 0; index < buckets; index++) {
    const bucketStart = tokensAt(start + index * bucketMs);
    const bucketEnd = tokensAt(start + (index + 1) * bucketMs);
    deltas.push(Math.max(0, bucketEnd - bucketStart));
  }
  const peak = Math.max(...deltas);
  if (peak <= 0) return flat;
  return deltas
    .map((delta) => {
      const level = Math.min(
        SPARKLINE_LEVELS.length - 1,
        Math.round((delta / peak) * (SPARKLINE_LEVELS.length - 1)),
      );
      return SPARKLINE_LEVELS[level];
    })
    .join("");
}

/** Current tokens/second for one run, from its trailing samples. */
export function runTokensPerSecond(samples: TokenSample[], nowMs: number): number {
  if (samples.length < 2) return 0;
  const latest = samples.reduce((a, b) => (a.timestampMs >= b.timestampMs ? a : b));
  const windowStart = nowMs - 10_000;
  let base = latest;
  for (const sample of samples) {
    if (sample.timestampMs >= windowStart && sample.timestampMs < base.timestampMs) base = sample;
  }
  const elapsed = (latest.timestampMs - base.timestampMs) / 1000;
  if (elapsed <= 0) return 0;
  return Math.max(0, latest.totalTokens - base.totalTokens) / elapsed;
}

// --- Flight-board formatter ----------------------------------------------------

export interface DashboardFormatOptions {
  ansi?: boolean | undefined;
  /** Terminal width the board may use; defaults to 132 and clamps at 96. */
  columns?: number | undefined;
  dashboardUrl?: string | null | undefined;
  /** How many events the bottom tape shows; defaults to 6. */
  eventsLimit?: number | undefined;
  /** Render the key-binding hint line (interactive TTY sessions only). */
  interactive?: boolean | undefined;
  maxAgents?: number | undefined;
  now?: Date | string | number | undefined;
  projectUrl?: string | undefined;
  runtimeSeconds?: number | undefined;
  snapshotReceivedAt?: Date | string | number | undefined;
  throughputTps?: number | undefined;
}

export interface AgentDetailOptions extends DashboardFormatOptions {
  /** Token-rate histogram for the inspected run (see {@link tokenRateSparkline}). */
  sparkline?: string | undefined;
  /** Current tokens/second for the inspected run. */
  runTps?: number | undefined;
}

const DEFAULT_COLUMNS = 132;
const MIN_COLUMNS = 96;
const DEFAULT_EVENTS_LIMIT = 6;
const EVENT_TYPE_WIDTH = 18;

// Unified-table cell widths; LAST ACTIVITY absorbs whatever width remains.
const COLS = { lane: 5, id: 9, title: 26, stage: 12, agent: 6, host: 12, ageTurn: 11, tokens: 9 };
const ROW_FIXED_WIDTH =
  6 + // " NN ▶ " index + marker prefix
  (COLS.lane + 1) +
  (COLS.id + 1) +
  (COLS.title + 1) +
  (COLS.stage + 1) +
  (COLS.agent + 1) +
  (COLS.host + 1) +
  (COLS.ageTurn + 1) +
  COLS.tokens +
  2;

interface BoardContext {
  ansi: boolean;
  columns: number;
  now: Date;
  activityWidth: number;
}

export function formatDashboard(
  snapshot: RuntimeSnapshot,
  options: DashboardFormatOptions = {},
): string {
  const context = boardContext(options);
  const { ansi, columns, now, activityWidth } = context;
  const lines: string[] = [...headerLines(snapshot, options, context)];

  lines.push(rule(columns, ansi));
  lines.push(tableHeader(ansi));
  lines.push(rule(columns, ansi));

  const reserving = snapshot.reserving ?? [];
  const blockedList: unknown[] =
    snapshot.blocked.length > 0
      ? snapshot.blocked
      : (arrayAt(snapshot, ["dispatchBlocks"]) ?? arrayAt(snapshot, ["dispatch_blocks"]) ?? []);
  const total =
    snapshot.running.length + reserving.length + snapshot.retrying.length + blockedList.length;
  if (total === 0) {
    lines.push(`      ${s("90", "no work in flight", ansi)}`);
  } else {
    snapshot.running.forEach((run, index) => {
      lines.push(formatRunningRow(run, index + 1, now, ansi, activityWidth));
    });
    for (const entry of reserving) lines.push(formatReservingRow(entry, now, ansi, activityWidth));
    for (const entry of snapshot.retrying) {
      lines.push(formatRetryRow(entry, now, ansi, activityWidth));
    }
    for (const entry of blockedList) lines.push(formatBlockedRow(entry, ansi, activityWidth));
  }

  lines.push(rule(columns, ansi));
  lines.push(...eventTapeLines(snapshot.recentEvents, options, context, null));
  if (options.interactive === true) {
    lines.push(
      `${s("36", " 1-9", ansi)}${s("90", " inspect agent", ansi)}${s("90", " · ", ansi)}${s("36", "q", ansi)}${s("90", " quit", ansi)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The narrowed, card-style view of one running agent (V4 "cards" density). */
export function formatAgentDetail(
  run: RunningEntry,
  snapshot: RuntimeSnapshot,
  options: AgentDetailOptions = {},
): string {
  const context = boardContext(options);
  const { ansi, columns, now } = context;
  const sep = s("90", " · ", ansi);
  const color = rowColor(run.lastEvent);
  const lines: string[] = [...headerLines(snapshot, options, context)];
  const wide = Math.max(24, columns - 4);

  lines.push(rule(columns, ansi));
  lines.push(
    ` ${s(color, "▶", ansi)} ${styledCell("36;1", run.issueIdentifier, ansi)}${sep}${styledCell("1", run.issueTitle || "untitled", ansi, { max: wide })}`,
  );
  lines.push(
    `   ${s("90", "stage ", ansi)}${styledCell(color, runningStage(run), ansi)}${sep}` +
      `${s("90", "agent ", ansi)}${styledCell("35", run.agentKind, ansi)}${sep}` +
      `${s("90", "host ", ansi)}${styledCell("39", run.workerHost ?? "local", ansi)}${sep}` +
      `${s("90", "slot ", ansi)}${s("39", String(run.slotIndex), ansi)}` +
      (run.retryAttempt ? `${sep}${s("38;5;208", `retry attempt ${run.retryAttempt}`, ansi)}` : ""),
  );
  const lastEventAgo = run.lastEventAt
    ? `${formatDuration(secondsBetween(now, run.lastEventAt))} ago`
    : "n/a";
  lines.push(
    `   ${s("90", "turn ", ansi)}${s("35", String(run.turnCount), ansi)}${sep}` +
      `${s("90", "age ", ansi)}${s("35", formatMinutesSeconds(secondsBetween(now, run.startedAt)), ansi)}${sep}` +
      `${s("90", "tools ", ansi)}${s("32", formatInteger(run.toolCallCount ?? 0), ansi)}${sep}` +
      `${s("90", "last event ", ansi)}${styledCell("39", String(run.lastEvent ?? "none"), ansi)} ${s("90", lastEventAgo, ansi)}`,
  );
  const rate = options.runTps !== undefined ? `${formatInteger(options.runTps)} tps` : null;
  lines.push(
    `   ${s("90", "tokens ", ansi)}${s("33", formatInteger(run.usageTotals.totalTokens), ansi)}` +
      `${s("90", ` (in ${formatInteger(run.usageTotals.inputTokens)} / out ${formatInteger(run.usageTotals.outputTokens)})`, ansi)}` +
      (options.sparkline
        ? `${sep}${s("90", "rate ", ansi)}${s("32", options.sparkline, ansi)}${rate ? ` ${s("36", rate, ansi)}` : ""} ${s("90", "(last 60s)", ansi)}`
        : ""),
  );
  lines.push(
    `   ${s("90", "session ", ansi)}${styledCell("36", run.sessionId ?? "n/a", ansi)}${sep}${s("90", "pid ", ansi)}${styledCell("39", run.executorPid ?? "n/a", ansi)}`,
  );
  if (run.workspacePath) {
    lines.push(
      `   ${s("90", "workspace ", ansi)}${styledCell("39", run.workspacePath, ansi, { max: wide })}`,
    );
  }
  if (run.issueUrl) {
    lines.push(
      `   ${s("90", "issue ", ansi)}${styledCell("36", run.issueUrl, ansi, { max: wide })}`,
    );
  }
  lines.push(
    `   ${s(color, "▸ ", ansi)}${styledCell(color, humanizeAgentMessage(run.lastMessage ?? null), ansi, { max: wide })}`,
  );

  lines.push(rule(columns, ansi));
  lines.push(...eventTapeLines(snapshot.recentEvents, options, context, run.issueIdentifier));
  if (options.interactive === true) {
    lines.push(
      `${s("36", " ←/→", ansi)}${s("90", " switch agent", ansi)}${s("90", " · ", ansi)}${s("36", "esc", ansi)}${s("90", " board", ansi)}${s("90", " · ", ansi)}${s("36", "q", ansi)}${s("90", " quit", ansi)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function boardContext(options: DashboardFormatOptions): BoardContext {
  const columns = Math.max(MIN_COLUMNS, options.columns ?? DEFAULT_COLUMNS);
  return {
    ansi: options.ansi === true,
    columns,
    now: coerceDate(options.now) ?? new Date(),
    activityWidth: Math.max(16, columns - ROW_FIXED_WIDTH),
  };
}

function headerLines(
  snapshot: RuntimeSnapshot,
  options: DashboardFormatOptions,
  context: BoardContext,
): string[] {
  const { ansi, now } = context;
  const maxAgents = options.maxAgents ?? 10;
  const snapshotReceivedAt = coerceDate(options.snapshotReceivedAt) ?? undefined;
  const runtimeSeconds =
    options.runtimeSeconds ?? liveRuntimeSeconds(snapshot, now, snapshotReceivedAt);
  const throughputTps =
    options.throughputTps ?? throughput(snapshot.usageTotals.totalTokens, runtimeSeconds);
  const sep = s("90", " · ", ansi);
  const reserving = snapshot.reserving?.length ?? 0;
  const blocked = Math.max(
    snapshot.blocked.length,
    arrayAt(snapshot, ["dispatchBlocks"])?.length ??
      arrayAt(snapshot, ["dispatch_blocks"])?.length ??
      0,
  );
  const lanes = [
    `${s("32", "▶", ansi)} ${s("32", String(snapshot.running.length), ansi)}${s("90", `/${maxAgents} running`, ansi)}`,
    reserving > 0 ? `${s("90", "◌", ansi)} ${s("90", `${reserving} reserving`, ansi)}` : null,
    snapshot.retrying.length > 0
      ? `${s("38;5;208", "↻", ansi)} ${s("38;5;208", String(snapshot.retrying.length), ansi)}${s("90", " retrying", ansi)}`
      : null,
    blocked > 0
      ? `${s("33", "■", ansi)} ${s("33", String(blocked), ansi)}${s("90", " blocked", ansi)}`
      : null,
  ].filter((part): part is string => part !== null);
  const lines: string[] = [];
  lines.push(
    ` ${b("LORENZ", ansi)}  ${lanes.join("  ")}${sep}` +
      `${s("36", `${formatInteger(throughputTps)} tps`, ansi)}${sep}` +
      `${s("90", "tok ", ansi)}${s("33", formatInteger(snapshot.usageTotals.totalTokens), ansi)}${sep}` +
      `${s("90", "up ", ansi)}${s("35", formatMinutesSeconds(runtimeSeconds), ansi)}`,
  );
  lines.push(
    ` ${formatLimitsLine(snapshot.rateLimits, ansi, sep)}${sep}` +
      `${s("90", "in ", ansi)}${s("33", formatInteger(snapshot.usageTotals.inputTokens), ansi)}` +
      `${s("90", " / out ", ansi)}${s("33", formatInteger(snapshot.usageTotals.outputTokens), ansi)}`,
  );
  lines.push(` ${formatPollLine(snapshot, options, now, ansi, sep)}`);
  return lines;
}

function rule(columns: number, ansi: boolean): string {
  return s("90", "─".repeat(columns), ansi);
}

function tableHeader(ansi: boolean): string {
  const header = [
    padEnd("LANE", COLS.lane),
    padEnd("ID", COLS.id),
    padEnd("TITLE", COLS.title),
    padEnd("STAGE", COLS.stage),
    padEnd("AGENT", COLS.agent),
    padEnd("HOST", COLS.host),
    padStart("AGE/TURN", COLS.ageTurn),
    padStart("TOKENS", COLS.tokens),
  ].join(" ");
  return `  ${s("90", "#", ansi)}   ${s("90", `${header}  LAST ACTIVITY`, ansi)}`;
}

function rowPrefix(
  index: number | null,
  marker: string,
  markerColor: string,
  ansi: boolean,
): string {
  const indexCell = index === null ? "  " : String(index).padStart(2);
  return ` ${s("90", indexCell, ansi)} ${s(markerColor, marker, ansi)} `;
}

function formatRunningRow(
  run: RunningEntry,
  index: number,
  now: Date,
  ansi: boolean,
  activityWidth: number,
): string {
  const color = rowColor(run.lastEvent);
  const ageTurn = `${formatMinutesSeconds(secondsBetween(now, run.startedAt))}/${run.turnCount}`;
  const activity = humanizeAgentMessage(run.lastMessage ?? null);
  return [
    `${rowPrefix(index <= 9 ? index : null, "▶", color, ansi)}${s("32", padEnd("run", COLS.lane), ansi)}`,
    styledCell("36", run.issueIdentifier, ansi, { padEnd: COLS.id }),
    styledCell("39", run.issueTitle || "untitled", ansi, { padEnd: COLS.title, max: COLS.title }),
    styledCell(color, runningStage(run), ansi, { padEnd: COLS.stage, max: COLS.stage }),
    styledCell("35", run.agentKind, ansi, { padEnd: COLS.agent }),
    styledCell("90", run.workerHost ?? "local", ansi, { padEnd: COLS.host, max: COLS.host }),
    s("35", padStart(ageTurn, COLS.ageTurn), ansi),
    s("33", padStart(formatInteger(run.usageTotals.totalTokens), COLS.tokens), ansi),
    ` ${styledCell("36", activity, ansi, { max: activityWidth })}`,
  ].join(" ");
}

function formatReservingRow(
  entry: NonNullable<RuntimeSnapshot["reserving"]>[number],
  now: Date,
  ansi: boolean,
  activityWidth: number,
): string {
  const age = formatDuration(secondsBetween(now, entry.reservedAtIso));
  const affinity = entry.affinityHost ? ` (prefers ${entry.affinityHost})` : "";
  return [
    `${rowPrefix(null, "◌", "90", ansi)}${s("90", padEnd("rsv", COLS.lane), ansi)}`,
    styledCell("36", entry.identifier, ansi, { padEnd: COLS.id }),
    styledCell("90", `reserving slot ${entry.slotIndex}`, ansi, {
      padEnd: COLS.title,
      max: COLS.title,
    }),
    s("90", padEnd("—", COLS.stage), ansi),
    s("90", padEnd("—", COLS.agent), ansi),
    styledCell("90", "(acquiring)", ansi, { padEnd: COLS.host }),
    s("90", padStart(age, COLS.ageTurn), ansi),
    s("90", padStart("—", COLS.tokens), ansi),
    ` ${styledCell("2", `acquiring worker${affinity}`, ansi, { max: activityWidth })}`,
  ].join(" ");
}

function formatRetryRow(
  retry: RuntimeSnapshot["retrying"][number],
  now: Date,
  ansi: boolean,
  activityWidth: number,
): string {
  const dueIn = `in ${formatDuration(secondsBetween(new Date(retry.dueAtIso), now))}`;
  return [
    `${rowPrefix(null, "↻", "38;5;208", ansi)}${s("38;5;208", padEnd("retry", COLS.lane), ansi)}`,
    styledCell("36", retry.issueIdentifier, ansi, { padEnd: COLS.id }),
    styledCell("33", `retry attempt ${retry.attempt}`, ansi, {
      padEnd: COLS.title,
      max: COLS.title,
    }),
    s("90", padEnd("—", COLS.stage), ansi),
    s("90", padEnd("—", COLS.agent), ansi),
    styledCell("90", retry.workerHost ?? "—", ansi, { padEnd: COLS.host, max: COLS.host }),
    s("38;5;208", padStart(dueIn, COLS.ageTurn), ansi),
    s("90", padStart("—", COLS.tokens), ansi),
    ` ${styledCell("2", retry.error ?? "cause unknown", ansi, { max: activityWidth })}`,
  ].join(" ");
}

function formatBlockedRow(block: unknown, ansi: boolean, activityWidth: number): string {
  if (!isRecord(block)) return `      ${terminalCell(String(block))}`;
  const identifier =
    stringAt(block, ["identifier"]) ??
    stringAt(block, ["issueIdentifier"]) ??
    stringAt(block, ["issue_identifier"]) ??
    "unknown";
  const state = stringAt(block, ["state"]) ?? "unknown";
  const reason = stringAt(block, ["reason"]) ?? "unknown";
  return [
    `${rowPrefix(null, "■", "33", ansi)}${s("33", padEnd("block", COLS.lane), ansi)}`,
    styledCell("36", identifier, ansi, { padEnd: COLS.id }),
    s("90", padEnd("—", COLS.title), ansi),
    styledCell("90", state, ansi, { padEnd: COLS.stage, max: COLS.stage }),
    s("90", padEnd("—", COLS.agent), ansi),
    s("90", padEnd("—", COLS.host), ansi),
    s("90", padStart("—", COLS.ageTurn), ansi),
    s("90", padStart("—", COLS.tokens), ansi),
    ` ${styledCell("33", reason.replaceAll("_", " "), ansi, { max: activityWidth })}`,
  ].join(" ");
}

/** The bottom log tape: recent runtime events, oldest first, newest at the bottom. */
function eventTapeLines(
  recentEvents: RuntimeSnapshot["recentEvents"] | undefined,
  options: DashboardFormatOptions,
  context: BoardContext,
  filterIdentifier: string | null,
): string[] {
  const { ansi, columns } = context;
  const limit = options.eventsLimit ?? DEFAULT_EVENTS_LIMIT;
  const label = filterIdentifier === null ? "events" : `events · ${filterIdentifier}`;
  const lines = [` ${b(label, ansi)}`];
  const filtered = (recentEvents ?? []).filter(
    (event) => filterIdentifier === null || event.message.includes(filterIdentifier),
  );
  if (filtered.length === 0) {
    lines.push(`   ${s("90", "no recent events", ansi)}`);
    return lines;
  }
  const messageWidth = Math.max(24, columns - (3 + 9 + EVENT_TYPE_WIDTH + 2));
  // recentEvents is newest-first; the tape reads downward toward "now".
  for (const event of filtered.slice(0, limit).reverse()) {
    lines.push(
      `   ${s("90", formatClockTime(event.at), ansi)} ${styledCell(eventColor(event.type), event.type, ansi, { padEnd: EVENT_TYPE_WIDTH, max: EVENT_TYPE_WIDTH })} ${styledCell("39", event.message, ansi, { max: messageWidth })}`,
    );
  }
  return lines;
}

function eventColor(type: string): string {
  if (type === "run_started" || type === "run_completed") return "32";
  if (/failed|error|stalled/.test(type)) return "31";
  if (type.startsWith("retry") || type === "dispatch_skipped") return "38;5;208";
  if (type.startsWith("workflow")) return "33";
  return "36";
}

function formatClockTime(iso: string): string {
  const time = sanitize(iso).slice(11, 19);
  return time.length === 8 ? time : "--:--:--";
}

function runningStage(run: RunningEntry): string {
  if ((run.lastEvent ?? "").toLowerCase().includes("retry")) return "retrying";
  const state = run.state.trim();
  const normalized = state.toLowerCase();
  if (normalized === "retrying" || normalized === "running") return normalized;
  return state || "unknown";
}

function rowColor(lastEvent: AgentUpdateType | null | undefined): string {
  if (lastEvent === null || lastEvent === undefined) return "31";
  switch (lastEvent) {
    case "turn_started":
      return "32";
    case "turn_completed":
      return "35";
    default:
      return "34";
  }
}

function formatLimitsLine(value: unknown, ansi: boolean, sep: string): string {
  if (value === null || value === undefined) return s("90", "rate limits unavailable", ansi);
  const model =
    stringAt(value, ["model"]) ?? stringAt(value, ["model_slug"]) ?? stringAt(value, ["modelSlug"]);
  const primary = formatRateBucket(value, "primary", ansi, true);
  const secondary = formatRateBucket(value, "secondary", ansi, false);
  const credits = formatCredits(valueAt(value, ["credits"]));
  if (!model && !primary && !secondary && !credits) return terminalCell(JSON.stringify(value));
  return [
    styledCell("33", model ?? "unknown", ansi),
    primary,
    secondary,
    credits ? styledCell("32", `credits ${credits}`, ansi) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(sep);
}

function formatRateBucket(
  value: unknown,
  key: string,
  ansi: boolean,
  gauge: boolean,
): string | null {
  const bucket = recordAt(value, [key]);
  if (!bucket) return null;
  const used = numberAt(bucket, ["used"]) ?? numberAt(bucket, ["remaining"]) ?? 0;
  const limit = numberAt(bucket, ["limit"]) ?? numberAt(bucket, ["total"]) ?? 0;
  const resetSeconds =
    numberAt(bucket, ["resetSeconds"]) ??
    numberAt(bucket, ["reset_seconds"]) ??
    numberAt(bucket, ["resetsInSeconds"]) ??
    0;
  const resets = `resets ${formatDuration(resetSeconds)}`;
  if (gauge && limit > 0) {
    const percent = Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
    const filled = Math.round(percent / 10);
    const color = percent >= 90 ? "31" : percent >= 75 ? "33" : "32";
    const bar = `${s(color, "█".repeat(filled), ansi)}${s("90", "░".repeat(10 - filled), ansi)}`;
    return `${s("90", `${key} `, ansi)}${bar} ${s(color, `${percent}%`, ansi)} ${s("90", resets, ansi)}`;
  }
  return s("36", `${key} ${formatInteger(used)}/${formatInteger(limit)} ${resets}`, ansi);
}

function formatPollLine(
  snapshot: RuntimeSnapshot,
  options: DashboardFormatOptions,
  now: Date,
  ansi: boolean,
  sep: string,
): string {
  const parts: string[] = [];
  if (snapshot.poll.nextPollAt) {
    const dueIn = formatDuration(secondsBetween(new Date(snapshot.poll.nextPollAt), now));
    parts.push(`${s("90", "poll in ", ansi)}${s("36", dueIn, ansi)}`);
  } else {
    parts.push(s("90", "poll n/a", ansi));
  }
  if (snapshot.poll.candidates > 0) {
    parts.push(
      `${s("90", "eligible ", ansi)}${s("36", `${snapshot.poll.eligible}/${snapshot.poll.candidates}`, ansi)}`,
    );
  }
  if (options.projectUrl) {
    parts.push(`${s("90", "project ", ansi)}${styledCell("36", options.projectUrl, ansi)}`);
  }
  if (options.dashboardUrl) {
    parts.push(
      `${s("90", "dash ", ansi)}${s("36", normalizeDashboardUrl(terminalCell(options.dashboardUrl)), ansi)}`,
    );
  }
  return parts.join(sep);
}

function formatCredits(value: unknown): string | null {
  if (value === null) return "none";
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(2);
  return null;
}

function normalizeDashboardUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  if (whole < 60) return `${whole}s`;
  return formatMinutesSeconds(whole);
}

function formatMinutesSeconds(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

function liveRuntimeSeconds(
  snapshot: RuntimeSnapshot,
  now: Date,
  snapshotReceivedAt: Date | undefined,
): number {
  const appStartedAt = coerceDate(snapshot.appStartedAt);
  if (appStartedAt) return Math.max(0, secondsBetween(now, appStartedAt));
  if (!snapshotReceivedAt || snapshot.running.length === 0) {
    return snapshot.usageTotals.secondsRunning;
  }
  const elapsedSinceSnapshot = Math.max(0, secondsBetween(now, snapshotReceivedAt));
  return snapshot.usageTotals.secondsRunning + elapsedSinceSnapshot;
}

function throughput(totalTokens: number, runtimeSeconds: number): number {
  if (runtimeSeconds <= 0) return 0;
  return Math.round(totalTokens / runtimeSeconds);
}

function initialThroughputState(): ThroughputState {
  return {
    tokenSamples: [],
    lastTpsSecond: null,
    lastTpsValue: 0,
    currentTps: 0,
  };
}

function updateThroughputState(
  state: ThroughputState,
  snapshot: RuntimeSnapshot,
  nowMs: number,
): ThroughputState {
  const currentTokens = snapshot.usageTotals.totalTokens;
  const tokenSamples = updateTokenSamples(state.tokenSamples, nowMs, currentTokens);
  const currentSecond = Math.floor(nowMs / 1000);
  if (state.lastTpsSecond === currentSecond) {
    return { ...state, tokenSamples, currentTps: state.lastTpsValue };
  }
  const currentTps = rollingThroughput(tokenSamples, nowMs, currentTokens);
  return {
    tokenSamples,
    lastTpsSecond: currentSecond,
    lastTpsValue: currentTps,
    currentTps,
  };
}

export function updateTokenSamples(
  samples: TokenSample[],
  nowMs: number,
  totalTokens: number,
): TokenSample[] {
  return pruneTokenSamples([{ timestampMs: nowMs, totalTokens }, ...samples], nowMs);
}

export function rollingThroughput(
  samples: TokenSample[],
  nowMs: number,
  currentTokens: number,
): number {
  const pruned = pruneTokenSamples(
    [{ timestampMs: nowMs, totalTokens: currentTokens }, ...samples],
    nowMs,
  );
  if (pruned.length < 2) return 0;
  const oldest = pruned[pruned.length - 1];
  if (!oldest) return 0;
  const elapsedMs = nowMs - oldest.timestampMs;
  const deltaTokens = Math.max(0, currentTokens - oldest.totalTokens);
  return elapsedMs <= 0 ? 0 : deltaTokens / (elapsedMs / 1000);
}

function pruneTokenSamples(samples: TokenSample[], nowMs: number): TokenSample[] {
  const minTimestampMs = nowMs - THROUGHPUT_WINDOW_MS;
  return samples.filter((sample) => sample.timestampMs >= minTimestampMs);
}

function secondsBetween(left: Date, right: Date | string): number {
  return (left.getTime() - new Date(right).getTime()) / 1000;
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function coerceDate(value: Date | string | number | undefined): Date | null {
  if (value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

function b(value: string, ansi: boolean): string {
  return s("1", value, ansi);
}

function s(code: string, value: string, ansi: boolean): string {
  return ansi ? `\x1b[${code}m${value}\x1b[0m` : value;
}

function padEnd(value: string, width: number): string {
  return value.padEnd(width);
}

function padStart(value: string, width: number): string {
  return value.padStart(width);
}

interface TerminalCellOptions {
  max?: number | undefined;
  padEnd?: number | undefined;
  padStart?: number | undefined;
}

function styledCell(
  code: string,
  value: string,
  ansi: boolean,
  options?: TerminalCellOptions,
): string {
  return s(code, terminalCell(value, options), ansi);
}

function terminalCell(value: string, options?: TerminalCellOptions): string {
  let cell = sanitize(value);
  if (options?.max !== undefined) cell = truncate(cell, options.max);
  if (options?.padEnd !== undefined) cell = cell.padEnd(options.padEnd);
  if (options?.padStart !== undefined) cell = cell.padStart(options.padStart);
  return cell;
}

const escapeCharacter = String.fromCharCode(27);
const asciiControlCharacters = `${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}`;
const ANSI_CONTROL_SEQUENCE = new RegExp(`${escapeCharacter}\\[[0-9;]*[A-Za-z]`, "g");
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${escapeCharacter}.`, "g");
const ASCII_CONTROL_CHARACTER = new RegExp(`[${asciiControlCharacters}]`, "g");

function sanitize(value: string): string {
  return value
    .replace(ANSI_CONTROL_SEQUENCE, "")
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(ASCII_CONTROL_CHARACTER, "")
    .trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: unknown, path: string[]): Record<string, unknown> | null {
  const found = valueAt(value, path);
  return isRecord(found) ? found : null;
}

function arrayAt(value: unknown, path: string[]): unknown[] | null {
  const found = valueAt(value, path);
  return Array.isArray(found) ? found : null;
}

function stringAt(value: unknown, path: string[]): string | null {
  const found = valueAt(value, path);
  return typeof found === "string" && found.trim() !== "" ? found : null;
}

function numberAt(value: unknown, path: string[]): number | null {
  const found = valueAt(value, path);
  return typeof found === "number" && Number.isFinite(found) ? found : null;
}

function valueAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}
