import fs from "node:fs";
import path from "node:path";

import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { DisplayEvent, TraceStats } from "@symphony/traceviz-server";

export type TracevizAppOptions = {
  dashboardDist: string;
  events: DisplayEvent[];
  identifier: string;
  issueId: string;
  stats: TraceStats;
};

export function createTracevizApp({
  dashboardDist,
  events,
  identifier,
  issueId,
  stats,
}: TracevizAppOptions): Hono {
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
    if (decodeURIComponent(c.req.param("id")) !== issueId) {
      return c.json({ error: "Ticket not found" }, 404);
    }

    return c.json({ events });
  });

  app.get("/api/v1/tickets/:id/stats", (c) => {
    if (decodeURIComponent(c.req.param("id")) !== issueId) {
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
