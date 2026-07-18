import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";

import { test, vi } from "vitest";
import {
  Executor,
  acquireAgentMcpEndpoint,
  hostAgentBinaryEnv,
  parseConfig as parseConfigWith,
  resolveBridgeCommand,
  shellEscape,
} from "@lorenz/cli";
import type { AgentUpdate } from "@lorenz/cli";
import { AgentExecutorRegistry } from "@lorenz/agent-sdk";
import type { AgentMcpEndpointLease } from "@lorenz/mcp";
import { workerHostPool } from "@lorenz/worker-host-pool";
import { assert, sampleIssue, settle, tempDir, writeExecutable } from "@lorenz/test-utils";

import { acpExecutorProvider } from "@lorenz/acp";

// Private executor registry so agent records parse through the ACP provider's option
// vocabulary without touching the process-wide default registry.
const executors = new AgentExecutorRegistry();
executors.register(acpExecutorProvider);

function parseConfig(raw: Record<string, unknown>): ReturnType<typeof parseConfigWith> {
  return parseConfigWith(raw, {}, {}, undefined, executors);
}

let nextAcpServerPort = 45_000 + (process.pid % 1_000);

test("hostAgentBinaryEnv resolves missing agent binaries and respects explicit overrides", () => {
  const lookup = (command: string) => `/host/${command}`;
  assert.deepEqual(hostAgentBinaryEnv({}, lookup), {
    CLAUDE_CODE_EXECUTABLE: "/host/claude",
    CODEX_PATH: "/host/codex",
  });
  // An explicit value in the environment is never overwritten.
  assert.deepEqual(hostAgentBinaryEnv({ CLAUDE_CODE_EXECUTABLE: "/explicit/claude" }, lookup), {
    CODEX_PATH: "/host/codex",
  });
  // Nothing is set when the host has no such binary.
  assert.deepEqual(
    hostAgentBinaryEnv({}, () => null),
    {},
  );
});

test("ACP executor starts a session, translates updates, approves permissions, and exposes fs", async () => {
  const root = await tempDir("lorenz-acp");
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
  assert.match(JSON.stringify(newSession.params), /"name":"lorenz_tracker"/);
  assert.match(
    JSON.stringify(newSession.params),
    /"headers":\[\{"name":"Authorization","value":"Bearer /,
  );
  const permission = traceEvents.find((event) => event.method === "permission");
  assert.equal(permission?.response?.outcome?.optionId, "allow");
});

test("ACP session submits a queued turn before the active turn finishes", async () => {
  const root = await tempDir("lorenz-acp-queued-turn");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "queued-turn");
  const executor = new Executor("claude");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
  });

  try {
    const active = executor.runTurn(session, "initial work", sampleIssue);
    await waitForTraceEvent(trace, "firstPromptWaiting");
    assert.ok(session.queueTurn);
    const queued = session.queueTurn("new direction");

    await vi.waitFor(
      async () => {
        const prompts = (await readTrace(trace)).filter((event) => event.method === "prompt");
        assert.equal(prompts.length, 2);
      },
      { timeout: 10_000, interval: 20 },
    );

    await active;
    await queued;
  } finally {
    await session.stop();
  }

  const prompts = (await readTrace(trace)).filter((event) => event.method === "prompt");
  assert.equal(prompts[0]?.params?.prompt?.[0]?.text, "initial work");
  assert.equal(prompts[1]?.params?.prompt?.[0]?.text, "new direction");
});

test("ACP session preserves submission order across an activation gate", async () => {
  const root = await tempDir("lorenz-acp-gated-queued-turn");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "queued-activation-gate");
  const executor = new Executor("claude");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
  });
  let allowActivation: (() => void) | undefined;
  const startWhen = new Promise<void>((resolve) => {
    allowActivation = resolve;
  });

  try {
    const active = executor.runTurn(session, "initial work", sampleIssue);
    await waitForTraceEvent(trace, "gatedFirstPromptWaiting");
    assert.ok(session.queueTurn);
    const queued = session.queueTurn("validated direction", { startWhen });
    const later = session.queueTurn("later direction");

    await settle(20);
    let prompts = (await readTrace(trace)).filter((event) => event.method === "prompt");
    assert.equal(prompts.length, 1);

    await fs.writeFile(`${trace}.release`, "");
    await active;
    await settle(20);
    prompts = (await readTrace(trace)).filter((event) => event.method === "prompt");
    assert.equal(prompts.length, 1);

    allowActivation?.();
    await Promise.all([queued, later]);
  } finally {
    allowActivation?.();
    await session.stop();
  }

  const prompts = (await readTrace(trace)).filter((event) => event.method === "prompt");
  assert.equal(prompts.length, 3);
  assert.equal(prompts[1]?.params?.prompt?.[0]?.text, "validated direction");
  assert.equal(prompts[2]?.params?.prompt?.[0]?.text, "later direction");
});

