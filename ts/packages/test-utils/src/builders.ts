import { defaultSettings, parseConfig } from "@lorenz/config";
import { normalizeIssue } from "@lorenz/issue";
import type { Issue, Settings } from "@lorenz/domain";

/** Quickly create an Issue object with sensible defaults. */
export function makeIssue(
  id: string,
  identifier: string,
  overrides: Record<string, unknown> = {},
): Issue {
  return normalizeIssue({
    id,
    identifier,
    title: overrides.title ?? `Issue ${identifier}`,
    state: overrides.state ?? "Todo",
    stateType: overrides.stateType ?? "unstarted",
    labels: overrides.labels ?? [],
    blockers: overrides.blockers ?? [],
    priority: overrides.priority ?? 2,
    description: overrides.description ?? null,
    ...overrides,
  });
}

/** Create a Settings object with sensible testing defaults. */
export function makeSettings(overrides: Record<string, unknown> = {}): Settings {
  return parseConfig(
    {
      tracker: {
        kind: "memory",
        endpoint: "memory://test",
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Done", "Cancelled"],
        dispatch: {
          acceptUnrouted: true,
          onlyRoutes: null,
          routeLabelPrefix: "Lorenz:",
        },
      },
      polling: { intervalMs: 100 },
      workspace: { root: "/tmp/sandbox_workspaces" },
      agent: {
        kind: "codex",
        maxConcurrentAgents: 5,
        maxTurns: 10,
        maxRetryBackoffMs: 1000,
        ensembleSize: 1,
      },
      codex: {
        command: "echo codex",
        turnTimeoutMs: 60_000,
        stallTimeoutMs: 30_000,
      },
      claude: {
        command: "echo claude",
        turnTimeoutMs: 60_000,
        stallTimeoutMs: 30_000,
        strictMcpConfig: true,
        providerConfig: { permissions: { defaultMode: "dontAsk" } },
      },
      ...overrides,
    },
    {},
    { tmpdir: "/tmp" },
  );
}

/** Create a fully-populated Issue literal without tracker normalization. */
export function issueWith(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "TEST-1",
    title: "Test issue",
    state: "Todo",
    stateType: "unstarted",
    description: null,
    branchName: null,
    url: null,
    priority: 1,
    createdAt: null,
    updatedAt: null,
    labels: [],
    blockers: [],
    assigneeId: null,
    assignedToWorker: true,
    ...overrides,
  };
}

/** Create Settings from `defaultSettings()` with common dispatch/agent knobs applied. */
export function settingsWith(
  overrides: {
    acceptUnrouted?: boolean;
    onlyRoutes?: string[] | null;
    routeLabelPrefix?: string;
    activeStates?: string[];
    terminalStates?: string[];
    maxConcurrentAgents?: number;
    ensembleSize?: number;
  } = {},
): Settings {
  const settings = defaultSettings();
  settings.tracker.dispatch.acceptUnrouted = overrides.acceptUnrouted ?? true;
  settings.tracker.dispatch.onlyRoutes = overrides.onlyRoutes ?? null;
  settings.tracker.dispatch.routeLabelPrefix = overrides.routeLabelPrefix ?? "Lorenz:";
  if (overrides.activeStates) settings.tracker.activeStates = overrides.activeStates;
  if (overrides.terminalStates) settings.tracker.terminalStates = overrides.terminalStates;
  if (overrides.maxConcurrentAgents !== undefined)
    settings.agent.maxConcurrentAgents = overrides.maxConcurrentAgents;
  if (overrides.ensembleSize !== undefined) settings.agent.ensembleSize = overrides.ensembleSize;
  return settings;
}
