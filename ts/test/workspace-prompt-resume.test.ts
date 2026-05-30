import fs from "node:fs/promises";
import path from "node:path";

import { test, vi } from "vitest";
import {
  buildPrompt,
  continuationPrompt,
  createWorkspaceForIssue,
  deleteResumeState,
  parseConfig,
  readResumeState,
  removeIssueWorkspaces,
  removeRemoteWorkspace,
  removeWorkspace,
  resumeStateMatches,
  runAgentAttempt,
  safeIdentifier,
  shellEscape,
  validateWorkspaceCwd,
  writeResumeState,
} from "@symphony/cli";

import { assert } from "./assert.js";
import { initGitRepo, sampleIssue, tempDir, writeExecutable } from "./helpers.js";

test("prompt rendering is strict and exposes ensemble context", async () => {
  const prompt = await buildPrompt(
    "{% if ensemble.enabled %}slot={{ ensemble.slot_index }}/{{ ensemble.size }}{% endif %} {{ issue.identifier }} {{ issue.state_type }} {{ issue.assigned_to_worker }} {{ attempt }}",
    { ...sampleIssue, stateType: "unstarted", assignedToWorker: true },
    { attempt: 2, slotIndex: 1, ensembleSize: 3 },
  );
  assert.equal(prompt, "slot=1/3 MT-1 unstarted true 2");

  await assert.rejects(() => buildPrompt("{{ missing.value }}", sampleIssue), /undefined variable/);
  await assert.rejects(
    () => buildPrompt("{{ ensemble.slotIndex }}", sampleIssue),
    /undefined variable/,
  );
});

test("empty workflow prompt uses the Elixir default prompt template", async () => {
  const prompt = await buildPrompt("", { ...sampleIssue, description: null });

  assert.match(prompt, /You are working on a Linear issue\./);
  assert.match(prompt, /Identifier: MT-1/);
  assert.match(prompt, /No description provided\./);
});

test("continuation prompt matches the Elixir runner guidance", () => {
  assert.equal(
    continuationPrompt(2, 3),
    `Continuation guidance:

- The previous agent turn completed normally, but the Linear issue is still in an active state.
- This is continuation turn #2 of 3 for the current agent run.
- Resume from the current workspace and workpad state instead of restarting from scratch.
- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.
- Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.
`,
  );
});

test("workspace path is safe, per-slot, and runs after_create in the slot directory", async () => {
  const root = await tempDir("symphony-ts-workspace");
  const settings = parseConfig({
    workspace: { root },
    hooks: { after_create: "pwd > created.cwd && echo created > marker.txt" },
  });

  const workspace = await createWorkspaceForIssue(settings, sampleIssue, {
    slotIndex: 1,
    ensembleSize: 3,
  });
  assert.equal(path.basename(workspace), "1");
  assert.equal(path.basename(path.dirname(workspace)), safeIdentifier(sampleIssue.identifier));
  assert.equal((await fs.readFile(path.join(workspace, "marker.txt"), "utf8")).trim(), "created");
  assert.equal((await fs.readFile(path.join(workspace, "created.cwd"), "utf8")).trim(), workspace);
});

test("workspace identifiers preserve Elixir safe_identifier semantics", async () => {
  assert.equal(safeIdentifier("  A B  "), "__A_B__");
  assert.equal(safeIdentifier(""), "");
  assert.equal(safeIdentifier(null), "");

  const root = await tempDir("symphony-ts-workspace-empty-identifier");
  const settings = parseConfig({ workspace: { root } });
  await assert.rejects(() => createWorkspaceForIssue(settings, ""), /workspace root/);
});

test("workspace cwd validation rejects control characters", async () => {
  const root = await tempDir("symphony-ts-workspace-control-chars");
  const workspace = path.join(root, "MT-1");
  await fs.mkdir(workspace, { recursive: true });
  const settings = parseConfig({ workspace: { root } });

  await assert.rejects(
    () => validateWorkspaceCwd(settings, `${workspace}\r`),
    /invalid_workspace_cwd/,
  );
  await assert.rejects(
    () => validateWorkspaceCwd(settings, `${workspace}\0`),
    /invalid_workspace_cwd/,
  );
});

