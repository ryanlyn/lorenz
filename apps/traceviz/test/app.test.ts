import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTracevizApp } from "../app.js";

const assetContent = 'console.log("mono-327");\n';

describe("traceviz static dashboard serving", () => {
  let originalCwd: string;
  let dashboardDist: string;
  let requestCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    dashboardDist = fs.mkdtempSync(path.join(os.tmpdir(), "traceviz-dashboard-dist-"));
    requestCwd = fs.mkdtempSync(path.join(os.tmpdir(), "traceviz-request-cwd-"));

    const assetPath = path.join(dashboardDist, "assets", "mono-327-test.js");
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.writeFileSync(assetPath, assetContent);
    fs.writeFileSync(
      path.join(dashboardDist, "index.html"),
      '<!doctype html><div id="root"></div>',
    );
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(dashboardDist, { recursive: true, force: true });
    fs.rmSync(requestCwd, { recursive: true, force: true });
  });

  it("serves assets from the dashboard dist after cwd changes", async () => {
    process.chdir(os.tmpdir());
    const app = createTracevizApp({
      dashboardDist,
      events: [],
      identifier: "TEST-1",
      issueId: "test-id",
      stats: {},
    });

    process.chdir(requestCwd);
    const response = await app.fetch(new Request("http://traceviz.local/assets/mono-327-test.js"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    await expect(response.text()).resolves.toBe(assetContent);
  });

  it("keeps the SPA fallback for app routes", async () => {
    const app = createTracevizApp({
      dashboardDist,
      events: [],
      identifier: "TEST-1",
      issueId: "test-id",
      stats: {},
    });

    const response = await app.fetch(new Request("http://traceviz.local/trace/test-id"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    await expect(response.text()).resolves.toBe(
      fs.readFileSync(path.join(dashboardDist, "index.html"), "utf-8"),
    );
  });
});
