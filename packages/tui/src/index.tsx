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
  trackerKind,
  agentKind,
  maxAgents,
}: {
  runtime: RuntimeViewSource;
  dashboardUrl?: string | null | undefined;
  trackerKind?: string | undefined;
  agentKind?: string | undefined;
  maxAgents?: number | undefined;
}) {
  const runSamplesRef = useRef<Map<string, TokenSample[]>>(new Map());
  const globalSamplesRef = useRef<TokenSample[]>([]);
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(() => {
    const initial = runtime.snapshot();
    const startedAt = Date.now();
    recordRunSamples(runSamplesRef.current, initial, startedAt);
    globalSamplesRef.current = recordGlobalSample(globalSamplesRef.current, initial, startedAt);
    return initial;
  });
  const [throughputState, setThroughputState] = useState<ThroughputState>(() =>
    initialThroughputState(),
  );
  const [now, setNow] = useState<number>(() => Date.now());
  const [snapshotReceivedAt, setSnapshotReceivedAt] = useState<number>(() => Date.now());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [cursorState, setCursorState] = useState(0);
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
        globalSamplesRef.current = recordGlobalSample(
          globalSamplesRef.current,
          nextSnapshot,
          receivedAt,
        );
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

  const running = snapshot.running;
  const cursor = running.length === 0 ? 0 : Math.min(cursorState, running.length - 1);
  const selectedRun =
    selectedKey === null ? null : (running.find((run) => runKey(run) === selectedKey) ?? null);

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
      const liveRunning = snapshotRef.current.running;
      const inspecting = selectedKey !== null;
      if (inspecting) {
        if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
          setSelectedKey((current) => {
            if (current === null || liveRunning.length === 0) return current;
            const index = liveRunning.findIndex((run) => runKey(run) === current);
            const step = key.leftArrow || key.upArrow ? -1 : 1;
            const next = liveRunning[(index + step + liveRunning.length) % liveRunning.length];
            return next ? runKey(next) : null;
          });
          return;
        }
      } else {
        if (key.upArrow) {
          setCursorState((current) => Math.max(0, Math.min(current, liveRunning.length - 1) - 1));
          return;
        }
        if (key.downArrow) {
          setCursorState((current) => Math.min(Math.max(0, liveRunning.length - 1), current + 1));
          return;
        }
        if (key.return) {
          const run = liveRunning[Math.min(cursor, liveRunning.length - 1)];
          if (run) setSelectedKey(runKey(run));
          return;
        }
      }
      const digit = Number.parseInt(input, 10);
      if (!Number.isNaN(digit) && digit >= 1 && digit <= liveRunning.length) {
        const run = liveRunning[digit - 1];
        if (run) {
          setSelectedKey(runKey(run));
          setCursorState(digit - 1);
        }
      }
    },
    { isActive: interactive },
  );

  const shared = {
    dashboardUrl,
    trackerKind,
    agentKind,
    maxAgents,
    throughputTps: throughputState.currentTps,
    throughputSparkline: tokenRateSparkline(globalSamplesRef.current, now),
    throughputCumulative: cumulativeTokenSparkline(globalSamplesRef.current, now),
    now,
    snapshotReceivedAt,
    columns: stdout?.columns,
    rows: stdout?.rows,
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
              cumulative: cumulativeTokenSparkline(
                runSamplesRef.current.get(runKey(selectedRun)) ?? [],
                now,
              ),
              runTps: runTokensPerSecond(runSamplesRef.current.get(runKey(selectedRun)) ?? [], now),
            })
          : formatDashboard(snapshot, {
              ...shared,
              cursor: interactive ? cursor : undefined,
              runSparkline: (run) =>
                tokenRateSparkline(runSamplesRef.current.get(runKey(run)) ?? [], now),
            })}
      </Text>
    </Box>
  );
}

