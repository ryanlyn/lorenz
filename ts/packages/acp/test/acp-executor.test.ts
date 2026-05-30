import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { test, vi } from "vitest";
import { AcpExecutor, acquireAgentMcpEndpoint, parseConfig, shellEscape } from "@symphony/cli";
import type { AgentUpdate } from "@symphony/cli";

import { assert } from "../../../test/assert.js";
import { sampleIssue, tempDir, writeExecutable } from "../../../test/helpers.js";

test("ACP executor starts a session, translates updates, approves permissions, and exposes fs", async () => {
  const root = await tempDir("symphony-ts-acp");
  const fake = await writeFakeAcpBridge(root);
  const trace = path.join(root, "trace.jsonl");
  await fs.writeFile(path.join(root, "README.md"), "workspace read\n");
  const settings = acpSettings(root, fake, trace, "new");
  const executor = new AcpExecutor("claude");
  const updates: AgentUpdate[] = [];
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
    onUpdate: (update) => updates.push(update),
  });
  const turnUpdates = await executor.runTurn(session, "hello", sampleIssue);
  await session.stop();

  assert.equal(session.resumeId, "acp-new");
  assert.ok(turnUpdates.some((update) => update.type === "turn_completed"));
  assert.equal(
    turnUpdates.find((update) => update.type === "turn_completed")?.sessionUpdate?.kind,
    "turn_completed",
  );
  assert.equal(
    updates.find((update) => update.type === "usage")?.sessionUpdate?.kind,
    "usage_update",
  );
  assert.ok(updates.some((update) => update.type === "assistant_message"));
  assert.ok(updates.some((update) => update.type === "tool_use_requested"));
  assert.ok(updates.some((update) => update.type === "approval_auto_approved"));
  assert.ok(updates.some((update) => update.type === "tool_result"));
  assert.ok(updates.some((update) => update.type === "fs_write"));
  assert.deepEqual(turnUpdates.find((update) => update.type === "turn_completed")?.usage, {
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
  });
  assert.equal(
    await fs.readFile(path.join(root, "from-acp.txt"), "utf8"),
    "workspace read\nbridge\n",
  );

  const traceEvents = await readTrace(trace);
  assert.ok(traceEvents.some((event) => event.method === "initialize"));
  const newSession = traceEvents.find((event) => event.method === "newSession");
  assert.ok(newSession);
  assert.match(JSON.stringify(newSession.params), /"type":"http"/);
  assert.match(JSON.stringify(newSession.params), /"name":"symphony_linear"/);
  assert.match(
    JSON.stringify(newSession.params),
    /"headers":\[\{"name":"Authorization","value":"Bearer /,
  );
  const permission = traceEvents.find((event) => event.method === "permission");
  assert.equal(permission?.response?.outcome?.optionId, "allow");
});

test("ACP executor prefers session/resume when the agent advertises resume support", async () => {
  const root = await tempDir("symphony-ts-acp-resume");
  const fake = await writeFakeAcpBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "resume");
  const executor = new AcpExecutor("claude");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
    resumeId: "acp-existing",
  });
  await session.stop();

  assert.equal(session.resumeId, "acp-existing");
  const traceEvents = await readTrace(trace);
  assert.ok(traceEvents.some((event) => event.method === "resumeSession"));
  assert.equal(
    traceEvents.some((event) => event.method === "loadSession"),
    false,
  );
  assert.equal(
    traceEvents.some((event) => event.method === "newSession"),
    false,
  );
});

test("ACP executor falls back to session/load and suppresses replayed updates", async () => {
  const root = await tempDir("symphony-ts-acp-load");
  const fake = await writeFakeAcpBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "load");
  const updates: AgentUpdate[] = [];
  const executor = new AcpExecutor("claude");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
    resumeId: "acp-loadable",
    onUpdate: (update) => updates.push(update),
  });
  await session.stop();

  assert.equal(session.resumeId, "acp-loadable");
  const traceEvents = await readTrace(trace);
  assert.ok(traceEvents.some((event) => event.method === "loadSession"));
  assert.equal(
    traceEvents.some((event) => event.method === "resumeSession"),
    false,
  );
  assert.equal(
    traceEvents.some((event) => event.method === "newSession"),
    false,
  );
  assert.ok(updates.some((update) => update.type === "session_replay_suppressed"));
  assert.equal(
    updates.some(
      (update) =>
        update.type === "assistant_message" &&
        JSON.stringify(update.message).includes("replayed history"),
    ),
    false,
  );
});

test("ACP executor times out stalled bridge turns and emits a typed failure", async () => {
  const root = await tempDir("symphony-ts-acp-stall");
  const fake = await writeFakeAcpBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "stall", 50);
  const updates: AgentUpdate[] = [];
  const executor = new AcpExecutor("claude");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
    onUpdate: (update) => updates.push(update),
  });
  try {
    await assert.rejects(
      () => executor.runTurn(session, "hello", sampleIssue),
      /acp turn timed out/,
    );
  } finally {
    await session.stop();
  }

  assert.ok(updates.some((update) => update.type === "turn_started"));
  const traceEvents = await readTrace(trace);
  assert.ok(traceEvents.some((event) => event.method === "cancel"));
});

