import os from "node:os";
import path from "node:path";

import { acpExecutorProvider } from "@lorenz/acp";
import { defaultAgentExecutorRegistry, type AgentExecutorRegistry } from "@lorenz/agent-sdk";
import {
  runAgentAttempt as runAgentAttemptCore,
  type RunAgentAttemptAdapters,
  type RunAgentAttemptInput,
  type RunResult,
} from "@lorenz/agent-runner";
import {
  defaultWorkerDriverRegistry,
  registerFakeWorkerDriver,
  type WorkerDriverRegistry,
} from "@lorenz/worker-sdk";
import type { DefaultSettingsOptions } from "@lorenz/config";
import { registerDockerWorkerDriver } from "@lorenz/docker-worker";
import { systemClock, type RuntimeTrackerClient, type Settings } from "@lorenz/domain";
import { registerJiraTrackers } from "@lorenz/jira-tracker";
import { registerLinearTracker } from "@lorenz/linear-tracker";
import { registerLocalTracker } from "@lorenz/local-tracker";
import { registerMemoryTracker } from "@lorenz/memory-tracker";
import { registerSlackTracker } from "@lorenz/slack-tracker";
import { registerStaticSshWorkerDriver } from "@lorenz/static-worker";
import { acquireAgentMcpEndpointForRun } from "@lorenz/mcp";
import { createWorkerPool, type WorkerPool } from "@lorenz/worker-pool";
import { workerHostPool } from "@lorenz/worker-host-pool";
import {
  createDispatchCoordinator,
  createPerRunEndpointManager,
  type DispatchCoordinator,
} from "@lorenz/dispatch-coordinator";
import {
  createWorkspaceForIssue,
  listIssueWorkspaceIdentifiers,
  removeIssueWorkspaces,
  runHook,
  type WorkspaceSkillOverlay,
} from "@lorenz/workspace";
import { mountedSkillSources } from "@lorenz/mcp";
import { appendLogEvent } from "@lorenz/log-file";
import { defaultToolRegistry, type ToolRegistry } from "@lorenz/tool-sdk";
import {
  createTrackerToolProvider,
  defaultTrackerRegistry,
  type TrackerRegistry,
} from "@lorenz/tracker-sdk";

import { ensureWorkerDriverLoaded } from "./workerDriverLoader.js";

export interface BackendRegistries {
  trackers?: TrackerRegistry | undefined;
  tools?: ToolRegistry | undefined;
  executors?: AgentExecutorRegistry | undefined;
  workerDrivers?: WorkerDriverRegistry | undefined;
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

