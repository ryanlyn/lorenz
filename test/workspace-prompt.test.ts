import fs from "node:fs/promises";
import path from "node:path";

import { test, vi } from "vitest";
import { acpExecutorProvider } from "@lorenz/acp";
import { AgentExecutorRegistry } from "@lorenz/agent-sdk";
import {
  buildPrompt,
  continuationPrompt,
  createWorkspaceForIssue,
  parseConfig as parseConfigWith,
  removeIssueWorkspaces,
  removeRemoteWorkspace,
  removeWorkspace,
  runAgentAttempt,
  safeIdentifier,
  shellEscape,
  validateWorkspaceCwd,
} from "@lorenz/cli";
import type { Settings } from "@lorenz/cli";
import { assert, sampleIssue, tempDir, writeExecutable } from "@lorenz/test-utils";

// Private executor registry standing in for the CLI composition root: attempts resolve
// the ACP executor through an explicit adapter instead of the process-default registry,
// and config parsing resolves agent option vocabularies through the same registry.
const executors = new AgentExecutorRegistry();
executors.register(acpExecutorProvider);

function parseConfig(raw: Record<string, unknown>): Settings {
  return parseConfigWith(raw, {}, {}, undefined, executors);
}

const executorAdapters = {
  executorFactory: async (settings: Settings) => {
    const kind = settings.agent.kind;
    const agent = settings.agents[kind];
    if (!agent) throw new Error(`agents.${kind} is required`);
    return executors.require(agent.executor).createExecutor(kind, settings);
  },
};

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

test("empty workflow prompt uses the default prompt template", async () => {
  const prompt = await buildPrompt("", { ...sampleIssue, description: null });

  assert.match(prompt, /You are working on an issue from the configured tracker\./);
  assert.match(prompt, /Identifier: MT-1/);
  assert.match(prompt, /No description provided\./);
});

test("continuation prompt matches the runner guidance", () => {
  assert.equal(
    continuationPrompt(2, 3),
    `Continuation guidance:

- The previous agent turn completed normally, but the issue is still in an active state.
- This is continuation turn #2 of 3 for the current agent run.
- Resume from the current workspace and workpad state instead of restarting from scratch.
- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.
- Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.
`,
  );
});