test("ACP gated turn uses the session id active at submission", async () => {
  const root = await tempDir("lorenz-acp-gated-session-rotation");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "queued-session-rotation");
  const updates: AgentUpdate[] = [];
  const executor = new Executor("claude");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
    onUpdate: (update) => updates.push(update),
  });
  let allowActivation: (() => void) | undefined;
  const startWhen = new Promise<void>((resolve) => {
    allowActivation = resolve;
  });

  try {
    const active = executor.runTurn(session, "initial work", sampleIssue);
    await waitForTraceEvent(trace, "rotationPromptWaiting");
    assert.ok(session.queueTurn);
    const queued = session.queueTurn("validated direction", { startWhen });

    await fs.writeFile(`${trace}.rotate`, "");
    await active;
    assert.equal(session.sessionId, "acp-rotated");

    allowActivation?.();
    await queued;
  } finally {
    allowActivation?.();
    await session.stop();
  }

  const prompts = (await readTrace(trace)).filter((event) => event.method === "prompt");
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1]?.params?.sessionId, "acp-rotated");
  assert.equal(
    updates.filter((update) => update.type === "turn_started").at(-1)?.sessionId,
    "acp-rotated",
  );
});

test("ACP session publishes queued responses in turn lifecycle order", async () => {
  const root = await tempDir("lorenz-acp-queued-response-order");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "queued-response-order");
  const updates: AgentUpdate[] = [];
  const executor = new Executor("claude");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
    onUpdate: (update) => updates.push(update),
  });

  try {
    const active = executor.runTurn(session, "initial work", sampleIssue);
    await waitForTraceEvent(trace, "firstPromptWaiting");
    assert.ok(session.queueTurn);
    let queuedSettled = false;
    const queued = session.queueTurn("new direction").then((result) => {
      queuedSettled = true;
      return result;
    });

    await waitForTraceEvent(trace, "queuedPromptResolved");
    await settle(20);
    try {
      assert.equal(queuedSettled, false);
      assert.deepEqual(
        updates.map((update) => update.type),
        ["session_started", "turn_started"],
      );
    } finally {
      await fs.writeFile(`${trace}.release`, "");
    }

    await active;
    await queued;
  } finally {
    await session.stop();
  }

  assert.deepEqual(
    updates
      .filter((update) => update.type === "turn_started" || update.type === "turn_completed")
      .map((update) => update.type),
    ["turn_started", "turn_completed", "turn_started", "turn_completed"],
  );
});

test("ACP session exposes queueTurn only when the bridge advertises prompt queuing", async () => {
  const root = await tempDir("lorenz-acp-no-prompt-queue");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "new");
  const session = await new Executor("claude").startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
  });

  try {
    assert.equal(session.queueTurn, undefined);
  } finally {
    await session.stop();
  }
});

test("ACP session ignores prompt queue capabilities without the Lorenz contract", async () => {
  const root = await tempDir("lorenz-acp-external-prompt-queue");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "queued-external-capability");
  const session = await new Executor("claude").startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
  });

  try {
    assert.equal(session.queueTurn, undefined);
  } finally {
    await session.stop();
  }
});

test("ACP turn timeout rejects queued turns and stops the session", async () => {
  const root = await tempDir("lorenz-acp-queued-timeout");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "queued-timeout", 500);
  const updates: AgentUpdate[] = [];
  const executor = new Executor("claude");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
    onUpdate: (update) => updates.push(update),
  });

  try {
    const active = executor
      .runTurn(session, "initial work", sampleIssue)
      .then(() => null)
      .catch((error: unknown) => error);
    await waitForTraceEvent(trace, "firstPromptWaiting");
    assert.ok(session.queueTurn);
    const queued = session.queueTurn("new direction").catch((error: unknown) => error);
    await waitForTraceEvent(trace, "queuedPromptWaiting");

    assert.match(String(await active), /acp turn timed out/);
    assert.match(String(await queued), /acp session stopped after turn timeout/);
    await assert.rejects(
      () => executor.runTurn(session, "more work", sampleIssue),
      /acp session stopped after turn timeout/,
    );
    await assert.rejects(
      () => session.queueTurn?.("more direction"),
      /acp session stopped after turn timeout/,
    );
  } finally {
    await session.stop();
  }

  assert.equal(updates.filter((update) => update.type === "turn_started").length, 1);
  const events = await readTrace(trace);
  assert.equal(
    events.some((event) => event.method === "queuedPromptRunning"),
    false,
  );
});

