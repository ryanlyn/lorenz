import { homedir } from "node:os";

import type { AgentConfig, ClaudeSettings, CodexSettings, Settings } from "@symphony/domain";

import { joinPath } from "./leaf-utils.js";

export interface DefaultSettingsOptions {
  tmpdir?: string | undefined;
}

export const defaultSettings = (options: DefaultSettingsOptions = {}): Settings => {
  const tmpdir = options.tmpdir ?? "/tmp";
  const workspaceRoot = joinPath(tmpdir, "symphony_workspaces");
  const codex: CodexSettings = {
    command: "codex-acp",
    turnTimeoutMs: 3_600_000,
    stallTimeoutMs: 300_000,
  };
  const claude: ClaudeSettings = {
    command: "claude-agent-acp",
    turnTimeoutMs: 3_600_000,
    stallTimeoutMs: 300_000,
    strictMcpConfig: true,
    providerConfig: {
      permissions: { defaultMode: "dontAsk" },
    },
  };
  return {
    tracker: {
      kind: undefined,
      endpoint: "https://api.linear.app/graphql",
      path: ".symphony/local",
      idPrefix: "BOARD-",
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
      dispatch: {
        acceptUnrouted: true,
        onlyRoutes: null,
        routeLabelPrefix: "Symphony:",
      },
    },
    polling: { intervalMs: 30_000 },
    workspace: {
      root: workspaceRoot,
      rootExpression: workspaceRoot,
      isolation: "per-agent",
    },
    worker: { sshHosts: [], sshTimeoutMs: 60_000 },
    hooks: { timeoutMs: 60_000 },
    agent: {
      kind: "codex",
      maxConcurrentAgents: 10,
      maxTurns: 20,
      maxRetryBackoffMs: 300_000,
      ensembleSize: 1,
    },
    agents: defaultAgentRecords(codex, claude),
    codex,
    claude,
    observability: {
      dashboardEnabled: true,
      refreshMs: 1_000,
      renderIntervalMs: 16,
    },
    server: { host: "127.0.0.1", port: 4040, traceDir: joinPath(homedir(), ".symphony/issues") },
    logging: { logFile: joinPath(homedir(), ".symphony/log/symphony.log") },
    statusOverrides: new Map(),
  };
};

export function defaultAgentRecords(
  codex: Pick<CodexSettings, "command" | "turnTimeoutMs" | "stallTimeoutMs">,
  claude: ClaudeSettings,
): Record<string, AgentConfig> {
  return {
    codex: {
      executor: "acp",
      bridgeCommand: codex.command,
      usageAccounting: "per-turn",
      turnTimeoutMs: codex.turnTimeoutMs,
      stallTimeoutMs: codex.stallTimeoutMs,
    },
    claude: {
      executor: "acp",
      bridgeCommand: claude.command,
      usageAccounting: "per-turn",
      providerConfig: claude.providerConfig,
      turnTimeoutMs: claude.turnTimeoutMs,
      stallTimeoutMs: claude.stallTimeoutMs,
      strictMcpConfig: claude.strictMcpConfig,
    },
  };
}
