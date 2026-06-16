import { Liquid } from "liquidjs";
import type { EnsembleContext, Issue, IssueRef } from "@lorenz/domain";
import type { ParsedPromptTemplate } from "@lorenz/domain";
import { effectivePromptTemplate, parsePromptTemplate } from "@lorenz/workflow";
import type { Template } from "liquidjs";

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
});

const parsedTemplateCache = new Map<string, ParsedPromptTemplate>();

export async function buildPrompt(
  template: string | ParsedPromptTemplate,
  issue: Issue,
  options: {
    attempt?: number | null;
    slotIndex?: number;
    ensembleSize?: number;
  } = {},
): Promise<string> {
  const ensemble = ensembleContext(options.slotIndex ?? 0, options.ensembleSize ?? 1);
  return engine.render(parsedPromptTemplateFor(template) as Template[], {
    issue: issuePromptContext(issue),
    attempt: options.attempt ?? null,
    ensemble,
  }) as Promise<string>;
}

function parsedPromptTemplateFor(template: string | ParsedPromptTemplate): ParsedPromptTemplate {
  if (typeof template !== "string") return template;
  const effectiveTemplate = effectivePromptTemplate(template);
  const cached = parsedTemplateCache.get(effectiveTemplate);
  if (cached) return cached;
  const parsed = parsePromptTemplate(effectiveTemplate);
  parsedTemplateCache.set(effectiveTemplate, parsed);
  return parsed;
}

function ensembleContext(slotIndex: number, size: number): EnsembleContext {
  return {
    enabled: size > 1,
    slot_index: slotIndex,
    size,
  };
}

export function continuationPrompt(turnNumber: number, maxTurns: number): string {
  return `Continuation guidance:

- The previous agent turn completed normally, but the issue is still in an active state.
- This is continuation turn #${turnNumber} of ${maxTurns} for the current agent run.
- Resume from the current workspace and workpad state instead of restarting from scratch.
- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.
- Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.
`;
}

function issuePromptContext(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    priority: issue.priority ?? null,
    state: issue.state,
    state_type: issue.stateType ?? null,
    branch_name: issue.branchName ?? null,
    url: issue.url ?? null,
    assignee_id: issue.assigneeId ?? null,
    blocked_by: issue.blockers.map(issueRefPromptContext),
    labels: issue.labels,
    assigned_to_worker: issue.assignedToWorker ?? true,
    created_at: issue.createdAt ?? null,
    updated_at: issue.updatedAt ?? null,
  };
}

function issueRefPromptContext(issue: IssueRef): Record<string, unknown> {
  return {
    id: issue.id ?? null,
    identifier: issue.identifier ?? null,
    state: issue.state ?? null,
    state_type: issue.stateType ?? null,
  };
}
