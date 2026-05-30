import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, test, vi } from "vitest";
import { CodexAppServerExecutor, parseConfig, shellEscape } from "@symphony/cli";
import type { AgentUpdate } from "@symphony/cli";

import { assert } from "../../../test/assert.js";
import { sampleIssue, tempDir, writeExecutable } from "../../../test/helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("Codex app-server executor performs initialize, thread start, turn start, and completion", async () => {
  const root = await tempDir("symphony-ts-codex");
  const fake = path.join(root, "fake-codex.js");
  const trace = path.join(root, "trace.jsonl");
  await writeExecutable(
    fake,
    `#!/usr/bin/env node
const fs = require("fs");
const readline = require("readline");
const trace = ${JSON.stringify(trace)};
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  fs.appendFileSync(trace, line + "\\n");
  const msg = JSON.parse(line);
  if (msg.id && msg.method === "initialize") console.log(JSON.stringify({ id: msg.id, result: {} }));
  if (msg.id && (msg.method === "thread/start" || msg.method === "thread/resume")) console.log(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-1" } } }));
  if (msg.id && msg.method === "turn/start") {
    console.log(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-1" } } }));
    console.log(JSON.stringify({ method: "thread/tokenUsage/updated", params: { total_token_usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } }));
    console.log(JSON.stringify({ method: "turn/completed" }));
  }
});
`,
  );

  const settings = parseConfig({
    workspace: { root: path.dirname(root) },
    codex: { command: `${fake} app-server` },
  });
  const executor = new CodexAppServerExecutor();
  const updates: AgentUpdate[] = [];
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
    onUpdate: (update) => updates.push(update),
  });
  const turnUpdates = await executor.runTurn(session, "hello", sampleIssue);
  await session.stop();

  assert.equal(session.resumeId, "thread-1");
  assert.ok(turnUpdates.some((update) => update.type === "turn_completed"));
  assert.equal(
    turnUpdates.find((update) => update.type === "turn_completed")?.sessionUpdate?.kind,
    "turn_completed",
  );
  assert.equal(
    updates.find((update) => update.type === "usage")?.sessionUpdate?.kind,
    "usage_update",
  );
  assert.ok(updates.some((update) => update.type === "usage"));
  const traceText = await fs.readFile(trace, "utf8");
  assert.equal(session.sessionId, "thread-1-turn-1");
  assert.match(traceText, /"method":"initialize"/);
  assert.match(traceText, /"method":"thread\/start"/);
  assert.match(traceText, /"method":"turn\/start"/);
  assert.match(traceText, /"approvalPolicy":\{"reject":/);
  assert.notMatch(traceText, /"approvalPolicy":"never"/);
  assert.match(traceText, /"inputSchema"/);
});

test("Codex app-server executor normalizes token usage notification params", async () => {
  const root = await tempDir("symphony-ts-codex-usage-params");
  const fake = path.join(root, "fake-codex-usage-params.js");
  await writeExecutable(
    fake,
    `#!/usr/bin/env node
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id && msg.method === "initialize") console.log(JSON.stringify({ id: msg.id, result: {} }));
  if (msg.id && msg.method === "thread/start") console.log(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-usage" } } }));
  if (msg.id && msg.method === "turn/start") {
    console.log(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-usage" } } }));
    console.log(JSON.stringify({ method: "thread/tokenUsage/updated", params: { usage: { prompt_tokens: "7", completion_tokens: "11", total_tokens: "18" } } }));
    console.log(JSON.stringify({ method: "turn/completed" }));
  }
});
`,
  );

  const settings = parseConfig({
    workspace: { root: path.dirname(root) },
    codex: { command: `${fake} app-server`, turn_timeout_ms: 5_000 },
  });
  const updates: AgentUpdate[] = [];
  const executor = new CodexAppServerExecutor();
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
    onUpdate: (update) => updates.push(update),
  });
  await executor.runTurn(session, "hello", sampleIssue);
  await session.stop();

  assert.deepEqual(updates.find((update) => update.type === "usage")?.usage, {
    inputTokens: 7,
    outputTokens: 11,
    totalTokens: 18,
  });
});