test("ACP timeout rejects queued turns when the backend is unresponsive", async () => {
  const root = await tempDir("lorenz-acp-queued-wedged-timeout");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "queued-wedged-timeout", 500);
  const executor = new Executor("claude");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
  });

  try {
    const active = executor
      .runTurn(session, "initial work", sampleIssue)
      .then(() => null)
      .catch((error: unknown) => error);
    await waitForTraceEvent(trace, "wedgedPromptWaiting");
    assert.ok(session.queueTurn);
    const queued = session.queueTurn("new direction");

    assert.match(String(await active), /acp turn timed out/);
    await expectRejectsWithin(() => queued, 1_000, /acp session stopped after turn timeout/);
  } finally {
    await session.stop();
  }
});

test("ACP session stop rejects queued turns without activating them", async () => {
  const root = await tempDir("lorenz-acp-queued-stop");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "queued-stop");
  const updates: AgentUpdate[] = [];
  const executor = new Executor("claude");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
    onUpdate: (update) => updates.push(update),
  });
  const active = executor.runTurn(session, "initial work", sampleIssue).catch((error) => error);
  await waitForTraceEvent(trace, "queuedStopPromptWaiting");
  assert.ok(session.queueTurn);
  const queued = session.queueTurn("new direction").catch((error) => error);
  await vi.waitFor(
    async () => {
      const prompts = (await readTrace(trace)).filter(
        (event) => event.method === "queuedStopPromptWaiting",
      );
      assert.equal(prompts.length, 2);
    },
    { timeout: 10_000, interval: 20 },
  );

  await session.stop();

  assert.match(String(await active), /acp session stopped/);
  assert.match(String(await queued), /acp session stopped/);
  assert.equal(updates.filter((update) => update.type === "turn_started").length, 1);
});