test("workspace path is safe, per-slot, and runs after_create in the slot directory", async () => {
  const root = await tempDir("lorenz-workspace");
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

test("workspace identifiers preserve safe identifier semantics", async () => {
  assert.equal(safeIdentifier("  A B  "), "__A_B__");
  assert.equal(safeIdentifier(""), "");
  assert.equal(safeIdentifier(null), "");

  const root = await tempDir("lorenz-workspace-empty-identifier");
  const settings = parseConfig({ workspace: { root } });
  await assert.rejects(() => createWorkspaceForIssue(settings, ""), /empty identifier/);
});

test("workspace cwd validation rejects control characters", async () => {
  const root = await tempDir("lorenz-workspace-control-chars");
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
  const root = await tempDir("lorenz-workspace-symlink-root");
  const outside = await tempDir("lorenz-workspace-symlink-outside");
  const symlinkRoot = path.join(root, "workspace-link");
  await fs.symlink(outside, symlinkRoot);
  await assert.rejects(
    () => createWorkspaceForIssue(parseConfig({ workspace: { root: symlinkRoot } }), "MT-SYMROOT"),
    /unsafe symlink/,
  );

  const finalRoot = await tempDir("lorenz-workspace-final-symlink");
  const finalOutside = await tempDir("lorenz-workspace-final-outside");
  await fs.symlink(finalOutside, path.join(finalRoot, "MT-SYMFINAL"));
  await assert.rejects(
    () => createWorkspaceForIssue(parseConfig({ workspace: { root: finalRoot } }), "MT-SYMFINAL"),
    /unsafe symlink/,
  );
});

test("workspace removal runs before_remove best-effort hooks and refuses unsafe paths", async () => {
  const root = await tempDir("lorenz-workspace-remove");
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
  const symlinkTarget = await tempDir("lorenz-symlink");
  await fs.symlink(symlinkTarget, symlinkPath);
  await assert.rejects(
    () => removeWorkspace(settings, symlinkPath),
    /unsafe symlink in workspace path/,
  );
  assert.equal(await fileExists(symlinkPath), true);

  const outsideRoot = await tempDir("lorenz-workspace-outside");
  await assert.rejects(() => removeWorkspace(settings, outsideRoot), /workspace outside root/);
  assert.equal(await fileExists(outsideRoot), true);
});

test("workspace issue cleanup removes issue directory and ignores missing or non-string identifiers", async () => {
  const root = await tempDir("lorenz-workspace-cleanup");
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
  const root = await tempDir("lorenz-remote-workspace");
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
  assert.match(traceText, /-T -p 2200 -- worker-01 bash -lc/);
  assert.match(traceText, /printf "%s\\n" "\$HOME"/);
  assert.match(traceText, /rm -rf/);

  vi.unstubAllEnvs();
});

test("remote workspace cwd validation accepts a missing path inside the workspace root", async () => {
  const root = await tempDir("lorenz-remote-missing-workspace");
  const trace = path.join(root, "ssh.trace");
  const remoteHome = path.join(root, "remote-home");

  const { canonicalRemoteHome, binDir } = await installEvalSsh(root, trace, remoteHome);
  vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);

  try {
    const workspaceRoot = path.join(canonicalRemoteHome, "workspaces");
    const workspace = path.join(workspaceRoot, "MT-MISSING");
    await fs.mkdir(workspaceRoot, { recursive: true });
    const settings = parseConfig({
      workspace: { root: "~/workspaces" },
      worker: { ssh_hosts: ["worker-01:2200"], ssh_timeout_ms: 5_000 },
    });

    const result = await validateWorkspaceCwd(settings, workspace, "worker-01:2200");

    assert.equal(result, workspace);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("remote workspace cwd validation reports symlink escapes through missing tail paths", async () => {
  const root = await tempDir("lorenz-remote-symlink-escape");
  const trace = path.join(root, "ssh.trace");
  const remoteHome = path.join(root, "remote-home");

  const { canonicalRemoteHome, binDir } = await installEvalSsh(root, trace, remoteHome);
  vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);

  try {
    const workspaceRoot = path.join(canonicalRemoteHome, "workspaces");
    const outside = await tempDir("lorenz-remote-outside");
    const link = path.join(workspaceRoot, "link-out");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.symlink(outside, link);
    const settings = parseConfig({
      workspace: { root: "~/workspaces" },
      worker: { ssh_hosts: ["worker-01:2200"], ssh_timeout_ms: 5_000 },
    });

    await assert.rejects(
      () => validateWorkspaceCwd(settings, path.join(link, "missing"), "worker-01:2200"),
      /symlink_escape/,
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

test("remote workspace creation forces the slot suffix for co-resident same-issue slots", async () => {
  const root = await tempDir("lorenz-remote-coreside");
  const trace = path.join(root, "ssh.trace");
  const remoteHome = path.join(root, "remote-home");

  const { canonicalRemoteHome, binDir } = await installEvalSsh(root, trace, remoteHome);
  vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);

  try {
    const settings = parseConfig({
      workspace: { root: "~/workspaces" },
      worker: { ssh_hosts: ["worker-01:2200"], ssh_timeout_ms: 5_000 },
    });

    // Both solo (ensembleSize default 1) but co-resident on one host: forceSlotSuffix
    // must give distinct `<issue>/<slotIndex>` remote dirs, not the shared bare path.
    const slot0 = await createWorkspaceForIssue(settings, "MT-REMOTE-CO", {
      workerHost: "worker-01:2200",
      slotIndex: 0,
      forceSlotSuffix: true,
    });
    const slot1 = await createWorkspaceForIssue(settings, "MT-REMOTE-CO", {
      workerHost: "worker-01:2200",
      slotIndex: 1,
      forceSlotSuffix: true,
    });

    const issueRoot = path.join(canonicalRemoteHome, "workspaces", "MT-REMOTE-CO");
    assert.equal(slot0, path.join(issueRoot, "0"));
    assert.equal(slot1, path.join(issueRoot, "1"));
    assert.ok(slot0 !== slot1);

    // The default (no forceSlotSuffix) still returns the bare remote issue dir.
    const bare = await createWorkspaceForIssue(settings, "MT-REMOTE-BARE", {
      workerHost: "worker-01:2200",
    });
    assert.equal(bare, path.join(canonicalRemoteHome, "workspaces", "MT-REMOTE-BARE"));
  } finally {
    vi.unstubAllEnvs();
  }
});

test("agent attempts run workspace hooks at lifecycle boundaries and tolerate after_run failures", async () => {
  const root = await tempDir("lorenz-workspace-agent-hooks");
  const workspaceRoot = path.join(root, "workspaces");
  const fakeBridge = path.join(root, "fake-acp.mjs");
  const hookLog = path.join(root, "hooks.log");
  const acpModule = new URL("../node_modules/@agentclientprotocol/sdk/dist/acp.js", import.meta.url)
    .href;
  await writeExecutable(
    fakeBridge,
    `#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import * as acp from ${JSON.stringify(acpModule)};
class FakeAgent {
  constructor(connection) { this.connection = connection; }
  async initialize() { return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { close: {} } } }; }
  async authenticate() { return {}; }
  async newSession() { return { sessionId: "hooks-session" }; }
  async prompt() {
    await this.connection.sessionUpdate({ sessionId: "hooks-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
    return { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }
  async cancel() {}
  async closeSession() { return {}; }
}
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((connection) => new FakeAgent(connection), stream);
`,
  );
  const settings = parseConfig({
    server: { port: 0 },
    workspace: { root: workspaceRoot },
    hooks: {
      after_create: `echo after_create >> ${JSON.stringify(hookLog)}`,
      before_run: `echo before_run >> ${JSON.stringify(hookLog)}`,
      after_run: `echo after_run >> ${JSON.stringify(hookLog)}; exit 17`,
    },
    agents: {
      codex: {
        bridge_command: `${process.execPath} ${fakeBridge}`,
        turn_timeout_ms: 5_000,
        stall_timeout_ms: 0,
      },
    },
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
    adapters: executorAdapters,
  });

  assert.equal(result.turnCount, 1);
  assert.deepEqual((await fs.readFile(hookLog, "utf8")).trim().split("\n"), [
    "after_create",
    "before_run",
    "after_run",
  ]);
});

test('workspace.isolation = "none" rejects every hook and co-locates agents in one folder', async () => {
  const root = await tempDir("lorenz-shared-ws");

  for (const hook of ["after_create", "before_run", "after_run", "before_remove"]) {
    assert.throws(
      () =>
        parseConfig({
          workspace: { root, isolation: "none" },
          hooks: { [hook]: "echo hi" },
        }),
      /workspace.isolation = "none" does not support hooks/,
    );
  }

  const fakeBridge = path.join(root, "fake-acp.mjs");
  const acpModule = new URL("../node_modules/@agentclientprotocol/sdk/dist/acp.js", import.meta.url)
    .href;
  await writeExecutable(
    fakeBridge,
    `#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import * as acp from ${JSON.stringify(acpModule)};
class FakeAgent {
  constructor(connection) { this.connection = connection; }
  async initialize() { return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { close: {} } } }; }
  async authenticate() { return {}; }
  async newSession() { return { sessionId: "shared-session" }; }
  async prompt() {
    await this.connection.sessionUpdate({ sessionId: "shared-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
    return { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }
  async cancel() {}
  async closeSession() { return {}; }
}
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((connection) => new FakeAgent(connection), stream);
`,
  );
  const sharedRoot = path.join(root, "shared");
  const settings = parseConfig({
    server: { port: 0 },
    workspace: { root: sharedRoot, isolation: "none" },
    agents: {
      codex: {
        bridge_command: `${process.execPath} ${fakeBridge}`,
        turn_timeout_ms: 5_000,
        stall_timeout_ms: 0,
      },
    },
    agent: { max_turns: 1 },
  });
  assert.equal(settings.workspace.isolation, "none");
  const workflow = {
    path: path.join(root, "WORKFLOW.md"),
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };

  const first = await runAgentAttempt({ issue: sampleIssue, workflow, adapters: executorAdapters });
  const second = await runAgentAttempt({
    issue: { ...sampleIssue, identifier: "MT-77" },
    workflow,
    adapters: executorAdapters,
  });

  const canonicalRoot = await fs.realpath(sharedRoot);
  assert.equal(first.workspace, canonicalRoot);
  assert.equal(second.workspace, canonicalRoot);
  const entries = await fs.readdir(canonicalRoot);
  assert.ok(!entries.includes(safeIdentifier(sampleIssue.identifier)));
  assert.ok(!entries.includes("MT-77"));
});

test("remote agent attempts run hooks over SSH", async () => {
  const root = await tempDir("lorenz-remote-agent-hooks");
  const trace = path.join(root, "ssh.trace");
  const remoteHome = path.join(root, "remote-home");
  const fakeBridge = path.join(root, "fake-acp.mjs");
  const hookLog = path.join(root, "remote-hooks.log");
  const acpModule = new URL("../node_modules/@agentclientprotocol/sdk/dist/acp.js", import.meta.url)
    .href;

  await writeExecutable(
    fakeBridge,
    `#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import * as acp from ${JSON.stringify(acpModule)};
class FakeAgent {
  constructor(connection) { this.connection = connection; }
  async initialize() { return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { close: {} } } }; }
  async authenticate() { return {}; }
  async newSession() { return { sessionId: "remote-session" }; }
  async prompt() {
    await this.connection.sessionUpdate({ sessionId: "remote-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
    return { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }
  async cancel() {}
  async closeSession() { return {}; }
}
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((connection) => new FakeAgent(connection), stream);
`,
  );

  const { canonicalRemoteHome, binDir } = await installEvalSsh(root, trace, remoteHome);
  vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);

  const settings = parseConfig({
    server: { port: 0 },
    workspace: { root: "~/workspaces" },
    worker: { ssh_hosts: ["worker-01:2200"], ssh_timeout_ms: 5_000 },
    hooks: {
      after_create: `echo after_create >> ${shellEscape(hookLog)}`,
      before_run: `echo before_run >> ${shellEscape(hookLog)}`,
      after_run: `echo after_run >> ${shellEscape(hookLog)}`,
    },
    agents: {
      codex: {
        bridge_command: `${process.execPath} ${fakeBridge}`,
        turn_timeout_ms: 5_000,
        stall_timeout_ms: 0,
      },
    },
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
    adapters: executorAdapters,
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

  const traceText = await fs.readFile(trace, "utf8");
  assert.match(traceText, /after_create/);
  assert.match(traceText, /before_run/);
  assert.match(traceText, /after_run/);

  vi.unstubAllEnvs();
});

test("agent attempts leave stall reconciliation to runtime", async () => {
  const root = await tempDir("lorenz-stall-retry");
  const workspaceRoot = path.join(root, "workspaces");
  const fakeBridge = path.join(root, "fake-stall-acp.mjs");
  const acpModule = new URL("../node_modules/@agentclientprotocol/sdk/dist/acp.js", import.meta.url)
    .href;
  await writeExecutable(
    fakeBridge,
    `#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import * as acp from ${JSON.stringify(acpModule)};
class FakeAgent {
  constructor(connection) { this.connection = connection; }
  async initialize() { return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { close: {} } } }; }
  async authenticate() { return {}; }
  async newSession() { return { sessionId: "stall-session" }; }
  async prompt() { return new Promise(() => {}); }
  async cancel() {}
  async closeSession() { return {}; }
}
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((connection) => new FakeAgent(connection), stream);
`,
  );

  const settings = parseConfig({
    server: { port: 0 },
    workspace: { root: workspaceRoot },
    agents: {
      codex: {
        bridge_command: `${process.execPath} ${fakeBridge}`,
        turn_timeout_ms: 50,
        stall_timeout_ms: 0,
      },
    },
    agent: { max_turns: 1 },
  });
  const workflow = {
    path: path.join(root, "WORKFLOW.md"),
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };
  await assert.rejects(
    () =>
      runAgentAttempt({
        issue: sampleIssue,
        workflow,
        adapters: executorAdapters,
      }),
    /timed out/,
  );
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
  *'printf "%s\\n" "$HOME"'*)
    printf '%s\\n' ${shellEscape(canonicalRemoteHome)}
    exit 0
    ;;
  *'/dev/tcp/127.0.0.1/'*) exit 0 ;;
esac
export HOME=${shellEscape(canonicalRemoteHome)}
eval "$last_arg"
`,
  );
  await fs.writeFile(trace, "");
  return { canonicalRemoteHome, binDir: bin };
}
