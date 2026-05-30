import os from "node:os";

import { AcpExecutor } from "@symphony/acp";
import {
  runAgentAttempt as runAgentAttemptCore,
  type RunAgentAttemptAdapters,
  type RunAgentAttemptInput,
  type RunResult,
} from "@symphony/agent-runner";
import { defaultSettings, type DefaultSettingsOptions } from "@symphony/config";
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
import { LocalTrackerClient } from "@symphony/local-tracker";
import { MemoryTrackerClient, memoryIssuesFromEnv } from "@symphony/memory-tracker";
import { SlackTrackerClient, SlackWebTransport } from "@symphony/slack-tracker";

export function runtimeDefaultSettings(): Settings {
  return defaultSettings(runtimeDefaultSettingsOptions());
}

export function runtimeDefaultSettingsOptions(): DefaultSettingsOptions {
  return { tmpdir: os.tmpdir(), cwd: process.cwd() };
}

function assertNever(value: never): never {
  throw new Error(`unhandled tracker kind: ${String(value)}`);
}

export function createTrackerClient(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeTrackerClient {
  const kind = settings.tracker.kind;
  if (kind === undefined) throw new Error("tracker.kind is required");
  switch (kind) {
    case "memory":
      return new MemoryTrackerClient(memoryIssuesFromEnv(env));
    case "linear":
      return new LinearClient(settings);
    case "local":
      return new LocalTrackerClient(settings);
    case "slack":
      return new SlackTrackerClient(settings, new SlackWebTransport(settings));
    default:
      return assertNever(kind);
  }
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
