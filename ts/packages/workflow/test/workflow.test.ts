import fs from "node:fs/promises";
import path from "node:path";

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

// --- workflowFilePath ---

test("workflowFilePath returns default path when none specified", () => {
  const result = workflowFilePath({}, "/projects/my-app");
  assert.equal(result, path.join("/projects/my-app", "WORKFLOW.md"));
});

test("workflowFilePath resolves relative path against project root", () => {
  const env = { SYMPHONY_WORKFLOW: "custom/workflow.md" };
  const result = workflowFilePath(env, "/projects/my-app");
  assert.equal(result, path.join("/projects/my-app", "custom/workflow.md"));
});

test("workflowFilePath keeps absolute path from environment", () => {
  const absolute = path.join("/projects/my-app", "custom/workflow.md");
  const result = workflowFilePath({ SYMPHONY_WORKFLOW: absolute }, "/other/project");
  assert.equal(result, absolute);
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

test("loadWorkflow resolves relative env workflow path against project root", async () => {
  const dir = await tempDir("symphony-workflow-env-cwd");
  const outside = await tempDir("symphony-workflow-env-outside");
  const workflowFile = path.join(dir, "custom", "workflow.md");
  await fs.mkdir(path.dirname(workflowFile), { recursive: true });
  await fs.writeFile(workflowFile, "Project root workflow");

  const originalCwd = process.cwd();
  try {
    process.chdir(outside);
    const result = await loadWorkflow(
      undefined,
      { SYMPHONY_WORKFLOW: "custom/workflow.md" },
      { cwd: dir },
    );

    assert.equal(result.path, workflowFile);
    assert.equal(result.promptTemplate, "Project root workflow");
  } finally {
    process.chdir(originalCwd);
  }
});

test("loadWorkflow validates Liquid prompt templates with prompt context", async () => {
  const dir = await tempDir("symphony-workflow-invalid-prompt");
  const workflowFile = path.join(dir, "WORKFLOW.md");
  await fs.writeFile(workflowFile, "{% if issue.identifier %}");

  await assert.rejects(
    () => loadWorkflow(workflowFile, {}, { cwd: dir }),
    /template_parse_error:.*template="/s,
  );
});

test("loadWorkflow caches the parsed effective prompt template", async () => {
  const dir = await tempDir("symphony-workflow-parsed-prompt");
  const workflowFile = path.join(dir, "WORKFLOW.md");
  await fs.writeFile(workflowFile, "Hello {{ issue.identifier }}");

  const result = await loadWorkflow(workflowFile, {}, { cwd: dir });

  assert.ok(
    Array.isArray((result as { parsedPromptTemplate?: unknown }).parsedPromptTemplate),
    "expected loadWorkflow to include a parsedPromptTemplate array",
  );
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