export function RuntimeDashboard({
  snapshot,
  throughputTps,
  dashboardUrl,
  trackerKind,
  agentKind,
  now,
  snapshotReceivedAt,
  columns,
  rows,
  maxAgents,
}: {
  snapshot: RuntimeSnapshot;
  throughputTps?: number | undefined;
  dashboardUrl?: string | null | undefined;
  trackerKind?: string | undefined;
  agentKind?: string | undefined;
  now?: Date | string | number | undefined;
  snapshotReceivedAt?: Date | string | number | undefined;
  columns?: number | undefined;
  rows?: number | undefined;
  maxAgents?: number | undefined;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        {formatDashboard(snapshot, {
          dashboardUrl,
          trackerKind,
          agentKind,
          throughputTps,
          now,
          snapshotReceivedAt,
          columns,
          rows,
          maxAgents,
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

/** Rolling fleet-wide token samples backing the header throughput sparkline. */
function recordGlobalSample(
  samples: TokenSample[],
  snapshot: RuntimeSnapshot,
  nowMs: number,
): TokenSample[] {
  return [
    { timestampMs: nowMs, totalTokens: snapshot.usageTotals.totalTokens },
    ...samples.filter((sample) => sample.timestampMs >= nowMs - RUN_SAMPLE_WINDOW_MS),
  ];
}

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

/**
 * Cumulative *total* histogram over the trailing minute: each glyph is the
 * running token total at that bucket, scaled across the window's min..max. It
 * reads as a rising staircase — the growth curve — pairing with the rate
 * histogram (how fast) to show how much has accumulated (how much).
 */
export function cumulativeTokenSparkline(
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
  const totals: number[] = [];
  for (let index = 0; index < buckets; index++) {
    totals.push(tokensAt(start + (index + 1) * bucketMs));
  }
  const min = Math.min(...totals);
  const max = Math.max(...totals);
  if (max <= min) return flat;
  return totals
    .map((total) => {
      const level = Math.min(
        SPARKLINE_LEVELS.length - 1,
        Math.round(((total - min) / (max - min)) * (SPARKLINE_LEVELS.length - 1)),
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

// --- Responsive column layout ---------------------------------------------------

export interface DashboardFormatOptions {
  ansi?: boolean | undefined;
  /** Terminal width the board fills; defaults to 132, floors at 60. */
  columns?: number | undefined;
  /** Terminal height; when set, the table windows itself and the tape shrinks to fit. */
  rows?: number | undefined;
  /** Highlighted running-row index (interactive cursor). */
  cursor?: number | undefined;
  dashboardUrl?: string | null | undefined;
  /** How many events the bottom tape shows; defaults to 6, shrinks under height pressure. */
  eventsLimit?: number | undefined;
  /** Render the key-binding hint line (interactive TTY sessions only). */
  interactive?: boolean | undefined;
  /** Configured concurrency cap; rendered next to the running count only when known. */
  maxAgents?: number | undefined;
  now?: Date | string | number | undefined;
  /** Configured tracker kind (e.g. "linear"); shown in the header identity. */
  trackerKind?: string | undefined;
  /** Configured default agent kind (e.g. "codex"); shown in the header identity. */
  agentKind?: string | undefined;
  /** Per-running-row token-rate histogram; the RATE column renders only when given. */
  runSparkline?: ((run: RuntimeSnapshot["running"][number]) => string) | undefined;
  runtimeSeconds?: number | undefined;
  snapshotReceivedAt?: Date | string | number | undefined;
  /** Rolling global token-rate histogram shown beside the tps figure. */
  throughputSparkline?: string | undefined;
  /** Rolling cumulative-total token histogram shown beside the total-tokens figure. */
  throughputCumulative?: string | undefined;
  throughputTps?: number | undefined;
}

export interface AgentDetailOptions extends DashboardFormatOptions {
  /** Token-rate histogram for the inspected run (see {@link tokenRateSparkline}). */
  sparkline?: string | undefined;
  /** Cumulative-total token histogram for the inspected run. */
  cumulative?: string | undefined;
  /** Current tokens/second for the inspected run. */
  runTps?: number | undefined;
}

const DEFAULT_COLUMNS = 132;
const MIN_COLUMNS = 60;
const MIN_ROWS = 16;
const DEFAULT_EVENTS_LIMIT = 6;
const MIN_EVENTS = 2;
const EVENT_TYPE_WIDTH = 18;
const WIDE_GAP_COLUMNS = 150;

type ColumnKey =
  | "lane"
  | "id"
  | "title"
  | "stage"
  | "agent"
  | "host"
  | "ageTurn"
  | "tokens"
  | "spark"
  | "activity";

interface ColumnSpec {
  key: ColumnKey;
  label: string;
  min: number;
  max: number;
  align: "left" | "right";
  /** Higher survives longer as the viewport narrows; Infinity is never dropped. */
  priority: number;
  /** Share of surplus width when the viewport is wide; 0 is fixed-width. */
  flex: number;
}

// Display order. Under width pressure the lowest-priority columns disappear
// first (lane word, then host, agent, stage, tokens): the row marker + color
// keep encoding the lane, so narrow boards lose detail, not meaning.
const COLUMN_SPECS: ColumnSpec[] = [
  { key: "lane", label: "LANE", min: 5, max: 5, align: "left", priority: 40, flex: 0 },
  { key: "id", label: "ID", min: 9, max: 12, align: "left", priority: Infinity, flex: 0 },
  { key: "title", label: "TITLE", min: 14, max: 44, align: "left", priority: Infinity, flex: 3 },
  { key: "stage", label: "STAGE", min: 9, max: 13, align: "left", priority: 60, flex: 1 },
  { key: "agent", label: "AGENT", min: 6, max: 6, align: "left", priority: 55, flex: 0 },
  { key: "host", label: "HOST", min: 8, max: 14, align: "left", priority: 50, flex: 1 },
  { key: "ageTurn", label: "AGE/TURN", min: 9, max: 11, align: "right", priority: 70, flex: 0 },
  { key: "tokens", label: "TOKENS", min: 7, max: 9, align: "right", priority: 65, flex: 0 },
  { key: "spark", label: "RATE", min: 10, max: 10, align: "left", priority: 45, flex: 0 },
  {
    key: "activity",
    label: "LAST ACTIVITY",
    min: 14,
    max: 64,
    align: "left",
    priority: Infinity,
    flex: 4,
  },
];

interface TableLayout {
  columns: Array<{ spec: ColumnSpec; width: number }>;
  gap: number;
  indexWidth: number;
  prefixWidth: number;
}

/**
 * Fit the table to the viewport: drop low-priority columns until the minimum
 * widths fit, then hand surplus width to flexible columns (activity and title
 * first). Whatever remains after every column hits its cap stays as negative
 * space instead of being crammed with more data.
 */
function computeLayout(columns: number, runningCount: number, includeSpark: boolean): TableLayout {
  const gap = columns >= WIDE_GAP_COLUMNS ? 2 : 1;
  const indexWidth = Math.max(1, String(Math.max(1, runningCount)).length);
  const prefixWidth = indexWidth + 4; // "▸ 12 ▶ " = cursor + index + marker cells
  const available = columns - prefixWidth;

  const active = COLUMN_SPECS.filter((spec) => includeSpark || spec.key !== "spark").map(
    (spec) => ({ spec, width: spec.min }),
  );
  const needed = () => active.reduce((sum, col) => sum + col.width, 0) + gap * (active.length - 1);
  while (needed() > available && active.some((col) => col.spec.priority !== Infinity)) {
    let lowest = 0;
    for (let index = 1; index < active.length; index++) {
      const candidate = active[index];
      const current = active[lowest];
      if (candidate && current && candidate.spec.priority < current.spec.priority) lowest = index;
    }
    active.splice(lowest, 1);
  }

  let surplus = available - needed();
  const flexOrder = [...active]
    .filter((col) => col.spec.flex > 0)
    .sort((a, b) => b.spec.flex - a.spec.flex);
  while (surplus > 0) {
    let grew = false;
    for (const col of flexOrder) {
      for (let unit = 0; unit < col.spec.flex && surplus > 0; unit++) {
        if (col.width < col.spec.max) {
          col.width += 1;
          surplus -= 1;
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
  return { columns: active, gap, indexWidth, prefixWidth };
}

interface Cell {
  text: string;
  color: string;
  truncate?: boolean;
}

function tableRow(
  layout: TableLayout,
  ansi: boolean,
  index: string | null,
  marker: string,
  markerColor: string,
  cursor: boolean,
  cells: Partial<Record<ColumnKey, Cell>>,
): string {
  const prefix = `${s("36;1", cursor ? "▸" : " ", ansi)}${s(cursor ? "36;1" : "90", (index ?? "").padStart(layout.indexWidth), ansi)} ${s(markerColor, marker, ansi)} `;
  const rendered = layout.columns.map(({ spec, width }) => {
    const cell = cells[spec.key] ?? { text: "—", color: "90" };
    const options: TerminalCellOptions =
      spec.align === "right"
        ? { padStart: width, max: width }
        : { padEnd: width, max: cell.truncate === false ? undefined : width };
    return styledCell(cell.color, cell.text, ansi, options);
  });
  return prefix + rendered.join(" ".repeat(layout.gap));
}

function tableHeader(layout: TableLayout, ansi: boolean): string {
  const prefix = ` ${"#".padStart(layout.indexWidth)}   `;
  const header = layout.columns
    .map(({ spec, width }) =>
      spec.align === "right"
        ? spec.label.padStart(width)
        : truncate(spec.label, width).padEnd(width),
    )
    .join(" ".repeat(layout.gap));
  return s("90", prefix + header, ansi);
}

// --- Flight-board formatter ----------------------------------------------------

interface BoardContext {
  ansi: boolean;
  columns: number;
  now: Date;
}

interface BoardRow {
  line: string;
  lane: "run" | "rsv" | "retry" | "block";
}

export function formatDashboard(
  snapshot: RuntimeSnapshot,
  options: DashboardFormatOptions = {},
): string {
  const context = boardContext(options);
  const { ansi, columns, now } = context;
  const layout = computeLayout(
    columns,
    snapshot.running.length,
    options.runSparkline !== undefined,
  );
  const header = headerLines(snapshot, options, context);
  const lines: string[] = [...header];

  const reserving = snapshot.reserving ?? [];
  const blockedList: unknown[] =
    snapshot.blocked.length > 0
      ? snapshot.blocked
      : (arrayAt(snapshot, ["dispatchBlocks"]) ?? arrayAt(snapshot, ["dispatch_blocks"]) ?? []);

  const tableRows: BoardRow[] = [
    ...snapshot.running.map((run, index) => ({
      line: formatRunningRow(
        run,
        index + 1,
        options.cursor === index,
        now,
        ansi,
        layout,
        options.runSparkline,
      ),
      lane: "run" as const,
    })),
    ...reserving.map((entry) => ({
      line: formatReservingRow(entry, now, ansi, layout),
      lane: "rsv" as const,
    })),
    ...snapshot.retrying.map((entry) => ({
      line: formatRetryRow(entry, now, ansi, layout),
      lane: "retry" as const,
    })),
    ...blockedList.map((entry) => ({
      line: formatBlockedRow(entry, ansi, layout),
      lane: "block" as const,
    })),
  ];

  // Vertical budget: the table gets the viewport minus chrome; the tape keeps
  // at least MIN_EVENTS lines and gives the rest back to the table.
  const eventsLimit = options.eventsLimit ?? DEFAULT_EVENTS_LIMIT;
  let tapeLimit = eventsLimit;
  let visible = tableRows;
  let aboveLine: string | null = null;
  let belowLine: string | null = null;
  if (options.rows !== undefined && tableRows.length > 0) {
    const usable = Math.max(MIN_ROWS, options.rows) - 2;
    const chrome = header.length + 3 + 1 + 1 + (options.interactive === true ? 1 : 0);
    const remaining = Math.max(MIN_EVENTS + 1, usable - chrome);
    tapeLimit = Math.min(eventsLimit, Math.max(MIN_EVENTS, remaining - tableRows.length));
    let budget = remaining - tapeLimit;
    if (tableRows.length > budget) {
      budget = Math.max(1, budget - 2);
      const cursor = Math.min(options.cursor ?? 0, tableRows.length - 1);
      const start = Math.max(
        0,
        Math.min(cursor - Math.floor(budget / 2), tableRows.length - budget),
      );
      const end = start + budget;
      visible = tableRows.slice(start, end);
      if (start > 0) {
        aboveLine = s("90", `${" ".repeat(layout.prefixWidth)}↑ ${start} more`, ansi);
      }
      if (end < tableRows.length) {
        belowLine = s(
          "90",
          `${" ".repeat(layout.prefixWidth)}↓ ${tableRows.length - end} more ${laneSummary(tableRows.slice(end))}`,
          ansi,
        );
      }
    }
  }

  lines.push(rule(columns, ansi));
  lines.push(tableHeader(layout, ansi));
  lines.push(rule(columns, ansi));
  if (tableRows.length === 0) {
    lines.push(`${" ".repeat(layout.prefixWidth)}${s("90", "no work in flight", ansi)}`);
  } else {
    if (aboveLine) lines.push(aboveLine);
    for (const row of visible) lines.push(row.line);
    if (belowLine) lines.push(belowLine);
  }

  lines.push(rule(columns, ansi));
  lines.push(...eventTapeLines(snapshot.recentEvents, tapeLimit, context, null));
  if (options.interactive === true) {
    lines.push(hintLine(["↑/↓ select", "⏎ inspect", "1-9 jump", "q quit"], ansi));
  }
  return `${lines.join("\n")}\n`;
}

function laneSummary(rows: BoardRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.lane, (counts.get(row.lane) ?? 0) + 1);
  const parts = [...counts.entries()].map(([lane, count]) => `${count} ${lane}`);
  return `(${parts.join(" · ")})`;
}

function hintLine(hints: string[], ansi: boolean): string {
  return ` ${hints
    .map((hint) => {
      const [keys, ...rest] = hint.split(" ");
      return `${s("36", keys ?? "", ansi)}${s("90", ` ${rest.join(" ")}`, ansi)}`;
    })
    .join(s("90", " · ", ansi))}`;
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

  lines.push(rule(columns, ansi));
  const id = terminalCell(run.issueIdentifier);
  lines.push(
    ` ${s(color, "▶", ansi)} ${s("36;1", id, ansi)}${sep}${styledCell("1", run.issueTitle || "untitled", ansi, { max: Math.max(16, columns - id.length - 6) })}`,
  );
  lines.push(
    fitLine(
      `   ${s("90", "stage ", ansi)}${styledCell(color, runningStage(run), ansi)}`,
      [
        `${s("90", "agent ", ansi)}${styledCell("35", run.agentKind, ansi)}`,
        `${s("90", "host ", ansi)}${styledCell("39", run.workerHost ?? "local", ansi)}`,
        `${s("90", "slot ", ansi)}${s("39", String(run.slotIndex), ansi)}`,
        ...(run.retryAttempt ? [s("38;5;208", `retry attempt ${run.retryAttempt}`, ansi)] : []),
      ],
      sep,
      columns,
    ),
  );
  const lastEventAgo = run.lastEventAt
    ? `${formatDuration(secondsBetween(now, run.lastEventAt))} ago`
    : "n/a";
  lines.push(
    fitLine(
      `   ${s("90", "turn ", ansi)}${s("35", String(run.turnCount), ansi)}`,
      [
        `${s("90", "age ", ansi)}${s("35", formatMinutesSeconds(secondsBetween(now, run.startedAt)), ansi)}`,
        `${s("90", "tools ", ansi)}${s("32", formatInteger(run.toolCallCount ?? 0), ansi)}`,
        `${s("90", "last event ", ansi)}${styledCell("39", String(run.lastEvent ?? "none"), ansi)} ${s("90", lastEventAgo, ansi)}`,
      ],
      sep,
      columns,
    ),
  );
  const rate = options.runTps !== undefined ? `${formatInteger(options.runTps)} tps` : null;
  lines.push(
    fitLine(
      `   ${s("90", "tokens ", ansi)}${s("33", formatInteger(run.usageTotals.totalTokens), ansi)}`,
      [
        s(
          "90",
          `in ${formatInteger(run.usageTotals.inputTokens)} / out ${formatInteger(run.usageTotals.outputTokens)}`,
          ansi,
        ),
        ...(options.sparkline
          ? [
              `${s("90", "rate ", ansi)}${s("32", options.sparkline, ansi)}${rate ? ` ${s("36", rate, ansi)}` : ""}`,
            ]
          : []),
        ...(options.cumulative
          ? [
              `${s("90", "total ", ansi)}${s("32", options.cumulative, ansi)} ${s("90", "(last 60s)", ansi)}`,
            ]
          : []),
      ],
      sep,
      columns,
    ),
  );
  lines.push(
    fitLine(
      `   ${s("90", "session ", ansi)}${styledCell("36", run.sessionId ?? "n/a", ansi, { max: Math.max(12, columns - 14) })}`,
      [`${s("90", "pid ", ansi)}${styledCell("39", run.executorPid ?? "n/a", ansi)}`],
      sep,
      columns,
    ),
  );
  if (run.workspacePath) {
    lines.push(
      `   ${s("90", "workspace ", ansi)}${styledCell("39", run.workspacePath, ansi, { max: Math.max(16, columns - 14) })}`,
    );
  }
  if (run.issueUrl) {
    lines.push(
      `   ${s("90", "issue ", ansi)}${styledCell("36", run.issueUrl, ansi, { max: Math.max(16, columns - 10) })}`,
    );
  }
  lines.push(
    `   ${s(color, "▸ ", ansi)}${styledCell(color, humanizeAgentMessage(run.lastMessage ?? null), ansi, { max: Math.max(16, columns - 6) })}`,
  );

  let tapeLimit = options.eventsLimit ?? DEFAULT_EVENTS_LIMIT;
  if (options.rows !== undefined) {
    const usable = Math.max(MIN_ROWS, options.rows) - 2;
    const chrome = lines.length + 2 + (options.interactive === true ? 1 : 0);
    tapeLimit = Math.min(tapeLimit, Math.max(MIN_EVENTS, usable - chrome));
  }
  lines.push(rule(columns, ansi));
  lines.push(...eventTapeLines(snapshot.recentEvents, tapeLimit, context, run.issueIdentifier));
  if (options.interactive === true) {
    lines.push(hintLine(["←/→ switch agent", "esc board", "q quit"], ansi));
  }
  return `${lines.join("\n")}\n`;
}

function boardContext(options: DashboardFormatOptions): BoardContext {
  return {
    ansi: options.ansi === true,
    columns: Math.max(MIN_COLUMNS, options.columns ?? DEFAULT_COLUMNS),
    now: coerceDate(options.now) ?? new Date(),
  };
}

/** Append optional segments while the line still fits the viewport. */
function fitLine(mandatory: string, optional: string[], sep: string, columns: number): string {
  let line = mandatory;
  for (const part of optional) {
    const candidate = `${line}${sep}${part}`;
    if (visibleLength(candidate) > columns) break;
    line = candidate;
  }
  return line;
}

function visibleLength(value: string): number {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function headerLines(
  snapshot: RuntimeSnapshot,
  options: DashboardFormatOptions,
  context: BoardContext,
): string[] {
  const { ansi, columns, now } = context;
  const snapshotReceivedAt = coerceDate(options.snapshotReceivedAt) ?? undefined;
  const runtimeSeconds =
    options.runtimeSeconds ?? liveRuntimeSeconds(snapshot, now, snapshotReceivedAt);
  const throughputTps =
    options.throughputTps ?? throughput(snapshot.usageTotals.totalTokens, runtimeSeconds);
  const sep = s("90", " · ", ansi);
  const blocked = Math.max(
    snapshot.blocked.length,
    arrayAt(snapshot, ["dispatchBlocks"])?.length ??
      arrayAt(snapshot, ["dispatch_blocks"])?.length ??
      0,
  );

  // Line 1: the fleet issue bar spans the full width of the header. The
  // configured concurrency cap rides the "active" legend, so the running count
  // is not repeated as a separate stat.
  const status = renderStatusBar(snapshot, blocked, options.maxAgents, ansi, columns - 2);
  const barLine = ` ${status.bar} `;

  // Line 2: identity on the left (LORENZ + configured tracker/agent kind),
  // operational vitals right-aligned.
  const kinds = [options.trackerKind, options.agentKind]
    .filter((kind): kind is string => typeof kind === "string" && kind.trim() !== "")
    .map((kind) => terminalCell(kind));
  const identity =
    kinds.length > 0
      ? ` ${b("LORENZ", ansi)}${sep}${s("36", kinds.join("/"), ansi)}`
      : ` ${b("LORENZ", ansi)}`;
  const opsParts = [
    `${s("90", "up ", ansi)}${s("35", formatMinutesSeconds(runtimeSeconds), ansi)}`,
    formatPollPart(snapshot, now, ansi),
    ...(options.dashboardUrl
      ? [
          `${s("90", "dash ", ansi)}${s("36", normalizeDashboardUrl(terminalCell(options.dashboardUrl)), ansi)}`,
        ]
      : []),
  ];
  const identityLine = joinRight(identity, opsParts, sep, columns);

  // Line 3: the status-bar legend on the left; the paired throughput charts
  // (moving rate + cumulative total) with their numerics on the right.
  const legendLine =
    status.legend.length > 0
      ? fitLine(` ${status.legend[0]}`, status.legend.slice(1), sep, columns)
      : ` ${s("90", "no issues tracked", ansi)}`;
  const rateChart = options.throughputSparkline
    ? `${s("90", "rate ", ansi)}${s("32", options.throughputSparkline, ansi)} ${s("36", `${formatInteger(throughputTps)} tps`, ansi)}`
    : `${s("90", "rate ", ansi)}${s("36", `${formatInteger(throughputTps)} tps`, ansi)}`;
  const totalChart = `${s("90", "total ", ansi)}${
    options.throughputCumulative ? `${s("32", options.throughputCumulative, ansi)} ` : ""
  }${s("33", formatInteger(snapshot.usageTotals.totalTokens), ansi)}${s("90", " tok", ansi)}`;
  const inOut = s(
    "90",
    `in ${formatInteger(snapshot.usageTotals.inputTokens)} / out ${formatInteger(snapshot.usageTotals.outputTokens)}`,
    ansi,
  );
  const chartsLine = joinRight(legendLine, [rateChart, totalChart, inOut], sep, columns);

  return [barLine, identityLine, chartsLine];
}

/** Greedily join parts with a separator while the budget allows. */
function fitParts(parts: string[], sep: string, budget: number): string {
  let joined = "";
  for (const part of parts) {
    const candidate = joined === "" ? part : `${joined}${sep}${part}`;
    if (visibleLength(candidate) > budget) break;
    joined = candidate;
  }
  return joined;
}

/** Left content, right content, and whatever viewport is left as negative space. */
function joinRight(left: string, rightParts: string[], sep: string, columns: number): string {
  const right = fitParts(rightParts, sep, columns - visibleLength(left) - 2);
  if (right === "") return left;
  const padding = columns - visibleLength(left) - visibleLength(right);
  return `${left}${" ".repeat(Math.max(2, padding))}${right}`;
}

interface StatusSegment {
  count: number;
  color: string;
  char: string;
  label: string;
  labelColor: string;
}

/**
 * The full-width stacked bar over every issue the runtime can see, ordered as
 * a pipeline: terminal states reached in this orchestrator instantiation
 * (muted green, ✓ and ✗ alike — the legend keeps the split), active runs
 * (green), pending lanes that are retrying/backing off (orange), and the
 * remaining dispatchable backlog (muted grey, hollow). Fills exactly
 * `barWidth` cells; every non-zero status keeps at least one cell, and the
 * rest is proportional.
 */
function renderStatusBar(
  snapshot: RuntimeSnapshot,
  blockedCount: number,
  maxAgents: number | undefined,
  ansi: boolean,
  barWidth: number,
): { bar: string; legend: string[] } {
  const width = Math.max(1, barWidth);
  const history = snapshot.runHistory ?? [];
  const done = history.filter((entry) => entry.outcome === "success").length;
  const failed = history.length - done;
  const active = snapshot.running.length;
  const activeLabel =
    maxAgents !== undefined ? `${active}/${maxAgents} active` : `${active} active`;
  const pending = (snapshot.reserving?.length ?? 0) + snapshot.retrying.length + blockedCount;
  // Eligible issues not yet claimed by a live lane are the dispatchable backlog.
  const backlog = Math.max(0, snapshot.poll.eligible - blockedCount);
  const segments: StatusSegment[] = [
    {
      count: history.length,
      color: "2;32",
      char: "█",
      label: failed > 0 ? `${done}✓ ${failed}✗` : `${done}✓`,
      labelColor: "2;32",
    },
    { count: active, color: "92", char: "█", label: activeLabel, labelColor: "92" },
    {
      count: pending,
      color: "38;5;208",
      char: "█",
      label: `${pending} pending`,
      labelColor: "38;5;208",
    },
    { count: backlog, color: "90", char: "░", label: `${backlog} backlog`, labelColor: "90" },
  ];
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  if (total === 0) {
    return { bar: s("90", "░".repeat(width), ansi), legend: [] };
  }
  const widths = segments.map((segment) =>
    segment.count === 0 ? 0 : Math.max(1, Math.round((segment.count / total) * width)),
  );
  // Nudge the largest segment until the bar is exactly `width` cells.
  let drift = widths.reduce((sum, value) => sum + value, 0) - width;
  while (drift !== 0) {
    const index = widths.indexOf(Math.max(...widths));
    const cell = widths[index] ?? 0;
    if (drift > 0 && cell > 1) {
      widths[index] = cell - 1;
      drift -= 1;
    } else if (drift < 0) {
      widths[index] = cell + 1;
      drift += 1;
    } else {
      break;
    }
  }
  const bar = segments
    .map((segment, index) => s(segment.color, segment.char.repeat(widths[index] ?? 0), ansi))
    .join("");
  const legend = segments
    .filter((segment) => segment.count > 0)
    .map((segment) => s(segment.labelColor, segment.label, ansi));
  return { bar, legend };
}

function rule(columns: number, ansi: boolean): string {
  return s("90", "─".repeat(columns), ansi);
}

function formatRunningRow(
  run: RunningEntry,
  index: number,
  cursor: boolean,
  now: Date,
  ansi: boolean,
  layout: TableLayout,
  runSparkline: DashboardFormatOptions["runSparkline"],
): string {
  const color = rowColor(run.lastEvent);
  const ageTurn = `${formatMinutesSeconds(secondsBetween(now, run.startedAt))}/${run.turnCount}`;
  return tableRow(layout, ansi, String(index), "▶", color, cursor, {
    lane: { text: "run", color: "32" },
    id: { text: run.issueIdentifier, color: cursor ? "36;1" : "36" },
    title: { text: run.issueTitle || "untitled", color: "39" },
    stage: { text: runningStage(run), color },
    agent: { text: run.agentKind, color: "35" },
    host: { text: run.workerHost ?? "local", color: "90" },
    ageTurn: { text: ageTurn, color: "35" },
    tokens: { text: formatInteger(run.usageTotals.totalTokens), color: "33" },
    ...(runSparkline ? { spark: { text: runSparkline(run), color: "32" } } : {}),
    activity: { text: humanizeAgentMessage(run.lastMessage ?? null), color: "36" },
  });
}

function formatReservingRow(
  entry: NonNullable<RuntimeSnapshot["reserving"]>[number],
  now: Date,
  ansi: boolean,
  layout: TableLayout,
): string {
  const age = formatDuration(secondsBetween(now, entry.reservedAtIso));
  const affinity = entry.affinityHost ? ` (prefers ${entry.affinityHost})` : "";
  return tableRow(layout, ansi, null, "◌", "90", false, {
    lane: { text: "rsv", color: "90" },
    id: { text: entry.identifier, color: "36" },
    title: { text: `reserving slot ${entry.slotIndex}`, color: "90" },
    host: { text: "(acquiring)", color: "90" },
    ageTurn: { text: age, color: "90" },
    activity: { text: `acquiring worker${affinity}`, color: "2" },
  });
}

function formatRetryRow(
  retry: RuntimeSnapshot["retrying"][number],
  now: Date,
  ansi: boolean,
  layout: TableLayout,
): string {
  const dueIn = `in ${formatDuration(secondsBetween(new Date(retry.dueAtIso), now))}`;
  return tableRow(layout, ansi, null, "↻", "38;5;208", false, {
    lane: { text: "retry", color: "38;5;208" },
    id: { text: retry.issueIdentifier, color: "36" },
    title: { text: `retry attempt ${retry.attempt}`, color: "33" },
    ...(retry.workerHost ? { host: { text: retry.workerHost, color: "90" } } : {}),
    ageTurn: { text: dueIn, color: "38;5;208" },
    activity: { text: retry.error ?? "cause unknown", color: "2" },
  });
}

function formatBlockedRow(block: unknown, ansi: boolean, layout: TableLayout): string {
  if (!isRecord(block)) return `${" ".repeat(layout.prefixWidth)}${terminalCell(String(block))}`;
  const identifier =
    stringAt(block, ["identifier"]) ??
    stringAt(block, ["issueIdentifier"]) ??
    stringAt(block, ["issue_identifier"]) ??
    "unknown";
  const state = stringAt(block, ["state"]) ?? "unknown";
  const reason = stringAt(block, ["reason"]) ?? "unknown";
  return tableRow(layout, ansi, null, "■", "33", false, {
    lane: { text: "block", color: "33" },
    id: { text: identifier, color: "36" },
    stage: { text: state, color: "90" },
    activity: { text: reason.replaceAll("_", " "), color: "33" },
  });
}

/** The bottom log tape: recent runtime events, oldest first, newest at the bottom. */
function eventTapeLines(
  recentEvents: RuntimeSnapshot["recentEvents"] | undefined,
  limit: number,
  context: BoardContext,
  filterIdentifier: string | null,
): string[] {
  const { ansi, columns } = context;
  const label = filterIdentifier === null ? "events" : `events · ${filterIdentifier}`;
  const lines = [` ${b(label, ansi)}`];
  const filtered = (recentEvents ?? []).filter(
    (event) => filterIdentifier === null || event.message.includes(filterIdentifier),
  );
  if (filtered.length === 0) {
    lines.push(`   ${s("90", "no recent events", ansi)}`);
    return lines;
  }
  const typeWidth = columns < 90 ? 0 : EVENT_TYPE_WIDTH;
  const messageWidth = Math.max(24, columns - (3 + 9 + typeWidth + 2));
  // recentEvents is newest-first; the tape reads downward toward "now".
  for (const event of filtered.slice(0, limit).reverse()) {
    const type =
      typeWidth === 0
        ? ""
        : `${styledCell(eventColor(event.type), event.type, ansi, { padEnd: typeWidth, max: typeWidth })} `;
    lines.push(
      `   ${s("90", formatClockTime(event.at), ansi)} ${type}${styledCell("39", event.message, ansi, { max: messageWidth })}`,
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

function formatPollPart(snapshot: RuntimeSnapshot, now: Date, ansi: boolean): string {
  if (snapshot.poll.nextPollAt) {
    const dueIn = formatDuration(secondsBetween(new Date(snapshot.poll.nextPollAt), now));
    return `${s("90", "poll in ", ansi)}${s("36", dueIn, ansi)}`;
  }
  return s("90", "poll n/a", ansi);
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

function arrayAt(value: unknown, path: string[]): unknown[] | null {
  const found = valueAt(value, path);
  return Array.isArray(found) ? found : null;
}

function stringAt(value: unknown, path: string[]): string | null {
  const found = valueAt(value, path);
  return typeof found === "string" && found.trim() !== "" ? found : null;
}

function valueAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}