test("Codex app-server executor answers string-id dynamic Linear tool calls", async () => {
  const root = await tempDir("symphony-ts-codex-tool");
  const fake = path.join(root, "fake-codex-tool.js");
  const trace = path.join(root, "trace.jsonl");
  await writeExecutable(
    fake,
    `#!/usr/bin/env node
const fs = require("fs");
const readline = require("readline");
const trace = ${JSON.stringify(trace)};
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  fs.appendFileSync(trace, line + "\\n");
  const msg = JSON.parse(line);
  if (msg.id && msg.method === "initialize") console.log(JSON.stringify({ id: msg.id, result: {} }));
  if (msg.id && msg.method === "thread/start") console.log(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-tool" } } }));
  if (msg.id && msg.method === "turn/start") {
    console.log(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-tool" } } }));
    console.log(JSON.stringify({ id: "tool-string-1", method: "item/tool/call", params: { name: "linear_graphql", arguments: { query: "query { viewer { id } }" } } }));
  }
  if (msg.id === "tool-string-1" && msg.result) {
    console.log(JSON.stringify({ method: "turn/completed" }));
  }
});
`,
  );

  const settings = parseConfig({
    workspace: { root: path.dirname(root) },
    tracker: { api_key: "linear-token", project_slug: "mono" },
    codex: { command: `${fake} app-server`, turn_timeout_ms: 5_000 },
  });
  vi.stubGlobal("fetch", (async () =>
    jsonResponse({ data: { viewer: { id: "viewer-1" } } })) as typeof fetch);
  const executor = new CodexAppServerExecutor();
  const session = await executor.startSession({ workspace: root, settings, issue: sampleIssue });
  const updates = await executor.runTurn(session, "hello", sampleIssue);
  await session.stop();

  assert.ok(updates.some((update) => update.type === "tool_call_completed"));
  const traceText = await fs.readFile(trace, "utf8");
  assert.match(traceText, /"id":"tool-string-1","result":\{"success":true/);
  assert.match(traceText, /"contentItems":/);
  assert.match(traceText, /viewer-1/);
});

test("Codex app-server executor reports dynamic tool failures", async () => {
  const root = await tempDir("symphony-ts-codex-tool-failure");
  const fake = path.join(root, "fake-codex-tool-failure.js");
  const trace = path.join(root, "trace.jsonl");
  await writeExecutable(
    fake,
    `#!/usr/bin/env node
const fs = require("fs");
const readline = require("readline");
const trace = ${JSON.stringify(trace)};
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  fs.appendFileSync(trace, line + "\\n");
  const msg = JSON.parse(line);
  if (msg.id && msg.method === "initialize") console.log(JSON.stringify({ id: msg.id, result: {} }));
  if (msg.id && msg.method === "thread/start") console.log(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-tool-failure" } } }));
  if (msg.id && msg.method === "turn/start") {
    console.log(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-tool-failure" } } }));
    console.log(JSON.stringify({ id: 99, method: "item/tool/call", params: { name: "not_a_tool", arguments: {} } }));
  }
  if (msg.id === 99 && msg.result) {
    console.log(JSON.stringify({ method: "turn/completed" }));
  }
});
`,
  );

  const settings = parseConfig({
    workspace: { root: path.dirname(root) },
    tracker: { api_key: "linear-token", project_slug: "mono" },
    codex: { command: `${fake} app-server`, turn_timeout_ms: 5_000 },
  });
  const executor = new CodexAppServerExecutor();
  const session = await executor.startSession({ workspace: root, settings, issue: sampleIssue });
  const updates = await executor.runTurn(session, "hello", sampleIssue);
  await session.stop();

  assert.ok(updates.some((update) => update.type === "tool_call_failed"));
  const traceText = await fs.readFile(trace, "utf8");
  assert.match(traceText, /Unsupported tool/);
  assert.match(traceText, /"contentItems":/);
});

test("Codex app-server executor tolerates missing issue fields when building turn titles", async () => {
  const root = await tempDir("symphony-ts-codex-issue-fields");
  const fake = path.join(root, "fake-codex-issue-fields.js");
  const trace = path.join(root, "trace.jsonl");
  await writeExecutable(
    fake,
    `#!/usr/bin/env node
const fs = require("fs");
const readline = require("readline");
const trace = ${JSON.stringify(trace)};
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  fs.appendFileSync(trace, line + "\\n");
  const msg = JSON.parse(line);
  if (msg.id && msg.method === "initialize") console.log(JSON.stringify({ id: msg.id, result: {} }));
  if (msg.id && msg.method === "thread/start") console.log(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-issue-fields" } } }));
  if (msg.id && msg.method === "turn/start") {
    console.log(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-issue-fields" } } }));
    console.log(JSON.stringify({ method: "turn/completed" }));
  }
});
`,
  );

  const cases: Array<{ issue: Record<string, unknown>; expectedTitle: string | null }> = [
    {
      issue: { id: "issue-full", identifier: "MT-1001", title: "Keep the full title" },
      expectedTitle: "MT-1001: Keep the full title",
    },
    { issue: { id: "issue-identifier-only", identifier: "MT-1001" }, expectedTitle: "MT-1001" },
    { issue: { id: "issue-title-only", title: "Title without identifier" }, expectedTitle: null },
    { issue: { id: "issue-missing-both" }, expectedTitle: null },
  ];

  const settings = parseConfig({
    workspace: { root: path.dirname(root) },
    codex: { command: `${fake} app-server`, turn_timeout_ms: 5_000 },
  });
  for (const [index, testCase] of cases.entries()) {
    await fs.writeFile(trace, "");
    const executor = new CodexAppServerExecutor();
    const session = await executor.startSession({
      workspace: root,
      settings,
      issue: testCase.issue as any,
    });
    await executor.runTurn(session, "hello", testCase.issue as any);
    await session.stop();

    const turnStart = (await fs.readFile(trace, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>)
      .find((message) => message.method === "turn/start");
    assert.ok(turnStart, `missing turn/start for case ${index}`);
    if (testCase.expectedTitle === null) {
      assert.equal("title" in turnStart.params, false);
    } else {
      assert.equal(turnStart.params.title, testCase.expectedTitle);
    }
  }
});

test("Codex app-server executor surfaces malformed protocol lines and survives dead approval replies", async () => {
  const malformedRoot = await tempDir("symphony-ts-codex-malformed");
  const malformedFake = path.join(malformedRoot, "fake-codex-malformed.js");
  await writeExecutable(
    malformedFake,
    `#!/usr/bin/env node
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id && msg.method === "initialize") console.log(JSON.stringify({ id: msg.id, result: {} }));
  if (msg.id && msg.method === "thread/start") console.log(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-malformed" } } }));
  if (msg.id && msg.method === "turn/start") {
    console.log(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-malformed" } } }));
    console.log('{"method":"turn/completed"');
    console.log(JSON.stringify({ method: "turn/completed" }));
  }
});
`,
  );

  const malformedUpdates: AgentUpdate[] = [];
  const malformedSettings = parseConfig({
    workspace: { root: path.dirname(malformedRoot) },
    codex: { command: `${malformedFake} app-server`, turn_timeout_ms: 5_000 },
  });
  const malformedExecutor = new CodexAppServerExecutor();
  const malformedSession = await malformedExecutor.startSession({
    workspace: malformedRoot,
    settings: malformedSettings,
    issue: sampleIssue,
    onUpdate: (update) => malformedUpdates.push(update),
  });
  await malformedExecutor.runTurn(malformedSession, "hello", sampleIssue);
  await malformedSession.stop();
  assert.ok(
    malformedUpdates.some(
      (update) => update.type === "malformed" && update.message === '{"method":"turn/completed"',
    ),
  );
  assert.ok(malformedUpdates.some((update) => update.type === "turn_completed"));

  const deadRoot = await tempDir("symphony-ts-codex-dead-approval");
  const deadFake = path.join(deadRoot, "fake-codex-dead-approval.js");
  await writeExecutable(
    deadFake,
    `#!/usr/bin/env node
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id && msg.method === "initialize") console.log(JSON.stringify({ id: msg.id, result: {} }));
  if (msg.id && msg.method === "thread/start") console.log(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-dead-approval" } } }));
  if (msg.id && msg.method === "turn/start") {
    console.log(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-dead-approval" } } }));
    console.log(JSON.stringify({ id: 99, method: "item/commandExecution/requestApproval", params: { command: "gh pr view", cwd: "/tmp" } }));
    process.exit(0);
  }
});
`,
  );

  const deadUpdates: AgentUpdate[] = [];
  const deadSettings = parseConfig({
    workspace: { root: path.dirname(deadRoot) },
    codex: { command: `${deadFake} app-server`, turn_timeout_ms: 5_000 },
  });
  const deadExecutor = new CodexAppServerExecutor();
  const deadSession = await deadExecutor.startSession({
    workspace: deadRoot,
    settings: deadSettings,
    issue: sampleIssue,
    onUpdate: (update) => deadUpdates.push(update),
  });
  await assert.rejects(
    () => deadExecutor.runTurn(deadSession, "hello", sampleIssue),
    /approval_required/,
  );
  await deadSession.stop();
  assert.ok(deadUpdates.some((update) => update.type === "approval_required"));
  assert.equal(
    deadUpdates.some((update) => update.type === "approval_auto_approved"),
    false,
  );
  assert.ok(deadUpdates.some((update) => update.type === "process_exit"));
});

test("Codex app-server executor replies to non-interactive user input requests", async () => {
  const root = await tempDir("symphony-ts-codex-user-input-default");
  const fake = path.join(root, "fake-codex-user-input-default.js");
  const trace = path.join(root, "trace.jsonl");
  await writeExecutable(
    fake,
    `#!/usr/bin/env node
const fs = require("fs");
const readline = require("readline");
const trace = ${JSON.stringify(trace)};
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  fs.appendFileSync(trace, line + "\\n");
  const msg = JSON.parse(line);
  if (msg.id && msg.method === "initialize") console.log(JSON.stringify({ id: msg.id, result: {} }));
  if (msg.id && msg.method === "thread/start") console.log(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-user-input-default" } } }));
  if (msg.id && msg.method === "turn/start") {
    console.log(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-user-input-default" } } }));
    console.log(JSON.stringify({ id: 110, method: "item/tool/requestUserInput", params: { questions: [{ id: "freeform-1", question: "What should I say?", options: null }] } }));
  }
  if (msg.id === 110 && msg.result?.answers?.["freeform-1"]?.answers?.length === 1) {
    console.log(JSON.stringify({ method: "turn/completed" }));
  }
});
`,
  );

  const updates: AgentUpdate[] = [];
  const settings = parseConfig({
    workspace: { root: path.dirname(root) },
    codex: { command: `${fake} app-server`, turn_timeout_ms: 5_000 },
  });
  const executor = new CodexAppServerExecutor();
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
    onUpdate: (update) => updates.push(update),
  });
  await executor.runTurn(session, "hello", sampleIssue);
  await session.stop();

  assert.ok(updates.some((update) => update.type === "tool_input_auto_answered"));
  assert.equal(
    updates.some((update) => update.type === "turn_input_required"),
    false,
  );
  assert.match(
    await fs.readFile(trace, "utf8"),
    /Unable to provide interactive input in this non-interactive Symphony run\./,
  );
});

