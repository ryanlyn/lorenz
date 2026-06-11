import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { Liquid } from "liquidjs";
import YAML from "yaml";
import { parseConfig } from "@symphony/config";
import {
  errorMessage,
  isRecord,
  type ParsedPromptTemplate,
  type WorkflowContentStamp,
  type WorkflowDefinition,
} from "@symphony/domain";
import type { DefaultSettingsOptions } from "@symphony/config";
import type { TrackerRegistry } from "@symphony/tracker-sdk";

type WorkflowLoadOptions = DefaultSettingsOptions & {
  cwd?: string | undefined;
  /**
   * Tracker providers consulted while parsing the `tracker:` config section. The
   * composition root passes its populated registry so provider option parsing, aliases,
   * and env fallbacks apply; when omitted, the process-wide default registry is used.
   */
  trackers?: TrackerRegistry | undefined;
};

const promptTemplateEngine = new Liquid({
  strictVariables: true,
  strictFilters: true,
});

export const defaultPromptTemplate = `You are working on an issue from the configured tracker.

Identifier: {{ issue.identifier }}
Title: {{ issue.title }}

Body:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}
`;

export function workflowFilePath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const workflow = env.SYMPHONY_WORKFLOW;
  if (!workflow) return path.join(cwd, "WORKFLOW.md");
  return path.isAbsolute(workflow) ? workflow : path.join(cwd, workflow);
}

export async function loadWorkflow(
  workflowPath?: string,
  env: NodeJS.ProcessEnv = process.env,
  defaults: WorkflowLoadOptions = {},
): Promise<WorkflowDefinition> {
  const absolute = path.resolve(workflowPath ?? workflowFilePath(env, defaults.cwd));
  let content: string;
  let stat: Stats;
  try {
    [content, stat] = await Promise.all([fs.readFile(absolute, "utf8"), fs.stat(absolute)]);
  } catch (error) {
    throw missingWorkflowFileError(absolute, error);
  }
  const { config, body } = parseWorkflowContent(content);
  const settings = defaults.trackers
    ? parseConfig(config, env, defaults, defaults.trackers)
    : parseConfig(config, env, defaults);
  return {
    path: absolute,
    config,
    promptTemplate: body,
    parsedPromptTemplate: parsePromptTemplate(body),
    stamp: workflowContentStamp(stat, content),
    settings,
  };
}

export async function currentWorkflowStamp(workflowPath: string): Promise<WorkflowContentStamp> {
  const absolute = path.resolve(workflowPath);
  try {
    const [content, stat] = await Promise.all([fs.readFile(absolute, "utf8"), fs.stat(absolute)]);
    return workflowContentStamp(stat, content);
  } catch (error) {
    throw missingWorkflowFileError(absolute, error);
  }
}

export async function workflowFileChanged(workflow: WorkflowDefinition): Promise<boolean> {
  if (!workflow.stamp) return true;
  return !workflowStampsEqual(workflow.stamp, await currentWorkflowStamp(workflow.path));
}

export function workflowStampsEqual(
  left: WorkflowContentStamp | undefined,
  right: WorkflowContentStamp | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size &&
    left.contentHash === right.contentHash
  );
}

export function parseWorkflowContent(content: string): {
  config: Record<string, unknown>;
  body: string;
} {
  const lines = content.split(/\r\n|\n|\r|\u2028|\u2029/);
  if (lines[0] !== "---") return { config: {}, body: content.trim() };

  const end = lines.indexOf("---", 1);
  if (end === -1) return { config: {}, body: content.trim() };

  const yamlText = lines.slice(1, end).join("\n");
  const body = lines
    .slice(end + 1)
    .join("\n")
    .trim();
  if (yamlText.trim() === "") return { config: {}, body };

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText) as unknown;
  } catch (error) {
    throw new Error(`workflow_parse_error: ${errorMessage(error)}`, { cause: error });
  }
  if (parsed === null)
    throw new Error("workflow_front_matter_not_a_map: front matter must be a map");
  if (!isRecord(parsed))
    throw new Error("workflow_front_matter_not_a_map: front matter must be a map");
  return { config: parsed, body };
}

export function effectivePromptTemplate(promptTemplate: string): string {
  return promptTemplate.trim() === "" ? defaultPromptTemplate : promptTemplate;
}

export function parsePromptTemplate(promptTemplate: string): ParsedPromptTemplate {
  const effectiveTemplate = effectivePromptTemplate(promptTemplate);
  try {
    return promptTemplateEngine.parse(effectiveTemplate);
  } catch (error) {
    throw new Error(
      `template_parse_error: ${errorMessage(error)} template=${JSON.stringify(effectiveTemplate)}`,
      { cause: error },
    );
  }
}

function workflowContentStamp(stat: Stats, content: string): WorkflowContentStamp {
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
}

function missingWorkflowFileError(absolute: string, error: unknown): Error {
  return new Error(
    `missing_workflow_file: ${absolute} ${(error as NodeJS.ErrnoException).code ?? ""}`.trim(),
    {
      cause: error,
    },
  );
}
