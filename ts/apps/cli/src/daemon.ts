import os from "node:os";

import { acpExecutorProvider } from "@symphony/acp";
import { defaultAgentExecutorRegistry } from "@symphony/agent-sdk";
import {
  runAgentAttempt as runAgentAttemptCore,
  type RunAgentAttemptAdapters,
  type RunAgentAttemptInput,
  type RunResult,
} from "@symphony/agent-runner";
import type { DefaultSettingsOptions } from "@symphony/config";
import type { RuntimeTrackerClient, Settings } from "@symphony/domain";
import { createWorkspaceForIssue, removeIssueWorkspaces, runHook } from "@symphony/workspace";
import { appendLogEvent } from "@symphony/log-file";
import {
  deleteResumeState,
  readResumeState,
  resumeStateMatches,
  writeResumeState,
} from "@symphony/resume-state";
import { defaultTrackerRegistry } from "@symphony/tracker-sdk";
import { registerBuiltinTrackerProviders } from "@symphony/trackers";

// Composition root: the CLI decides which tracker backends and agent executors this
// binary supports. Everything downstream (config parsing, dispatch validation, MCP tools,
// executor selection) resolves them through the registries.
registerBuiltinTrackerProviders();
defaultAgentExecutorRegistry.register(acpExecutorProvider);

export function runtimeDefaultSettingsOptions(): DefaultSettingsOptions {
  return { tmpdir: os.tmpdir() };
}

export function createTrackerClient(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeTrackerClient {
  return defaultTrackerRegistry.require(settings.tracker.kind).createClient(settings, { env });
}

function createRunAgentAttemptAdapters(): RunAgentAttemptAdapters {
  return {
    createWorkspaceForIssue,
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
  deleteResumeState,
  appendLogEvent,
};
