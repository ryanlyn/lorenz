import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "vitest";

import { assert } from "../../../test/assert.js";
import { tempDir } from "../../../test/helpers.js";

import {
  workflowFilePath,
  loadWorkflow,
  parseWorkflowContent,
  effectivePromptTemplate,
  defaultPromptTemplate,
} from "@symphony/workflow";

const tsRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

// --- workflowFilePath ---

test("workflowFilePath returns default path when none specified", () => {
  const result = workflowFilePath({}, "/projects/my-app");
  assert.equal(result, path.join("/projects/my-app", "WORKFLOW.md"));
});

test("workflowFilePath resolves relative path against project root", () => {
  const env = { SYMPHONY_WORKFLOW: "custom/workflow.md" };
  const result = workflowFilePath(env, "/projects/my-app");
  assert.equal(result, "custom/workflow.md");
});

// --- loadWorkflow ---

test("loadWorkflow reads and parses YAML workflow file", async () => {
  const dir = await tempDir("symphony-workflow-load");
  const workflowFile = path.join(dir, "WORKFLOW.md");
  await fs.writeFile(
    workflowFile,
    ["---", "ensemble_size: 2", "---", "Hello {{ issue.identifier }}"].join("\n"),
  );

  const result = await loadWorkflow(workflowFile, {}, { cwd: dir });
  assert.equal(result.path, workflowFile);
  assert.deepEqual(result.config, { ensemble_size: 2 });
  assert.equal(result.promptTemplate, "Hello {{ issue.identifier }}");
});

test("loadWorkflow returns error for missing file", async () => {
  const dir = await tempDir("symphony-workflow-missing");
  const missing = path.join(dir, "DOES_NOT_EXIST.md");

  await assert.rejects(() => loadWorkflow(missing, {}, { cwd: dir }), /missing_workflow_file/);
});

test("loadWorkflow returns error for malformed YAML", async () => {
  const dir = await tempDir("symphony-workflow-malformed");
  const workflowFile = path.join(dir, "WORKFLOW.md");
  await fs.writeFile(workflowFile, ["---", "bad: yaml: [unterminated", "---", "body"].join("\n"));

  await assert.rejects(() => loadWorkflow(workflowFile, {}, { cwd: dir }), /workflow_parse_error/);
});

test("WORKFLOW.slack.md uses route- as the dispatch route_label_prefix", async () => {
  const workflowFile = path.join(tsRoot, "WORKFLOW.slack.md");
  const workflow = await loadWorkflow(workflowFile, {}, { cwd: tsRoot });

  assert.equal(workflow.settings.tracker.dispatch.routeLabelPrefix, "route-");
});

// conversations.history is tightly rate-limited (newer apps can be ~1 req/min) and each poll
// re-scans recent history, so the shipped Slack workflow keeps a conservative one-minute poll
// interval to avoid 429 storms on busy channels. Guard the concrete value.
test("WORKFLOW.slack.md polls at a conservative 60s interval to respect Slack rate limits", async () => {
  const workflowFile = path.join(tsRoot, "WORKFLOW.slack.md");
  const workflow = await loadWorkflow(workflowFile, {}, { cwd: tsRoot });

  assert.equal(workflow.settings.polling.intervalMs, 60000);
});

// --- parseWorkflowContent ---

test("parseWorkflowContent extracts frontmatter and body", () => {
  const content = ["---", "key: value", "num: 42", "---", "Body text here"].join("\n");
  const result = parseWorkflowContent(content);
  assert.deepEqual(result.config, { key: "value", num: 42 });
  assert.equal(result.body, "Body text here");
});

test("parseWorkflowContent handles content without frontmatter", () => {
  const content = "Just a plain body\nwith multiple lines";
  const result = parseWorkflowContent(content);
  assert.deepEqual(result.config, {});
  assert.equal(result.body, content.trim());
});

test("parseWorkflowContent handles empty content", () => {
  const result = parseWorkflowContent("");
  assert.deepEqual(result.config, {});
  assert.equal(result.body, "");
});

// --- effectivePromptTemplate ---

test("effectivePromptTemplate returns custom template when provided", () => {
  const custom = "Custom prompt: {{ issue.title }}";
  assert.equal(effectivePromptTemplate(custom), custom);
});

test("effectivePromptTemplate returns default template when empty string given", () => {
  assert.equal(effectivePromptTemplate(""), defaultPromptTemplate);
  assert.equal(effectivePromptTemplate("   "), defaultPromptTemplate);
});

// --- defaultPromptTemplate ---

test("defaultPromptTemplate contains issue field placeholders", () => {
  assert.match(defaultPromptTemplate, /issue\.identifier/);
  assert.match(defaultPromptTemplate, /issue\.title/);
  assert.match(defaultPromptTemplate, /issue\.description/);
});
