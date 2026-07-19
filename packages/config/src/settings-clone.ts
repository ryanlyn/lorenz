import type {
  AgentConfig,
  Settings,
  TrackerSettings,
  WorkerPoolSettings,
  WorkerPoolSettingsInput,
  WorkerSettings,
} from "@lorenz/domain";
import { withDerivedMaxInFlight } from "@lorenz/domain";

/**
 * Clone runtime settings for one issue-state evaluation. Mutable collections and opaque option
 * bags are isolated while the status override map retains its normalized keys and fragments.
 */
export function cloneSettings(settings: Settings): Settings {
  return {
    ...settings,
    tracker: cloneTracker(settings.tracker),
    trackers: Object.fromEntries(
      Object.entries(settings.trackers).map(([name, tracker]) => [name, cloneTracker(tracker)]),
    ),
    polling: { ...settings.polling },
    workspace: { ...settings.workspace },
    worker: cloneWorkerSettings(settings.worker),
    hooks: { ...settings.hooks },
    agent: { ...settings.agent, skills: [...settings.agent.skills] },
    agents: cloneAgentRecords(settings.agents),
    ...(settings.toolOptions !== undefined && {
      toolOptions: structuredClone(settings.toolOptions),
    }),
    observability: { ...settings.observability },
    server: { ...settings.server },
    logging: { ...settings.logging },
    statusOverrides: new Map(settings.statusOverrides),
  };
}

export function cloneAgentRecords(
  records: Record<string, AgentConfig>,
): Record<string, AgentConfig> {
  const cloned: Record<string, AgentConfig> = {};
  for (const [name, record] of Object.entries(records)) {
    cloned[name] = { ...record, options: structuredClone(record.options) };
  }
  return cloned;
}

function cloneWorkerSettings(worker: WorkerSettings): WorkerSettings {
  const cloned: WorkerSettings = { ...worker, sshHosts: [...worker.sshHosts] };
  if (worker.workerPool === undefined) {
    delete cloned.workerPool;
  } else {
    cloned.workerPool = cloneWorkerPool(worker.workerPool);
  }
  return cloned;
}

function cloneWorkerPool(workerPool: WorkerPoolSettings): WorkerPoolSettings {
  // Spreading an enumerable getter materializes its current value. Remove that value and reinstall
  // the accessor over the cloned canonical field so maxInFlight continues to track slotsPerMachine.
  const { maxInFlight: _maxInFlight, ...rest } = workerPool;
  const input: WorkerPoolSettingsInput = { ...rest };
  if (workerPool.spend !== undefined) input.spend = { ...workerPool.spend };
  if (workerPool.driverOptions !== undefined) {
    input.driverOptions = structuredClone(workerPool.driverOptions);
  }
  return withDerivedMaxInFlight(input);
}

function cloneTracker(tracker: TrackerSettings): TrackerSettings {
  return {
    ...tracker,
    dispatch: {
      ...tracker.dispatch,
      onlyRoutes: tracker.dispatch.onlyRoutes === null ? null : [...tracker.dispatch.onlyRoutes],
    },
    activeStates: [...tracker.activeStates],
    terminalStates: [...tracker.terminalStates],
    options: structuredClone(tracker.options),
  };
}
