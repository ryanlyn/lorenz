import fs from "node:fs/promises";
import path from "node:path";

import { test } from "vitest";
import { assert, tempDir } from "@lorenz/test-utils";

import {
  workflowFilePath,
  loadWorkflow,
  parseWorkflowContent,
  renderWorkflowContent,
  writeWorkflowFile,
  effectivePromptTemplate,
  defaultPromptTemplate,
} from "@lorenz/workflow";

// --- workflowFilePath ---

test("workflowFilePath returns default path when none specified", () => {
  const result = workflowFilePath({}, "/projects/my-app");
  assert.equal(result, path.join("/projects/my-app", "WORKFLOW.md"));
});

test("workflowFilePath resolves relative path against project root", () => {
  const env = { LORENZ_WORKFLOW: "custom/workflow.md" };
  const result = workflowFilePath(env, "/projects/my-app");
  assert.equal(result, path.join("/projects/my-app", "custom/workflow.md"));
});

test("workflowFilePath keeps absolute path from environment", () => {
  const absolute = path.join("/projects/my-app", "custom/workflow.md");
  const result = workflowFilePath({ LORENZ_WORKFLOW: absolute }, "/other/project");
  assert.equal(result, absolute);
});

// --- loadWorkflow ---

test("loadWorkflow reads and parses YAML workflow file", async () => {
  const dir = await tempDir("lorenz-workflow-load");
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
  const dir = await tempDir("lorenz-workflow-env-cwd");
  const outside = await tempDir("lorenz-workflow-env-outside");
  const workflowFile = path.join(dir, "custom", "workflow.md");
  await fs.mkdir(path.dirname(workflowFile), { recursive: true });
  await fs.writeFile(workflowFile, "Project root workflow");

  const originalCwd = process.cwd();
  try {
    process.chdir(outside);
    const result = await loadWorkflow(
      undefined,
      { LORENZ_WORKFLOW: "custom/workflow.md" },
      { cwd: dir },
    );

    assert.equal(result.path, workflowFile);
    assert.equal(result.promptTemplate, "Project root workflow");
  } finally {
    process.chdir(originalCwd);
  }
});

test("loadWorkflow validates Liquid prompt templates with prompt context", async () => {
  const dir = await tempDir("lorenz-workflow-invalid-prompt");
  const workflowFile = path.join(dir, "WORKFLOW.md");
  await fs.writeFile(workflowFile, "{% if issue.identifier %}");

  await assert.rejects(
    () => loadWorkflow(workflowFile, {}, { cwd: dir }),
    /template_parse_error:.*template="/s,
  );
});

test("loadWorkflow caches the parsed effective prompt template", async () => {
  const dir = await tempDir("lorenz-workflow-parsed-prompt");
  const workflowFile = path.join(dir, "WORKFLOW.md");
  await fs.writeFile(workflowFile, "Hello {{ issue.identifier }}");

  const result = await loadWorkflow(workflowFile, {}, { cwd: dir });

  assert.ok(
    Array.isArray((result as { parsedPromptTemplate?: unknown }).parsedPromptTemplate),
    "expected loadWorkflow to include a parsedPromptTemplate array",
  );
});

test("loadWorkflow returns error for missing file", async () => {
  const dir = await tempDir("lorenz-workflow-missing");
  const missing = path.join(dir, "DOES_NOT_EXIST.md");

  await assert.rejects(() => loadWorkflow(missing, {}, { cwd: dir }), /missing_workflow_file/);
});

test("loadWorkflow returns error for malformed YAML", async () => {
  const dir = await tempDir("lorenz-workflow-malformed");
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

// --- renderWorkflowContent ---

test("renderWorkflowContent renders exact YAML front matter and prompt body", () => {
  const result = renderWorkflowContent(
    {
      tracker: { kind: "local" },
      polling: { interval_ms: 5000 },
    },
    "Fix {{ issue.identifier }}.",
  );

  assert.equal(
    result,
    [
      "---",
      "tracker:",
      "  kind: local",
      "polling:",
      "  interval_ms: 5000",
      "---",
      "",
      "Fix {{ issue.identifier }}.",
      "",
    ].join("\n"),
  );
});

// --- writeWorkflowFile ---

test("writeWorkflowFile creates parent directories and returns the absolute path", async () => {
  const dir = await tempDir("lorenz-workflow-write-parent");
  const workflowFile = path.join(dir, "nested", "config", "WORKFLOW.md");
  const config = { tracker: { kind: "local" } };
  const promptTemplate = "Handle {{ issue.identifier }}.";

  const writtenPath = await writeWorkflowFile(workflowFile, config, promptTemplate);

  assert.equal(writtenPath, path.resolve(workflowFile));
  assert.equal(
    await fs.readFile(workflowFile, "utf8"),
    renderWorkflowContent(config, promptTemplate),
  );
});

test("writeWorkflowFile does not clobber an existing workflow by default", async () => {
  const dir = await tempDir("lorenz-workflow-write-no-clobber");
  const workflowFile = path.join(dir, "WORKFLOW.md");
  await fs.writeFile(workflowFile, "existing workflow", "utf8");

  await assert.rejects(
    () => writeWorkflowFile(workflowFile, { tracker: { kind: "local" } }, "replacement"),
    /workflow file already exists: .*; pass --force to replace it/,
  );

  assert.equal(await fs.readFile(workflowFile, "utf8"), "existing workflow");
  assert.deepEqual(await fs.readdir(dir), ["WORKFLOW.md"]);
});

test("writeWorkflowFile atomically overwrites an existing workflow when forced", async () => {
  const dir = await tempDir("lorenz-workflow-write-force");
  const workflowFile = path.join(dir, "WORKFLOW.md");
  const config = { tracker: { kind: "linear" } };
  const promptTemplate = "Replace {{ issue.identifier }}.";
  await fs.writeFile(workflowFile, "existing workflow", "utf8");

  const writtenPath = await writeWorkflowFile(workflowFile, config, promptTemplate, {
    force: true,
  });

  assert.equal(writtenPath, path.resolve(workflowFile));
  assert.equal(
    await fs.readFile(workflowFile, "utf8"),
    renderWorkflowContent(config, promptTemplate),
  );
  assert.deepEqual(await fs.readdir(dir), ["WORKFLOW.md"]);
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
