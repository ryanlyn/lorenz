import { homedir } from "node:os";

import type { AgentConfig, Settings } from "@symphony/domain";

import { joinPath } from "./leaf-utils.js";

export interface DefaultSettingsOptions {
  tmpdir?: string | undefined;
}

/** Model id Claude sessions are pinned to unless overridden via `claude.model` or a provider config. */
const DEFAULT_CLAUDE_MODEL = "claude-opus-4-6[1m]";

export const defaultSettings = (options: DefaultSettingsOptions = {}): Settings => {
  const tmpdir = options.tmpdir ?? "/tmp";
  const workspaceRoot = joinPath(tmpdir, "symphony_workspaces");
  return {
    tracker: {
      kind: undefined,
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
      dispatch: {
        acceptUnrouted: true,
        onlyRoutes: null,
        routeLabelPrefix: "Symphony:",
      },
      options: {},
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
    agents: defaultAgentRecords(),
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

export function defaultAgentRecords(): Record<string, AgentConfig> {
  return {
    codex: {
      executor: "acp",
      bridgeCommand: "codex-acp",
      usageAccounting: "per-turn",
      turnTimeoutMs: 3_600_000,
      stallTimeoutMs: 300_000,
    },
    claude: {
      executor: "acp",
      bridgeCommand: "claude-agent-acp",
      usageAccounting: "per-turn",
      providerConfig: {
        model: DEFAULT_CLAUDE_MODEL,
        permissions: { defaultMode: "dontAsk" },
      },
      turnTimeoutMs: 3_600_000,
      stallTimeoutMs: 300_000,
      strictMcpConfig: true,
    },
  };
}