test("vendored prompt queues advertise capability and isolate Claude usage at handoff", async () => {
  const claudeSource = await fs.readFile(
    path.resolve("vendor/claude-agent-acp/dist/acp-agent.js"),
    "utf8",
  );
  const codexSource = await fs.readFile(path.resolve("vendor/codex-acp/dist/index.js"), "utf8");
  assert.match(claudeSource, /"symphony\/promptQueueing": true/);
  assert.match(codexSource, /"symphony\/promptQueueing": true/);

  const promptStart = claudeSource.indexOf("async prompt(params)");
  const queuedHandoff = claudeSource.indexOf("const cancelled = await", promptStart);
  const cancellationReset = claudeSource.indexOf("session.cancelled = false", promptStart);
  const usageReset = claudeSource.indexOf("session.accumulatedUsage = {", promptStart);
  assert.ok(promptStart >= 0);
  assert.ok(queuedHandoff > promptStart);
  assert.ok(cancellationReset > queuedHandoff);
  assert.ok(usageReset > queuedHandoff);
  const queueSubmission = claudeSource.slice(promptStart, cancellationReset);
  assert.match(queueSubmission, /const deferInput = isLocalOnlyCommand \|\|/);
  assert.match(queueSubmission, /if \(!deferInput\) \{\s*session\.input\.push\(userMessage\)/);
  assert.match(
    queueSubmission,
    /if \(!pendingPrompt\.inputSubmitted\) \{\s*session\.input\.push\(userMessage\)/,
  );
  const promptErrorStart = claudeSource.indexOf("catch (error)", promptStart);
  const promptFinallyStart = claudeSource.indexOf("finally {", promptErrorStart);
  const promptErrorBody = claudeSource.slice(promptErrorStart, promptFinallyStart);
  assert.match(promptErrorBody, /some\(\(pending\) => pending\.inputSubmitted\)/);
  assert.match(promptErrorBody, /this\.discardSession\(params\.sessionId, session\)/);
  const replayCheck = claudeSource.indexOf("// Check for prompt replay", queuedHandoff);
  const cancelledMessageCheck = claudeSource.indexOf("if (session.cancelled)", replayCheck);
  assert.ok(replayCheck > queuedHandoff);
  assert.ok(cancelledMessageCheck > replayCheck);
  assert.match(
    claudeSource.slice(replayCheck, cancelledMessageCheck),
    /stopReason: session\.cancelled \? "cancelled" : "end_turn"/,
  );

  const cancelStart = claudeSource.indexOf("async cancel(params)");
  const teardownStart = claudeSource.indexOf("async teardownSession", cancelStart);
  const cancelBody = claudeSource.slice(cancelStart, teardownStart);
  assert.equal(/pendingMessages/.test(cancelBody), false);
  assert.match(claudeSource.slice(teardownStart), /cancelPendingPrompts\(session\)/);
  assert.match(claudeSource, /settleNextPendingPrompt\(session\)/);

  const codexPromptStart = codexSource.indexOf("async prompt(params)");
  const codexRunPromptStart = codexSource.indexOf("async runPrompt(params)", codexPromptStart);
  assert.match(codexSource.slice(codexPromptStart, codexRunPromptStart), /setImmediate\(resolve\)/);
});

test("ACP executor can pass through cumulative bridge usage without double counting", async () => {
  const root = await tempDir("lorenz-acp-cumulative-usage");
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

test("ACP executor accumulates per-call usage buckets incrementally", async () => {
  const root = await tempDir("lorenz-acp-call-usage");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "call-usage");
  const executor = new Executor("claude");
  const updates: AgentUpdate[] = [];
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
    onUpdate: (update) => updates.push(update),
  });
  const firstTurn = await executor.runTurn(session, "hello", sampleIssue);
  // The full stream arrives via onUpdate (runTurn resolves only the terminal
  // update): slice this turn's notifications off the stream before turn two.
  const firstTurnStream = updates.splice(0);
  const secondTurn = await executor.runTurn(session, "hello again", sampleIssue);
  await session.stop();

  // Three unique buckets stream during the first turn (the duplicate seq and
  // the plain usage_update carry no usage), each carrying running totals.
  const firstTurnUsage = firstTurnStream
    .filter((update) => update.type === "session_notification" && update.usage)
    .map((update) => update.usage);
  assert.deepEqual(firstTurnUsage, [
    { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    { inputTokens: 14, outputTokens: 6, totalTokens: 20 },
    { inputTokens: 21, outputTokens: 9, totalTokens: 30 },
  ]);
  assert.ok(
    firstTurnStream
      .filter((update) => update.type === "session_notification" && update.usage)
      .every((update) => update.usageKind === "cumulative"),
  );

  // Turn end must not re-add the bridge's turn aggregate on top of buckets.
  const firstCompleted = firstTurn.find((update) => update.type === "turn_completed");
  assert.equal(firstCompleted?.usageKind, "cumulative");
  assert.deepEqual(firstCompleted?.usage, { inputTokens: 21, outputTokens: 9, totalTokens: 30 });

  // The second turn's bucket accumulates on top of the first turn.
  const secondCompleted = secondTurn.find((update) => update.type === "turn_completed");
  assert.deepEqual(secondCompleted?.usage, { inputTokens: 28, outputTokens: 12, totalTokens: 40 });
});

test("ACP executor does not retain a flood turn's stream (bridge stdout, per-turn batch)", async () => {
  // Regression guard for the daemon OOM: the bridge streams ~49MB of unique
  // chunks in one turn. Neither execa (result buffering of the child's stdout)
  // nor runTurn (per-turn update batch) may retain that stream - post-GC heap
  // growth must stay a small fraction of the streamed volume while the session
  // (and so the bridge process) is still alive.
  const forceGc = (() => {
    if (typeof globalThis.gc === "function") return globalThis.gc.bind(globalThis);
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    v8.setFlagsFromString("--no-expose-gc");
    return gc;
  })();
  const heapUsedAfterGc = (): number => {
    forceGc();
    forceGc();
    return process.memoryUsage().heapUsed;
  };

  const root = await tempDir("lorenz-acp-flood");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "flood", 60_000);
  const executor = new Executor("claude");
  let streamedChunks = 0;
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
    onUpdate: (update) => {
      if (update.type === "session_notification") streamedChunks += 1;
    },
  });
  try {
    const baseline = heapUsedAfterGc();
    const turnUpdates = await executor.runTurn(session, "hello", sampleIssue);
    const growth = heapUsedAfterGc() - baseline;

    // The stream really flowed (3000 chunks x ~16KB) and the resolved batch is
    // just the terminal update, not the turn's history.
    assert.ok(streamedChunks >= 3000, `expected the flood to stream, got ${streamedChunks}`);
    assert.ok(
      turnUpdates.length <= 1,
      `expected only the terminal update, got ${turnUpdates.length}`,
    );
    const maxGrowth = 20 * 1024 * 1024;
    assert.ok(
      growth < maxGrowth,
      `post-GC heap grew ${(growth / 1048576).toFixed(1)}MB after a ~49MB flood turn - ` +
        "the bridge stream is being retained again",
    );
  } finally {
    await session.stop();
  }
});

