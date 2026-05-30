import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { test, vi } from "vitest";

import { assert } from "../../../test/assert.js";
import { tempDir } from "../../../test/helpers.js";

import { parseRunsArgs, runRunsCommand, runRunsMain } from "@symphony/cli/runs";

test("runs command parses Elixir mix task filters", () => {
  assert.deepEqual(
    parseRunsArgs(["--issue", "MONO-171", "--failed", "--limit", "5", "--port", "4100"]),
    {
      status: "ok",
      options: {
        issue: "MONO-171",
        failed: true,
        cost: false,
        retries: false,
        id: null,
        limit: 5,
        url: null,
        port: 4100,
        json: false,
      },
    },
  );
  assert.deepEqual(parseRunsArgs(["--port", "0"]), {
    status: "ok",
    options: {
      issue: null,
      failed: false,
      cost: false,
      retries: false,
      id: null,
      limit: null,
      url: null,
      port: 0,
      json: false,
    },
  });
  assert.deepEqual(parseRunsArgs(["--issue=MONO-171", "--limit=5", "--port=4100"]), {
    status: "ok",
    options: {
      issue: "MONO-171",
      failed: false,
      cost: false,
      retries: false,
      id: null,
      limit: 5,
      url: null,
      port: 4100,
      json: false,
    },
  });
});

test("runs command queries the observability API and renders a run table", async () => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/api/v1/runs?failed=true&limit=5");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        view: "runs",
        summary: { total: 1, running: 0, success: 0, failed: 1, stalled: 0, canceled: 0 },
        runs: [
          {
            id: "run-2",
            issue_identifier: "MT-RETRY",
            agent_kind: "codex",
            outcome: "failed",
            retry_attempt: 2,
            turn_count: 3,
            tokens: { total_tokens: 15 },
            duration_ms: 1234,
            session_id: "thread-retry-turn-2",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const parsed = parseRunsArgs([
      "--url",
      `http://127.0.0.1:${address.port}`,
      "--failed",
      "--limit",
      "5",
    ]);
    assert.equal(parsed.status, "ok");
    const output = await runRunsCommand(parsed.options);
    assert.match(output, /Run History/);
    assert.match(output, /run-2/);
    assert.match(output, /MT-RETRY/);
    assert.match(output, /failed/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("runs command renders cost, retries, run detail, and JSON branches", async () => {
  const seenUrls: string[] = [];
  const server = http.createServer((request, response) => {
    seenUrls.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/api/v1/runs?cost=true") {
      response.end(
        JSON.stringify({
          view: "cost",
          summary: {
            by_agent: [
              {
                agent_kind: "codex",
                run_count: 2,
                completed_count: 1,
                input_tokens: 1000,
                output_tokens: 250,
                total_tokens: 1250,
                average_total_tokens_per_run: 625,
                estimated_cost_usd: 1.23456,
              },
            ],
            top_runs: [
              {
                id: "run-cost",
                issue_identifier: "MT-COST",
                agent_kind: "codex",
                outcome: "success",
                tokens: { total_tokens: 1250 },
              },
            ],
          },
        }),
      );
      return;
    }
    if (request.url === "/api/v1/runs?retries=true") {
      response.end(
        JSON.stringify({
          view: "retries",
          issues: [
            {
              issue_identifier: "MT-RETRY",
              attempts: 3,
              latest_outcome: "failed",
              total_tokens: 99,
              latest_run_id: "run-3",
              latest_failure_reason: "boom",
            },
          ],
        }),
      );
      return;
    }
    if (request.url === "/api/v1/runs?id=run-2") {
      response.end(
        JSON.stringify({
          view: "run",
          run: {
            id: "run-2",
            issue_id: "issue-2",
            issue_identifier: "MT-DETAIL",
            agent_kind: "claude",
            outcome: "success",
            retry_attempt: 2,
            duration_ms: 2500,
            tokens: { total_tokens: 42 },
            turn_count: 4,
            session_id: "thread-detail",
            resume_id: "resume-detail",
            worker_host: "worker-1",
            workspace_path: "/tmp/work",
            last_event: "turn_completed",
            last_event_at: "2026-05-05T00:00:02.000Z",
            failure_reason: null,
            log_hints: { symphony_log_file: "/tmp/symphony.log" },
          },
          related_runs: [
            {
              id: "run-1",
              outcome: "failed",
              tokens: { total_tokens: 12 },
              started_at: "2026-05-05T00:00:00.000Z",
            },
          ],
        }),
      );
      return;
    }
    response.end(JSON.stringify({ view: "runs", summary: { total: 0 }, runs: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const costOptions = parseRunsArgs(["--url", baseUrl, "--cost"]);
    assert.equal(costOptions.status, "ok");
    const cost = await runRunsCommand(costOptions.options);
    assert.match(cost, /Cost Summary/);
    assert.match(cost, /codex/);
    assert.match(cost, /\$1\.2346/);

    const retriesOptions = parseRunsArgs(["--url", baseUrl, "--retries"]);
    assert.equal(retriesOptions.status, "ok");
    const retries = await runRunsCommand(retriesOptions.options);
    assert.match(retries, /Retry Summary/);
    assert.match(retries, /MT-RETRY/);
    assert.match(retries, /boom/);

    const detailOptions = parseRunsArgs(["--url", baseUrl, "--id", "run-2"]);
    assert.equal(detailOptions.status, "ok");
    const detail = await runRunsCommand(detailOptions.options);
    assert.match(detail, /Run run-2/);
    assert.match(detail, /worker=worker-1/);
    assert.match(detail, /Related runs/);

    const jsonOptions = parseRunsArgs(["--url", baseUrl, "--json"]);
    assert.equal(jsonOptions.status, "ok");
    const json = await runRunsCommand(jsonOptions.options);
    assert.match(json, /"view": "runs"/);

    assert.deepEqual(seenUrls, [
      "/api/v1/runs?cost=true",
      "/api/v1/runs?retries=true",
      "/api/v1/runs?id=run-2",
      "/api/v1/runs",
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("runs command reports Elixir-shaped 404 and 503 errors", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/api/v1/runs?id=missing") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "run_not_found", message: "Run not found" } }));
      return;
    }
    response.writeHead(503, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ error: { code: "snapshot_timeout", message: "Snapshot timed out" } }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await assert.rejects(() => runRunsMain(["--url", baseUrl, "--id", "missing"]), /Run not found/);
    await assert.rejects(() => runRunsMain(["--url", baseUrl]), /Snapshot timed out/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("runs command uses workflow-derived default server host and port", async () => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/api/v1/runs?limit=1");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        view: "runs",
        summary: { total: 0, running: 0, success: 0, failed: 0, stalled: 0, canceled: 0 },
        runs: [],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const dir = await tempDir("symphony-ts-runs-workflow");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await fs.writeFile(
      workflowPath,
      `---\nserver:\n  host: 127.0.0.1\n  port: ${address.port}\n---\nRun it\n`,
    );
    vi.stubEnv("SYMPHONY_WORKFLOW", workflowPath);

    const output = await runRunsMain(["--limit", "1"]);
    assert.match(output, /Run History/);
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
