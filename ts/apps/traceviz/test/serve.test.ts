import type * as NodeFs from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

const serverMock = vi.hoisted(() => ({
  fetch: undefined as undefined | ((request: Request) => Response | Promise<Response>),
}));

vi.mock("@hono/node-server", () => ({
  serve: (
    options: { fetch: (request: Request) => Response | Promise<Response> },
    callback?: () => void,
  ) => {
    serverMock.fetch = options.fetch;
    callback?.();
  },
}));

vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: () => () => undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const existsSync = (target: Parameters<typeof actual.existsSync>[0]): boolean => {
    if (target.toString().endsWith("apps/symphony-dashboard/dist")) {
      return true;
    }
    return actual.existsSync(target);
  };

  return {
    ...actual,
    default: {
      ...actual.default,
      existsSync,
    },
    existsSync,
  };
});

const fixturePath = fileURLToPath(
  new URL("../../../packages/traceviz-server/test/fixtures/minimal-trace.jsonl", import.meta.url),
);

async function loadStandaloneFetch(): Promise<(request: Request) => Response | Promise<Response>> {
  vi.resetModules();
  serverMock.fetch = undefined;

  const originalArgv = process.argv;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    process.argv = ["node", "serve.ts", fixturePath];
    await import("../serve.ts");
  } finally {
    process.argv = originalArgv;
    log.mockRestore();
  }

  if (!serverMock.fetch) {
    throw new Error("TraceViz standalone app did not start");
  }

  return serverMock.fetch;
}

describe("standalone traceviz routes", () => {
  it("serves the loaded trace for the matching ticket id", async () => {
    const fetch = await loadStandaloneFetch();

    const eventsResponse = await fetch(
      new Request("http://localhost/api/v1/tickets/test-id/events"),
    );
    expect(eventsResponse.status).toBe(200);
    const eventsBody = (await eventsResponse.json()) as { events: unknown[] };
    expect(eventsBody.events.length).toBeGreaterThan(0);

    const statsResponse = await fetch(new Request("http://localhost/api/v1/tickets/test-id/stats"));
    expect(statsResponse.status).toBe(200);
    const statsBody = (await statsResponse.json()) as { totalEvents: number };
    expect(statsBody.totalEvents).toBeGreaterThan(0);
  });

  it("returns 404 when the route ticket id does not match the loaded trace", async () => {
    const fetch = await loadStandaloneFetch();

    const eventsResponse = await fetch(
      new Request("http://localhost/api/v1/tickets/not-the-loaded-trace/events"),
    );
    expect(eventsResponse.status).toBe(404);

    const statsResponse = await fetch(
      new Request("http://localhost/api/v1/tickets/not-the-loaded-trace/stats"),
    );
    expect(statsResponse.status).toBe(404);
  });
});
