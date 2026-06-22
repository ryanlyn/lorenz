import path from "node:path";
import { mkdirSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { IssueStore } from "../src/issue-store.js";
import { createTraceRoutes } from "../src/trace-routes.js";

function makeTempDir(): string {
  const dir = path.join(
    tmpdir(),
    `trace-routes-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTraceLine(traceDir: string, issueId: string, line: Record<string, unknown>): void {
  const issueDir = path.join(traceDir, issueId);
  mkdirSync(issueDir, { recursive: true });
  appendFileSync(path.join(issueDir, "trace.jsonl"), JSON.stringify(line) + "\n");
}

describe("trace routes with IssueStore enrichment", () => {
  let traceDir: string;
  let issueStore: IssueStore;
  let app: ReturnType<typeof createTraceRoutes>["app"];
  let watcher: ReturnType<typeof createTraceRoutes>["watcher"];

  beforeEach(() => {
    traceDir = makeTempDir();
    issueStore = new IssueStore(path.join(traceDir, "issues.db"));

    writeTraceLine(traceDir, "TEST-1", {
      type: "turn_started",
      issueId: "id-1",
      issueIdentifier: "TEST-1",
      timestamp: "2026-01-01T00:00:00Z",
    });
    writeTraceLine(traceDir, "TEST-2", {
      type: "turn_started",
      issueId: "id-2",
      issueIdentifier: "TEST-2",
      timestamp: "2026-01-01T00:01:00Z",
    });

    const routes = createTraceRoutes(traceDir, issueStore);
    app = routes.app;
    watcher = routes.watcher;
  });

  afterEach(() => {
    watcher.stop();
    issueStore.close();
    rmSync(traceDir, { recursive: true, force: true });
  });

  async function getJson(path: string, expectedStatus = 200): Promise<unknown> {
    const req = new Request(`http://localhost${path}`);
    const res = await app.fetch(req);
    expect(res.status).toBe(expectedStatus);
    return res.json();
  }

  it("GET /api/v1/tickets enriches title and url from issue store", async () => {
    issueStore.upsert({
      issueId: "id-1",
      issueIdentifier: "TEST-1",
      title: "Fix login",
      url: "https://linear.app/1",
    });
    issueStore.upsert({
      issueId: "id-2",
      issueIdentifier: "TEST-2",
      title: "Add tests",
      url: null,
    });

    // Let watcher pick up the trace files
    watcher.start(() => {});
    await vi.waitFor(() => expect(watcher.getTickets()).toHaveLength(2));

    const data = (await getJson("/api/v1/tickets")) as { tickets: Array<Record<string, unknown>> };
    expect(data.tickets).toHaveLength(2);

    const ticket1 = data.tickets.find((t) => t.issueId === "id-1");
    expect(ticket1?.title).toBe("Fix login");
    expect(ticket1?.url).toBe("https://linear.app/1");

    const ticket2 = data.tickets.find((t) => t.issueId === "id-2");
    expect(ticket2?.title).toBe("Add tests");
    expect(ticket2?.url).toBeNull();
  });

  it("GET /api/v1/tickets returns tickets without store data gracefully", async () => {
    watcher.start(() => {});
    await vi.waitFor(() => expect(watcher.getTickets()).toHaveLength(2));

    const data = (await getJson("/api/v1/tickets")) as { tickets: Array<Record<string, unknown>> };
    expect(data.tickets).toHaveLength(2);

    const ticket1 = data.tickets.find((t) => t.issueId === "id-1");
    expect(ticket1?.title).toBeUndefined();
    expect(ticket1?.url).toBeUndefined();
  });

  it("GET /api/v1/tickets/:id/events uses store identifier", async () => {
    issueStore.upsert({ issueId: "id-1", issueIdentifier: "RENAMED-1", title: "Title", url: null });

    watcher.start(() => {});
    await vi.waitFor(() => expect(watcher.getTickets()).toHaveLength(2));

    const data = (await getJson("/api/v1/tickets/id-1/events")) as Record<string, unknown>;
    expect(data.identifier).toBe("RENAMED-1");
  });

  it("GET /api/v1/tickets/:id/events decodes valid encoded ticket ids", async () => {
    issueStore.upsert({ issueId: "id-1", issueIdentifier: "RENAMED-1", title: "Title", url: null });

    watcher.start(() => {});
    await vi.waitFor(() => expect(watcher.getTickets()).toHaveLength(2));

    const data = (await getJson("/api/v1/tickets/id%2D1/events")) as Record<string, unknown>;
    expect(data.issueId).toBe("id-1");
    expect(data.identifier).toBe("RENAMED-1");
  });

  it("GET /api/v1/tickets/:id/events falls back to watcher identifier", async () => {
    watcher.start(() => {});
    await vi.waitFor(() => expect(watcher.getTickets()).toHaveLength(2));

    const data = (await getJson("/api/v1/tickets/id-1/events")) as Record<string, unknown>;
    expect(data.identifier).toBe("TEST-1");
  });

  it.each(["/api/v1/tickets/%E0%A4%A/exists", "/api/v1/tickets/%E0%A4%A/events"])(
    "GET %s returns structured 400 for malformed ticket ids",
    async (path) => {
      const req = new Request(`http://localhost${path}`);
      const res = await app.fetch(req);

      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toMatch(/^application\/json/i);
      expect(await res.json()).toEqual({
        error: {
          code: "invalid_path_parameter",
          message: "Malformed percent encoding in path parameter",
        },
      });
    },
  );

  it("GET /api/v1/tickets/:id/exists returns true for known ticket", async () => {
    watcher.start(() => {});
    await vi.waitFor(() => expect(watcher.getTickets()).toHaveLength(2));

    const data = (await getJson("/api/v1/tickets/id-1/exists")) as { exists: boolean };
    expect(data.exists).toBe(true);
  });

  it("GET /api/v1/tickets/:id/exists returns false for unknown ticket", async () => {
    watcher.start(() => {});
    await vi.waitFor(() => expect(watcher.getTickets()).toHaveLength(2));

    const data = (await getJson("/api/v1/tickets/no-such-id/exists")) as { exists: boolean };
    expect(data.exists).toBe(false);
  });

  it("GET /api/v1/issues/recent returns records from issue store", async () => {
    // Fake timers give the two upserts distinct, deterministic `updatedAt`
    // stamps (IssueStore.upsert reads Date.now()) so recency ordering is stable.
    vi.useFakeTimers();
    try {
      issueStore.upsert({
        issueId: "id-1",
        issueIdentifier: "TEST-1",
        title: "First issue",
        url: null,
      });
      vi.advanceTimersByTime(10);
      issueStore.upsert({
        issueId: "id-2",
        issueIdentifier: "TEST-2",
        title: "Second issue",
        url: "https://linear.app/2",
      });
    } finally {
      vi.useRealTimers();
    }

    const data = (await getJson("/api/v1/issues/recent?limit=5")) as {
      issues: Array<Record<string, unknown>>;
    };
    expect(data.issues).toHaveLength(2);
    expect(data.issues[0]!.issueId).toBe("id-2");
  });

  it("GET /api/v1/issues/search filters by query", async () => {
    issueStore.upsert({
      issueId: "id-1",
      issueIdentifier: "TEST-1",
      title: "Fix login",
      url: null,
    });
    issueStore.upsert({
      issueId: "id-2",
      issueIdentifier: "TEST-2",
      title: "Add signup",
      url: null,
    });

    const data = (await getJson("/api/v1/issues/search?q=login")) as {
      issues: Array<Record<string, unknown>>;
    };
    expect(data.issues).toHaveLength(1);
    expect(data.issues[0]!.issueId).toBe("id-1");
  });

  it("GET /api/v1/issues/search returns empty array for no matches", async () => {
    const data = (await getJson("/api/v1/issues/search?q=nonexistent")) as {
      issues: Array<Record<string, unknown>>;
    };
    expect(data.issues).toHaveLength(0);
  });
});
