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
import { trackerSpecifierFromConfig, type DefaultSettingsOptions } from "@lorenz/config";
import { registerDockerWorkerDriver } from "@lorenz/docker-worker";
import { systemClock, type RuntimeTrackerClient, type Settings } from "@lorenz/domain";
import { registerJiraTrackers } from "@lorenz/jira-tracker";
import { registerLinearTracker } from "@lorenz/linear-tracker";
import { registerLocalTracker } from "@lorenz/local-tracker";
import { registerMemoryTracker } from "@lorenz/memory-tracker";
import { registerSlackTracker } from "@lorenz/slack-tracker";
import { registerStaticSshWorkerDriver } from "@lorenz/static-worker";
import { acquireAgentMcpEndpointForRun, type IsRunLive } from "@lorenz/mcp";
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
import { ensureTrackerProviderLoaded } from "./trackerLoader.js";

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

/**
 * `loadWorkflow` pre-parse hook: dynamic-import any out-of-tree tracker named by
 * `tracker.kind` (a module specifier rather than a registered kind) and register
 * it into `trackers` under that exact string, BEFORE the config parser resolves
 * the tracker provider. Mirrors {@link buildWorkerPool}'s driver-loading step:
 * the loader is a no-op for a built-in kind, dynamic-imports on a miss, and
 * fail-loud on an unresolvable specifier / SDK mismatch at the same startup point
 * as an unregistered kind. Re-running it on a reload re-encounters an
 * already-loaded specifier and emits `tracker_provider_module_pinned`; a config
 * that switches `tracker.kind` to a NEW specifier hot-loads it.
 *
 * `baseDir` anchors `./relative` specifiers to the workflow file's directory (the
 * most predictable anchor for operators), and `logEvent` routes the
 * `tracker_provider_loaded`/`_module_pinned` audit events to the configured log
 * file when one is known.
 */
export async function prepareTrackerExtensions(
  rawConfig: Record<string, unknown>,
  context: { baseDir: string; logFile?: string | undefined; trackers?: TrackerRegistry },
): Promise<void> {
  const specifier = trackerSpecifierFromConfig(rawConfig);
  if (specifier === undefined) return;
  const trackers = context.trackers ?? defaultTrackerRegistry;
  const logEvent =
    context.logFile === undefined
      ? undefined
      : (event: Record<string, unknown>): void => void appendLogEvent(context.logFile!, event);
  await ensureTrackerProviderLoaded(specifier, trackers, {
    baseDir: context.baseDir,
    logEvent,
  });
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
 * The CONCRETE per-run {@link McpEndpointManager} (`perRunClaimEnforcement=true`) is wired
 * here: it OWNS the whole per-run MCP endpoint lease (auth token + refcounted local
 * mcp server + reverse tunnel) via the injected `acquireAgentMcpEndpointForRun`. The
 * daemon is the right ownership boundary because it already depends on
 * `@lorenz/mcp`, keeping `@lorenz/worker-pool` and
 * `@lorenz/dispatch-coordinator` free of any mcp/tunnel runtime dependency.
 * At the default `slotsPerMachine=1` this opens exactly ONE endpoint
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
  // Forward reference so the per-run endpoint manager's `acquireForRun` can inject
  // the coordinator's own `isRunLive` oracle into `@lorenz/mcp`. The coordinator
  // is the live-slot authority the gateway owner re-check reads; the daemon is the
  // only place that holds both `@lorenz/mcp` and the coordinator, so it closes the
  // loop here WITHOUT either package importing the other. `acquireForRun` is only
  // ever called AFTER `createDispatchCoordinator` returns (during an
  // `acquireRunSlot`), so `ref.coordinator` is always bound by then.
  const ref: { coordinator: DispatchCoordinator | undefined } = { coordinator: undefined };
  const isRunLive: IsRunLive = (runKey, workerHost, generation) =>
    ref.coordinator?.isRunLive(runKey, workerHost, generation) ?? false;
  const coordinator = createDispatchCoordinator({
    pool,
    // The concrete manager OWNS each run's whole endpoint lease; it calls the
    // injected `acquireAgentMcpEndpointForRun` (signature-compatible) for an
    // ssh-addressable host and returns null for an empty (local) host so the
    // local path keeps using acp's own endpoint.
    mcpEndpointManager: createPerRunEndpointManager({
      // The composition root binds the concrete tunnel transport (the shared
      // worker-host pool) AND the coordinator-backed `isRunLive` oracle, keeping
      // `@lorenz/mcp` free of any worker-host-pool / coordinator import while the
      // coordinator stays on the manager seam. The per-run MCP server mounts
      // `isRunLive` so its Token B middleware enforces the per-request owner
      // re-check + generation fence over live coordinator slots; the
      // capture-before-await fence is what makes that window safe.
      acquireForRun: async (runSettings, workerHost, runKey) =>
        acquireAgentMcpEndpointForRun(runSettings, workerHost, runKey, workerHostPool, isRunLive),
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
  ref.coordinator = coordinator;
  return coordinator;
}

/**
 * Skill overlay for a prepared workspace: the configured `agent.skills` unioned with the skills
 * bundled by the mounted tool packs, copied into `.lorenz/skills` with a `.gitignore` so they
 * are never committed. Returns undefined when nothing is configured so workspace preparation
 * skips the overlay entirely.
 */
function resolveSkillOverlay(settings: Settings): WorkspaceSkillOverlay | undefined {
  const sources = [
    ...new Set([
      ...settings.agent.skills,
      ...mountedSkillSources(settings, defaultToolRegistry, defaultTrackerRegistry),
    ]),
  ];
  if (sources.length === 0) return undefined;
  return { sources, destDir: ".lorenz/skills" };
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