test("workspace creation rejects symlink roots and final symlink directories", async () => {
  const root = await tempDir("symphony-ts-workspace-symlink-root");
  const outside = await tempDir("symphony-ts-workspace-symlink-outside");
  const symlinkRoot = path.join(root, "workspace-link");
  await fs.symlink(outside, symlinkRoot);
  await assert.rejects(
    () => createWorkspaceForIssue(parseConfig({ workspace: { root: symlinkRoot } }), "MT-SYMROOT"),
    /unsafe symlink/,
  );

  const finalRoot = await tempDir("symphony-ts-workspace-final-symlink");
  const finalOutside = await tempDir("symphony-ts-workspace-final-outside");
  await fs.symlink(finalOutside, path.join(finalRoot, "MT-SYMFINAL"));
  await assert.rejects(
    () => createWorkspaceForIssue(parseConfig({ workspace: { root: finalRoot } }), "MT-SYMFINAL"),
    /unsafe symlink/,
  );
});

test("workspace removal runs before_remove best-effort hooks and refuses unsafe paths", async () => {
  const root = await tempDir("symphony-ts-workspace-remove");
  const beforeRemoveMarker = path.join(root, "before-remove.log");
  const settings = parseConfig({
    workspace: { root },
    hooks: {
      after_create: "echo after_create > after_create.log",
      before_remove: `echo before_remove > ${JSON.stringify(beforeRemoveMarker)}`,
    },
  });

  const workspace = await createWorkspaceForIssue(settings, "MT-HOOKS");
  assert.equal(await fileExists(path.join(workspace, "after_create.log")), true);
  assert.deepEqual(await removeWorkspace(settings, workspace), [workspace]);
  assert.equal(await fileExists(workspace), false);
  assert.equal((await fs.readFile(beforeRemoveMarker, "utf8")).trim(), "before_remove");

  const recreated = await createWorkspaceForIssue(settings, "MT-HOOKS-FAIL");
  const failingSettings = parseConfig({
    workspace: { root },
    hooks: { before_remove: "echo failure && exit 17" },
  });
  assert.deepEqual(await removeWorkspace(failingSettings, recreated), [recreated]);
  assert.equal(await fileExists(recreated), false);

  const timeoutWorkspace = await createWorkspaceForIssue(settings, "MT-HOOKS-TIMEOUT");
  const timeoutSettings = parseConfig({
    workspace: { root },
    hooks: { timeout_ms: 10, before_remove: "sleep 1" },
  });
  assert.deepEqual(await removeWorkspace(timeoutSettings, timeoutWorkspace), [timeoutWorkspace]);
  assert.equal(await fileExists(timeoutWorkspace), false);

  await assert.rejects(() => removeWorkspace(settings, root), /refusing to remove workspace root/);
  assert.deepEqual(await removeWorkspace(settings, path.join(root, "missing")), []);

  const symlinkPath = path.join(root, "MT-SYM");
  const symlinkTarget = await tempDir("symphony-ts-symlink");
  await fs.symlink(symlinkTarget, symlinkPath);
  await assert.rejects(
    () => removeWorkspace(settings, symlinkPath),
    /unsafe symlink in workspace path/,
  );
  assert.equal(await fileExists(symlinkPath), true);

  const outsideRoot = await tempDir("symphony-ts-workspace-outside");
  await assert.rejects(() => removeWorkspace(settings, outsideRoot), /workspace outside root/);
  assert.equal(await fileExists(outsideRoot), true);
});

