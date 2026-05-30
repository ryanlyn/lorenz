import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { test, vi } from "vitest";
import {
  CodexAppServerExecutor,
  createWorkspaceForIssue,
  parseConfig,
  readResumeState,
  runAgentAttempt,
  runSsh,
  shellEscape,
} from "@symphony/cli";
import type { Issue, WorkflowDefinition } from "@symphony/cli";

import { assert } from "./assert.js";
import { sampleIssue, tempDir } from "./helpers.js";

const execFileAsync = promisify(execFile);
const runLiveSsh = process.env.SYMPHONY_TS_RUN_LIVE_SSH_E2E === "1";
const requireRemoteClaude = process.env.SYMPHONY_TS_REQUIRE_REMOTE_CLAUDE === "1";
const remoteClaudeAcpBridge = process.env.SYMPHONY_TS_CLAUDE_ACP_BRIDGE_COMMAND;

test(
  "live SSH worker runs remote Codex and remote Claude MCP resume",
  { timeout: 900_000, skip: !runLiveSsh },
  async (t) => {
    const setup = await setupLiveWorkers();
    if (setup.status === "skip") {
      t.skip(setup.reason);
      return;
    }

    try {
      await runRemoteCodexCanary(setup);
      if (!setup.claudeTokenAvailable) {
        if (requireRemoteClaude)
          throw new Error("remote Claude canary requires CLAUDE_CODE_OAUTH_TOKEN");
        console.warn("remote Claude canary skipped because no Claude OAuth token was supplied");
        return;
      }
      if (!remoteClaudeAcpBridge) {
        if (requireRemoteClaude)
          throw new Error("remote Claude canary requires SYMPHONY_TS_CLAUDE_ACP_BRIDGE_COMMAND");
        console.warn("remote Claude canary skipped because no Claude ACP bridge was supplied");
        return;
      }
      await runRemoteClaudeResumeCanary(setup);
    } finally {
      await setup.cleanup();
    }
  },
);

interface LiveWorkerSetup {
  status: "ok";
  hosts: string[];
  workspaceRoot: string;
  runId: string;
  claudeTokenAvailable: boolean;
  cleanup(): Promise<void>;
}

type LiveWorkerSetupResult = LiveWorkerSetup | { status: "skip"; reason: string };