test("ACP executor reconciles bucket undercount against the turn aggregate", async () => {
  const root = await tempDir("lorenz-acp-call-usage-undercount");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "call-usage-undercount");
  const executor = new Executor("claude");
  const session = await executor.startSession({ workspace: root, settings, issue: sampleIssue });
  const turnUpdates = await executor.runTurn(session, "hello", sampleIssue);
  await session.stop();

  // Two buckets arrived (20 tokens) but the bridge reported a 30-token turn;
  // the shortfall tops the totals up instead of being dropped or re-added.
  assert.deepEqual(turnUpdates.find((update) => update.type === "turn_completed")?.usage, {
    inputTokens: 21,
    outputTokens: 9,
    totalTokens: 30,
  });
});

test("ACP executor floors bucket totals with the bridge cumulative counter", async () => {
  const root = await tempDir("lorenz-acp-call-usage-floor");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "call-usage-total-floor", 5_000, {
    agentKind: "codex",
  });
  const executor = new Executor("codex");
  const session = await executor.startSession({ workspace: root, settings, issue: sampleIssue });
  const turnUpdates = await executor.runTurn(session, "hello", sampleIssue);
  await session.stop();

  // The seq-2 bucket never arrived and the bridge reported no turn usage, but
  // symphony/totalUsage recovers the missing call.
  assert.deepEqual(turnUpdates.find((update) => update.type === "turn_completed")?.usage, {
    inputTokens: 21,
    outputTokens: 9,
    totalTokens: 30,
  });
});

test("ACP executor ignores session updates for a different active session", async () => {
  const root = await tempDir("lorenz-acp-session-mismatch");
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
  const traceEvents = await readTrace(trace);
  const closeSession = traceEvents.find((event) => event.method === "closeSession");
  assert.equal(closeSession?.params?.sessionId, "acp-new");
});

test("ACP executor stops the bridge when a turn stalls", async () => {
  const root = await tempDir("lorenz-acp-stall");
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
    await vi.waitFor(() => {
      assert.ok(updates.some((update) => update.type === "process_exit"));
    });
  } finally {
    await session.stop();
  }

  assert.ok(updates.some((update) => update.type === "turn_started"));
  assert.ok(updates.some((update) => update.type === "process_exit"));
});

