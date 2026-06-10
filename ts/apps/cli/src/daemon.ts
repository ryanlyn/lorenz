import os from "node:os";
import path from "node:path";

import { Executor } from "@symphony/acp";
import {
  runAgentAttempt as runAgentAttemptCore,
  type RunAgentAttemptAdapters,
  type RunAgentAttemptInput,
  type RunResult,
} from "@symphony/agent-runner";
import type { DefaultSettingsOptions } from "@symphony/config";
import type { RuntimeTrackerClient, Settings } from "@symphony/domain";
import { systemClock } from "@symphony/ports";
import { acquireAgentMcpEndpointForRun } from "@symphony/mcp";
import { createBoxPool, type BoxPool } from "@symphony/worker-box-pool";
import {
  createDispatchCoordinator,
  createPerRunEndpointManager,
  type DispatchCoordinator,
} from "@symphony/dispatch-coordinator";
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

export function runtimeDefaultSettingsOptions(): DefaultSettingsOptions {
  return { tmpdir: os.tmpdir() };
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
    case "linear": {
      const client = new LinearClient(settings);
      // Resolve project slugs (e.g. from project_labels) in the background; from origin/main.
      void client.resolveProjectSlugs();
      return client;
    }
    case "local":
      return new LocalTrackerClient(settings);
    default:
      return assertNever(kind);
  }
}

/**
 * Constructs the warm worker box pool when `worker.box_pool.enabled` is set, and
 * returns `undefined` otherwise so the disabled path stays byte-identical to the
 * pre-pool daemon. Built-in providers (`fake`, `static-ssh`, ...) self-register
 * on the `@symphony/worker-box-pool` barrel import; `createBoxPool` resolves the
 * configured `provider` against that registry and throws
 * `box_pool_provider_unavailable` for an unregistered enabled kind, so an
 * operator misconfiguration fails loud at startup rather than silently disabling
 * the pool. The write-ahead ledger (only consulted by cloud providers) lives
 * under `<workspace.root>/.symphony/box-pool/`.
 */
export function buildBoxPool(
  settings: Settings,
  _env: NodeJS.ProcessEnv = process.env,
): BoxPool | undefined {
  const boxPoolSettings = settings.worker.boxPool;
  if (!boxPoolSettings?.enabled) return undefined;
  return createBoxPool(boxPoolSettings, {
    clock: systemClock,
    logEvent: (event: Record<string, unknown>) =>
      void appendLogEvent(settings.logging.logFile, event),
    ledgerPath: path.join(settings.workspace.root, ".symphony", "box-pool", "ledger.json"),
  });
}

/**
 * Constructs the runtime-facing {@link DispatchCoordinator} when
 * `worker.box_pool.enabled` is set, wrapping the same {@link BoxPool} that
 * {@link buildBoxPool} builds and the injected {@link McpEndpointManager}. Returns
 * `undefined` when the pool is disabled so the disabled path stays byte-identical
 * to the pre-pool daemon.
 *
 * The CONCRETE per-run {@link McpEndpointManager} (`perRunEndpoint=true`) is wired
 * here: it OWNS the whole per-run MCP endpoint lease (auth token + refcounted local
 * mcp server + reverse tunnel) via the injected `acquireAgentMcpEndpointForRun`. The
 * daemon is the right ownership boundary because it already depends on
 * `@symphony/mcp`, keeping `@symphony/worker-box-pool` and
 * `@symphony/dispatch-coordinator` free of any mcp/tunnel runtime dependency
 * (invariant #8). At the default `slotsPerMachine=1` this opens exactly ONE endpoint
 * per run (just coordinator-owned), and the manager returns `null` for a
 * `null`/`pending://` worker host so the local path keeps using acp's own endpoint -
 * byte-identical to the single-tenant path. `buildBoxPool` stays for the box-pool
 * wiring / e2e tests and for any caller that still wants a bare pool.
 */
export function buildDispatchCoordinator(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): DispatchCoordinator | undefined {
  const boxPoolSettings = settings.worker.boxPool;
  if (!boxPoolSettings?.enabled) return undefined;
  const pool = buildBoxPool(settings, env);
  if (!pool) return undefined;
  return createDispatchCoordinator({
    pool,
    // The concrete manager OWNS each run's whole endpoint lease; it calls the
    // injected `acquireAgentMcpEndpointForRun` (signature-compatible) for an
    // ssh-addressable host and returns null for a null/`pending://` host so the
    // local path keeps using acp's own endpoint.
    mcpEndpointManager: createPerRunEndpointManager({
      acquireForRun: acquireAgentMcpEndpointForRun,
    }),
    // Same structured-event sink as the pool so coordinator faults (e.g.
    // box_pool_endpoint_release_failed) reach the log file instead of being
    // silently dropped by the no-op default.
    logEvent: (event: Record<string, unknown>) =>
      void appendLogEvent(settings.logging.logFile, event),
    settings: boxPoolSettings,
  });
}

function createRunAgentAttemptAdapters(): RunAgentAttemptAdapters {
  return {
    createWorkspaceForIssue,
    runHook,
    readResumeState,
    resumeStateMatches,
    writeResumeState,
    executorFactory: (settings) => {
      const agent = settings.agents[settings.agent.kind];
      if (!agent) throw new Error(`agents.${settings.agent.kind} is required`);
      return new Executor(settings.agent.kind);
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
