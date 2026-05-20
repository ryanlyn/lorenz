import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { parseConfig } from "@symphony/config";
import type { WorkflowDefinition } from "@symphony/domain";
import type { DefaultSettingsOptions } from "@symphony/config";

export const defaultPromptTemplate = `You are working on a Linear issue.

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
  return env.SYMPHONY_WORKFLOW || path.join(cwd, "WORKFLOW.md");
}

export async function loadWorkflow(
  workflowPath?: string,
  env: NodeJS.ProcessEnv = process.env,
  defaults: DefaultSettingsOptions = {},
): Promise<WorkflowDefinition> {
  const absolute = path.resolve(workflowPath ?? workflowFilePath(env));
  let content: string;
  try {
    content = await fs.readFile(absolute, "utf8");
  } catch (error) {
    throw new Error(
      `missing_workflow_file: ${absolute} ${(error as NodeJS.ErrnoException).code ?? ""}`.trim(),
      {
        cause: error,
      },
    );
  }
  const { config, body } = parseWorkflowContent(content);
  return {
    path: absolute,
    config,
    promptTemplate: body,
    settings: parseConfig(config, env, defaults),
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
