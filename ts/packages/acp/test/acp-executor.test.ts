import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { test, vi } from "vitest";
import {
  Executor,
  acquireAgentMcpEndpoint,
  parseConfig,
  resolveBridgeCommand,
  shellEscape,
} from "@symphony/cli";
import type { AgentUpdate } from "@symphony/cli";
import { assert, sampleIssue, tempDir, writeExecutable } from "@symphony/test-utils";

let nextAcpServerPort = 45_000 + (process.pid % 1_000);

test("ACP executor starts a session, translates updates, approves permissions, and exposes fs", async () => {
  const root = await tempDir("symphony-ts-acp");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  await fs.writeFile(path.join(root, "README.md"), "workspace read\n");
  const settings = acpSettings(root, fake, trace, "new");
  const executor = new Executor("claude");
  const updates: AgentUpdate[] = [];
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
    onUpdate: (update) => updates.push(update),
  });
  const turnUpdates = await executor.runTurn(session, "hello", sampleIssue);
  const secondTurnUpdates = await executor.runTurn(session, "hello again", sampleIssue);
  await session.stop();

  assert.equal(session.resumeId, "acp-new");
  assert.ok(turnUpdates.some((update) => update.type === "turn_completed"));
  assert.equal(
    turnUpdates.find((update) => update.type === "turn_completed")?.sessionUpdate?.kind,
    "turn_completed",
  );
  assert.equal(
    updates.some((update) => update.type === "session_notification" && update.usage),
    false,
  );
  assert.ok(updates.some((update) => update.type === "approval_auto_approved"));
  assert.ok(updates.some((update) => update.type === "fs_write"));
  const turnCompleted = turnUpdates.find((update) => update.type === "turn_completed");
  assert.equal(turnCompleted?.usageKind, "cumulative");
  assert.deepEqual(turnCompleted?.usage, {
    inputTokens: 7,
    outputTokens: 3,
    totalTokens: 10,
  });
  assert.deepEqual(secondTurnUpdates.find((update) => update.type === "turn_completed")?.usage, {
    inputTokens: 14,
    outputTokens: 6,
    totalTokens: 20,
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

test("ACP executor can pass through cumulative bridge usage without double counting", async () => {
  const root = await tempDir("symphony-ts-acp-cumulative-usage");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  await fs.writeFile(path.join(root, "README.md"), "workspace read\n");
  const settings = acpSettings(root, fake, trace, "cumulative-usage", 5_000, {
    agentKind: "pi",
    usageAccounting: "cumulative",
  });
  const executor = new Executor("pi");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
  });
  const firstTurnUpdates = await executor.runTurn(session, "hello", sampleIssue);
  const secondTurnUpdates = await executor.runTurn(session, "hello again", sampleIssue);
  await session.stop();

  assert.deepEqual(firstTurnUpdates.find((update) => update.type === "turn_completed")?.usage, {
    inputTokens: 7,
    outputTokens: 3,
    totalTokens: 10,
  });
  assert.deepEqual(secondTurnUpdates.find((update) => update.type === "turn_completed")?.usage, {
    inputTokens: 14,
    outputTokens: 6,
    totalTokens: 20,
  });
});

test("ACP executor ignores session updates for a different active session", async () => {
  const root = await tempDir("symphony-ts-acp-session-mismatch");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "wrong-session-update");
  const updates: AgentUpdate[] = [];
  const executor = new Executor("claude");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
    onUpdate: (update) => updates.push(update),
  });
  try {
    const turnUpdates = await executor.runTurn(session, "hello", sampleIssue);
    assert.ok(turnUpdates.some((update) => update.type === "turn_completed"));
  } finally {
    await session.stop();
  }

  assert.equal(session.sessionId, "acp-new");
  assert.equal(session.resumeId, "acp-new");
  assert.ok(
    updates.some(
      (update) => update.type === "session_notification" && update.message.sessionId === "acp-new",
    ),
  );
  assert.equal(
    updates.some(
      (update) =>
        update.type === "session_notification" && update.message.sessionId === "wrong-session",
    ),
    false,
  );
  const mismatch = updates.find(
    (update) => update.type === "malformed" && String(update.message).includes("wrong-session"),
  );
  assert.equal(mismatch?.sessionId, "acp-new");
  assert.equal(mismatch?.resumeId, "acp-new");
  const traceEvents = await readTrace(trace);
  const closeSession = traceEvents.find((event) => event.method === "closeSession");
  assert.equal(closeSession?.params?.sessionId, "acp-new");
});

