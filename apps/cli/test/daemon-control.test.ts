import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, test, vi } from "vitest";
import { assert } from "@lorenz/test-utils";

import {
  runDaemonRefreshCommand,
  runDaemonStatusCommand,
  runDaemonStopCommand,
} from "../src/daemonControl.js";
import { daemonLockPath } from "../src/daemonLock.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("daemon status --url fetches the requested endpoint without a workflow lock", async () => {
  const fetchSpy = vi.fn(async (url: string) => {
    assert.equal(url, "http://127.0.0.1:48080/api/v1/daemon");
    return new Response(JSON.stringify({ owner_id: "owner-url" }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  });
  vi.stubGlobal("fetch", fetchSpy);

  const result = await runDaemonStatusCommand({
    workflowPath: null,
    url: "http://127.0.0.1:48080",
    port: null,
    controlToken: null,
    json: true,
  });

  assert.equal(result.statusCode, 0);
  assert.match(result.output, /owner-url/);
  assert.equal(fetchSpy.mock.calls.length, 1);
});

test("daemon stop --url uses the lock token only for the matching endpoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lorenz-daemon-control-"));
  try {
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "name: daemon-control",
        "tracker:",
        "  kind: memory",
        "workspace:",
        `  root: ${JSON.stringify(root)}`,
        "---",
        "",
      ].join("\n"),
      "utf8",
    );
    const lockPath = daemonLockPath(workflowPath);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        version: 1,
        ownerId: "owner-a",
        pid: 101,
        hostname: "host-a",
        startedAt: "2026-01-01T00:00:00.000Z",
        workflowPath,
        workspaceRoot: root,
        endpoint: { kind: "http", address: "http://127.0.0.1:48080/" },
        controlToken: "control-token",
        heartbeatAt: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );

    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (url === "http://127.0.0.1:48080/api/v1/stop") {
        assert.equal(headers?.authorization, "Bearer control-token");
      } else {
        assert.equal(url, "http://127.0.0.1:48081/api/v1/stop");
        assert.equal(headers?.authorization, undefined);
      }
      return new Response(JSON.stringify({ stopping: true }), {
        status: 202,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await runDaemonStopCommand({
      workflowPath,
      url: "http://127.0.0.1:48080",
      port: null,
      controlToken: null,
      json: true,
    });

    assert.equal(result.statusCode, 0);
    assert.equal(fetchSpy.mock.calls[0]?.[0], "http://127.0.0.1:48080/api/v1/stop");
    assert.match(result.output, /stopping/);

    const mismatch = await runDaemonStopCommand({
      workflowPath,
      url: "http://127.0.0.1:48081",
      port: null,
      controlToken: null,
      json: true,
    });
    assert.equal(mismatch.statusCode, 0);
    await assert.rejects(
      () =>
        runDaemonStopCommand({
          workflowPath,
          url: "http://127.0.0.1:48080/?x=1",
          port: null,
          controlToken: null,
          json: true,
        }),
      /--url must not include a query string or fragment/,
    );
    assert.equal(fetchSpy.mock.calls.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon control --url works without a workflow lock", async () => {
  const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    assert.equal(headers?.authorization, undefined);
    if (url === "http://127.0.0.1:48080/api/v1/refresh") {
      return new Response(JSON.stringify({ refreshed: true }), {
        status: 202,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    assert.equal(url, "http://127.0.0.1:48080/api/v1/stop");
    return new Response(JSON.stringify({ stopping: true }), {
      status: 202,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  });
  vi.stubGlobal("fetch", fetchSpy);

  const refresh = await runDaemonRefreshCommand({
    workflowPath: null,
    url: "http://127.0.0.1:48080",
    port: null,
    controlToken: null,
    json: true,
  });
  const stop = await runDaemonStopCommand({
    workflowPath: null,
    url: "http://127.0.0.1:48080",
    port: null,
    controlToken: null,
    json: true,
  });

  assert.equal(refresh.statusCode, 0);
  assert.match(refresh.output, /refreshed/);
  assert.equal(stop.statusCode, 0);
  assert.match(stop.output, /stopping/);
  assert.equal(fetchSpy.mock.calls.length, 2);
});

test("daemon control reads the lock before parsing a broken workflow", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lorenz-daemon-control-broken-workflow-"));
  try {
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "name: daemon-control-broken-workflow",
        "tracker:",
        "  kind: memory",
        "workspace:",
        `  root: ${JSON.stringify(root)}`,
        "---",
        "",
      ].join("\n"),
      "utf8",
    );
    const lockPath = daemonLockPath(workflowPath);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        version: 1,
        ownerId: "owner-a",
        pid: 101,
        hostname: "host-a",
        startedAt: "2026-01-01T00:00:00.000Z",
        workflowPath,
        workspaceRoot: root,
        endpoint: { kind: "http", address: "http://127.0.0.1:48080/" },
        controlToken: "control-token",
        heartbeatAt: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );
    await writeFile(workflowPath, "---\nname: [\n---\n", "utf8");

    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (url === "http://127.0.0.1:48080/api/v1/daemon") {
        assert.equal(headers?.authorization, undefined);
        return new Response(JSON.stringify({ owner_id: "owner-live" }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      assert.match(url, /^http:\/\/127\.0\.0\.1:48080\/api\/v1\/(?:refresh|stop)$/);
      assert.equal(headers?.authorization, "Bearer control-token");
      return new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const status = await runDaemonStatusCommand({
      workflowPath,
      url: null,
      port: null,
      controlToken: null,
      json: true,
    });
    const refresh = await runDaemonRefreshCommand({
      workflowPath,
      url: null,
      port: null,
      controlToken: null,
      json: true,
    });
    const stop = await runDaemonStopCommand({
      workflowPath,
      url: null,
      port: null,
      controlToken: null,
      json: true,
    });

    assert.equal(status.statusCode, 0);
    assert.match(status.output, /owner-live/);
    assert.equal(refresh.statusCode, 0);
    assert.equal(stop.statusCode, 0);
    assert.equal(fetchSpy.mock.calls.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon control does not fall back to workflow port when the lock has no HTTP endpoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lorenz-daemon-control-none-"));
  try {
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "name: daemon-control-none",
        "tracker:",
        "  kind: memory",
        "workspace:",
        `  root: ${JSON.stringify(root)}`,
        "server:",
        "  port: 48080",
        "---",
        "",
      ].join("\n"),
      "utf8",
    );
    const lockPath = daemonLockPath(workflowPath);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        version: 1,
        ownerId: "owner-a",
        pid: 101,
        hostname: "host-a",
        startedAt: "2026-01-01T00:00:00.000Z",
        workflowPath,
        workspaceRoot: root,
        endpoint: { kind: "none", address: "" },
        controlToken: "control-token",
        heartbeatAt: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );
    const fetchSpy = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);

    await assert.rejects(
      () =>
        runDaemonStopCommand({
          workflowPath,
          url: null,
          port: null,
          controlToken: null,
          json: true,
        }),
      /Daemon is running without a usable control endpoint/,
    );
    assert.equal(fetchSpy.mock.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon control --url can use an explicit control token", async () => {
  const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    assert.equal(headers?.authorization, "Bearer explicit-token");
    return new Response(JSON.stringify({ stopping: true }), {
      status: 202,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  });
  vi.stubGlobal("fetch", fetchSpy);

  const result = await runDaemonStopCommand({
    workflowPath: null,
    url: "http://127.0.0.1:48080",
    port: null,
    controlToken: "explicit-token",
    json: true,
  });

  assert.equal(result.statusCode, 0);
  assert.match(result.output, /stopping/);
  assert.equal(fetchSpy.mock.calls[0]?.[0], "http://127.0.0.1:48080/api/v1/stop");
});

test("daemon control reports non-json HTTP errors", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("not json", {
          status: 500,
          headers: { "content-type": "text/plain" },
        }),
    ),
  );

  const result = await runDaemonStopCommand({
    workflowPath: null,
    url: "http://127.0.0.1:48080",
    port: null,
    controlToken: "explicit-token",
    json: false,
  });

  assert.equal(result.statusCode, 1);
  assert.match(result.output, /Daemon request failed with status 500/);
});

