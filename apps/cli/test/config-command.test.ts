import fs from "node:fs/promises";
import path from "node:path";

import { test } from "vitest";
import { loadWorkflow } from "@lorenz/workflow";
import { assert, tempDir } from "@lorenz/test-utils";

import {
  buildInitialWorkflowConfig,
  parseConfigArgs,
  runConfigCommand,
  type ConfigChoice,
  type ConfigInputOptions,
  type ConfigPrompter,
  type OnboardingAnswers,
} from "../src/config.js";

test("config CLI parses its workflow path and overwrite flag", () => {
  assert.deepEqual(parseConfigArgs([]), {
    status: "ok",
    options: { workflowPath: null, force: false },
  });
  assert.deepEqual(parseConfigArgs(["--force", "config/WORKFLOW.md"]), {
    status: "ok",
    options: { workflowPath: "config/WORKFLOW.md", force: true },
  });
  const help = parseConfigArgs(["--help"]);
  assert.equal(help.status, "help");
  if (help.status === "help") {
    assert.match(help.message, /Usage: lorenz-config/);
  }
  assert.deepEqual(parseConfigArgs(["one.md", "two.md"]), {
    status: "error",
    message: "error: too many arguments. Expected 1 argument but got 2.",
  });
});

test("initial workflow defaults to Jira and Claude with secret references", () => {
  const config = buildInitialWorkflowConfig(defaultAnswers());

  assert.deepEqual(config, {
    tracker: {
      kind: "jira",
      active_states: ["To Do", "In Progress"],
      terminal_states: ["Done", "Closed", "Cancelled", "Canceled"],
    },
    trackers: {
      jira: {
        provider: "jira",
        base_url: "$JIRA_BASE_URL",
        email: "$JIRA_EMAIL",
        api_key: "$JIRA_API_KEY",
        project_keys: ["ENG"],
      },
    },
    agent: { kind: "claude" },
  });
});

test("config command creates a loadable Jira and Claude workflow", async () => {
  const root = await tempDir("lorenz-config-command");
  const workflowPath = path.join(root, "nested", "WORKFLOW.md");
  const stdout = new CaptureWriter();
  const stderr = new CaptureWriter();
  const prompter = new ScriptedPrompter([
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "ENG, PLATFORM",
  ]);

  assert.equal(
    await runConfigCommand(
      { workflowPath, force: false },
      { prompter, stdout, stderr, env: {}, cwd: root },
    ),
    0,
  );

  const workflow = await loadWorkflow(
    workflowPath,
    {
      JIRA_BASE_URL: "https://example.atlassian.net",
      JIRA_EMAIL: "agent@example.com",
      JIRA_API_KEY: "token",
    },
    {},
  );
  assert.equal(workflow.settings.tracker.kind, "jira");
  assert.equal(workflow.settings.agent.kind, "claude");
  assert.match(workflow.promptTemplate, /Use the available tracker tools/);
  assert.match(stdout.value, /Created .*WORKFLOW\.md/);
  assert.equal(stderr.value, "");
});

test("config command supports local and Codex alternatives", async () => {
  const root = await tempDir("lorenz-config-local");
  const workflowPath = path.join(root, "WORKFLOW.md");
  const prompter = new ScriptedPrompter(["local", "codex", ".lorenz/tasks", "TASK-"]);

  assert.equal(
    await runConfigCommand(
      { workflowPath, force: false },
      { prompter, stdout: new CaptureWriter(), stderr: new CaptureWriter(), cwd: root },
    ),
    0,
  );

  const workflow = await loadWorkflow(workflowPath, {}, {});
  assert.equal(workflow.settings.tracker.kind, "local");
  assert.equal(workflow.settings.agent.kind, "codex");
});

test("config command refuses an existing workflow unless forced", async () => {
  const root = await tempDir("lorenz-config-existing");
  const workflowPath = path.join(root, "WORKFLOW.md");
  await fs.writeFile(workflowPath, "existing\n");
  const stderr = new CaptureWriter();

  assert.equal(
    await runConfigCommand(
      { workflowPath, force: false },
      {
        prompter: new ScriptedPrompter([]),
        stdout: new CaptureWriter(),
        stderr,
        cwd: root,
      },
    ),
    1,
  );

  assert.equal(await fs.readFile(workflowPath, "utf8"), "existing\n");
  assert.match(stderr.value, /workflow file already exists: .*; pass --force to replace it/);
});

test("config command force-overwrites without asking for confirmation", async () => {
  const root = await tempDir("lorenz-config-force");
  const workflowPath = path.join(root, "WORKFLOW.md");
  await fs.writeFile(workflowPath, "existing\n");
  const prompter = new ScriptedPrompter([
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "ENG",
  ]);

  assert.equal(
    await runConfigCommand(
      { workflowPath, force: true },
      {
        prompter,
        stdout: new CaptureWriter(),
        stderr: new CaptureWriter(),
        cwd: root,
      },
    ),
    0,
  );

  assert.match(await fs.readFile(workflowPath, "utf8"), /kind: jira/);
});

test("config command rejects literal API secrets", async () => {
  const root = await tempDir("lorenz-config-secret-reference");
  const workflowPath = path.join(root, "WORKFLOW.md");
  const prompter = new ScriptedPrompter([
    undefined,
    undefined,
    undefined,
    undefined,
    "literal-token",
    "$CUSTOM_JIRA_TOKEN",
    "ENG",
  ]);

  assert.equal(
    await runConfigCommand(
      { workflowPath, force: false },
      {
        prompter,
        stdout: new CaptureWriter(),
        stderr: new CaptureWriter(),
        cwd: root,
      },
    ),
    0,
  );

  assert.equal(
    prompter.messages.some((message) => /literal secrets are not stored/.test(message)),
    true,
  );
  assert.match(await fs.readFile(workflowPath, "utf8"), /api_key: \$CUSTOM_JIRA_TOKEN/);
});

function defaultAnswers(): OnboardingAnswers {
  return {
    tracker: {
      kind: "jira",
      baseUrl: "$JIRA_BASE_URL",
      email: "$JIRA_EMAIL",
      apiKey: "$JIRA_API_KEY",
      projectKeys: ["ENG"],
    },
    agent: "claude",
  };
}

class CaptureWriter {
  value = "";

  write(value: string): boolean {
    this.value += value;
    return true;
  }
}

class ScriptedPrompter implements ConfigPrompter {
  readonly messages: string[] = [];

  constructor(private readonly answers: Array<string | undefined>) {}

  async select(
    _question: string,
    _choices: readonly ConfigChoice[],
    defaultValue: string,
  ): Promise<string> {
    const answer = this.answers.shift();
    return Promise.resolve(answer === undefined ? defaultValue : String(answer));
  }

  async input(_question: string, options: ConfigInputOptions = {}): Promise<string> {
    const answer = this.answers.shift();
    return Promise.resolve(answer === undefined ? (options.defaultValue ?? "") : String(answer));
  }

  message(message: string): void {
    this.messages.push(message);
  }

  close(): void {}
}
