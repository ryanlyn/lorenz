import {
  PRIORITY_VALUES,
  isRecord,
  normalizeStateType,
  type Issue,
  type IssueRef,
  type IssueStateType,
  type Priority,
  isValidEnsembleSize,
} from "@symphony/domain";

export function normalizeIssue(input: Record<string, unknown>, assignee?: string): Issue {
  const id = requiredString(input, "id");
  const identifier = requiredString(input, "identifier");
  const title = requiredString(input, "title");
  const state = firstOptionalString(
    stringFromPath(input, ["state", "name"]),
    input.state,
    input.state_name,
    input.stateName,
  );
  if (state === null || state.trim() === "") throw new Error("issue.state is required");
  const rawStateType = firstOptionalString(
    stringFromPath(input, ["state", "type"]),
    input.state_type,
    input.stateType,
  );
  const stateType = normalizeStateType(rawStateType);
  if (stateType === null) throw new Error("issue.stateType is required");
  const assigneeId =
    stringFromPath(input, ["assignee", "id"]) ??
    optionalString(input.assignee_id ?? input.assigneeId);

  const labels = normalizeLabels(input.labels);
  const blockers = normalizeBlockers(input);
  const assignedToWorker =
    assignee === undefined || assignee === ""
      ? true
      : assigneeId === undefined || assigneeId === null
        ? false
        : assigneeId.toLowerCase() === assignee.toLowerCase();

  return {
    id,
    identifier,
    title,
    description: optionalString(input.description),
    state,
    stateType,
    branchName: optionalString(input.branchName ?? input.branch_name),
    url: optionalString(input.url),
    priority: priorityOrNull(input.priority),
    createdAt: optionalString(input.created_at ?? input.createdAt),
    updatedAt: optionalString(input.updated_at ?? input.updatedAt),
    labels,
    blockers,
    assigneeId,
    assignedToWorker,
    raw: input,
  };
}

const DEFAULT_STATE_TYPES: Record<string, IssueStateType> = {
  todo: "unstarted",
  "in progress": "started",
  done: "completed",
  cancelled: "canceled",
  canceled: "canceled",
  backlog: "backlog",
  triage: "triage",
};

/** Best-effort category for a free-form workflow state name; null when unknown. */
export function defaultStateType(name: string): IssueStateType | null {
  return DEFAULT_STATE_TYPES[name.trim().toLowerCase()] ?? null;
}

export function ensembleSize(issue: Issue): number | null {
  for (const label of issue.labels) {
    const match = /^ensemble:(\d+)$/.exec(label.trim().toLowerCase());
    if (!match) continue;
    const size = Number(match[1]);
    if (isValidEnsembleSize(size)) return size;
  }
  return null;
}

export function isTerminalState(
  state: string | undefined | null,
  terminalStates: string[],
): boolean {
  if (!state) return false;
  const normalized = state.trim().toLowerCase();
  return terminalStates.some((candidate) => candidate.trim().toLowerCase() === normalized);
}

function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((label) => {
      if (typeof label === "string") return label;
      if (isRecord(label) && typeof label.name === "string") return label.name;
      return "";
    })
    .filter((label) => label.trim() !== "")
    .map((label) => label.trim().toLowerCase());
}

function normalizeBlockers(input: Record<string, unknown>): IssueRef[] {
  const rawBlockers = input.blockers;
  if (Array.isArray(rawBlockers)) return rawBlockers.map(normalizeIssueRef);

  const relations = input.relations;
  if (!Array.isArray(relations)) return [];

  return relations.flatMap((relation) => {
    if (
      !isRecord(relation) ||
      typeof relation.type !== "string" ||
      relation.type.trim().toLowerCase() !== "blocks"
    )
      return [];
    const issue = relation.relatedIssue ?? relation.issue;
    return [normalizeIssueRef(issue)];
  });
}

function normalizeIssueRef(value: unknown): IssueRef {
  if (!isRecord(value)) return {};
  return {
    id: optionalString(value.id) ?? undefined,
    identifier: optionalString(value.identifier) ?? undefined,
    state: stringFromPath(value, ["state", "name"]) ?? optionalString(value.state) ?? undefined,
    stateType: normalizeStateType(
      firstOptionalString(
        stringFromPath(value, ["state", "type"]),
        value.state_type,
        value.stateType,
      ),
    ),
  };
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`issue.${key} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value;
}

function firstOptionalString(...values: unknown[]): string | null {
  for (const value of values) {
    const stringValue = optionalString(value);
    if (stringValue !== null) return stringValue;
  }
  return null;
}

function priorityOrNull(value: unknown): Priority | null {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (PRIORITY_VALUES as readonly number[]).includes(value)
  )
    return value as Priority;
  return null;
}

function stringFromPath(input: Record<string, unknown>, path: string[]): string | null {
  let current: unknown = input;
  for (const segment of path) {
    if (!isRecord(current)) return null;
    current = current[segment];
  }
  return typeof current === "string" ? current : null;
}