  const workerDrivers = registries.workerDrivers ?? defaultWorkerDriverRegistry;
  registerFakeWorkerDriver({ workerDrivers });
  registerStaticSshWorkerDriver({ workerDrivers });
  registerDockerWorkerDriver({ workerDrivers });
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

/** Options for {@link buildWorkerPool} / {@link buildDispatchCoordinator}. */
export interface BuildWorkerPoolOptions {
  /**
   * Anchor for `./relative` driver module specifiers; the daemon passes
   * `dirname(workflow.path)` (the most predictable anchor for operators).
   * Defaults to `process.cwd()`.
   */
  baseDir?: string | undefined;
}

/**
 * Constructs the warm worker pool when `worker.worker_pool.enabled` is set, and
 * returns `undefined` otherwise so the disabled path stays byte-identical to the
 * pre-pool daemon. The pool resolves the configured `driver` against the
 * worker-driver registry populated by {@link registerBuiltinBackends}; a driver
 * string that is NOT a registered kind is treated as a module specifier and
 * dynamic-imported into the registry first (see {@link ensureWorkerDriverLoaded}),
 * so third-party drivers load at the same fail-loud startup point - an
 * unresolvable driver throws `worker_pool_driver_unavailable` before the pool, the
 * runtime, or any provision exists. The write-ahead ledger (only consulted by
 * cloud drivers) lives under `<workspace.root>/.lorenz/worker-pool/`.
 */
export async function buildWorkerPool(
  settings: Settings,
  _env: NodeJS.ProcessEnv = process.env,
  options: BuildWorkerPoolOptions = {},
): Promise<WorkerPool | undefined> {
  const workerPoolSettings = settings.worker.workerPool;
  if (!workerPoolSettings?.enabled) return undefined;
  const logEvent = (event: Record<string, unknown>): void =>
    void appendLogEvent(settings.logging.logFile, event);
  await ensureWorkerDriverLoaded(workerPoolSettings.driver, defaultWorkerDriverRegistry, {
    baseDir: options.baseDir ?? process.cwd(),
    logEvent,
  });
  return createWorkerPool(workerPoolSettings, {
    clock: systemClock,
    logEvent,
    ledgerPath: path.join(settings.workspace.root, ".lorenz", "worker-pool", "ledger.json"),
    drivers: defaultWorkerDriverRegistry,
  });
}

/**
 * Constructs the runtime-facing {@link DispatchCoordinator} when
 * `worker.worker_pool.enabled` is set, wrapping the same {@link WorkerPool} that
 * {@link buildWorkerPool} builds and the injected {@link McpEndpointManager}. Returns
 * `undefined` when the pool is disabled so the disabled path stays byte-identical
 * to the pre-pool daemon.
 *
 * The CONCRETE per-run {@link McpEndpointManager} (`perRunEndpoint=true`) is wired
 * here: it OWNS the whole per-run MCP endpoint lease (auth token + refcounted local
 * mcp server + reverse tunnel) via the injected `acquireAgentMcpEndpointForRun`. The
 * daemon is the right ownership boundary because it already depends on
 * `@lorenz/mcp`, keeping `@lorenz/worker-pool` and
 * `@lorenz/dispatch-coordinator` free of any mcp/tunnel runtime dependency
 * (invariant #8). At the default `slotsPerMachine=1` this opens exactly ONE endpoint
 * per run (just coordinator-owned), and the manager returns `null` for an empty
 * (local) worker host so the local path keeps using acp's own endpoint -
 * byte-identical to the single-tenant path. `buildWorkerPool` stays for the worker-pool
 * wiring / e2e tests and for any caller that still wants a bare pool.
 */
export async function buildDispatchCoordinator(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
  options: BuildWorkerPoolOptions = {},
): Promise<DispatchCoordinator | undefined> {
  const workerPoolSettings = settings.worker.workerPool;
  if (!workerPoolSettings?.enabled) return undefined;
  const pool = await buildWorkerPool(settings, env, options);
  if (!pool) return undefined;
  const baseDir = options.baseDir ?? process.cwd();
  const logEvent = (event: Record<string, unknown>): void =>
    void appendLogEvent(settings.logging.logFile, event);
  return createDispatchCoordinator({
    pool,
    // The concrete manager OWNS each run's whole endpoint lease; it calls the
    // injected `acquireAgentMcpEndpointForRun` (signature-compatible) for an
    // ssh-addressable host and returns null for an empty (local) host so the
    // local path keeps using acp's own endpoint.
    mcpEndpointManager: createPerRunEndpointManager({
      // The composition root binds the concrete tunnel transport (the shared
      // worker-host pool), keeping `@lorenz/mcp` free of any worker-host-pool
      // import (invariant #8) while the coordinator stays on the 3-arg acquirer.
      acquireForRun: async (runSettings, workerHost, runKey) =>
        acquireAgentMcpEndpointForRun(runSettings, workerHost, runKey, workerHostPool),
    }),
    // Same structured-event sink as the pool so coordinator faults (e.g.
    // worker_pool_endpoint_release_failed) reach the log file instead of being
    // silently dropped by the no-op default.
    logEvent,
    settings: workerPoolSettings,
    // Reload path for out-of-tree drivers: the coordinator awaits this loader
    // BEFORE pool.reconcile, so a reload that changes `driver` to a module
    // specifier hot-loads it while pool.reconcile/swapDriver stay synchronous
    // and transactional. A registered-but-unused module is inert.
    driverLoader: async (driver: string) =>
      ensureWorkerDriverLoaded(driver, defaultWorkerDriverRegistry, { baseDir, logEvent }),
  });
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
  appendLogEvent,
};