test("ACP executor prefers session/resume when the agent advertises resume support", async () => {
  const root = await tempDir("symphony-ts-acp-resume");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "resume");
  const executor = new Executor("claude");
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
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "load");
  const updates: AgentUpdate[] = [];
  const executor = new Executor("claude");
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
        update.type === "session_notification" &&
        JSON.stringify(update.message).includes("replayed history"),
    ),
    false,
  );
});

test("ACP executor times out stalled bridge turns and emits a typed failure", async () => {
  const root = await tempDir("symphony-ts-acp-stall");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "stall", 5_000, { stallTimeoutMs: 50 });
  const updates: AgentUpdate[] = [];
  const executor = new Executor("claude");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
    onUpdate: (update) => updates.push(update),
  });
  try {
    await expectRejectsWithin(
      () => executor.runTurn(session, "hello", sampleIssue),
      500,
      /acp turn timed out/,
    );
  } finally {
    await session.stop();
  }

  assert.ok(updates.some((update) => update.type === "turn_started"));
  const traceEvents = await readTrace(trace);
  assert.ok(traceEvents.some((event) => event.method === "cancel"));
});

test("ACP executor resets the stall timeout on session notifications", async () => {
  const root = await tempDir("symphony-ts-acp-active-stall-reset");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "active-long-turn", 5_000, {
    stallTimeoutMs: 500,
  });
  const updates: AgentUpdate[] = [];
  const executor = new Executor("claude");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
    onUpdate: (update) => updates.push(update),
  });
  try {
    const turnUpdates = await executor.runTurn(session, "hello", sampleIssue);
    assert.ok(turnUpdates.some((update) => update.type === "turn_completed"));
  } finally {
    await session.stop();
  }

  assert.ok(updates.some((update) => update.type === "session_notification"));
  const traceEvents = await readTrace(trace);
  assert.equal(
    traceEvents.some((event) => event.method === "cancel"),
    false,
  );
});

test("ACP executor emits matching terminal sessionUpdate kinds for cancelled and failed turns", async () => {
  const cases = [
    {
      mode: "cancelled-turn",
      stopReason: "cancelled",
      updateType: "turn_cancelled",
      error: /acp_turn_cancelled/,
    },
    {
      mode: "failed-turn",
      stopReason: "refusal",
      updateType: "turn_failed",
      error: /acp_turn_failed: refusal/,
    },
  ] as const;

  for (const testCase of cases) {
    const root = await tempDir(`symphony-ts-acp-${testCase.mode}`);
    const fake = await writeFakeBridge(root);
    const trace = path.join(root, "trace.jsonl");
    const settings = acpSettings(root, fake, trace, testCase.mode);
    const updates: AgentUpdate[] = [];
    const executor = new Executor("claude");
    const session = await executor.startSession({
      workspace: root,
      settings,
      issue: sampleIssue,
      onUpdate: (update) => updates.push(update),
    });
    try {
      await assert.rejects(() => executor.runTurn(session, "hello", sampleIssue), testCase.error);
    } finally {
      await session.stop();
    }

    const terminal = updates.find((update) => update.type === testCase.updateType);
    assert.equal(terminal?.type, testCase.updateType);
    assert.equal(terminal?.sessionUpdate?.kind, testCase.updateType);
    assert.equal(
      (terminal?.message as { response?: { stopReason?: string } } | undefined)?.response
        ?.stopReason,
      testCase.stopReason,
    );
  }
});

test("ACP executor suppresses late terminal updates after turn timeout", async () => {
  const root = await tempDir("symphony-ts-acp-late-timeout");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "late-complete-after-timeout", 50);
  const updates: AgentUpdate[] = [];
  const executor = new Executor("claude");
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
    await waitForTraceEvent(trace, "promptResolvedAfterCancel");
  } finally {
    await session.stop();
  }

  const traceEvents = await readTrace(trace);
  assert.ok(traceEvents.some((event) => event.method === "cancel"));
  assert.equal(
    updates.some((update) => update.type === "turn_completed" || update.type === "turn_cancelled"),
    false,
  );
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

test("writeProviderConfig writes .claude/settings.local.json for claude bridge", async () => {
  const root = await tempDir("symphony-ts-acp-provider-claude");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const providerConfig = { permission_mode: "dontAsk" };
  const settings = acpSettings(root, fake, trace, "new", 5_000, { providerConfig });
  const executor = new Executor("claude");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
  });
  await session.stop();

  const written = JSON.parse(
    await fs.readFile(path.join(root, ".claude", "settings.local.json"), "utf8"),
  );
  assert.deepEqual(written, { permission_mode: "dontAsk" });
});

