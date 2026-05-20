import {
  ISSUE_STATE_TYPES,
  type Issue,
  type IssueRef,
  type IssueStateType,
} from "@symphony/domain";

export function normalizeIssue(input: Record<string, unknown>, assignee?: string): Issue {
  const id = requiredString(input, "id");
  const identifier = requiredString(input, "identifier");
  const title = requiredString(input, "title");
  const state =
    stringFromPath(input, ["state", "name"]) ??
    optionalString(input.state ?? input.state_name ?? input.stateName);
  if (state === null || state.trim() === "") throw new Error("issue.state is required");
  const stateType =
    stringFromPath(input, ["state", "type"]) ?? optionalString(input.state_type ?? input.stateType);
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
    stateType: normalizeStateType(stateType),
    branchName: optionalString(input.branchName ?? input.branch_name),
    url: optionalString(input.url),
    priority: numberOrNull(input.priority),
    createdAt: optionalString(input.created_at ?? input.createdAt),
    updatedAt: optionalString(input.updated_at ?? input.updatedAt),
    labels,
    blockers,
    assigneeId,
    assignedToWorker,
    raw: input,
  };
}

export function ensembleSize(issue: Issue): number | null {
  for (const label of issue.labels) {
    const match = /^ensemble:(\d+)$/.exec(label.trim().toLowerCase());
    if (!match) continue;
    const size = Number(match[1]);
    if (Number.isInteger(size) && size > 0) return size;
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
      stringFromPath(value, ["state", "type"]) ??
        optionalString(value.state_type ?? value.stateType),
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

function normalizeStateType(value: string | null): IssueStateType | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  return isOneOf(normalized, ISSUE_STATE_TYPES) ? normalized : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<const Values extends readonly string[]>(
  value: string,
  values: Values,
): value is Values[number] {
  return (values as readonly string[]).includes(value);
}
