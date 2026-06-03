/**
 * Standalone trace viewer: reads a JSONL trace file and serves
 * the pre-built dashboard UI with the parsed events.
 *
 * Usage:
 *   pnpm traceviz path/to/trace.jsonl
 */

import fs from "node:fs";
import path from "node:path";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { parseTraceLines, extractTicketMetadata, computeStats } from "@symphony/traceviz-server";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: pnpm traceviz <path-to-trace.jsonl>");
  process.exit(1);
}

const resolved = path.resolve(filePath);
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

const dashboardDist = path.resolve(import.meta.dirname, "../symphony-dashboard/dist");
if (!fs.existsSync(dashboardDist)) {
  console.error(`Dashboard not built. Run: pnpm --filter @symphony/dashboard build`);
  process.exit(1);
}

const app = new Hono();

app.get("/api/v1/tickets", (c) => {
  return c.json({
    tickets: [
      {
        issueId,
        identifier,
        turnCount: events.filter((e) => e.kind === "turn_started").length,
        status: "completed" as const,
        startedAt: events[0]?.timestamp,
      },
    ],
  });
});

app.get("/api/v1/tickets/:id/events", (c) => {
  return c.json({ events });
});

app.get("/api/v1/tickets/:id/stats", (c) => {
  return c.json(stats);
});

app.get("/health", (c) => c.json({ status: "ok" }));

app.use("/*", serveStatic({ root: path.relative(process.cwd(), dashboardDist) }));

// SPA fallback: serve index.html for any unmatched route
app.get("/*", (c) => {
  const html = fs.readFileSync(path.join(dashboardDist, "index.html"), "utf-8");
  return c.html(html);
});

const PORT = 4040;

serve({ fetch: app.fetch, port: PORT }, () => {
  const url = `http://localhost:${PORT}/#/trace/${encodeURIComponent(issueId)}`;
  console.log(`Trace: ${resolved} (${events.length} events)`);
  console.log();
  console.log(`  ${url}`);
  console.log();
});