test("ACP executor resets the stall timeout on session notifications", async () => {
  const root = await tempDir("lorenz-acp-active-stall-reset");
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

test("ACP executor resets the stall timeout on client activity", async () => {
  const root = await tempDir("lorenz-acp-client-activity-stall-reset");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "active-client-events", 5_000, {
    stallTimeoutMs: 350,
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

  assert.equal(updates.filter((update) => update.type === "fs_write").length, 3);
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
    const root = await tempDir(`lorenz-acp-${testCase.mode}`);
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

test("ACP executor suppresses terminal updates after turn timeout", async () => {
  const root = await tempDir("lorenz-acp-late-timeout");
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
    await vi.waitFor(() => {
      assert.ok(updates.some((update) => update.type === "process_exit"));
    });
  } finally {
    await session.stop();
  }

  assert.equal(
    updates.some((update) => update.type === "turn_completed" || update.type === "turn_cancelled"),
    false,
  );
});

test("ACP executor does not rearm the stall timer after turn timeout", async () => {
  const root = await tempDir("lorenz-acp-late-activity-timeout");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "late-activity-after-timeout", 50, {
    stallTimeoutMs: 100,
  });
  const executor = new Executor("claude");
  const updates: AgentUpdate[] = [];
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
    await vi.waitFor(() => {
      assert.ok(updates.some((update) => update.type === "process_exit"));
    });
    await settle(150);
    const traceEvents = await readTrace(trace);
    assert.equal(traceEvents.filter((event) => event.method === "cancel").length, 0);
  } finally {
    await session.stop();
  }
});

test("ACP MCP endpoint leases reuse one reverse tunnel per worker host with per-session tokens", async () => {
  const root = await tempDir("lorenz-acp-remote-mcp");
  const trace = path.join(root, "ssh.trace");
  const leases: Awaited<ReturnType<typeof acquireAgentMcpEndpoint>>[] = [];
  try {
    await installEvalSsh(root, trace);
    const settings = parseConfig({
      server: { host: "127.0.0.1", port: await reserveTcpPort() },
      worker: { ssh_timeout_ms: 5_000 },
    });
    const first = await acquireAgentMcpEndpoint(settings, "worker-acp", workerHostPool);
    leases.push(first);
    const second = await acquireAgentMcpEndpoint(settings, "worker-acp", workerHostPool);
    leases.push(second);

    assert.equal(first.url, "http://127.0.0.1:46000/mcp");
    assert.equal(second.url, "http://127.0.0.1:46000/mcp");
    assert.notEqual(first.token, second.token);
    assert.notEqual(acpAuthHeader(first.acpServer()), acpAuthHeader(second.acpServer()));
    await waitForTunnelTrace(trace, 1);

    await first.release();
    leases.splice(leases.indexOf(first), 1);
    const third = await acquireAgentMcpEndpoint(settings, "worker-acp", workerHostPool);
    leases.push(third);
    assert.equal(tunnelTraceCount(await fs.readFile(trace, "utf8")), 1);

    await second.release();
    leases.splice(leases.indexOf(second), 1);
    await third.release();
    leases.splice(leases.indexOf(third), 1);
    const fourth = await acquireAgentMcpEndpoint(settings, "worker-acp", workerHostPool);
    leases.push(fourth);
    await waitForTunnelTrace(trace, 2);
  } finally {
    await Promise.all(leases.map((lease) => lease.release()));
    vi.unstubAllEnvs();
  }
});

test("ACP executor consumes a threaded mcpEndpoint and SKIPS its own acquire and release", async () => {
  const root = await tempDir("lorenz-acp-threaded");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  await fs.writeFile(path.join(root, "README.md"), "workspace read\n");
  const settings = acpSettings(root, fake, trace, "new");
  const lease = makeFakeEndpointLease();
  const executor = new Executor("claude");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
    mcpEndpoint: lease,
  });
  await session.stop();

  // The session must carry the THREADED lease verbatim (not a freshly acquired one).
  assert.equal(session.mcpEndpoint, lease);
  // newSession's mcpServers came from the threaded lease's acpServer(), proving acp
  // did NOT acquire its own endpoint.
  assert.equal(lease.acpServerCalls > 0, true);
  const traceEvents = await readTrace(trace);
  const newSession = traceEvents.find((event) => event.method === "newSession");
  assert.ok(newSession);
  assert.match(JSON.stringify(newSession.params), /"name":"threaded_endpoint"/);
  // The coordinator owns the whole lease, so acp must NOT release it on stop.
  assert.equal(lease.releaseCalls, 0);
});

test("ACP executor acquires AND releases its OWN endpoint when no mcpEndpoint is threaded", async () => {
  const root = await tempDir("lorenz-acp-own");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  await fs.writeFile(path.join(root, "README.md"), "workspace read\n");
  const settings = acpSettings(root, fake, trace, "new");
  const executor = new Executor("claude");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
  });
  // acp owns its own endpoint on the local path: it acquired a real one (the
  // default lorenz_tracker server) and releasing the session releases it.
  assert.match(JSON.stringify(session.mcpEndpoint.acpServer()), /"name":"lorenz_tracker"/);
  await session.stop();

  const traceEvents = await readTrace(trace);
  const newSession = traceEvents.find((event) => event.method === "newSession");
  assert.ok(newSession);
  assert.match(JSON.stringify(newSession.params), /"name":"lorenz_tracker"/);
});

test("provider config rides session/new _meta as a claude settings overlay", async () => {
  const root = await tempDir("lorenz-acp-provider-claude");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const providerConfig = { model: "claude-opus-4-6", permissions: { defaultMode: "dontAsk" } };
  const settings = acpSettings(root, fake, trace, "new", 5_000, { providerConfig });
  const executor = new Executor("claude");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
  });
  await session.stop();

  const newSession = (await readTrace(trace)).find((event) => event.method === "newSession");
  assert.deepEqual(newSession?.params?._meta?.["symphony/settings"], providerConfig);
  await assert.rejects(() => fs.access(path.join(root, ".claude", "settings.local.json")));
});

test("provider config pins the default claude model via session _meta", async () => {
  const root = await tempDir("lorenz-acp-provider-claude-model");
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

  const newSession = (await readTrace(trace)).find((event) => event.method === "newSession");
  assert.deepEqual(newSession?.params?._meta?.["symphony/settings"], {
    model: "claude-opus-4-6[1m]",
    permissions: { defaultMode: "dontAsk" },
  });
});