test("writeProviderConfig pins the default claude model in settings.local.json", async () => {
  const root = await tempDir("symphony-ts-acp-provider-claude-model");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "new", 5_000);
  const executor = new Executor("claude");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
  });
  await session.stop();

  const written = JSON.parse(
    await fs.readFile(path.join(root, ".claude", "settings.local.json"), "utf8"),
  );
  assert.deepEqual(written, {
    model: "claude-opus-4-6[1m]",
    permissions: { defaultMode: "dontAsk" },
  });
});

test("writeProviderConfig writes .codex/config.toml for codex bridge", async () => {
  const root = await tempDir("symphony-ts-acp-provider-codex");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const providerConfig = {
    "bad key": "literal-space",
    model: "gpt-5.5",
    "model.provider": "literal-dot",
    model_reasoning_effort: "xhigh",
  };
  const settings = acpSettings(root, fake, trace, "new", 5_000, {
    agentKind: "codex",
    providerConfig,
  });
  const executor = new Executor("codex");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
  });
  await session.stop();

  const toml = await fs.readFile(path.join(root, ".codex", "config.toml"), "utf8");
  assert.match(toml, /"bad key" = "literal-space"/);
  assert.match(toml, /model = "gpt-5.5"/);
  assert.match(toml, /"model.provider" = "literal-dot"/);
  assert.match(toml, /model_reasoning_effort = "xhigh"/);
});

test("writeProviderConfig writes nested TOML sections", async () => {
  const root = await tempDir("symphony-ts-acp-provider-toml-nested");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const providerConfig = {
    model: "gpt-5.5",
    history: { "max.entries": 100, persistence: true },
    "history.options": { "save mode": "all" },
  };
  const settings = acpSettings(root, fake, trace, "new", 5_000, {
    agentKind: "codex",
    providerConfig,
  });
  const executor = new Executor("codex");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
  });
  await session.stop();

  const toml = await fs.readFile(path.join(root, ".codex", "config.toml"), "utf8");
  assert.match(toml, /model = "gpt-5.5"/);
  assert.match(toml, /\[history\]/);
  assert.match(toml, /"max.entries" = 100/);
  assert.match(toml, /persistence = true/);
  assert.match(toml, /\["history.options"\]/);
  assert.match(toml, /"save mode" = "all"/);
});

test("writeProviderConfig is skipped when providerConfig is absent from agent config", async () => {
  const root = await tempDir("symphony-ts-acp-provider-none");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "new", 5_000, { agentKind: "codex" });
  delete (settings.agents.codex as Record<string, unknown>).providerConfig;
  const executor = new Executor("codex");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
  });
  await session.stop();

  await assert.rejects(() => fs.access(path.join(root, ".codex", "config.toml")));
});

test("resolveBridgeCommand points bare bridge names at the vendored packages", async () => {
  const codex = resolveBridgeCommand("codex-acp", null);
  assert.notEqual(codex, "codex-acp");
  assert.match(codex, /vendor\/codex-acp\/dist\/index\.js/);
  assert.ok(codex.startsWith(shellEscape(process.execPath)));
  await fs.access(codex.split(" ")[1]?.replace(/^'|'$/g, "") ?? "");

  const claude = resolveBridgeCommand("claude-agent-acp", null);
  assert.match(claude, /vendor\/claude-agent-acp\/dist\/index\.js/);
});