test("workspace issue cleanup removes issue directory and ignores missing or non-string identifiers", async () => {
  const root = await tempDir("symphony-ts-workspace-cleanup");
  const settings = parseConfig({ workspace: { root } });
  const slot = await createWorkspaceForIssue(settings, "S 1", { slotIndex: 1, ensembleSize: 2 });
  const issueRoot = path.dirname(slot);
  await fs.writeFile(path.join(slot, "scratch.txt"), "remove me\n");

  await removeIssueWorkspaces(settings, "S 1");
  assert.equal(await fileExists(issueRoot), false);
  await removeIssueWorkspaces(settings, "missing");
  await removeIssueWorkspaces(settings, null);
});

test("remote workspace creation and removal use SSH hooks and validate remote paths", async () => {
  const root = await tempDir("symphony-ts-remote-workspace");
  const trace = path.join(root, "ssh.trace");
  const remoteHome = path.join(root, "remote-home");

  const { canonicalRemoteHome, binDir } = await installEvalSsh(root, trace, remoteHome);
  vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);

  const marker = path.join(root, "remote-before-remove.log");
  const settings = parseConfig({
    workspace: { root: "~/workspaces" },
    worker: { ssh_hosts: ["worker-01:2200"], ssh_timeout_ms: 5_000 },
    hooks: {
      after_create: "echo remote-after > after_create.log",
      before_remove: `echo remote-before > ${shellEscape(marker)}`,
    },
  });

  const workspace = await createWorkspaceForIssue(settings, "MT-REMOTE", {
    workerHost: "worker-01:2200",
  });
  assert.equal(workspace, path.join(canonicalRemoteHome, "workspaces", "MT-REMOTE"));
  assert.equal(
    (await fs.readFile(path.join(workspace, "after_create.log"), "utf8")).trim(),
    "remote-after",
  );

  await removeRemoteWorkspace(settings, workspace, "worker-01:2200");
  assert.equal(await fileExists(workspace), false);
  assert.equal((await fs.readFile(marker, "utf8")).trim(), "remote-before");

  await assert.rejects(
    () => removeRemoteWorkspace(settings, "/tmp/outside-root", "worker-01:2200"),
    /workspace outside root/,
  );
  const traceText = await fs.readFile(trace, "utf8");
  assert.match(traceText, /-T -p 2200 worker-01 bash -lc/);
  assert.match(traceText, /printf "%s\\n" "\$HOME"/);
  assert.match(traceText, /rm -rf/);

  vi.unstubAllEnvs();
});

test("agent attempts run workspace hooks at lifecycle boundaries and tolerate after_run failures", async () => {
  const root = await tempDir("symphony-ts-workspace-agent-hooks");
  const workspaceRoot = path.join(root, "workspaces");
  const fakeCodex = path.join(root, "fake-codex.js");
  const hookLog = path.join(root, "hooks.log");
  await writeExecutable(
    fakeCodex,
    `#!/usr/bin/env node
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id && msg.method === "initialize") console.log(JSON.stringify({ id: msg.id, result: {} }));
  if (msg.id && msg.method === "thread/start") console.log(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-hooks" } } }));
  if (msg.id && msg.method === "turn/start") {
    console.log(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-hooks" } } }));
    console.log(JSON.stringify({ method: "turn/completed" }));
  }
});
`,
  );
  const settings = parseConfig({
    workspace: { root: workspaceRoot },
    hooks: {
      after_create: `echo after_create >> ${JSON.stringify(hookLog)}`,
      before_run: `echo before_run >> ${JSON.stringify(hookLog)}`,
      after_run: `echo after_run >> ${JSON.stringify(hookLog)}; exit 17`,
    },
    codex: { command: `${fakeCodex} app-server`, turn_timeout_ms: 5_000 },
    agent: { max_turns: 1 },
  });
  const workflow = {
    path: path.join(root, "WORKFLOW.md"),
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };

  const result = await runAgentAttempt({ issue: sampleIssue, workflow });

  assert.equal(result.turnCount, 1);
  assert.deepEqual((await fs.readFile(hookLog, "utf8")).trim().split("\n"), [
    "after_create",
    "before_run",
    "after_run",
  ]);
});

