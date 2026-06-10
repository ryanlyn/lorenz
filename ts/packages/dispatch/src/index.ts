import { ensembleSize, isTerminalState } from "@symphony/issue";
import { normalizeRouteName, normalizeStateName, settingsForIssueState } from "@symphony/config";
import type { DispatchBlockReason, Issue, Priority, Settings } from "@symphony/domain";

export function routeNames(issue: Issue, settings: Settings): string[] {
  const prefix = settings.tracker.dispatch.routeLabelPrefix.trim().toLowerCase();
  return issue.labels
    .filter((label) => label.toLowerCase().startsWith(prefix))
    .map((label) => normalizeRouteName(label.slice(prefix.length)))
    .filter((route) => route !== "");
}

export function hasRouteLabel(issue: Issue, settings: Settings): boolean {
  const prefix = settings.tracker.dispatch.routeLabelPrefix.trim().toLowerCase();
  return issue.labels.some((label) => label.toLowerCase().startsWith(prefix));
}

export function issueIsActive(issue: Issue, settings: Settings): boolean {
  return (
    stateIn(issue.state, settings.tracker.activeStates) &&
    !stateIn(issue.state, settings.tracker.terminalStates)
  );
}

export function issueHasOpenBlockers(issue: Issue, settings: Settings): boolean {
  if (issue.stateType !== "unstarted") return false;

  return issue.blockers.some(
    (blocker) => !isTerminalState(blocker.state, settings.tracker.terminalStates),
  );
}

export function routedToThisWorker(issue: Issue, settings: Settings): boolean {
  if (issue.assignedToWorker === false) return false;

  const routes = routeNames(issue, settings);
  const dispatch = settings.tracker.dispatch;
  if (routes.length === 0) return hasRouteLabel(issue, settings) ? false : dispatch.acceptUnrouted;
  if (dispatch.onlyRoutes === null) return true;
  if (dispatch.onlyRoutes.length === 0) return false;
  const allowed = new Set(dispatch.onlyRoutes.map(normalizeRouteName));
  return routes.some((route) => allowed.has(route));
}

export function dispatchBlockReason(
  issue: Issue,
  settings: Settings,
  state: {
    runningCount: number;
    runningByState?: Map<string, number>;
    claimedSlots?: Set<string>;
    workerCapacityAvailable?: boolean | undefined;
  },
): DispatchBlockReason | null {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) return null;
  if (!issueIsActive(issue, settings)) return null;
  if (!routedToThisWorker(issue, settings)) return null;
  if (issueHasOpenBlockers(issue, settings)) return null;

  if (state.runningCount >= settings.agent.maxConcurrentAgents) return "global_concurrency_cap";

  const effective = settingsForIssueState(settings, issue.state);
  const stateCount = state.runningByState?.get(normalizeStateName(issue.state)) ?? 0;
  if (stateCount >= effective.agent.maxConcurrentAgents) return "local_concurrency_cap";

  if (state.workerCapacityAvailable === false) return "worker_host_capacity";

  return null;
}

export function shouldDispatchIssue(
  issue: Issue,
  settings: Settings,
  state: {
    runningCount: number;
    runningByState?: Map<string, number>;
    claimedSlots?: Set<string>;
    workerCapacityAvailable?: boolean | undefined;
  },
): boolean {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
  if (!issueIsActive(issue, settings)) return false;
  if (!routedToThisWorker(issue, settings)) return false;
  if (issueHasOpenBlockers(issue, settings)) return false;
  if (dispatchBlockReason(issue, settings, state)) return false;

  const size = ensembleSize(issue) ?? settings.agent.ensembleSize;
  const claimed = state.claimedSlots ?? new Set<string>();
  for (let slot = 0; slot < size; slot += 1) {
    if (!claimed.has(slotKey(issue.id, slot))) return true;
  }
  return false;
}

export function firstUnclaimedSlot(
  issue: Issue,
  settings: Settings,
  claimedSlots: Set<string>,
  preferredSlotIndex?: number | null,
): number | null {
  const size = ensembleSize(issue) ?? settings.agent.ensembleSize;
  if (
    preferredSlotIndex !== undefined &&
    preferredSlotIndex !== null &&
    Number.isInteger(preferredSlotIndex) &&
    preferredSlotIndex >= 0 &&
    preferredSlotIndex < size &&
    !claimedSlots.has(slotKey(issue.id, preferredSlotIndex))
  ) {
    return preferredSlotIndex;
  }
  for (let slot = 0; slot < size; slot += 1) {
    if (!claimedSlots.has(slotKey(issue.id, slot))) return slot;
  }
  return null;
}

export function slotKey(issueId: string, slotIndex: number): string {
  return `${issueId}:${slotIndex}`;
}

export function sortForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((left, right) => {
    const priority = prioritySort(left.priority) - prioritySort(right.priority);
    if (priority !== 0) return priority;
    const created = createdAtSort(left.createdAt) - createdAtSort(right.createdAt);
    if (created !== 0) return created;
    return left.identifier.localeCompare(right.identifier);
  });
}

function createdAtSort(value: string | null | undefined): number {
  if (value === null || value === undefined || value === "") return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

function stateIn(state: string, states: string[]): boolean {
  return states.some((candidate) => candidate.trim().toLowerCase() === state.trim().toLowerCase());
}

function prioritySort(priority: Priority | null | undefined): number {
  return priority ?? Number.MAX_SAFE_INTEGER;
}
