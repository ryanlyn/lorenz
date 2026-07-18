import fs from "node:fs";
import path from "node:path";

import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  createTraceTicketRoutes,
  decodePathParam,
  invalidPathParameterError,
  type TraceDataSource,
} from "@lorenz/server/trace-routes";
import type { TraceStats } from "@lorenz/traceviz-core";

export type TracevizAppOptions = {
  dashboardDist: string;
  source: TraceDataSource;
  stats: TraceStats;
};

export function createTracevizApp({ dashboardDist, source, stats }: TracevizAppOptions): Hono {
  const app = new Hono();

  app.route("/", createTraceTicketRoutes(source));

  app.get("/api/v1/tickets/:id/stats", (c) => {
    const issueId = decodePathParam(c.req.param("id"));
    if (issueId === null) return c.json({ error: invalidPathParameterError }, 400);
    if (source.getTicketTrace(issueId) === null) {
      return c.json({ error: "Ticket not found" }, 404);
    }

    return c.json(stats);
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.use("/*", serveStatic({ root: dashboardDist }));

  app.get("/*", (c) => {
    const html = fs.readFileSync(path.join(dashboardDist, "index.html"), "utf-8");
    return c.html(html);
  });

  return app;
}