test("agent attempts persist the latest rotated Claude session id", async () => {
  const root = await tempDir("symphony-ts-claude-rotated-session");
  const fakeClaude = path.join(root, "fake-claude-acp.mjs");
  const acpModule = new URL("../node_modules/@agentclientprotocol/sdk/dist/acp.js", import.meta.url)
    .href;
  await writeExecutable(
    fakeClaude,
    `#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import * as acp from ${JSON.stringify(acpModule)};

class FakeAgent {
  constructor(connection) {
    this.connection = connection;
    this.turn = 0;
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { sessionCapabilities: { close: {} } }
    };
  }

  async authenticate() {
    return {};
  }

  async newSession() {
    return { sessionId: "claude-session-0" };
  }

  async prompt(params) {
    this.turn += 1;
    const sessionId = "claude-session-" + this.turn;
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "turn " + this.turn }
      }
    });
    return {
      stopReason: "end_turn",
      usage: { inputTokens: this.turn, outputTokens: 1, totalTokens: this.turn + 1 }
    };
  }

  async cancel() {}

  async closeSession() {
    return {};
  }
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((connection) => new FakeAgent(connection), stream);
`,
  );
  const settings = parseConfig({
    workspace: { root: path.join(root, "workspaces") },
    agent: { kind: "claude", max_turns: 2 },
    agents: {
      claude: {
        executor: "acp",
        bridge_command: process.execPath,
        bridge_args: [fakeClaude],
        turn_timeout_ms: 5_000,
        stall_timeout_ms: 0,
      },
    },
    hooks: { after_create: "git init -b main >/dev/null" },
  });
  const workflow = {
    path: path.join(root, "WORKFLOW.md"),
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };

  const result = await runAgentAttempt({
    issue: sampleIssue,
    workflow,
    fetchIssue: async () => sampleIssue,
  });

  const resume = await readResumeState(result.workspace);
  assert.equal(result.turnCount, 2);
  assert.equal(result.resumeId, "claude-session-2");
  assert.equal(resume.status, "ok");
  assert.equal(resume.status === "ok" && resume.state.resumeId, "claude-session-2");
});

test("remote agent attempts run hooks and persist resume state over SSH", async () => {
  const root = await tempDir("symphony-ts-remote-agent-hooks");
  const trace = path.join(root, "ssh.trace");
  const remoteHome = path.join(root, "remote-home");
  const fakeCodex = path.join(root, "fake-codex.js");
  const hookLog = path.join(root, "remote-hooks.log");

  await writeExecutable(
    fakeCodex,
    `#!/usr/bin/env node
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id && msg.method === "initialize") console.log(JSON.stringify({ id: msg.id, result: {} }));
  if (msg.id && msg.method === "thread/start") console.log(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-remote-hooks" } } }));
  if (msg.id && msg.method === "turn/start") {
    console.log(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-remote-hooks" } } }));
    console.log(JSON.stringify({ method: "turn/completed" }));
  }
});
`,
  );

  const { canonicalRemoteHome, binDir } = await installEvalSsh(root, trace, remoteHome);
  vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);

  const settings = parseConfig({
    workspace: { root: "~/workspaces" },
    worker: { ssh_hosts: ["worker-01:2200"], ssh_timeout_ms: 5_000 },
    hooks: {
      after_create: `git init -q && echo after_create >> ${shellEscape(hookLog)}`,
      before_run: `echo before_run >> ${shellEscape(hookLog)}`,
      after_run: `echo after_run >> ${shellEscape(hookLog)}`,
    },
    codex: { command: `${fakeCodex} app-server`, turn_timeout_ms: 5_000 },
    agent: { max_turns: 1 },
  });
  const workflow = {
    path: path.join(root, "WORKFLOW.md"),
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };

  const result = await runAgentAttempt({
    issue: sampleIssue,
    workflow,
    workerHost: "worker-01:2200",
  });

  assert.equal(
    result.workspace,
    path.join(canonicalRemoteHome, "workspaces", sampleIssue.identifier),
  );
  assert.equal(result.turnCount, 1);
  assert.deepEqual((await fs.readFile(hookLog, "utf8")).trim().split("\n"), [
    "after_create",
    "before_run",
    "after_run",
  ]);

  const resume = await readResumeState(result.workspace, "worker-01:2200");
  assert.equal(resume.status, "ok");
  assert.equal(resume.status === "ok" && resume.state.workerHost, "worker-01:2200");
  assert.equal(
    resume.status === "ok" &&
      resumeStateMatches(resume.state, {
        agentKind: "codex",
        issue: sampleIssue,
        workspacePath: result.workspace,
        workerHost: "worker-01:2200",
      }),
    true,
  );

  const traceText = await fs.readFile(trace, "utf8");
  assert.match(traceText, /git -C/);
  assert.match(traceText, /symphony\/resume.json/);

  vi.unstubAllEnvs();
});