test("daemon status lock fallback keeps text-mode status successful on request failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lorenz-daemon-status-fallback-"));
  try {
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "name: daemon-status-fallback",
        "tracker:",
        "  kind: memory",
        "workspace:",
        `  root: ${JSON.stringify(root)}`,
        "---",
        "",
      ].join("\n"),
      "utf8",
    );
    const lockPath = daemonLockPath(workflowPath);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        version: 1,
        ownerId: "owner-a",
        pid: 101,
        hostname: "host-a",
        startedAt: "2026-01-01T00:00:00.000Z",
        workflowPath,
        workspaceRoot: root,
        endpoint: { kind: "http", address: "http://127.0.0.1:48080/" },
        controlToken: "control-token",
        heartbeatAt: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );

    const text = await runDaemonStatusCommand({
      workflowPath,
      url: null,
      port: null,
      controlToken: null,
      json: false,
    });
    const json = await runDaemonStatusCommand({
      workflowPath,
      url: null,
      port: null,
      controlToken: null,
      json: true,
    });
    const direct = await runDaemonStatusCommand({
      workflowPath: null,
      url: "http://127.0.0.1:48080",
      port: null,
      controlToken: null,
      json: false,
    });

    assert.equal(text.statusCode, 0);
    assert.match(text.output, /owner-a/);
    assert.equal(json.statusCode, 1);
    assert.match(json.output, /owner-a/);
    assert.equal(direct.statusCode, 1);
    assert.match(direct.output, /connection refused/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon status lock fallback preserves non-json HTTP error status", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lorenz-daemon-status-http-error-"));
  try {
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "name: daemon-status-http-error",
        "tracker:",
        "  kind: memory",
        "workspace:",
        `  root: ${JSON.stringify(root)}`,
        "---",
        "",
      ].join("\n"),
      "utf8",
    );
    const lockPath = daemonLockPath(workflowPath);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        version: 1,
        ownerId: "owner-a",
        pid: 101,
        hostname: "host-a",
        startedAt: "2026-01-01T00:00:00.000Z",
        workflowPath,
        workspaceRoot: root,
        endpoint: { kind: "http", address: "http://127.0.0.1:48080/" },
        controlToken: "control-token",
        heartbeatAt: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("not json", {
            status: 500,
            headers: { "content-type": "text/plain" },
          }),
      ),
    );

    const fallback = await runDaemonStatusCommand({
      workflowPath,
      url: null,
      port: null,
      controlToken: null,
      json: false,
    });
    const direct = await runDaemonStatusCommand({
      workflowPath: null,
      url: "http://127.0.0.1:48080",
      port: null,
      controlToken: null,
      json: false,
    });

    assert.equal(fallback.statusCode, 1);
    assert.match(fallback.output, /owner-a/);
    assert.equal(direct.statusCode, 1);
    assert.match(direct.output, /Daemon request failed with status 500/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