test("Codex app-server executor only auto-approves approvals when policy is never", async () => {
  const root = await tempDir("symphony-ts-codex-never-approval");
  const fake = path.join(root, "fake-codex-never-approval.js");
  await writeExecutable(
    fake,
    `#!/usr/bin/env node
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id && msg.method === "initialize") console.log(JSON.stringify({ id: msg.id, result: {} }));
  if (msg.id && msg.method === "thread/start") console.log(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-never" } } }));
  if (msg.id && msg.method === "turn/start") {
    console.log(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-never" } } }));
    console.log(JSON.stringify({ id: 99, method: "item/commandExecution/requestApproval", params: { command: "pwd", cwd: "/tmp" } }));
  }
  if (msg.id === 99 && msg.result?.decision) console.log(JSON.stringify({ method: "turn/completed" }));
});
`,
  );

  const updates: AgentUpdate[] = [];
  const settings = parseConfig({
    workspace: { root: path.dirname(root) },
    codex: { command: `${fake} app-server`, approval_policy: "never", turn_timeout_ms: 5_000 },
  });
  const executor = new CodexAppServerExecutor();
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
    onUpdate: (update) => updates.push(update),
  });
  await executor.runTurn(session, "hello", sampleIssue);
  await session.stop();

  assert.ok(updates.some((update) => update.type === "approval_auto_approved"));
  assert.equal(
    updates.some((update) => update.type === "approval_required"),
    false,
  );
});