test("remote resume-state reads honor the configured SSH timeout", async () => {
  const root = await tempDir("symphony-ts-remote-resume-timeout");
  const bin = path.join(root, "bin");

  await fs.mkdir(bin, { recursive: true });
  await writeExecutable(
    path.join(bin, "ssh"),
    `#!/bin/sh
sleep 1
`,
  );
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);

  const startedAt = Date.now();
  const result = await readResumeState("/remote/workspace", "worker-01:2200", 20);

  assert.equal(result.status, "unavailable");
  assert.ok(Date.now() - startedAt < 500);

  vi.unstubAllEnvs();
});

test("agent attempts warn and skip invalid resume state files", async () => {
  const root = await tempDir("symphony-ts-invalid-resume-warning");
  const workspaceRoot = path.join(root, "workspaces");
  const fakeCodex = path.join(root, "fake-codex.js");
  await writeExecutable(
    fakeCodex,
    `#!/usr/bin/env node
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id && msg.method === "initialize") console.log(JSON.stringify({ id: msg.id, result: {} }));
  if (msg.id && msg.method === "thread/start") console.log(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-invalid-resume" } } }));
  if (msg.id && msg.method === "thread/resume") console.log(JSON.stringify({ id: msg.id, error: { message: "should not resume invalid state" } }));
  if (msg.id && msg.method === "turn/start") {
    console.log(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-invalid-resume" } } }));
    console.log(JSON.stringify({ method: "turn/completed" }));
  }
});
`,
  );
  const settings = parseConfig({
    workspace: { root: workspaceRoot },
    hooks: { after_create: "git init -q" },
    codex: { command: `${fakeCodex} app-server`, turn_timeout_ms: 5_000 },
    agent: { max_turns: 1 },
  });
  const workflow = {
    path: path.join(root, "WORKFLOW.md"),
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };
  const workspace = await createWorkspaceForIssue(settings, sampleIssue);
  const resumePath = path.join(workspace, ".git", "symphony", "resume.json");
  await fs.mkdir(path.dirname(resumePath), { recursive: true });
  await fs.writeFile(resumePath, "{not-json");
  const updates: string[] = [];

  const result = await runAgentAttempt({
    issue: sampleIssue,
    workflow,
    onUpdate: (update) => updates.push(`${update.type}:${String(update.message ?? "")}`),
  });

  assert.equal(result.turnCount, 1);
  assert.ok(
    updates.some((update) => update.includes("resume_state_warning:resume_state_decode_failed")),
  );
});

