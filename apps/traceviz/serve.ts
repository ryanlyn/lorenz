/**
 * Standalone trace viewer: reads a JSONL trace file and serves
 * the pre-built dashboard UI with the parsed events.
 *
 * Usage:
 *   pnpm traceviz path/to/trace.jsonl
 */

import fs from "node:fs";
import path from "node:path";

import { serve } from "@hono/node-server";
import { parseTraceLines, extractTicketMetadata, computeStats } from "@lorenz/traceviz-server";

import { createTracevizApp } from "./app.js";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: pnpm traceviz <path-to-trace.jsonl>");
  process.exit(1);
}

const invocationCwd = process.env.INIT_CWD ?? process.cwd();
const resolved = path.resolve(invocationCwd, filePath);
if (!fs.existsSync(resolved)) {
  console.error(`File not found: ${resolved}`);
  process.exit(1);
}

const content = fs.readFileSync(resolved, "utf-8");
const lines = content.split("\n").filter((l) => l.trim().length > 0);
const events = parseTraceLines(lines);
const metadata = extractTicketMetadata(lines);
const stats = computeStats(events);

const issueId = metadata?.issueId ?? path.basename(resolved, ".jsonl");
const identifier = metadata?.issueIdentifier ?? path.basename(resolved, ".jsonl");

const dashboardDist = path.resolve(import.meta.dirname, "../web/dist");
if (!fs.existsSync(dashboardDist)) {
  console.error(`Dashboard not built. Run: pnpm --filter @lorenz/dashboard build`);
  process.exit(1);
}

const app = createTracevizApp({
  dashboardDist,
  events,
  identifier,
  issueId,
  stats,
});

const PORT = 4040;

serve({ fetch: app.fetch, hostname: "127.0.0.1", port: PORT }, () => {
  const url = `http://localhost:${PORT}/#/trace/${encodeURIComponent(issueId)}`;
  console.log(`Trace: ${resolved} (${events.length} events)`);
  console.log();
  console.log(`  ${url}`);
  console.log();
});
