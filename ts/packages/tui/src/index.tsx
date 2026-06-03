import React, { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import { humanizeAgentMessage } from "@symphony/humanize";
import type { AgentUpdateType } from "@symphony/domain";
import type { RuntimeSnapshot } from "@symphony/runtime-events";

const REFRESH_INTERVAL_MS = 250;

export interface RuntimeViewSource {
  snapshot(): RuntimeSnapshot;
  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void;
}

export {
  humanizeAgentMessage,
  humanizeCodexMessage,
  humanizeClaudeMessage,
} from "@symphony/humanize";

export function RuntimeApp({
  runtime,
  dashboardUrl,
  projectUrl,
}: {
  runtime: RuntimeViewSource;
  dashboardUrl?: string | null | undefined;
  projectUrl?: string | undefined;
}) {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(() => runtime.snapshot());
  const [throughputState, setThroughputState] = useState<ThroughputState>(() =>
    initialThroughputState(),
  );
  const [now, setNow] = useState<number>(() => Date.now());
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  useEffect(
    () =>
      runtime.subscribe((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        setThroughputState((state) => updateThroughputState(state, nextSnapshot, Date.now()));
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

  return (
    <RuntimeDashboard
      snapshot={snapshot}
      throughputTps={throughputState.currentTps}
      dashboardUrl={dashboardUrl}
      projectUrl={projectUrl}
      now={now}
    />
  );
}

export function RuntimeDashboard({
  snapshot,
  throughputTps,
  dashboardUrl,
  projectUrl,
  now,
}: {
  snapshot: RuntimeSnapshot;
  throughputTps?: number | undefined;
  dashboardUrl?: string | null | undefined;
  projectUrl?: string | undefined;
  now?: Date | string | number | undefined;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        {formatElixirStyleDashboard(snapshot, {
          dashboardUrl,
          projectUrl,
          throughputTps,
          now,
          ansi: true,
        })}
      </Text>
    </Box>
  );
}

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

export interface DashboardFormatOptions {
  ansi?: boolean | undefined;
  dashboardUrl?: string | null | undefined;
  maxAgents?: number | undefined;
  now?: Date | string | number | undefined;
  projectUrl?: string | undefined;
  runtimeSeconds?: number | undefined;
  throughputTps?: number | undefined;
}

export function formatElixirStyleDashboard(
  snapshot: RuntimeSnapshot,
  options: DashboardFormatOptions = {},
): string {
  const ansi = options.ansi === true;
  const now = coerceDate(options.now) ?? new Date();
  const maxAgents = options.maxAgents ?? 10;
  const runtimeSeconds = options.runtimeSeconds ?? liveRuntimeSeconds(snapshot, now);
  const throughputTps =
    options.throughputTps ?? throughput(snapshot.usageTotals.totalTokens, runtimeSeconds);
  const lines = [
    b("╭─ SYMPHONY STATUS", ansi),
    `${b("│ Agents: ", ansi)}${s("32", String(snapshot.running.length), ansi)}${s("90", "/", ansi)}${s("90", String(maxAgents), ansi)}`,
    `${b("│ Throughput: ", ansi)}${s("36", `${formatInteger(throughputTps)} tps`, ansi)}`,
    `${b("│ Runtime: ", ansi)}${s("35", formatMinutesSeconds(runtimeSeconds), ansi)}`,
    `${b("│ Tokens: ", ansi)}${s("33", `in ${formatInteger(snapshot.usageTotals.inputTokens)}`, ansi)}${s("90", " | ", ansi)}${s("33", `out ${formatInteger(snapshot.usageTotals.outputTokens)}`, ansi)}${s("90", " | ", ansi)}${s("33", `total ${formatInteger(snapshot.usageTotals.totalTokens)}`, ansi)}`,
    `${b("│ Rate Limits: ", ansi)}${formatTerminalRateLimits(snapshot.rateLimits, ansi)}`,
    `${b("│ Project: ", ansi)}${s("36", options.projectUrl ?? "https://linear.app/project/project/issues", ansi)}`,
  ];
  if (options.dashboardUrl)
    lines.push(
      `${b("│ Dashboard: ", ansi)}${s("36", normalizeDashboardUrl(options.dashboardUrl), ansi)}`,
    );
  const nextRefresh = formatNextRefresh(snapshot.poll.nextPollAt, now);
  lines.push(
    `${b("│ Next refresh: ", ansi)}${s(nextRefresh === "n/a" ? "90" : "36", nextRefresh, ansi)}`,
  );
  lines.push(b("├─ Running", ansi), "│", runningHeader(ansi), runningDivider(ansi));
  if (snapshot.running.length === 0) {
    lines.push(`│  ${s("90", "No active agents", ansi)}`);
  } else {
    for (const run of snapshot.running) lines.push(formatRunningRow(run, now, ansi));
  }
  lines.push("│", b("├─ Backoff queue", ansi), "│");
  if (snapshot.retrying.length === 0) {
    lines.push(`│  ${s("90", "No queued retries", ansi)}`);
  } else {
    for (const retry of snapshot.retrying) lines.push(formatRetryRow(retry, now, ansi));
  }
  lines.push("│", b("├─ Dispatch blocks", ansi), "│");
  const dispatchBlocks =
    snapshot.blocked.length > 0
      ? snapshot.blocked
      : (arrayAt(snapshot, ["dispatchBlocks"]) ?? arrayAt(snapshot, ["dispatch_blocks"]));
  if (!dispatchBlocks || dispatchBlocks.length === 0) {
    lines.push(`│  ${s("90", "No capacity-blocked issues", ansi)}`);
  } else {
    for (const block of dispatchBlocks) lines.push(formatDispatchBlockRow(block, ansi));
  }
  lines.push("╰─");
  return `${lines.join("\n")}\n`;
}

function runningHeader(ansi: boolean): string {
  const header =
    "ID       SLOT  AGENT    STAGE          PID      AGE / TURN   TOKENS     SESSION        EVENT";
  return `│   ${s("90", ansi ? header.padEnd(111) : header, ansi)}`;
}

function runningDivider(ansi: boolean): string {
  return `│   ${s("90", "───────────────────────────────────────────────────────────────────────────────────────────────────────────────", ansi)}`;
}

function formatRunningRow(
  run: RuntimeSnapshot["running"][number],
  now: Date,
  ansi: boolean,
): string {
  const stage = runningStage(run);
  const ageTurn = `${formatMinutesSeconds(secondsBetween(now, run.startedAt))} / ${run.turnCount}`;
  const event = terminalEvent(run);
  const color = rowColor(run.lastEvent);
  const ageWidth = ansi ? 12 : 13;
  const tokenWidth = ansi ? 10 : 9;
  return [
    "│",
    s(color, "●", ansi),
    s("36", run.issueIdentifier.padEnd(8), ansi),
    s("90", String(run.slotIndex).padEnd(5), ansi),
    s("36", run.agentKind.padEnd(8), ansi),
    s(color, stage.padEnd(14), ansi),
    s("33", String(run.executorPid ?? "n/a").padEnd(8), ansi),
    s("35", ageTurn.padEnd(ageWidth), ansi),
    s("33", formatInteger(run.usageTotals.totalTokens).padStart(tokenWidth), ansi),
    s("36", shortSession(run.sessionId ?? run.resumeId ?? "n/a").padEnd(14), ansi),
    s(color, ansi ? event.padEnd(24) : event, ansi),
  ].join(" ");
}

function formatRetryRow(
  retry: RuntimeSnapshot["retrying"][number],
  now: Date,
  ansi: boolean,
): string {
  const dueIn = formatRetryDue(secondsBetween(new Date(retry.dueAtIso), now));
  const error = stringAt(retry, ["error"]);
  const suffix = error ? `error=${sanitize(error)}` : "error=n/a";
  return `│  ${s("38;5;208", "↻", ansi)} ${s("31", retry.identifier, ansi)} ${s("33", `attempt=${retry.attempt}`, ansi)}${s("2", " in ", ansi)}${s("36", dueIn, ansi)} ${s("2", suffix, ansi)}`;
}

function formatDispatchBlockRow(block: unknown, ansi: boolean): string {
  if (!isRecord(block)) return `│  ${sanitize(String(block))}`;
  const identifier =
    stringAt(block, ["identifier"]) ??
    stringAt(block, ["issueIdentifier"]) ??
    stringAt(block, ["issue_identifier"]) ??
    "unknown";
  const reason = stringAt(block, ["reason"]) ?? "unknown";
  const state = stringAt(block, ["state"]) ?? "unknown";
  return [
    `│  ${s("38;5;208", "•", ansi)}`,
    s("31", sanitize(identifier), ansi),
    s("33", `state=${sanitize(state)}`, ansi),
    `${s("2", "reason=", ansi)}${s("36", sanitize(reason), ansi)}`,
  ].join(" ");
}

function runningStage(run: RuntimeSnapshot["running"][number]): string {
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

function terminalEvent(run: RuntimeSnapshot["running"][number]): string {
  return truncate(
    humanizeAgentMessage({
      agent_kind: run.agentKind,
      event: run.lastEvent,
      message: run.lastMessage,
    }),
    24,
  );
}

function formatTerminalRateLimits(value: unknown, ansi: boolean): string {
  if (value === null || value === undefined) return s("90", "unavailable", ansi);
  const model =
    stringAt(value, ["model"]) ?? stringAt(value, ["model_slug"]) ?? stringAt(value, ["modelSlug"]);
  const primary = rateBucket(value, "primary");
  const secondary = rateBucket(value, "secondary");
  const credits = formatCredits(valueAt(value, ["credits"]));
  if (!model && !primary && !secondary && !credits) return sanitize(JSON.stringify(value));
  return [
    s("33", model ?? "unknown", ansi),
    primary ? s("36", primary, ansi) : null,
    secondary ? s("36", secondary, ansi) : null,
    credits ? s("32", `credits ${credits}`, ansi) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(s("90", " | ", ansi));
}

function rateBucket(value: unknown, key: string): string | null {
  const bucket = recordAt(value, [key]);
  if (!bucket) return null;
  const used = numberAt(bucket, ["used"]) ?? numberAt(bucket, ["remaining"]) ?? 0;
  const limit = numberAt(bucket, ["limit"]) ?? numberAt(bucket, ["total"]) ?? 0;
  const resetSeconds =
    numberAt(bucket, ["resetSeconds"]) ??
    numberAt(bucket, ["reset_seconds"]) ??
    numberAt(bucket, ["resetsInSeconds"]) ??
    0;
  return `${key} ${formatInteger(used)}/${formatInteger(limit)} reset ${formatInteger(resetSeconds)}s`;
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

function formatNextRefresh(nextPollAt: string | null, now: Date): string {
  if (!nextPollAt) return "n/a";
  return `in ${formatRetryDue(secondsBetween(new Date(nextPollAt), now))}`;
}

function formatRetryDue(seconds: number): string {
  return `${Math.max(0, seconds).toFixed(3)}s`;
}

function formatMinutesSeconds(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

function liveRuntimeSeconds(snapshot: RuntimeSnapshot, now: Date): number {
  let seconds = snapshot.usageTotals.secondsRunning;
  for (const run of snapshot.running) {
    seconds += Math.max(0, secondsBetween(now, run.startedAt));
  }
  return seconds;
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

function shortSession(value: string): string {
  if (value.length <= 13) return value;
  return `${value.slice(0, 4)}...${value.slice(-6)}`;
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
