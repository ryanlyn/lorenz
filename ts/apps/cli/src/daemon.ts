import os from "node:os";

import { acpExecutorProvider } from "@symphony/acp";
import { defaultAgentExecutorRegistry, type AgentExecutorRegistry } from "@symphony/agent-sdk";
import {
  runAgentAttempt as runAgentAttemptCore,
  type RunAgentAttemptAdapters,
  type RunAgentAttemptInput,
  type RunResult,
} from "@symphony/agent-runner";
import type { DefaultSettingsOptions } from "@symphony/config";
import type { RuntimeTrackerClient, Settings } from "@symphony/domain";
import { registerJiraTrackers } from "@symphony/jira-tracker";
import { registerLinearTracker } from "@symphony/linear-tracker";
import { registerLocalTracker } from "@symphony/local-tracker";
import { registerMemoryTracker } from "@symphony/memory-tracker";
import { registerSlackTracker } from "@symphony/slack-tracker";
import {
  createWorkspaceForIssue,
  listIssueWorkspaceIdentifiers,
  removeIssueWorkspaces,
  runHook,
  type WorkspaceSkillOverlay,
} from "@symphony/workspace";
import { mountedSkillSources } from "@symphony/mcp";
import { appendLogEvent } from "@symphony/log-file";
import {
  deleteResumeState,
  readResumeState,
  resumeStateMatches,
  writeResumeState,
} from "@symphony/resume-state";
import { defaultToolRegistry, type ToolRegistry } from "@symphony/tool-sdk";
import {
  createTrackerToolProvider,
  defaultTrackerRegistry,
  type TrackerRegistry,
} from "@symphony/tracker-sdk";

export interface BackendRegistries {
  trackers?: TrackerRegistry | undefined;
  tools?: ToolRegistry | undefined;
  executors?: AgentExecutorRegistry | undefined;
}

/**
 * Composition root: the CLI decides which extensions and agent executors this binary
 * supports. Each extension registers itself; the CLI only lists them here. Everything
 * downstream (config parsing, dispatch validation, MCP tools, executor selection)
 * resolves through the registries. Called from every CLI entrypoint before config is
 * parsed; idempotent so entrypoints and tests can call it freely.
 */
export function registerBuiltinBackends(registries: BackendRegistries = {}): void {
  const trackers = registries.trackers ?? defaultTrackerRegistry;
  const tools = registries.tools ?? defaultToolRegistry;
  const executors = registries.executors ?? defaultAgentExecutorRegistry;

  registerLinearTracker({ trackers, tools });
  registerLocalTracker({ trackers, tools });
  registerMemoryTracker({ trackers });
  registerJiraTrackers({ trackers });
  registerSlackTracker({ trackers, tools });
  if (tools.get("tracker") === undefined) {
    tools.register(createTrackerToolProvider(trackers));
  }
  if (executors.get(acpExecutorProvider.executor) === undefined) {
    executors.register(acpExecutorProvider);
  }
}

export function runtimeDefaultSettingsOptions(): DefaultSettingsOptions {
  return { tmpdir: os.tmpdir() };
}

export function createTrackerClient(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeTrackerClient {
  return defaultTrackerRegistry.require(settings.tracker.kind).createClient(settings, { env });
}

/**
 * Skill overlay for a prepared workspace: the configured `agent.skills` unioned with the skills
 * bundled by the mounted tool packs, copied into the destination the active executor reads from
 * (`.codex/skills` for Codex, `.claude/skills` for Claude). Returns undefined when nothing is
 * configured so workspace preparation skips the overlay entirely.
 */
function resolveSkillOverlay(settings: Settings): WorkspaceSkillOverlay | undefined {
  const sources = [
    ...new Set([
      ...settings.agent.skills,
      ...mountedSkillSources(settings, defaultToolRegistry, defaultTrackerRegistry),
    ]),
  ];
  if (sources.length === 0) return undefined;
  return { sources, destDir: resolveSkillsDestination(settings) };
}

function resolveSkillsDestination(settings: Settings): string {
  const kind = settings.agent.kind;
  const agent = settings.agents[kind];
  if (!agent) return ".codex/skills";
  return (
    defaultAgentExecutorRegistry.get(agent.executor)?.skillsDir?.(kind, agent) ?? ".codex/skills"
  );
}

function createRunAgentAttemptAdapters(): RunAgentAttemptAdapters {
  return {
    createWorkspaceForIssue: async (settings, issue, options) =>
      createWorkspaceForIssue(settings, issue, {
        ...options,
        skillOverlay: resolveSkillOverlay(settings),
      }),
    runHook,
    readResumeState,
    resumeStateMatches,
    writeResumeState,
    executorFactory: async (settings) => {
      const kind = settings.agent.kind;
      const agent = settings.agents[kind];
      if (!agent) throw new Error(`agents.${kind} is required`);
      return defaultAgentExecutorRegistry.require(agent.executor).createExecutor(kind, settings);
    },
  };
}

export async function runAgentAttempt(input: RunAgentAttemptInput): Promise<RunResult> {
  return runAgentAttemptCore({
    ...input,
    adapters: { ...createRunAgentAttemptAdapters(), ...input.adapters },
  });
}

export const runtimeAdapters = {
  removeIssueWorkspaces,
  listIssueWorkspaces: listIssueWorkspaceIdentifiers,
  deleteResumeState,
  appendLogEvent,
};