async function setupLiveWorkers(): Promise<LiveWorkerSetupResult> {
  const configuredHosts = (process.env.SYMPHONY_LIVE_SSH_WORKER_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  const runId = `symphony-ts-live-ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (configuredHosts.length > 0) {
    const workspaceRoot = `~/.${runId}/workspaces`;
    return {
      status: "ok",
      hosts: configuredHosts,
      workspaceRoot,
      runId,
      claudeTokenAvailable: true,
      cleanup: async () => {
        await cleanupRemoteRoot(configuredHosts, `~/.${runId}`);
      },
    };
  }

  const nativeSshd = await setupNativeSshdWorker(runId).catch(() => null);
  if (nativeSshd) return nativeSshd;

  if (!(await commandExists("docker")))
    return {
      status: "skip",
      reason: "docker is required when SYMPHONY_LIVE_SSH_WORKER_HOSTS is unset",
    };
  if (!(await commandExists("ssh-keygen")))
    return { status: "skip", reason: "ssh-keygen is required for docker SSH workers" };

  const authJsonPath =
    process.env.SYMPHONY_LIVE_DOCKER_CODEX_AUTH_JSON ??
    path.join(os.homedir(), ".codex", "auth.json");
  if (!(await fileExists(authJsonPath)))
    return { status: "skip", reason: `missing Codex auth json at ${authJsonPath}` };

  const root = await tempDir("symphony-ts-live-docker-ssh");
  const sshRoot = path.join(root, "ssh");
  const keyPath = path.join(sshRoot, "id_ed25519");
  const configPath = path.join(sshRoot, "config");
  const ports = [await reserveTcpPort(), await reserveTcpPort()];
  const hosts = ports.map((port) => `localhost:${port}`);
  const dockerSupportDir = path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "elixir",
    "test",
    "support",
    "live_e2e_docker",
  );
  const projectName = dockerProjectName(runId);
  const claudeToken =
    process.env.SYMPHONY_LIVE_DOCKER_CLAUDE_CODE_OAUTH_TOKEN ??
    process.env.CLAUDE_CODE_OAUTH_TOKEN ??
    "";
  const composeEnv = {
    ...process.env,
    SYMPHONY_LIVE_DOCKER_CODEX_AUTH_JSON: authJsonPath,
    SYMPHONY_LIVE_DOCKER_AUTHORIZED_KEY: `${keyPath}.pub`,
    SYMPHONY_LIVE_DOCKER_WORKER_1_PORT: String(ports[0]),
    SYMPHONY_LIVE_DOCKER_WORKER_2_PORT: String(ports[1]),
    SYMPHONY_LIVE_DOCKER_CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
  };

  await fs.mkdir(sshRoot, { recursive: true });
  await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
  await fs.writeFile(
    configPath,
    [
      "Host localhost 127.0.0.1",
      "  User root",
      `  IdentityFile ${keyPath}`,
      "  IdentitiesOnly yes",
      "  StrictHostKeyChecking no",
      "  UserKnownHostsFile /dev/null",
      "  LogLevel ERROR",
      "",
    ].join("\n"),
  );
  vi.stubEnv("SYMPHONY_SSH_CONFIG", configPath);

  const cleanup = async () => {
    vi.unstubAllEnvs();
    await cleanupRemoteRoot(hosts, `~/.${runId}`);
    await execFileAsync(
      "docker",
      ["compose", "-f", "docker-compose.yml", "-p", projectName, "down", "-v", "--remove-orphans"],
      {
        cwd: dockerSupportDir,
        env: composeEnv,
      },
    ).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  };

  try {
    await execFileAsync(
      "docker",
      ["compose", "-f", "docker-compose.yml", "-p", projectName, "up", "-d", "--build"],
      {
        cwd: dockerSupportDir,
        env: composeEnv,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    await waitForSshHosts(hosts);
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    status: "ok",
    hosts,
    workspaceRoot: `~/.${runId}/workspaces`,
    runId,
    claudeTokenAvailable: claudeToken !== "",
    cleanup,
  };
}

async function setupNativeSshdWorker(runId: string): Promise<LiveWorkerSetup> {
  if (!(await fileExists("/usr/sbin/sshd"))) throw new Error("local sshd is unavailable");
  if (!(await commandExists("ssh-keygen"))) throw new Error("ssh-keygen is unavailable");

  const root = await tempDir("symphony-ts-live-native-sshd");
  const keyPath = path.join(root, "id_ed25519");
  const hostKeyPath = path.join(root, "ssh_host_ed25519_key");
  const configPath = path.join(root, "sshd_config");
  const clientConfigPath = path.join(root, "ssh_config");
  const authorizedKeysPath = path.join(root, "authorized_keys");
  const logPath = path.join(root, "sshd.log");
  const pidPath = path.join(root, "sshd.pid");
  const port = await reserveTcpPort();
  const host = `localhost:${port}`;
  const user = os.userInfo().username;

  await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
  await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKeyPath]);
  await fs.copyFile(`${keyPath}.pub`, authorizedKeysPath);
  await fs.chmod(root, 0o700);
  await fs.chmod(keyPath, 0o600);
  await fs.chmod(authorizedKeysPath, 0o600);
  await fs.writeFile(
    configPath,
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${hostKeyPath}`,
      `AuthorizedKeysFile ${authorizedKeysPath}`,
      `PidFile ${pidPath}`,
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "ChallengeResponseAuthentication no",
      "PubkeyAuthentication yes",
      "StrictModes no",
      "UsePAM no",
      "PermitRootLogin no",
      "AcceptEnv CLAUDE_CODE_OAUTH_TOKEN",
      `AllowUsers ${user}`,
      "LogLevel ERROR",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    clientConfigPath,
    [
      "Host localhost 127.0.0.1",
      `  User ${user}`,
      `  IdentityFile ${keyPath}`,
      "  IdentitiesOnly yes",
      "  StrictHostKeyChecking no",
      "  UserKnownHostsFile /dev/null",
      "  LogLevel ERROR",
      "  SendEnv CLAUDE_CODE_OAUTH_TOKEN",
      "",
    ].join("\n"),
  );

  await execFileAsync("/usr/sbin/sshd", ["-t", "-f", configPath]);
  await execFileAsync("/usr/sbin/sshd", ["-f", configPath, "-E", logPath]);
  vi.stubEnv("SYMPHONY_SSH_CONFIG", clientConfigPath);

  const cleanup = async () => {
    vi.unstubAllEnvs();
    await cleanupRemoteRoot([host], `~/.${runId}`);
    const pid = await fs.readFile(pidPath, "utf8").catch(() => "");
    if (pid.trim()) {
      try {
        process.kill(Number(pid.trim()), "SIGTERM");
      } catch {
        // best effort
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  };

  try {
    await waitForSshHosts([host]);
  } catch (error) {
    await cleanup();
    const log = await fs.readFile(logPath, "utf8").catch(() => "");
    throw new Error(
      `native_sshd_unavailable: ${error instanceof Error ? error.message : String(error)} ${log}`,
      { cause: error },
    );
  }

  return {
    status: "ok",
    hosts: [host],
    workspaceRoot: `~/.${runId}/workspaces`,
    runId,
    claudeTokenAvailable:
      process.env.CLAUDE_CODE_OAUTH_TOKEN !== undefined &&
      process.env.CLAUDE_CODE_OAUTH_TOKEN !== "",
    cleanup,
  };
}

async function runRemoteCodexCanary(setup: LiveWorkerSetup): Promise<void> {
  const host = setup.hosts[0];
  assert.ok(host);
  const marker = `TS_REMOTE_CODEX_${Date.now()}`;
  const issue: Issue = {
    ...sampleIssue,
    id: "issue-remote-codex",
    identifier: "TS-REMOTE-CODEX",
    title: "Remote Codex SSH canary",
    state: "Todo",
    stateType: "unstarted",
  };
  const settings = parseConfig({
    workspace: { root: setup.workspaceRoot },
    worker: { ssh_hosts: setup.hosts, ssh_timeout_ms: 60_000 },
    hooks: { after_create: initRepoHook(), timeout_ms: 60_000 },
    codex: {
      command: process.env.SYMPHONY_TS_CODEX_COMMAND ?? "codex app-server",
      approval_policy: "never",
      turn_timeout_ms: 300_000,
      stall_timeout_ms: 300_000,
    },
  });
  const workspace = await createWorkspaceForIssue(settings, issue, { workerHost: host });
  const executor = new CodexAppServerExecutor();
  const session = await executor.startSession({ workspace, workerHost: host, settings, issue });
  try {
    const updates = await executor.runTurn(
      session,
      [
        "This is a live TypeScript Symphony remote SSH Codex canary.",
        `Create a file named REMOTE_CODEX_E2E.txt whose only contents are ${marker} followed by a newline.`,
        "Do not create any other files.",
      ].join("\n"),
      issue,
    );
    assert.ok(updates.some((update) => update.type === "turn_completed"));
  } finally {
    await session.stop();
  }

  const result = await runSsh(
    host,
    `cat ${shellEscape(path.posix.join(workspace, "REMOTE_CODEX_E2E.txt"))}`,
    {
      timeoutMs: settings.worker.sshTimeoutMs,
      stderrToStdout: true,
    },
  );
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, `${marker}\n`);
}

async function runRemoteClaudeResumeCanary(setup: LiveWorkerSetup): Promise<void> {
  const host = setup.hosts[0];
  assert.ok(host);
  assert.ok(process.env.LINEAR_API_KEY, "LINEAR_API_KEY is required for remote Claude MCP canary");
  const issue: Issue = {
    ...sampleIssue,
    id: "issue-remote-claude",
    identifier: "TS-REMOTE-CLAUDE",
    title: "Remote Claude SSH canary",
    state: "In Progress",
    stateType: "started",
    url: "https://example.org/issues/TS-REMOTE-CLAUDE",
  };
  const settings = parseConfig({
    tracker: {
      api_key: "$LINEAR_API_KEY",
      project_slug: "symphony-414bf2e49ff2",
    },
    workspace: { root: setup.workspaceRoot },
    worker: { ssh_hosts: setup.hosts, ssh_timeout_ms: 60_000 },
    hooks: { after_create: initRepoHook(), timeout_ms: 60_000 },
    agent: { kind: "claude", max_turns: 1 },
    agents: {
      claude: {
        executor: "acp",
        bridge_command: remoteClaudeAcpBridge ?? "claude-agent-acp",
        bridge_args: remoteClaudeAcpBridgeArgs(),
        turn_timeout_ms: 300_000,
        stall_timeout_ms: 300_000,
      },
    },
  });

  const first = await runAgentAttempt({
    issue,
    workflow: workflow(settings, firstClaudePrompt()),
    workerHost: host,
  });
  assert.equal(first.turnCount, 1);
  assert.ok(first.resumeId);
  const firstContents = await readRemoteFile(
    host,
    path.posix.join(first.workspace, "REMOTE_CLAUDE_ONE.txt"),
  );
  assert.equal(firstContents, "TS_REMOTE_CLAUDE_ONE\n");
  const firstResume = await readResumeState(first.workspace, host);
  assert.equal(firstResume.status, "ok");

  const second = await runAgentAttempt({
    issue,
    workflow: workflow(settings, secondClaudePrompt()),
    workerHost: host,
  });
  assert.equal(second.turnCount, 1);
  assert.equal(second.resumeId, first.resumeId);
  const secondContents = await readRemoteFile(
    host,
    path.posix.join(second.workspace, "REMOTE_CLAUDE_TWO.txt"),
  );
  assert.equal(secondContents, "TS_REMOTE_CLAUDE_TWO\n");
}

function workflow(
  settings: ReturnType<typeof parseConfig>,
  promptTemplate: string,
): WorkflowDefinition {
  return {
    path: path.join(os.tmpdir(), "WORKFLOW.md"),
    config: {},
    promptTemplate,
    settings,
  };
}

function firstClaudePrompt(): string {
  return [
    "This is a live TypeScript Symphony remote Claude MCP canary.",
    "Use the mcp__symphony_linear__linear_graphql tool once with this exact query:",
    "query SymphonyTsRemoteClaudeCanary { viewer { id } }",
    "Then create a file named REMOTE_CLAUDE_ONE.txt whose only contents are TS_REMOTE_CLAUDE_ONE followed by a newline.",
    "Do not create any other files.",
  ].join("\n");
}

function secondClaudePrompt(): string {
  return [
    "Use the mcp__symphony_linear__linear_graphql tool once with this exact query:",
    "query SymphonyTsRemoteClaudeResumeCanary { viewer { id } }",
    "Then create a file named REMOTE_CLAUDE_TWO.txt whose only contents are TS_REMOTE_CLAUDE_TWO followed by a newline.",
    "Do not create any other files.",
  ].join("\n");
}

function initRepoHook(): string {
  return [
    "git init -q -b main || git init -q",
    "git config user.name 'Symphony Test User'",
    "git config user.email 'symphony-test@example.com'",
    "printf '# remote e2e\\n' > README.md",
    "git add README.md",
    "git commit -m init >/dev/null 2>&1 || true",
  ].join("\n");
}

async function readRemoteFile(host: string, remotePath: string): Promise<string> {
  const result = await runSsh(host, `cat ${shellEscape(remotePath)}`, {
    timeoutMs: 60_000,
    stderrToStdout: true,
  });
  assert.equal(result.status, 0, result.stdout);
  return result.stdout;
}

async function waitForSshHosts(hosts: string[]): Promise<void> {
  for (const host of hosts) {
    await vi.waitFor(
      async () => {
        const result = await runSsh(host, "printf ready", {
          timeoutMs: 5_000,
          stderrToStdout: true,
        }).catch(() => null);
        if (result?.status !== 0 || result.stdout !== "ready")
          throw new Error(`SSH worker ${host} not ready`);
      },
      { timeout: 60_000, interval: 1_000 },
    );
  }
}

async function cleanupRemoteRoot(hosts: string[], remoteRoot: string): Promise<void> {
  await Promise.all(
    hosts.map((host) =>
      runSsh(host, `rm -rf ${shellEscape(remoteRoot)}`, {
        timeoutMs: 30_000,
        stderrToStdout: true,
      }).catch(() => undefined),
    ),
  );
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("sh", ["-lc", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function reserveTcpPort(retries = 3): Promise<number> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const p = typeof address === "object" && address !== null ? address.port : null;
        server.close((error) => {
          if (error) reject(error);
          else if (p === null) reject(new Error("failed to reserve tcp port"));
          else resolve(p);
        });
      });
      server.on("error", reject);
    });
    // Verify the port is still available to reduce TOCTOU race window
    const available = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => {
        probe.close(() => resolve(true));
      });
    });
    if (available) return port;
    if (attempt < retries - 1) {
      // Small delay before retrying to let ephemeral port churn settle
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error("failed to reserve an available tcp port after retries");
}

function dockerProjectName(runId: string): string {
  return runId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

function remoteClaudeAcpBridgeArgs(): string[] {
  const raw = process.env.SYMPHONY_TS_CLAUDE_ACP_BRIDGE_ARGS;
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("SYMPHONY_TS_CLAUDE_ACP_BRIDGE_ARGS must be a JSON string array");
  }
  return parsed;
}