test("resolveBridgeCommand preserves arguments, custom commands, and remote hosts", () => {
  assert.match(resolveBridgeCommand("codex-acp --flag value", null), /index\.js'? --flag value$/);
  assert.equal(
    resolveBridgeCommand("my-custom-bridge --port 1", null),
    "my-custom-bridge --port 1",
  );
  assert.equal(resolveBridgeCommand("/usr/local/bin/codex-acp", null), "/usr/local/bin/codex-acp");
  assert.equal(resolveBridgeCommand("codex-acp", "worker-1"), "codex-acp");
});

function acpSettings(
  root: string,
  fake: string,
  trace: string,
  mode: string,
  turnTimeoutMs = 5_000,
  opts?: {
    agentKind?: string;
    providerConfig?: Record<string, unknown>;
    stallTimeoutMs?: number;
    usageAccounting?: "per-turn" | "cumulative";
  },
) {
  const kind = opts?.agentKind ?? "claude";
  return parseConfig({
    server: { host: "127.0.0.1", port: nextAcpServerPort++ },
    workspace: { root: path.dirname(root) },
    agent: { kind },
    agents: {
      [kind]: {
        executor: "acp",
        bridge_command: `${process.execPath} ${fake} ${mode} ${trace}`,
        turn_timeout_ms: turnTimeoutMs,
        stall_timeout_ms: opts?.stallTimeoutMs ?? 0,
        ...(opts?.providerConfig ? { provider_config: opts.providerConfig } : {}),
        ...(opts?.usageAccounting ? { usage_accounting: opts.usageAccounting } : {}),
      },
    },
  });
}

async function writeFakeBridge(root: string): Promise<string> {
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
    this.promptCount = 0;
    this.cancelled = false;
    this.cancelWaiters = [];
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
    this.promptCount += 1;
    if (mode === "stall") {
      await new Promise(() => {});
    }
    if (mode === "late-complete-after-timeout") {
      await this.waitForCancel();
      record({ method: "promptResolvedAfterCancel", params });
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 2,
          cachedReadTokens: 4,
          cachedWriteTokens: 1,
          outputTokens: 3,
          thoughtTokens: 9,
          totalTokens: 10
        }
      };
    }
    if (mode === "active-long-turn") {
      for (let i = 0; i < 3; i += 1) {
        await sleep(200);
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "still working " + i }
          }
        });
      }
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 2,
          cachedReadTokens: 4,
          cachedWriteTokens: 1,
          outputTokens: 3,
          thoughtTokens: 9,
          totalTokens: 10
        }
      };
    }
    if (mode === "cancelled-turn") {
      return {
        stopReason: "cancelled",
        usage: {
          inputTokens: 2,
          cachedReadTokens: 4,
          cachedWriteTokens: 1,
          outputTokens: 3,
          thoughtTokens: 9,
          totalTokens: 10
        }
      };
    }
    if (mode === "failed-turn") {
      return {
        stopReason: "refusal",
        usage: {
          inputTokens: 2,
          cachedReadTokens: 4,
          cachedWriteTokens: 1,
          outputTokens: 3,
          thoughtTokens: 9,
          totalTokens: 10
        }
      };
    }
    if (mode === "wrong-session-update") {
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "valid session" }
        }
      });
      await this.connection.sessionUpdate({
        sessionId: "wrong-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "wrong session" }
        }
      });
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 2,
          cachedReadTokens: 4,
          cachedWriteTokens: 1,
          outputTokens: 3,
          thoughtTokens: 9,
          totalTokens: 10
        }
      };
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
      update: { sessionUpdate: "usage_update", used: 50, size: 100 }
    });
    const usageMultiplier = mode === "cumulative-usage" ? this.promptCount : 1;
    return {
      stopReason: "end_turn",
      usage: {
        inputTokens: 2 * usageMultiplier,
        cachedReadTokens: 4 * usageMultiplier,
        cachedWriteTokens: 1 * usageMultiplier,
        outputTokens: 3 * usageMultiplier,
        thoughtTokens: 9 * usageMultiplier,
        totalTokens: 10 * usageMultiplier
      }
    };
  }

  async cancel(params) {
    record({ method: "cancel", params });
    this.cancelled = true;
    const waiters = this.cancelWaiters;
    this.cancelWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async closeSession(params) {
    record({ method: "closeSession", params });
    return {};
  }

  async waitForCancel() {
    if (this.cancelled) return;
    await new Promise((resolve) => {
      this.cancelWaiters.push(resolve);
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
case "$last_arg" in
  *'/dev/tcp/127.0.0.1/'*) exit 0 ;;
esac
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

async function waitForTraceEvent(tracePath: string, method: string): Promise<void> {
  await vi.waitFor(
    async () => {
      assert.ok((await readTrace(tracePath)).some((event) => event.method === method));
    },
    { timeout: 10_000, interval: 100 },
  );
}

async function expectRejectsWithin(
  fn: () => Promise<unknown>,
  timeoutMs: number,
  expected: RegExp,
): Promise<void> {
  const promise = fn();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      () =>
        Promise.race([
          promise,
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`promise did not reject within ${timeoutMs}ms`)),
              timeoutMs,
            );
          }),
        ]),
      expected,
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    promise.catch(() => {});
  }
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