test("Codex app-server executor can launch through an SSH worker host", async () => {
  const root = await tempDir("symphony-ts-codex-remote");
  const remoteWorkspace = path.join(root, "remote-workspace");
  const fakeCodex = path.join(root, "fake-codex-remote.js");
  const sshTrace = path.join(root, "ssh.trace");
  const codexTrace = path.join(root, "codex.trace");
  await fs.mkdir(remoteWorkspace, { recursive: true });
  await installEvalSsh(root, sshTrace);
  await writeExecutable(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require("fs");
const readline = require("readline");
const trace = ${JSON.stringify(codexTrace)};
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  fs.appendFileSync(trace, line + "\\n");
  const msg = JSON.parse(line);
  if (msg.id && msg.method === "initialize") console.log(JSON.stringify({ id: msg.id, result: {} }));
  if (msg.id && msg.method === "thread/start") console.log(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-remote" } } }));
  if (msg.id && msg.method === "turn/start") {
    console.log(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-remote" } } }));
    console.log(JSON.stringify({ method: "turn/completed" }));
  }
});
`,
  );

  const settings = parseConfig({
    workspace: { root: path.dirname(root) },
    codex: { command: `${fakeCodex} app-server`, turn_timeout_ms: 5_000 },
  });
  const executor = new CodexAppServerExecutor();
  const session = await executor.startSession({
    workspace: remoteWorkspace,
    workerHost: "worker-01:2200",
    settings,
    issue: sampleIssue,
  });
  await executor.runTurn(session, "hello", sampleIssue);
  await session.stop();

  const sshLog = await fs.readFile(sshTrace, "utf8");
  assert.match(sshLog, /-T -p 2200 worker-01 bash -lc/);
  assert.match(sshLog, /remote-workspace/);
  assert.match(await fs.readFile(codexTrace, "utf8"), /"method":"turn\/start"/);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function installEvalSsh(root: string, trace: string): Promise<void> {
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  await writeExecutable(
    path.join(bin, "ssh"),
    `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> ${shellEscape(trace)}
is_tunnel=0
for arg in "$@"; do
  if [ "$arg" = "-N" ]; then is_tunnel=1; fi
  last_arg="$arg"
done
if [ "$is_tunnel" = "1" ]; then
  trap 'exit 0' TERM INT
  while :; do sleep 1; done
fi
eval "$last_arg"
`,
  );
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
  await fs.writeFile(trace, "");
}
