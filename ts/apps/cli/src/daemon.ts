import os from "node:os";

import { AcpExecutor } from "@symphony/acp";
import {
  runAgentAttempt as runAgentAttemptCore,
  type RunAgentAttemptAdapters,
  type RunAgentAttemptInput,
  type RunResult,
} from "@symphony/agent-runner";
import type { DefaultSettingsOptions } from "@symphony/config";
import { CodexAppServerExecutor } from "@symphony/codex";
import type { RuntimeTrackerClient, Settings } from "@symphony/domain";
import { createWorkspaceForIssue, removeIssueWorkspaces, runHook } from "@symphony/workspace";
import { appendLogEvent } from "@symphony/log-file";
import {
  deleteResumeState,
  readResumeState,
  resumeStateMatches,
  writeResumeState,
} from "@symphony/resume-state";
import { LinearClient } from "@symphony/linear-tracker";
import { MemoryTrackerClient, memoryIssuesFromEnv } from "@symphony/memory-tracker";

export function runtimeDefaultSettingsOptions(): DefaultSettingsOptions {
  return { tmpdir: os.tmpdir(), cwd: process.cwd() };
}

export function createTrackerClient(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeTrackerClient {
  if (settings.tracker.kind === "memory") return new MemoryTrackerClient(memoryIssuesFromEnv(env));
  if (settings.tracker.kind === "linear") return new LinearClient(settings);
  throw new Error("tracker.kind is required");
}

export function createRunAgentAttemptAdapters(): RunAgentAttemptAdapters {
  return {
    createWorkspaceForIssue,
    runHook,
    readResumeState,
    resumeStateMatches,
    writeResumeState,
    executorFactory: (settings) => {
      const agent = settings.agents[settings.agent.kind];
      if (!agent) throw new Error(`agents.${settings.agent.kind} is required`);
      if (agent.executor === "appserver") return new CodexAppServerExecutor();
      if (agent.executor === "acp") return new AcpExecutor(settings.agent.kind);
      throw new Error(`unsupported agents.${settings.agent.kind}.executor`);
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
