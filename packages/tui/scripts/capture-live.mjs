// Visual-capture harness for the TUI: renders the flight board and the
// narrowed agent-detail view with a rich fake snapshot, converts the ANSI
// output to styled HTML, and writes one HTML file per view for screenshotting
// (e.g. `chromium --headless --screenshot=board.png board.html`).
//
// Usage: node packages/tui/scripts/capture-live.mjs <output-dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatAgentDetail, formatDashboard, tokenRateSparkline } from "@lorenz/tui";

const now = Date.now();
const iso = (offsetSeconds) => new Date(now + offsetSeconds * 1000).toISOString();

const snapshot = {
  appStatus: "running",
  appStartedAt: iso(-85 * 60 - 23),
  workflowPath: "/tmp/WORKFLOW.md",
  poll: { status: "idle", candidates: 14, eligible: 6, lastPollAt: iso(-7), nextPollAt: iso(23), lastError: null },
  running: [
    {
      issueId: "i1", issueIdentifier: "ENG-2014", issueTitle: "Dedupe webhook retries on 5xx",
      state: "In Progress", slotIndex: 0, ensembleSize: 1, agentKind: "codex",
      sessionId: "thread-12b8d4", executorPid: "48213", workerHost: "mac-mini-01",
      turnCount: 6, startedAt: iso(-14 * 60 - 2), lastEvent: "session_notification",
      lastEventAt: iso(-9),
      lastMessage: { method: "turn/diff/updated", params: { diff: "a\nb\nc\nd\n" } },
      workspacePath: "/Users/ryan/lorenz-ws/eng-2014", toolCallCount: 41,
      issueUrl: "https://linear.app/northwind/issue/ENG-2014",
      usageTotals: { inputTokens: 70_000, outputTokens: 19_350, totalTokens: 89_350, secondsRunning: 0 },
    },
    {
      issueId: "i2", issueIdentifier: "ENG-2027", issueTitle: "Fix pagination cursor drift in Linear sync",
      state: "Agent Review", slotIndex: 1, ensembleSize: 1, agentKind: "claude",
      sessionId: "thread-66af90", executorPid: "48377", workerHost: "ssh-worker-2",
      turnCount: 11, startedAt: iso(-27 * 60 - 3), lastEvent: "turn_completed",
      lastEventAt: iso(-89),
      lastMessage: { agent_kind: "claude", event: "turn_completed", message: {} },
      workspacePath: "/Users/ryan/lorenz-ws/eng-2027", toolCallCount: 87,
      issueUrl: "https://linear.app/northwind/issue/ENG-2027",
      usageTotals: { inputTokens: 160_000, outputTokens: 22_500, totalTokens: 182_500, secondsRunning: 0 },
    },
    {
      issueId: "i3", issueIdentifier: "ENG-2031", issueTitle: "Quieten flaky worker-recycle test",
      state: "In Progress", slotIndex: 2, ensembleSize: 1, agentKind: "codex",
      sessionId: "thread-e71a23", executorPid: "48512", workerHost: null,
      turnCount: 2, startedAt: iso(-3 * 60 - 28), lastEvent: "turn_started",
      lastEventAt: iso(-3),
      lastMessage: { method: "item/commandExecution/started", params: { command: "pnpm vitest worker-pool -t recycle" } },
      workspacePath: "/Users/ryan/lorenz-ws/eng-2031", toolCallCount: 9,
      usageTotals: { inputTokens: 20_000, outputTokens: 4_700, totalTokens: 24_700, secondsRunning: 0 },
    },
  ],
  reserving: [
    { issueId: "i4", identifier: "ENG-2058", slotIndex: 3, affinityHost: "ssh-worker-2", retryAttempt: null, reservedAtIso: iso(-4) },
  ],
  retrying: [
    { issueId: "i5", issueIdentifier: "ENG-2009", attempt: 2, dueAtIso: iso(34), monotonicDeadlineMs: 0, error: "Linear 429: rate limited, honoring Retry-After", slotIndex: 0 },
    { issueId: "i6", issueIdentifier: "ENG-2044", attempt: 1, dueAtIso: iso(112), monotonicDeadlineMs: 0, error: "agent stalled past stall_timeout_ms", slotIndex: 1 },
  ],
  blocked: [
    { issueId: "i7", identifier: "ENG-2061", state: "Todo", reason: "global_concurrency_cap" },
    { issueId: "i8", identifier: "ENG-2062", state: "Todo", reason: "worker_host_capacity" },
  ],
  runHistory: [],
  usageTotals: { inputTokens: 248_900, outputTokens: 63_420, totalTokens: 312_320, secondsRunning: 5_123 },
  rateLimits: { model: "claude-opus-4-6", primary: { used: 6_120, limit: 10_000, resetSeconds: 1_840 }, credits: null },
  logFile: null,
  recentEvents: [
    { type: "run_started", message: "ENG-2031 session thread-e71a23 spawned on local (slot 2)", at: iso(-18) },
    { type: "retry_timer_due", message: "ENG-2009 backoff armed: attempt 2 in 34s (Linear 429)", at: iso(-42) },
    { type: "turn_completed", message: "ENG-2027 claude turn 11 completed (182,500 tok)", at: iso(-89) },
    { type: "dispatch_skipped", message: "ENG-2061 dispatch skipped: global_concurrency_cap (3/3 slots)", at: iso(-133) },
    { type: "session_notification", message: "ENG-2014 ran `pnpm vitest webhooks` — 2 failed", at: iso(-160) },
    { type: "session_notification", message: "ENG-2027 wrote packages/tracker/src/cursor.ts (+64 −12)", at: iso(-208) },
  ],
};

