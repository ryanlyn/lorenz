// Lorenz TUI redesign mockups: builds styled terminal "screenshots" (HTML -> PNG)
// plus plain-text ASCII captures for each design direction.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });

// Monokai Pro-ish palette (matches repo badge colors)
const C = {
  red: "#FF6188",
  orange: "#FC9867",
  yellow: "#FFD866",
  green: "#A9DC76",
  cyan: "#78DCE8",
  purple: "#AB9DF2",
  fg: "#FCFCFA",
  dim: "#8b888f",
  dim2: "#5b585f",
  bg: "#19181a",
  bgAlt: "#221f22",
  sel: "#3a3740",
};

// A segment: { t: text, c: color, b: bold, d: dim, bg: background, i: italic }
const seg = (t, c = C.fg, o = {}) => ({ t, c, ...o });
const sp = (n = 1) => seg(" ".repeat(n));
const padE = (t, n) => (t.length >= n ? t : t + " ".repeat(n - t.length));
const padS = (t, n) => (t.length >= n ? t : " ".repeat(n - t.length) + t);
const trunc = (t, n) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

function esc(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function lineToHtml(segs) {
  return segs
    .map((s) => {
      const styles = [`color:${s.c}`];
      if (s.b) styles.push("font-weight:700");
      if (s.i) styles.push("font-style:italic");
      if (s.bg) styles.push(`background:${s.bg}`);
      return `<span style="${styles.join(";")}">${esc(s.t)}</span>`;
    })
    .join("");
}

const lineToText = (segs) => segs.map((s) => s.t).join("");

function renderWindow(title, lines, { cols = 118 } = {}) {
  const body = lines.map((l) => lineToHtml(l)).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { background:#0b0a0c; }
  .win { width:${cols * 8.65 + 44}px; margin:18px; border-radius:12px; overflow:hidden;
         background:${C.bg}; box-shadow:0 12px 48px rgba(0,0,0,.6); border:1px solid #2e2b30; }
  .bar { display:flex; align-items:center; gap:8px; padding:12px 16px; background:${C.bgAlt};
         border-bottom:1px solid #2e2b30; }
  .dot { width:12px; height:12px; border-radius:50%; }
  .title { color:#a6a2aa; font:600 13px/-apple-system ui-monospace,SFMono-Regular,Menlo,monospace; margin-left:8px; }
  pre { padding:16px 22px 20px; font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
        color:${C.fg}; white-space:pre; }
  </style></head><body>
  <div class="win">
    <div class="bar"><div class="dot" style="background:#ff5f57"></div><div class="dot" style="background:#febc2e"></div><div class="dot" style="background:#28c840"></div><div class="title">${esc(title)}</div></div>
    <pre>${body}</pre>
  </div></body></html>`;
}

// ---------------------------------------------------------------------------
// Shared fake data
const runs = [
  { id: "ENG-2014", title: "Dedupe webhook retries on 5xx", agent: "codex", host: "mac-mini-01", age: "14m02s", turns: 6, tok: "89,350", tools: 41, ev: "editing src/webhooks/retry.ts", evc: C.cyan, stage: "In Progress", spin: "⠸", spark: "▂▃▃▅▆▇▇▆", sess: "thre…12b8d4" },
  { id: "ENG-2027", title: "Fix pagination cursor drift in Linear sync", agent: "claude", host: "ssh-worker-2", age: "27m03s", turns: 11, tok: "182,500", tools: 87, ev: "turn completed · awaiting review", evc: C.purple, stage: "Agent Review", spin: "⠴", spark: "▅▆▇▇▆▅▃▂", sess: "thre…66af90" },
  { id: "ENG-2031", title: "Quieten flaky worker-recycle test", agent: "codex", host: "local", age: "3m28s", turns: 2, tok: "24,700", tools: 9, ev: "reproducing the failure", evc: C.green, stage: "In Progress", spin: "⠧", spark: "▁▁▂▃▃▅▆▇", sess: "thre…e71a23" },
];
const reserving = [{ id: "ENG-2058", title: "Migrate tracker adapters to ACP v2", age: "0m04s", ev: "negotiating worker lease" }];
const retries = [
  { id: "ENG-2009", attempt: 2, due: "34s", err: "Linear 429: rate limited, honoring Retry-After" },
  { id: "ENG-2044", attempt: 1, due: "1m52s", err: "agent stalled past stall_timeout_ms" },
  { id: "ENG-2051", attempt: 4, due: "8m06s", err: "worker recycled mid-run (machine_recycled)" },
];
const blocked = [
  { id: "ENG-2061", state: "Todo", reason: "global_concurrency_cap" },
  { id: "ENG-2062", state: "Todo", reason: "worker_host_capacity" },
];
const history = [
  { id: "ENG-2003", ok: true, dur: "22m", tok: "141k" },
  { id: "ENG-1998", ok: true, dur: "9m", tok: "36k" },
  { id: "ENG-2007", ok: false, dur: "41m", tok: "203k", err: "tests failed twice" },
];
const events = [
  { t: "09:41:22", type: "run_started", c: C.green, m: "ENG-2031 session e71a23 spawned on local (slot 0)" },
  { t: "09:41:04", type: "tool_call", c: C.cyan, m: "ENG-2014 codex ran `pnpm vitest webhooks` — 2 failed" },
  { t: "09:40:58", type: "retry_armed", c: C.orange, m: "ENG-2009 backoff armed: attempt 2 in 34s (Linear 429)" },
  { t: "09:40:31", type: "turn_done", c: C.purple, m: "ENG-2027 claude turn 11 completed (182,500 tok) — awaiting review" },
  { t: "09:39:47", type: "dispatch", c: C.yellow, m: "ENG-2061 dispatch skipped: global_concurrency_cap (3/3 slots)" },
  { t: "09:39:12", type: "tracker", c: C.dim, m: "poll ok: 14 candidates, 6 eligible, next in 30s" },
];

// ---------------------------------------------------------------------------
const versions = {};

// === V1: FLIGHT BOARD — one unified pipeline table ==========================
{
  const L = [];
  const W = 126;
  const rule = (c = C.dim2) => L.push([seg("─".repeat(W), c)]);
  // KPI strip
  L.push([
    seg(" LORENZ ", C.bg, { bg: C.cyan, b: true }),
    sp(2), seg("●", C.green), seg(" 3 running", C.fg), seg("/10", C.dim),
    sp(2), seg("◌ 1 reserving", C.dim),
    sp(2), seg("↻ 3 retrying", C.orange),
    sp(2), seg("■ 2 blocked", C.yellow),
    sp(2), seg("│", C.dim2), sp(2), seg("2.1k tps", C.cyan),
    sp(2), seg("│", C.dim2), sp(2), seg("tok 312,320", C.yellow), seg(" (249k▲ 63k▼)", C.dim),
    sp(2), seg("│", C.dim2), sp(2), seg("up 85m", C.purple),
  ]);
  L.push([
    seg(" opus-4-6 ", C.dim), seg("▮▮▮▮▮▮▮", C.green), seg("▯▯▯▯", C.dim2), seg(" 61% ↺31m", C.dim),
    sp(2), seg("│", C.dim2), sp(2), seg("poll ", C.dim), seg("23s", C.cyan),
    sp(2), seg("│", C.dim2), sp(2), seg("linear.app/northwind/ENG", C.dim), sp(2), seg("│", C.dim2), sp(2), seg(":8771", C.dim),
  ]);
  rule();
  // cell widths: marker(4) lane(6) id(9) title(30) agent(7) host(13) age(8R) turn(5R) tokens(9R) gap(3) activity(rest)
  const FIXED = 4 + 6 + 9 + 1 + 30 + 1 + 7 + 1 + 13 + 1 + 8 + 1 + 5 + 1 + 9 + 3;
  const ACT = W - FIXED;
  const row = (marker, mc, lane, id, idOpts, title, tc, agent, host, hc, age, ac, turn, tnc, tok, tkc, act, actc) =>
    L.push([
      seg("  " + marker + " ", mc), seg(padE(lane, 6), mc),
      seg(padE(id, 9), C.cyan, idOpts), sp(1),
      seg(padE(trunc(title, 30), 30), tc), sp(1),
      seg(padE(agent, 7), agent === "—" ? C.dim2 : C.purple), sp(1),
      seg(padE(host, 13), hc), sp(1),
      seg(padS(age, 8), ac), sp(1),
      seg(padS(turn, 5), tnc), sp(1),
      seg(padS(tok, 9), tkc),
      seg("   " + trunc(act, ACT), actc),
    ]);
  L.push([
    seg("    " + padE("LANE", 6) + padE("ID", 9) + " " + padE("TITLE", 30) + " " + padE("AGENT", 7) + " " + padE("HOST", 13) + " " + padS("AGE", 8) + " " + padS("TURN", 5) + " " + padS("TOKENS", 9) + "   LAST ACTIVITY", C.dim, { b: true }),
  ]);
  rule();
  for (const r of runs)
    row("▶", C.green, "run", r.id, { b: true }, r.title, C.fg, r.agent, r.host, C.dim, r.age, C.fg, String(r.turns), C.purple, r.tok, C.yellow, r.ev, r.evc);
  for (const r of reserving)
    row("◌", C.dim, "rsv", r.id, {}, r.title, C.dim, "—", "(acquiring)", C.dim2, r.age, C.dim, "—", C.dim2, "—", C.dim2, r.ev, C.dim);
  for (const r of retries)
    row("↻", C.orange, "retry", r.id, {}, "", C.dim2, "—", "—", C.dim2, "in " + r.due, C.orange, "a" + r.attempt, C.yellow, "—", C.dim2, r.err, C.dim);
  for (const r of blocked)
    row("■", C.yellow, "block", r.id, {}, "", C.dim2, "—", "—", C.dim2, "—", C.dim2, r.state, C.dim, "—", C.dim2, r.reason.replaceAll("_", " "), C.yellow);
  rule();
  L.push([
    seg(" 09:41:22 ", C.dim2), seg("ENG-2031 spawned on local", C.dim),
    seg("  ·  ", C.dim2), seg("09:40:58 ", C.dim2), seg("ENG-2009 backoff armed (34s)", C.dim),
    seg("  ·  ", C.dim2), seg("09:40:31 ", C.dim2), seg("ENG-2027 turn 11 completed", C.dim),
  ]);
  versions.v1 = { title: "lorenz — v1 · flight board", lines: L, cols: W };
}

// === V2: MISSION CONTROL — panes + selection + detail =======================
{
  const L = [];
  const W = 126;
  const LW = 58, RW = W - LW - 3; // left/right pane widths
  // top KPI bar
  L.push([
    seg(" LORENZ ", C.bg, { bg: C.cyan, b: true }),
    seg("  running ", C.dim), seg("3", C.green, { b: true }), seg("/10", C.dim),
    seg("   retry ", C.dim), seg("3", C.orange, { b: true }),
    seg("   blocked ", C.dim), seg("2", C.yellow, { b: true }),
    seg("   tok ", C.dim), seg("312,320", C.yellow),
    seg("   tps ", C.dim), seg("2.1k", C.cyan),
    seg("   opus-4-6 ", C.dim), seg("▮▮▮▮▮▮▮", C.green), seg("▯▯▯▯", C.dim2), seg(" 61%", C.dim),
    seg("   poll ", C.dim), seg("23s", C.cyan),
  ]);
  const top = (l, tl, r, tr) => {
    const lt = `╭─ ${tl} `, rt = `╭─ ${tr} `;
    L.push([
      seg(lt, C.dim2), seg("─".repeat(Math.max(0, l - lt.length - 1)) + "╮", C.dim2),
      sp(1),
      seg(rt, C.dim2), seg("─".repeat(Math.max(0, r - rt.length - 1)) + "╮", C.dim2),
    ]);
  };
  const rowLR = (lsegs, rsegs) => {
    const lTxt = lineToText(lsegs), rTxt = lineToText(rsegs);
    L.push([
      seg("│", C.dim2), ...lsegs, seg(" ".repeat(Math.max(0, LW - 2 - lTxt.length))), seg("│", C.dim2),
      sp(1),
      seg("│", C.dim2), ...rsegs, seg(" ".repeat(Math.max(0, RW - 2 - rTxt.length))), seg("│", C.dim2),
    ]);
  };
  const bot = () => L.push([seg("╰" + "─".repeat(LW - 2) + "╯", C.dim2), sp(1), seg("╰" + "─".repeat(RW - 2) + "╯", C.dim2)]);

  top(LW, "agents (7)", RW, "ENG-2027 · Fix pagination cursor drift in Linear sync");
  const rowsL = [
    [seg(" ● ", C.green), seg("ENG-2014 ", C.cyan), seg("codex  ", C.purple), seg("run   ", C.green), seg(" 6t ", C.dim), seg("14m ", C.dim), seg(" 89,350", C.yellow)],
    [seg(" ● ", C.purple), seg("ENG-2027 ", C.cyan, { b: true, bg: C.sel }), seg("claude ", C.purple, { bg: C.sel }), seg("review", C.purple, { bg: C.sel }), seg(" 11t ", C.dim, { bg: C.sel }), seg("27m ", C.dim, { bg: C.sel }), seg("182,500", C.yellow, { bg: C.sel }), seg(" ◀", C.cyan)],
    [seg(" ● ", C.green), seg("ENG-2031 ", C.cyan), seg("codex  ", C.purple), seg("run   ", C.green), seg(" 2t ", C.dim), seg(" 3m ", C.dim), seg(" 24,700", C.yellow)],
    [seg(" ◌ ", C.dim), seg("ENG-2058 ", C.cyan), seg("—      ", C.dim2), seg("rsv   ", C.dim), seg("  —  ", C.dim2), seg(" 4s ", C.dim), seg("      —", C.dim2)],
    [seg(" ↻ ", C.orange), seg("ENG-2009 ", C.cyan), seg("—      ", C.dim2), seg("retry ", C.orange), seg(" a2 ", C.yellow), seg("34s ", C.orange), seg("   429 ", C.red)],
    [seg(" ↻ ", C.orange), seg("ENG-2044 ", C.cyan), seg("—      ", C.dim2), seg("retry ", C.orange), seg(" a1 ", C.yellow), seg(" 2m ", C.orange), seg("stalled", C.red)],
    [seg(" ■ ", C.yellow), seg("ENG-2061 ", C.cyan), seg("—      ", C.dim2), seg("block ", C.yellow), seg("  —  ", C.dim2), seg("  —  ", C.dim2), seg("   cap", C.dim)],
  ];
  const rowsR = [
    [seg(" state ", C.dim), seg("Agent Review", C.purple, { b: true }), seg("   turn ", C.dim), seg("11", C.fg), seg("   age ", C.dim), seg("27m03s", C.fg), seg("   slot ", C.dim), seg("0", C.fg)],
    [seg(" host ", C.dim), seg("ssh-worker-2", C.fg), seg("   pid ", C.dim), seg("48377", C.fg), seg("   sess ", C.dim), seg("thre…66af90", C.cyan)],
    [seg(" tokens ", C.dim), seg("182,500", C.yellow), seg("  ▅▆▇▇▆▅▃▂ ", C.green), seg("  tools ", C.dim), seg("87", C.green), seg("   retry ", C.dim), seg("0", C.fg)],
    [seg(" ws ", C.dim), seg("~/lorenz-ws/eng-2027", C.dim)],
    [sp(1)],
    [seg(" 09:40:31 ", C.dim2), seg("turn 11 completed — awaiting review", C.purple)],
    [seg(" 09:38:02 ", C.dim2), seg("wrote packages/tracker/src/cursor.ts", C.fg)],
  ];
  for (let i = 0; i < 7; i++) rowLR(rowsL[i] ?? [sp(1)], rowsR[i] ?? [sp(1)]);
  bot();
  // events pane full width
  const et = "╭─ events ";
  L.push([seg(et, C.dim2), seg("─".repeat(W - et.length - 1) + "╮", C.dim2)]);
  for (const e of events.slice(0, 4)) {
    const txt = ` ${e.t}  ${padE(e.type, 12)} ${e.m}`;
    L.push([
      seg("│", C.dim2), seg(" " + e.t + "  ", C.dim2), seg(padE(e.type, 12), e.c), seg(" " + e.m, C.fg),
      seg(" ".repeat(Math.max(0, W - 2 - txt.length - 1))), seg("│", C.dim2),
    ]);
  }
  L.push([seg("╰" + "─".repeat(W - 2) + "╯", C.dim2)]);
  L.push([
    seg(" ↑↓", C.cyan), seg(" select ", C.dim),
    seg(" ⏎", C.cyan), seg(" detail ", C.dim),
    seg(" l", C.cyan), seg(" logs ", C.dim),
    seg(" k", C.cyan), seg(" kill ", C.dim),
    seg(" r", C.cyan), seg(" retry now ", C.dim),
    seg(" p", C.cyan), seg(" pause dispatch ", C.dim),
    seg(" o", C.cyan), seg(" open issue ", C.dim),
    seg(" q", C.cyan), seg(" quit", C.dim),
  ]);
  versions.v2 = { title: "lorenz — v2 · mission control", lines: L, cols: W };
}

// === V3: TAPE — log-first with sticky status footer ==========================
{
  const L = [];
  const W = 126;
  const feed = [
    { t: "09:38:02", c: C.cyan, id: "ENG-2027", m: "wrote packages/tracker/src/cursor.ts (+64 −12)" },
    { t: "09:38:40", c: C.cyan, id: "ENG-2014", m: "ran `pnpm vitest webhooks` — 4 passed, 2 failed" },
    { t: "09:39:12", c: C.dim, id: "tracker ", m: "poll ok: 14 candidates, 6 eligible · next in 30s" },
    { t: "09:39:47", c: C.yellow, id: "dispatch", m: "ENG-2061 skipped — global_concurrency_cap (3/3 slots)" },
    { t: "09:40:31", c: C.purple, id: "ENG-2027", m: "turn 11 completed (182,500 tok) → stage Agent Review" },
    { t: "09:40:58", c: C.orange, id: "ENG-2009", m: "retry armed: attempt 2 in 34s — Linear 429, honoring Retry-After" },
    { t: "09:41:04", c: C.cyan, id: "ENG-2014", m: "editing src/webhooks/retry.ts" },
    { t: "09:41:22", c: C.green, id: "ENG-2031", m: "run started on local slot 0 · session thre…e71a23" },
    { t: "09:41:39", c: C.green, id: "ENG-2031", m: "reproducing the failure: `pnpm vitest worker-pool -t recycle`" },
  ];
  L.push([seg("  lorenz tape — newest at bottom, scrollback is history", C.dim2, { i: true })]);
  L.push([sp(1)]);
  for (const e of feed) {
    L.push([
      seg("  " + e.t + " ", C.dim2),
      seg("▏", e.c),
      seg(" " + padE(e.id, 9), e.c, { b: true }),
      seg(e.m, e.id.startsWith("ENG") ? C.fg : C.dim),
    ]);
  }
  L.push([sp(1)]);
  L.push([seg("─".repeat(W), C.dim2)]);
  L.push([
    seg(" ● 3", C.green), seg("/10 run", C.dim),
    seg("  ◌ 1 rsv", C.dim),
    seg("  ↻ 3 retry", C.orange), seg(" (next 34s)", C.dim),
    seg("  ■ 2 blk", C.yellow),
    seg("  │ ", C.dim2), seg("2.1k tps", C.cyan),
    seg("  │ ", C.dim2), seg("tok 312k", C.yellow),
    seg("  │ ", C.dim2), seg("opus 61% ↺31m", C.dim),
    seg("  │ ", C.dim2), seg("poll 23s", C.cyan),
    seg("  │ ", C.dim2), seg(":8771", C.dim),
  ]);
  L.push([
    seg(" ENG-2014", C.cyan), seg(" 6t 14m ", C.dim), seg("▸ editing retry.ts", C.cyan),
    seg("   ENG-2027", C.cyan), seg(" 11t 27m ", C.dim), seg("▸ agent review", C.purple),
    seg("   ENG-2031", C.cyan), seg(" 2t 3m ", C.dim), seg("▸ reproducing failure", C.green),
  ]);
  versions.v3 = { title: "lorenz — v3 · tape", lines: L, cols: W };
}

// === V4: CARDS — one card per agent ==========================================
{
  const L = [];
  const W = 126;
  L.push([
    seg(" LORENZ ", C.bg, { bg: C.cyan, b: true }),
    seg("  3/10 agents · 1 reserving · 3 retrying · 2 blocked", C.dim),
    seg("   │   ", C.dim2), seg("312,320 tok", C.yellow), seg(" @ ", C.dim), seg("2.1k tps", C.cyan),
    seg("   │   ", C.dim2), seg("opus-4-6 ", C.dim), seg("▮▮▮▮▮▮▮▯▯▯▯ 61%", C.green), seg(" ↺31m", C.dim),
    seg("   │   ", C.dim2), seg("poll 23s", C.cyan),
  ]);
  L.push([sp(1)]);
  const card = (r) => {
    const head = `╭─ ${r.id} · ${trunc(r.title, 52)} `;
    const tail = ` ${r.agent} · ${r.host} ─╮`;
    L.push([
      seg("╭─ ", C.dim2), seg(r.id, C.cyan, { b: true }), seg(" · ", C.dim2), seg(trunc(r.title, 52), C.fg, { b: true }),
      seg(" " + "─".repeat(Math.max(0, W - head.length - tail.length)), C.dim2),
      seg(" " + r.agent, C.purple), seg(" · ", C.dim2), seg(r.host, C.dim), seg(" ─╮", C.dim2),
    ]);
    const l2 = ` ${r.spin} ${r.stage} · turn ${r.turns} · ${r.age}`;
    const r2 = `tok ${r.tok} ${r.spark}  tools ${r.tools} `;
    L.push([
      seg("│", C.dim2),
      seg(" " + r.spin + " ", C.green), seg(r.stage, r.stage === "Agent Review" ? C.purple : C.green, { b: true }),
      seg(" · turn " + r.turns + " · " + r.age, C.dim),
      seg(" ".repeat(Math.max(0, W - 2 - l2.length - r2.length))),
      seg("tok ", C.dim), seg(r.tok, C.yellow), seg(" " + r.spark, C.green), seg("  tools " + r.tools + " ", C.dim),
      seg("│", C.dim2),
    ]);
    const l3 = ` ▸ ${r.ev}`;
    L.push([
      seg("│", C.dim2), seg(" ▸ ", r.evc), seg(r.ev, r.evc),
      seg(" ".repeat(Math.max(0, W - 2 - l3.length))), seg("│", C.dim2),
    ]);
    L.push([seg("╰" + "─".repeat(W - 2) + "╯", C.dim2)]);
  };
  for (const r of runs) card(r);
  L.push([
    seg(" waiting  ", C.dim, { b: true }),
    seg("◌ ENG-2058", C.dim), seg(" acquiring worker (4s)", C.dim2),
    seg("   ↻ ENG-2009", C.orange), seg(" a2 34s — 429", C.dim2),
    seg("   ↻ ENG-2044", C.orange), seg(" a1 1m52s — stalled", C.dim2),
    seg("   ↻ ENG-2051", C.orange), seg(" a4 8m06s", C.dim2),
  ]);
  L.push([
    seg("          ", C.dim),
    seg("■ ENG-2061 ENG-2062", C.yellow), seg(" blocked — concurrency caps", C.dim2),
    seg("   ✓ ENG-2003 22m", C.green), seg("   ✓ ENG-1998 9m", C.green), seg("   ✗ ENG-2007 tests failed", C.red),
  ]);
  versions.v4 = { title: "lorenz — v4 · cards", lines: L, cols: W };
}

// === V5: EVOLUTION — current skeleton, flaws fixed ===========================
{
  const L = [];
  const W = 126;
  L.push([seg("╭─ ", C.dim2), seg("LORENZ", C.fg, { b: true }), seg("  agents ", C.dim), seg("3", C.green), seg("/10", C.dim), seg("  ·  up ", C.dim), seg("85m23s", C.purple), seg("  ·  ", C.dim), seg("2.1k tps", C.cyan), seg("  ·  tok ", C.dim), seg("312,320", C.yellow), seg(" (in 249k / out 63k)", C.dim2)]);
  L.push([seg("│  ", C.dim2), seg("opus-4-6 ", C.dim), seg("primary ", C.dim2), seg("▮▮▮▮▮▮▮▯▯▯▯", C.green), seg(" 61% resets 31m", C.dim), seg("  ·  poll in ", C.dim), seg("23s", C.cyan), seg("  ·  ", C.dim), seg("linear.app/northwind/ENG", C.cyan), seg("  ·  dash ", C.dim), seg(":8771", C.cyan)]);
  L.push([seg("├─ ", C.dim2), seg("running", C.fg, { b: true }), seg(" 3", C.green)]);
  L.push([seg("│  ", C.dim2), seg("   " + padE("ID", 9) + padE("TITLE", 36) + padE("AGENT", 7) + padE("HOST", 13) + padS("AGE", 7) + padS("TURN", 5) + padS("TOKENS", 9) + "  ACTIVITY", C.dim)]);
  for (const r of runs) {
    L.push([
      seg("│  ", C.dim2),
      seg("● ", r.stage === "Agent Review" ? C.purple : C.green),
      seg(padE(r.id, 9), C.cyan, { b: true }),
      seg(padE(trunc(r.title, 35), 36), C.fg),
      seg(padE(r.agent, 7), C.purple),
      seg(padE(r.host, 13), C.dim),
      seg(padS(r.age, 7), C.fg),
      seg(padS(String(r.turns), 5), C.purple),
      seg(padS(r.tok, 9), C.yellow),
      seg("  " + r.ev, r.evc),
    ]);
  }
  L.push([seg("├─ ", C.dim2), seg("waiting", C.fg, { b: true }), seg(" 6", C.orange)]);
  L.push([seg("│  ", C.dim2), seg("◌ ", C.dim), seg(padE("ENG-2058", 9), C.cyan), seg(padE("reserving slot 1", 36), C.dim), seg("acquiring worker lease (4s)", C.dim2)]);
  for (const r of retries) {
    L.push([
      seg("│  ", C.dim2), seg("↻ ", C.orange),
      seg(padE(r.id, 9), C.cyan),
      seg(padE(`retry ${r.attempt} in ${r.due}`, 36), C.orange),
      seg(trunc(r.err, 60), C.dim2),
    ]);
  }
  for (const r of blocked) {
    L.push([
      seg("│  ", C.dim2), seg("■ ", C.yellow),
      seg(padE(r.id, 9), C.cyan),
      seg(padE(r.state.toLowerCase(), 36), C.dim),
      seg(r.reason.replaceAll("_", " "), C.yellow),
    ]);
  }
  L.push([seg("├─ ", C.dim2), seg("recent", C.fg, { b: true }), seg("  2✓ 1✗", C.dim)]);
  L.push([
    seg("│  ", C.dim2), seg("✓ ", C.green), seg(padE("ENG-2003", 9), C.cyan), seg(padE("merged after 22m · 141k tok", 36), C.dim),
    seg("✓ ", C.green), seg(padE("ENG-1998", 9), C.cyan), seg("9m · 36k tok", C.dim),
  ]);
  L.push([
    seg("│  ", C.dim2), seg("✗ ", C.red), seg(padE("ENG-2007", 9), C.cyan), seg(padE("failed after 41m — tests failed twice", 38), C.dim),
  ]);
  L.push([seg("╰─ ", C.dim2), seg("09:41:22 ", C.dim2), seg("ENG-2031 run started on local · session thre…e71a23", C.dim)]);
  versions.v5 = { title: "lorenz — v5 · evolution (current layout, fixed)", lines: L, cols: W };
}

// ---------------------------------------------------------------------------
const shots = [];
for (const [name, v] of Object.entries(versions)) {
  const html = renderWindow(v.title, v.lines, { cols: v.cols });
  writeFileSync(join(OUT, `${name}.html`), html);
  writeFileSync(join(OUT, `${name}.txt`), v.lines.map(lineToText).join("\n") + "\n");
  const h = Math.ceil(v.lines.length * 22.5 + 175);
  const w = Math.ceil(v.cols * 8.65 + 44 + 44);
  shots.push(`/opt/pw-browsers/chromium --headless --disable-gpu --no-sandbox --hide-scrollbars --screenshot=${join(OUT, name + ".png")} --window-size=${w},${h} file://${join(OUT, name + ".html")} 2>/dev/null`);
}
writeFileSync(join(OUT, "shots.sh"), shots.join("\n") + "\n");
console.log("wrote", Object.keys(versions).join(", "));