test("ACP MCP endpoint leases reuse one reverse tunnel per worker host with per-session tokens", async () => {
  const root = await tempDir("symphony-ts-acp-remote-mcp");
  const trace = path.join(root, "ssh.trace");
  const leases: Awaited<ReturnType<typeof acquireAgentMcpEndpoint>>[] = [];
  try {
    await installEvalSsh(root, trace);
    const settings = parseConfig({
      server: { host: "127.0.0.1", port: await reserveTcpPort() },
      worker: { ssh_timeout_ms: 5_000 },
    });
    const first = await acquireAgentMcpEndpoint(settings, "worker-acp");
    leases.push(first);
    const second = await acquireAgentMcpEndpoint(settings, "worker-acp");
    leases.push(second);

    assert.equal(first.url, "http://127.0.0.1:46000/claude-mcp");
    assert.equal(second.url, "http://127.0.0.1:46000/claude-mcp");
    assert.notEqual(first.token, second.token);
    assert.notEqual(acpAuthHeader(first.acpServer()), acpAuthHeader(second.acpServer()));
    await waitForTunnelTrace(trace, 1);

    await first.release();
    leases.splice(leases.indexOf(first), 1);
    const third = await acquireAgentMcpEndpoint(settings, "worker-acp");
    leases.push(third);
    assert.equal(tunnelTraceCount(await fs.readFile(trace, "utf8")), 1);

    await second.release();
    leases.splice(leases.indexOf(second), 1);
    await third.release();
    leases.splice(leases.indexOf(third), 1);
    const fourth = await acquireAgentMcpEndpoint(settings, "worker-acp");
    leases.push(fourth);
    await waitForTunnelTrace(trace, 2);
  } finally {
    await Promise.all(leases.map((lease) => lease.release()));
    vi.unstubAllEnvs();
  }
});

function acpSettings(
  root: string,
  fake: string,
  trace: string,
  mode: string,
  turnTimeoutMs = 5_000,
) {
  return parseConfig({
    workspace: { root: path.dirname(root) },
    agent: { kind: "claude" },
    agents: {
      claude: {
        executor: "acp",
        bridge_command: process.execPath,
        bridge_args: [fake, mode, trace],
        turn_timeout_ms: turnTimeoutMs,
        stall_timeout_ms: 0,
      },
    },
  });
}

async function writeFakeAcpBridge(root: string): Promise<string> {
  const fake = path.join(root, "fake-acp-bridge.mjs");
  const acpModule = new URL("../node_modules/@agentclientprotocol/sdk/dist/acp.js", import.meta.url)
    .href;
  await writeExecutable(
    fake,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from ${JSON.stringify(acpModule)};

const mode = process.argv[2] ?? "new";
const trace = process.argv[3];
function record(event) {
  if (!trace) return;
  fs.appendFileSync(trace, JSON.stringify(event) + "\\n");
}

class FakeAgent {
  constructor(connection) {
    this.connection = connection;
  }

  async initialize(params) {
    record({ method: "initialize", params });
    const agentCapabilities = mode === "load"
      ? { loadSession: true, sessionCapabilities: { close: {} } }
      : { loadSession: true, sessionCapabilities: { resume: {}, close: {} } };
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities };
  }

  async authenticate() {
    return {};
  }

  async newSession(params) {
    record({ method: "newSession", params });
    return { sessionId: "acp-new" };
  }

  async resumeSession(params) {
    record({ method: "resumeSession", params });
    return {};
  }

  async loadSession(params) {
    record({ method: "loadSession", params });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "replayed history" }
      }
    });
    return {};
  }

  async prompt(params) {
    record({ method: "prompt", params });
    if (mode === "stall") {
      await new Promise(() => {});
    }
    const read = await this.connection.readTextFile({
      sessionId: params.sessionId,
      path: path.join(process.cwd(), "README.md")
    });
    await this.connection.writeTextFile({
      sessionId: params.sessionId,
      path: path.join(process.cwd(), "from-acp.txt"),
      content: read.content + "bridge\\n"
    });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "working" }
      }
    });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Editing file",
        kind: "edit",
        status: "pending",
        locations: [],
        rawInput: { path: "from-acp.txt" }
      }
    });
    const response = await this.connection.requestPermission({
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: "call-1",
        title: "Editing file",
        kind: "edit",
        status: "pending",
        locations: [],
        rawInput: { path: "from-acp.txt" }
      },
      options: [
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Reject", optionId: "reject" }
      ]
    });
    record({ method: "permission", response });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        rawOutput: { ok: true }
      }
    });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "usage_update", used: 5, size: 100 }
    });
    return {
      stopReason: "end_turn",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
    };
  }

  async cancel(params) {
    record({ method: "cancel", params });
  }

  async closeSession(params) {
    record({ method: "closeSession", params });
    return {};
  }
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((connection) => new FakeAgent(connection), stream);
`,
  );
  return fake;
}

async function readTrace(trace: string): Promise<any[]> {
  const text = await fs.readFile(trace, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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

function tunnelTraceCount(trace: string): number {
  return trace
    .split("\n")
    .filter((line) => line.includes("-N -o ExitOnForwardFailure=yes") && line.includes("-R "))
    .length;
}

function acpAuthHeader(server: unknown): string | undefined {
  const record = server as { type?: string; headers?: Array<{ value?: string }> };
  assert.equal(record.type, "http");
  return record.headers?.[0]?.value;
}

async function waitForTunnelTrace(tracePath: string, count: number): Promise<void> {
  await vi.waitFor(
    async () => {
      assert.equal(tunnelTraceCount(await fs.readFile(tracePath, "utf8")), count);
    },
    { timeout: 10_000, interval: 100 },
  );
}

function reserveTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port === null) reject(new Error("failed to reserve tcp port"));
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}