test("agent attempts leave stall reconciliation to runtime and preserve resume state on turn failure", async () => {
  const root = await tempDir("symphony-ts-stall-retry");
  const workspaceRoot = path.join(root, "workspaces");
  const fakeCodex = path.join(root, "fake-stalled-codex.js");
  await writeExecutable(
    fakeCodex,
    `#!/usr/bin/env node
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id && msg.method === "initialize") console.log(JSON.stringify({ id: msg.id, result: {} }));
  if (msg.id && (msg.method === "thread/start" || msg.method === "thread/resume")) {
    console.log(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-stalled" } } }));
  }
  if (msg.id && msg.method === "turn/start") {
    console.log(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-stalled" } } }));
  }
});
`,
  );

  const settings = parseConfig({
    workspace: { root: workspaceRoot },
    hooks: { after_create: "git init -q" },
    codex: { command: `${fakeCodex} app-server`, stall_timeout_ms: 30, turn_timeout_ms: 50 },
    agent: { max_turns: 1 },
  });
  const workflow = {
    path: path.join(root, "WORKFLOW.md"),
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };
  const workspace = await createWorkspaceForIssue(settings, sampleIssue);
  await writeResumeState(workspace, {
    agentKind: "codex",
    resumeId: "thread-stale",
    issueId: sampleIssue.id,
    issueIdentifier: sampleIssue.identifier,
    issueState: sampleIssue.state,
    workspacePath: workspace,
  });

  await assert.rejects(
    () => runAgentAttempt({ issue: sampleIssue, workflow }),
    /codex turn timed out/,
  );
  assert.equal((await readResumeState(workspace)).status, "ok");
});

test("resume state reads generic agent/session_id shape and matches issue/workspace identity", async () => {
  const workspace = await tempDir("symphony-ts-resume");
  await initGitRepo(workspace);

  await writeResumeState(workspace, {
    agentKind: "codex",
    resumeId: "thread-1",
    issueId: sampleIssue.id,
    issueIdentifier: sampleIssue.identifier,
    issueState: sampleIssue.state,
    workspacePath: workspace,
  });

  const result = await readResumeState(workspace);
  assert.equal(result.status, "ok");
  assert.equal(result.status === "ok" && result.state.agentKind, "codex");
  const resumePath = path.join(workspace, ".git", "symphony", "resume.json");
  const encoded = JSON.parse(await fs.readFile(resumePath, "utf8"));
  assert.equal(encoded.agent, "codex");
  assert.equal(encoded.session_id, "thread-1");
  assert.equal(
    result.status === "ok" &&
      resumeStateMatches(result.state, {
        agentKind: "codex",
        issue: sampleIssue,
        workspacePath: workspace,
      }),
    true,
  );
  assert.equal(
    result.status === "ok" &&
      resumeStateMatches(
        {
          agentKind: "codex",
          resumeId: "legacy-thread",
          workspacePath: workspace,
        },
        {
          agentKind: "codex",
          issue: sampleIssue,
          workspacePath: workspace,
        },
      ),
    false,
  );

  await assert.rejects(
    () => writeResumeState(workspace, { agentKind: "" as "codex", resumeId: "bad" }),
    /invalid_resume_state/,
  );

  await fs.writeFile(
    resumePath,
    `${JSON.stringify({
      agent: "pi",
      session_id: "pi-session",
      issue_id: sampleIssue.id,
      issue_identifier: sampleIssue.identifier,
      issue_state: sampleIssue.state,
      workspace_path: workspace,
    })}\n`,
  );
  const generic = await readResumeState(workspace);
  assert.equal(generic.status, "ok");
  assert.equal(generic.status === "ok" && generic.state.agentKind, "pi");
  assert.equal(generic.status === "ok" && generic.state.resumeId, "pi-session");

  await deleteResumeState(workspace);
  assert.equal((await readResumeState(workspace)).status, "missing");
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function installEvalSsh(
  root: string,
  trace: string,
  remoteHome: string,
): Promise<{ canonicalRemoteHome: string; binDir: string }> {
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(remoteHome, { recursive: true });
  const canonicalRemoteHome = await fs.realpath(remoteHome);
  await writeExecutable(
    path.join(bin, "ssh"),
    `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> ${shellEscape(trace)}
for arg in "$@"; do last_arg="$arg"; done
case "$last_arg" in
  *'printf "%s\\n" "$HOME"'*)
    printf '%s\\n' ${shellEscape(canonicalRemoteHome)}
    exit 0
    ;;
esac
export HOME=${shellEscape(canonicalRemoteHome)}
eval "$last_arg"
`,
  );
  await fs.writeFile(trace, "");
  return { canonicalRemoteHome, binDir: bin };
}