const shared = {
  ansi: true,
  interactive: true,
  maxAgents: 10,
  dashboardUrl: "http://127.0.0.1:8771",
  projectUrl: "https://linear.app/northwind/team/ENG",
};

// Fake a bursty token history for the inspected run so the histogram has shape.
const detailRun = snapshot.running[1];
const samples = [];
for (let i = 0; i <= 20; i++) {
  const t = now - (20 - i) * 3_000;
  const burst = i >= 8 && i <= 13 ? (i - 7) * 9_000 : i > 13 ? 54_000 : 0;
  samples.push({ timestampMs: t, totalTokens: 120_000 + i * 800 + burst });
}

// A crowded fleet: dozens of running agents plus queues, on a bounded viewport.
const crowd = {
  ...snapshot,
  running: Array.from({ length: 64 }, (_, i) => ({
    ...snapshot.running[i % 3],
    issueId: `c${i}`,
    issueIdentifier: `ENG-${2100 + i}`,
    slotIndex: i,
    startedAt: iso(-((i * 47) % 3200) - 60),
    usageTotals: {
      inputTokens: 1000 * i,
      outputTokens: 400 * i,
      totalTokens: 1400 * i + 900,
      secondsRunning: 0,
    },
  })),
};

const views = {
  board: { cols: 132, text: formatDashboard(snapshot, { ...shared, columns: 132, cursor: 1, rows: 44 }), title: "flight board · 132 cols" },
  board_wide: { cols: 172, text: formatDashboard(snapshot, { ...shared, columns: 172, cursor: 1, rows: 44 }), title: "flight board · 172 cols (flex columns + negative space)" },
  board_narrow: { cols: 78, text: formatDashboard(snapshot, { ...shared, columns: 78, cursor: 1, rows: 44 }), title: "flight board · 78 cols (tmux split)" },
  board_crowd: { cols: 132, text: formatDashboard(crowd, { ...shared, maxAgents: 100, columns: 132, cursor: 33, rows: 32 }), title: "flight board · 64 running agents in a 32-row viewport" },
  detail: {
    cols: 132,
    title: "agent detail (⏎ on ENG-2027)",
    text: formatAgentDetail(detailRun, snapshot, {
      ...shared,
      columns: 132,
      sparkline: tokenRateSparkline(samples, now),
      runTps: 2_057,
    }),
  },
};

// --- ANSI -> HTML ------------------------------------------------------------
const PALETTE = {
  30: "#403e41", 31: "#FF6188", 32: "#A9DC76", 33: "#FFD866", 34: "#6796E6",
  35: "#AB9DF2", 36: "#78DCE8", 37: "#FCFCFA", 39: "#FCFCFA",
  90: "#8b888f", 91: "#FF6188", 92: "#A9DC76", 93: "#FFD866", 94: "#6796E6",
  95: "#AB9DF2", 96: "#78DCE8", 97: "#FCFCFA",
};
const C256 = { 208: "#FC9867" };
function ansiToHtml(text) {
  let html = "";
  let state = { color: null, bold: false, dim: false };
  const esc = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const flushStyled = (chunk) => {
    if (chunk === "") return;
    const styles = [`color:${state.color ?? "#FCFCFA"}`];
    if (state.bold) styles.push("font-weight:700");
    if (state.dim) styles.push("opacity:.55");
    html += `<span style="${styles.join(";")}">${esc(chunk)}</span>`;
  };
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    flushStyled(text.slice(last, match.index));
    last = match.index + match[0].length;
    const codes = (match[1] === "" ? "0" : match[1]).split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) state = { color: null, bold: false, dim: false };
      else if (code === 1) state.bold = true;
      else if (code === 2) state.dim = true;
      else if (code === 22) { state.bold = false; state.dim = false; }
      else if (code === 38 && codes[i + 1] === 5) { state.color = C256[codes[i + 2]] ?? null; i += 2; }
      else if (PALETTE[code]) state.color = PALETTE[code];
      else if (code === 39) state.color = null;
    }
  }
  flushStyled(text.slice(last));
  return html;
}

const outDir = process.argv[2] ?? "/tmp/tui-capture";
mkdirSync(outDir, { recursive: true });
for (const [name, view] of Object.entries(views)) {
  const width = Math.ceil(view.cols * 7.85 + 48);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
html,body { background:#0b0a0c; }
.win { width:${width}px; margin:18px; border-radius:12px; overflow:hidden; background:#19181a;
       box-shadow:0 12px 48px rgba(0,0,0,.6); border:1px solid #2e2b30; }
.bar { display:flex; align-items:center; gap:8px; padding:12px 16px; background:#221f22; border-bottom:1px solid #2e2b30; }
.dot { width:12px; height:12px; border-radius:50%; }
.title { color:#a6a2aa; font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace; margin-left:8px; }
pre { padding:16px 22px 20px; font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color:#FCFCFA; white-space:pre; }
</style></head><body><div class="win">
<div class="bar"><div class="dot" style="background:#ff5f57"></div><div class="dot" style="background:#febc2e"></div><div class="dot" style="background:#28c840"></div><div class="title">lorenz — ${view.title}</div></div>
<pre>${ansiToHtml(view.text)}</pre></div></body></html>`;
  writeFileSync(join(outDir, `${name}.html`), html);
  writeFileSync(join(outDir, `${name}.txt`), view.text.replaceAll(/\x1b\[[0-9;]*m/g, ""));
}
console.log("wrote", Object.keys(views).join(", "), "to", outDir);