test("provider config rides session/new _meta as codex config overrides", async () => {
  const root = await tempDir("lorenz-acp-provider-codex");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const providerConfig = {
    model: "gpt-5.5",
    model_reasoning_effort: "xhigh",
    shell_environment_policy: { inherit: "all" },
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

  const newSession = (await readTrace(trace)).find((event) => event.method === "newSession");
  assert.deepEqual(newSession?.params?._meta?.["symphony/config"], providerConfig);
  await assert.rejects(() => fs.access(path.join(root, ".codex", "config.toml")));
});

test("session requests omit _meta when providerConfig is absent", async () => {
  const root = await tempDir("lorenz-acp-provider-none");
  const fake = await writeFakeBridge(root);
  const trace = path.join(root, "trace.jsonl");
  const settings = acpSettings(root, fake, trace, "new", 5_000, { agentKind: "codex" });
  delete settings.agents.codex!.options.providerConfig;
  const executor = new Executor("codex");
  const session = await executor.startSession({
    workspace: root,
    settings,
    issue: sampleIssue,
  });
  await session.stop();

  const newSession = (await readTrace(trace)).find((event) => event.method === "newSession");
  assert.equal(newSession?.params?._meta, undefined);
  await assert.rejects(() => fs.access(path.join(root, ".codex", "config.toml")));
});

test("resolveBridgeCommand points bare bridge names at the vendored packages", async () => {
  const codex = resolveBridgeCommand("codex-acp", null);
  assert.notEqual(codex, "codex-acp");
  assert.match(codex, /vendor\/codex-acp\/dist\/index\.js/);
  assert.ok(codex.startsWith(shellEscape(process.execPath)));
  await fs.access(codex.split(" ")[1]?.replace(/^'|'$/g, "") ?? "");

  const claude = resolveBridgeCommand("claude-agent-acp", null);
  assert.match(claude, /vendor\/claude-agent-acp\/dist\/bundle\.js/);
  await fs.access(claude.split(" ")[1]?.replace(/^'|'$/g, "") ?? "");
});

test("resolveBridgeCommand preserves arguments, custom commands, and remote hosts", () => {
  assert.match(resolveBridgeCommand("codex-acp --flag value", null), /index\.js'? --flag value$/);
  assert.match(
    resolveBridgeCommand("claude-agent-acp --flag value", null),
    /bundle\.js'? --flag value$/,
  );
  assert.equal(
    resolveBridgeCommand("my-custom-bridge --port 1", null),
    "my-custom-bridge --port 1",
  );
  assert.equal(resolveBridgeCommand("/usr/local/bin/codex-acp", null), "/usr/local/bin/codex-acp");
  assert.equal(resolveBridgeCommand("codex-acp", "worker-1"), "codex-acp");
});

interface FakeEndpointLease extends AgentMcpEndpointLease {
  acpServerCalls: number;
  releaseCalls: number;
}

function makeFakeEndpointLease(): FakeEndpointLease {
  const lease: FakeEndpointLease = {
    url: "http://127.0.0.1:46999/claude-mcp",
    token: "threaded-token",
    generation: 1,
    acpServerCalls: 0,
    releaseCalls: 0,
    acpServer() {
      lease.acpServerCalls += 1;
      return {
        type: "http",
        name: "threaded_endpoint",
        url: lease.url,
        headers: [{ name: "Authorization", value: `Bearer ${lease.token}` }],
      };
    },
    async release() {
      lease.releaseCalls += 1;
    },
  };
  return lease;
}

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
    this.firstPromptReleased = false;
  }

  async initialize(params) {
    record({ method: "initialize", params });
    const agentCapabilities = { sessionCapabilities: { close: {} } };
    if (mode === "queued-external-capability") {
      agentCapabilities._meta = { claudeCode: { promptQueueing: true } };
    } else if (mode.startsWith("queued")) {
      agentCapabilities._meta = { "symphony/promptQueueing": true };
    }
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities };
  }

  async authenticate() {
    return {};
  }

  async newSession(params) {
    record({ method: "newSession", params });
    return { sessionId: "acp-new" };
  }

  async prompt(params) {
    record({ method: "prompt", params });
    this.promptCount += 1;
    if (mode.startsWith("call-usage")) {
      const bucket = (seq) => ({
        seq,
        inputTokens: 2,
        outputTokens: 3,
        cachedReadTokens: 4,
        cachedWriteTokens: 1,
        totalTokens: 10
      });
      const turnUsage = (calls) => ({
        inputTokens: 2 * calls,
        cachedReadTokens: 4 * calls,
        cachedWriteTokens: 1 * calls,
        outputTokens: 3 * calls,
        totalTokens: 10 * calls
      });
      const sendBucket = async (seq, totalUsage) => {
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "usage_update",
            used: 10 * seq,
            size: 100,
            _meta: {
              "symphony/callUsage": bucket(seq),
              ...(totalUsage ? { "symphony/totalUsage": totalUsage } : {})
            }
          }
        });
      };
      if (mode === "call-usage") {
        if (this.promptCount === 1) {
          await sendBucket(1);
          await sendBucket(2);
          await sendBucket(2);
          await sendBucket(3);
          await this.connection.sessionUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: "usage_update", used: 50, size: 100 }
          });
          return { stopReason: "end_turn", usage: turnUsage(3) };
        }
        await sendBucket(4);
        return { stopReason: "end_turn", usage: turnUsage(1) };
      }
      if (mode === "call-usage-undercount") {
        await sendBucket(1);
        await sendBucket(2);
        return { stopReason: "end_turn", usage: turnUsage(3) };
      }
      await sendBucket(1, turnUsage(1));
      await sendBucket(3, turnUsage(3));
      return { stopReason: "end_turn" };
    }
    if (mode === "queued-turn") {
      const promptNumber = this.promptCount;
      if (promptNumber === 1) {
        record({ method: "firstPromptWaiting" });
        while (this.promptCount < 2) await sleep(10);
        record({ method: "firstPromptReleased" });
        await sleep(10);
      } else {
        record({ method: "queuedPromptAccepted" });
        await sleep(30);
      }
      return { stopReason: "end_turn" };
    }
    if (mode === "queued-activation-gate") {
      const promptNumber = this.promptCount;
      if (promptNumber === 1) {
        record({ method: "gatedFirstPromptWaiting" });
        while (!fs.existsSync(trace + ".release")) await sleep(5);
        record({ method: "gatedFirstPromptReleased" });
      } else {
        record({ method: "gatedQueuedPromptRunning" });
      }
      return { stopReason: "end_turn" };
    }
    if (mode === "queued-session-rotation") {
      if (this.promptCount === 1) {
        record({ method: "rotationPromptWaiting" });
        while (!fs.existsSync(trace + ".rotate")) await sleep(5);
        await this.connection.sessionUpdate({
          sessionId: "acp-rotated",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "rotated session" }
          }
        });
        record({ method: "rotationPromptReleased" });
      }
      return { stopReason: "end_turn" };
    }
    if (mode === "queued-response-order") {
      const promptNumber = this.promptCount;
      if (promptNumber === 1) {
        record({ method: "firstPromptWaiting" });
        while (!fs.existsSync(trace + ".release")) await sleep(5);
        record({ method: "firstPromptResolved" });
        return { stopReason: "end_turn" };
      }
      record({ method: "queuedPromptResolved" });
      return { stopReason: "end_turn" };
    }
    if (mode === "queued-timeout") {
      const promptNumber = this.promptCount;
      if (promptNumber === 1) {
        record({ method: "firstPromptWaiting" });
        await this.waitForCancel();
        await sleep(100);
        this.firstPromptReleased = true;
        record({ method: "firstPromptReleased" });
        return { stopReason: "end_turn" };
      }
      record({ method: "queuedPromptWaiting" });
      while (!this.firstPromptReleased) await sleep(5);
      await sleep(30);
      record({ method: "queuedPromptRunning" });
      return { stopReason: "end_turn" };
    }
    if (mode === "queued-wedged-timeout") {
      record({ method: "wedgedPromptWaiting" });
      await new Promise(() => {});
    }
    if (mode === "queued-stop") {
      record({ method: "queuedStopPromptWaiting" });
      await new Promise(() => {});
    }
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
    if (mode === "late-activity-after-timeout") {
      await this.waitForCancel();
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "late activity" }
        }
      });
      record({ method: "lateActivityAfterTimeout" });
      await new Promise(() => {});
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
    if (mode === "active-client-events") {
      for (let i = 0; i < 3; i += 1) {
        await sleep(200);
        await this.connection.writeTextFile({
          sessionId: params.sessionId,
          path: path.join(process.cwd(), "active-" + i + ".txt"),
          content: "still working"
        });
      }
      return { stopReason: "end_turn" };
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
    if (mode === "flood") {
      // Stream a large volume of unique chunks: the daemon must not retain the
      // bridge's stdout (execa result buffering) or the streamed updates.
      for (let i = 0; i < 3000; i++) {
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: ("flood-" + i + "-").padEnd(64, "y").repeat(256) }
          }
        });
      }
      return { stopReason: "end_turn" };
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
            // eslint-disable-next-line no-restricted-syntax -- bounded failure deadline for a rejection assertion (cleared in the finally below), not a wall-clock sleep that gates an assertion.
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
