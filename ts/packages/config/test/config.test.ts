import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { test } from "vitest";
import {
  loadWorkflow,
  parseConfig,
  parseWorkflowContent,
  settingsForIssueState,
  validateDispatchConfig,
  workflowFilePath,
} from "@symphony/cli";

import { assert } from "../../../test/assert.js";
import { tempDir } from "../../../test/helpers.js";

test("config resolves env-backed Linear token and assignee", () => {
  const settings = parseConfig(
    {
      tracker: {
        api_key: "$LINEAR_API_KEY",
        project_slug: "mono",
        assignee: "$LINEAR_ASSIGNEE",
      },
    },
    { LINEAR_API_KEY: "linear-token", LINEAR_ASSIGNEE: "worker@example.com" },
  );

  assert.equal(settings.tracker.apiKey, "linear-token");
  assert.equal(settings.tracker.assignee, "worker@example.com");
  assert.equal(settings.agent.kind, "codex");
  assert.equal(settings.agent.maxTurns, 20);
  assert.equal(settings.agent.ensembleSize, 1);
  assert.equal(settings.agents.codex?.executor, "appserver");
  assert.equal(settings.agents.claude?.executor, "acp");
});

test("config resolves op:// references via 1Password CLI", async () => {
  const root = await tempDir("symphony-op-mock");
  const opScript = path.join(root, "op");
  await fs.writeFile(
    opScript,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.0.0"; else echo "resolved-secret"; fi\n',
  );
  await fs.chmod(opScript, 0o755);

  const settings = parseConfig(
    { tracker: { api_key: "op://vault/item/field" } },
    { PATH: `${root}:${process.env.PATH}` },
  );
  assert.equal(settings.tracker.apiKey, "resolved-secret");
});

test("config resolves op:// references from env var fallback", async () => {
  const root = await tempDir("symphony-op-mock");
  const opScript = path.join(root, "op");
  await fs.writeFile(
    opScript,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.0.0"; else echo "env-secret"; fi\n',
  );
  await fs.chmod(opScript, 0o755);

  const settings = parseConfig(
    {},
    { LINEAR_API_KEY: "op://vault/item/key", PATH: `${root}:${process.env.PATH}` },
  );
  assert.equal(settings.tracker.apiKey, "env-secret");
});

test("config throws when op:// reference used but op CLI not installed", () => {
  assert.throws(
    () => parseConfig({ tracker: { api_key: "op://vault/item/field" } }, { PATH: "/nonexistent" }),
    /1Password CLI \(op\) is required.*cannot be managed by mise/,
  );
});

test("config falls back to canonical env vars when explicit env refs resolve empty", () => {
  const settings = parseConfig(
    {
      tracker: {
        api_key: "$EMPTY_TOKEN",
        assignee: "$EMPTY_ASSIGNEE",
      },
    },
    {
      EMPTY_TOKEN: "",
      EMPTY_ASSIGNEE: "",
      LINEAR_API_KEY: "fallback-token",
      LINEAR_ASSIGNEE: "fallback@example.com",
    },
  );

  assert.equal(settings.tracker.apiKey, "fallback-token");
  assert.equal(settings.tracker.assignee, "fallback@example.com");
});

test("config defaults and validation match Elixir parity", () => {
  const settings = parseConfig({}, {});

  assert.equal(settings.tracker.kind, undefined);
  assert.equal(settings.claude.model, "claude-opus-4-6[1m]");
  assert.equal(settings.observability.renderIntervalMs, 16);
  assert.throws(() => validateDispatchConfig(settings), /tracker.kind is required/);
});

test("workspace root honors SYMPHONY_WORKSPACE_ROOT and expands local tilde paths", () => {
  const configured = parseConfig({ workspace: { root: "~/configured" } }, { HOME: os.homedir() });
  assert.equal(configured.workspace.root, path.join(os.homedir(), "configured"));
  assert.equal(configured.workspace.rootExpression, "~/configured");

  const settings = parseConfig(
    { workspace: { root: "~/configured" } },
    { HOME: os.homedir(), SYMPHONY_WORKSPACE_ROOT: "~/override" },
  );

  assert.equal(settings.workspace.root, path.join(os.homedir(), "override"));
  assert.equal(settings.workspace.rootExpression, "~/override");
});

test("workspace root resolves only whole-string env references", () => {
  const resolved = parseConfig(
    { workspace: { root: "$WORKSPACE_ROOT" } },
    {
      WORKSPACE_ROOT: "/tmp/symphony-env-root",
    },
  );
  assert.equal(resolved.workspace.root, "/tmp/symphony-env-root");

  const literal = parseConfig(
    { workspace: { root: "/tmp/$WORKSPACE_ROOT/work" } },
    {
      WORKSPACE_ROOT: "expanded",
    },
  );
  assert.equal(literal.workspace.root, "/tmp/$WORKSPACE_ROOT/work");
});

test("workspace root falls back to default when env reference is unset or empty", () => {
  const fallback = path.join(os.tmpdir(), "symphony_workspaces");

  for (const env of [{}, { WORKSPACE_ROOT: "" }]) {
    const settings = parseConfig({ workspace: { root: "$WORKSPACE_ROOT" } }, env, {
      tmpdir: os.tmpdir(),
    });
    assert.equal(settings.workspace.root, fallback);
    assert.equal(settings.workspace.rootExpression, fallback);
  }

  const override = parseConfig(
    { workspace: { root: "/tmp/configured-root" } },
    { SYMPHONY_WORKSPACE_ROOT: "$UNSET_WORKSPACE_ROOT" },
    { tmpdir: os.tmpdir() },
  );
  assert.equal(override.workspace.root, fallback);
  assert.equal(override.workspace.rootExpression, fallback);
});

test("dispatch config rejects blank routes and normalizes unique route names", () => {
  assert.throws(
    () => parseConfig({ tracker: { dispatch: { only_routes: ["backend", " "] } } }),
    /tracker.dispatch.only_routes must not contain blank routes/,
  );

  assert.deepEqual(
    parseConfig({
      tracker: { dispatch: { only_routes: ["Backend", " backend ", "Frontend"] } },
    }).tracker.dispatch.onlyRoutes,
    ["backend", "frontend"],
  );
});

test("Codex sandbox config rejects non-parity shapes", () => {
  assert.throws(
    () => parseConfig({ codex: { turn_sandbox_policy: "workspace-write" } }),
    /codex.turn_sandbox_policy must be a map/,
  );
  assert.throws(
    () => parseConfig({ codex: { thread_sandbox: { type: "workspaceWrite" } } }),
    /codex.thread_sandbox must be a string/,
  );

  assert.equal(parseConfig().codex.turnSandboxPolicy, null);
});

test("config validates literal-only backend, approval, and sandbox names", () => {
  const settings = parseConfig({
    tracker: { kind: "memory" },
    codex: { approval_policy: "never", thread_sandbox: "danger-full-access" },
  });

  assert.equal(settings.tracker.kind, "memory");
  assert.equal(settings.codex.approvalPolicy, "never");
  assert.equal(settings.codex.threadSandbox, "danger-full-access");

  assert.throws(
    () => parseConfig({ tracker: { kind: "github" } }),
    /unsupported tracker.kind: github/,
  );
  assert.throws(
    () => parseConfig({ codex: { approval_policy: "ask-always" } }),
    /unsupported codex.approval_policy: ask-always/,
  );
  assert.throws(
    () => parseConfig({ codex: { thread_sandbox: "workspaceWrite" } }),
    /unsupported codex.thread_sandbox: workspaceWrite/,
  );
  assert.throws(
    () =>
      parseConfig({
        status_overrides: {
          Todo: { codex: { thread_sandbox: "workspaceWrite" } },
        },
      }),
    /unsupported status_overrides\.\*\.codex\.thread_sandbox: workspaceWrite/,
  );
});

test("agents map hoists legacy backends and can override known runtime settings", () => {
  const settings = parseConfig({
    agent: { kind: "codex" },
    codex: { command: "legacy-codex", read_timeout_ms: 123 },
    claude: { command: "legacy-claude", model: "legacy-model", permission_mode: "acceptEdits" },
    agents: {
      codex: {
        executor: "appserver",
        command: "codex-from-agent-map",
        read_timeout_ms: 456,
      },
      claude: {
        executor: "acp",
        bridge_command: "claude-agent-acp",
        bridge_args: ["--permission-mode", "acceptEdits"],
        model: "opus-agent",
      },
      pi: {
        executor: "acp",
        bridge_command: "pi-acp",
        bridge_args: ["--safe-mode"],
      },
    },
  });

  assert.equal(settings.codex.command, "codex-from-agent-map");
  assert.equal(settings.codex.readTimeoutMs, 456);
  assert.equal(settings.claude.command, "claude-agent-acp");
  assert.equal(settings.claude.model, "opus-agent");
  assert.deepEqual(settings.agents.pi, {
    executor: "acp",
    bridgeCommand: "pi-acp",
    bridgeArgs: ["--safe-mode"],
    model: "legacy-model",
    permissionMode: "acceptEdits",
    turnTimeoutMs: 3_600_000,
    stallTimeoutMs: 300_000,
    strictMcpConfig: true,
  });
});

test("dispatch validation requires configured agents for active and override states", () => {
  const missing = parseConfig({
    tracker: { kind: "memory" },
    agent: { kind: "pi" },
  });
  delete missing.agents.pi;
  assert.throws(() => validateDispatchConfig(missing), /agents\.pi is required/);

  const invalidBridge = parseConfig({
    tracker: { kind: "memory" },
    agent: { kind: "pi" },
    agents: { pi: { executor: "acp", bridge_command: "" } },
  });
  assert.throws(
    () => validateDispatchConfig(invalidBridge),
    /agents\.pi\.bridgeCommand is required/,
  );
});

test("undocumented top-level compatibility keys are ignored", () => {
  const settings = parseConfig({
    tracker_kind: "memory",
    max_turns: 3,
    codex_command: "custom-codex",
    workspace_root: "/tmp/legacy-root",
    hook_before_run: "echo legacy",
  });

  assert.equal(settings.tracker.kind, undefined);
  assert.equal(settings.agent.maxTurns, 20);
  assert.equal(settings.codex.command, "codex app-server");
  assert.notEqual(settings.workspace.root, "/tmp/legacy-root");
  assert.equal(settings.hooks.beforeRun, null);
});

test("known workflow sections reject unsupported nested keys after alias normalization", () => {
  assert.throws(
    () =>
      parseConfig({
        tracker: { kind: "memory", project_slug: "mono", surprise: true },
      }),
    /tracker contains unsupported keys: surprise/,
  );

  assert.throws(
    () =>
      parseConfig({
        agent: { max_turns: 3, maxTurns: 4, typo: 5 },
      }),
    /agent contains unsupported keys: typo/,
  );
});

test("status overrides normalize state names and deep merge Codex policy maps", () => {
  const settings = parseConfig({
    status_overrides: {
      "In Progress": {
        agent: { kind: "claude", max_turns: 5 },
        codex: { approval_policy: { reject: { rules: false } } },
      },
    },
  });

  const effective = settingsForIssueState(settings, "in progress");
  assert.equal(effective.agent.kind, "claude");
  assert.equal(effective.agent.maxTurns, 5);
  assert.deepEqual(effective.codex.approvalPolicy, {
    reject: {
      sandbox_approval: true,
      rules: false,
      mcp_elicitations: true,
    },
  });
});

test("dispatch validation preflights backend commands reachable through status overrides", () => {
  const settings = parseConfig({
    tracker: { kind: "memory" },
    claude: { command: "" },
    status_overrides: {
      "In Progress": { agent: { kind: "claude" } },
    },
  });

  assert.throws(() => validateDispatchConfig(settings), /claude.command is required/);
});

test("config rejects empty strings and booleans for typed fields", () => {
  assert.throws(
    () => parseConfig({ polling: { interval_ms: "" } }),
    /polling.interval_ms must be a positive integer/,
  );
  assert.throws(
    () => parseConfig({ codex: { stall_timeout_ms: " " } }),
    /codex.stall_timeout_ms must be a non-negative integer/,
  );
  assert.throws(
    () => parseConfig({ server: { port: "" } }),
    /server.port must be a valid port number/,
  );
  assert.throws(
    () => parseConfig({ server: { port: 99999 } }),
    /server.port must be a valid port number/,
  );
  assert.throws(
    () => parseConfig({ polling: { interval_ms: true } }),
    /polling.interval_ms must be a positive integer/,
  );
  assert.throws(
    () => parseConfig({ observability: { dashboard_enabled: "" } }),
    /expected a boolean/,
  );
  assert.throws(() => parseConfig({ tracker: { kind: "" } }), /unsupported tracker.kind/);
});

test("stall_timeout_ms=0 is accepted as a valid value at top-level and in status overrides", () => {
  const settings = parseConfig({
    codex: { stall_timeout_ms: 0 },
    claude: { stall_timeout_ms: 0 },
    status_overrides: {
      Todo: {
        codex: { stall_timeout_ms: 0 },
        claude: { stall_timeout_ms: 0 },
      },
    },
  });

  assert.equal(settings.codex.stallTimeoutMs, 0);
  assert.equal(settings.claude.stallTimeoutMs, 0);

  const effective = settingsForIssueState(settings, "Todo");
  assert.equal(effective.codex.stallTimeoutMs, 0);
  assert.equal(effective.claude.stallTimeoutMs, 0);
});

test("hooks accept explicit null as disabled", () => {
  const settings = parseConfig({
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
    },
  });

  assert.equal(settings.hooks.afterCreate, null);
  assert.equal(settings.hooks.beforeRun, null);
  assert.equal(settings.hooks.afterRun, null);
  assert.equal(settings.hooks.beforeRemove, null);
});

test("config reports useful errors for list fields and agent executors", () => {
  assert.throws(
    () => parseConfig({ tracker: { active_states: "Todo" } }),
    /tracker.active_states must be a list of strings/,
  );
  assert.throws(
    () => parseConfig({ worker: { ssh_hosts: "worker-a" } }),
    /worker.ssh_hosts must be a list of strings/,
  );
  assert.throws(
    () => parseConfig({ agents: { pi: { executor: "acp", bridge_args: "--safe-mode" } } }),
    /agents.pi.bridge_args must be a list of strings/,
  );
  assert.throws(
    () => parseConfig({ agents: { pi: { executor: "foo" } } }),
    /unsupported agents.pi.executor: foo/,
  );
});

test("config ignores custom logging.log_file and uses default path", () => {
  const settings = parseConfig({
    logging: { log_file: "tmp/custom/symphony.log" },
  });

  assert.equal(settings.logging.logFile, "./log/symphony.log");
});

test("status overrides reject legacy per-state map and unknown sections", () => {
  assert.throws(
    () =>
      parseConfig({
        status_overrides: {
          Todo: {
            agent: { max_concurrent_agents_by_state: { Todo: 1 } },
          },
        },
      }),
    /unsupported keys/,
  );

  assert.throws(
    () =>
      parseConfig({
        status_overrides: {
          Todo: { worker: { ssh_timeout_ms: 1 } },
        },
      }),
    /unsupported keys/,
  );
});

test("copied workflow examples load independently in the TypeScript port", async () => {
  const root = path.resolve("..");
  for (const name of ["WORKFLOW.md", "WORKFLOW_FULL_ACCESS.md"]) {
    const workflow = await loadWorkflow(path.join(root, "ts", name), {
      LINEAR_API_KEY: "test-token",
      LINEAR_ASSIGNEE: "worker@example.com",
    });
    assert.equal(workflow.settings.tracker.dispatch.acceptUnrouted, true);
    assert.equal(workflow.settings.tracker.dispatch.routeLabelPrefix, "Symphony:");
    assert.ok(workflow.promptTemplate.length > 100);
  }
});

test("workflow path defaults match Elixir SYMPHONY_WORKFLOW then cwd WORKFLOW.md", async () => {
  const root = await tempDir("symphony-ts-workflow-env");
  const workflowPath = path.join(root, "CUSTOM_WORKFLOW.md");
  await fs.writeFile(workflowPath, "plain prompt");

  assert.equal(workflowFilePath({ SYMPHONY_WORKFLOW: workflowPath }, root), workflowPath);
  assert.equal(workflowFilePath({}, root), path.join(root, "WORKFLOW.md"));

  const workflow = await loadWorkflow(undefined, {
    SYMPHONY_WORKFLOW: workflowPath,
    LINEAR_API_KEY: "test-token",
  });
  assert.equal(workflow.path, workflowPath);
  assert.deepEqual(workflow.config, {});
  assert.equal(workflow.promptTemplate, "plain prompt");

  await assert.rejects(
    () => loadWorkflow(path.join(root, "MISSING_WORKFLOW.md")),
    /missing_workflow_file:/,
  );
});

test("workflow parsing treats front matter as optional like Elixir", () => {
  assert.deepEqual(parseWorkflowContent(" plain prompt\n"), {
    config: {},
    body: "plain prompt",
  });
  assert.deepEqual(parseWorkflowContent("---\ntracker:\n  kind: memory\n---\nPrompt\n"), {
    config: { tracker: { kind: "memory" } },
    body: "Prompt",
  });
  assert.deepEqual(parseWorkflowContent("---\ntracker:\n  kind: memory\nPrompt"), {
    config: {},
    body: "---\ntracker:\n  kind: memory\nPrompt",
  });
  assert.deepEqual(parseWorkflowContent("---\ntracker:\n  kind: memory\n---\u2028Prompt\n"), {
    config: { tracker: { kind: "memory" } },
    body: "Prompt",
  });
  assert.throws(
    () => parseWorkflowContent("---\nnull\n---\nPrompt"),
    /workflow_front_matter_not_a_map/,
  );
  assert.throws(
    () => parseWorkflowContent("---\n[]\n---\nPrompt"),
    /workflow_front_matter_not_a_map/,
  );
  assert.throws(
    () => parseWorkflowContent("---\ntracker:\n  kind: [\n---\nPrompt"),
    /workflow_parse_error/,
  );
});

test("parses local tracker config with path", () => {
  const settings = parseConfig(
    { tracker: { kind: "local", path: ".symphony/local", active_states: ["Todo"] } },
    {},
  );
  assert.equal(settings.tracker.kind, "local");
  assert.equal(settings.tracker.path, ".symphony/local");
});

test("local tracker id_prefix defaults to BOARD- and can be overridden", () => {
  const def = parseConfig({ tracker: { kind: "local" } }, {});
  assert.equal(def.tracker.idPrefix, "BOARD-");

  const custom = parseConfig({ tracker: { kind: "local", id_prefix: "XXX-" } }, {});
  assert.equal(custom.tracker.idPrefix, "XXX-");
});

test("an unsafe id_prefix is rejected at config parse", () => {
  assert.throws(
    () => parseConfig({ tracker: { kind: "local", id_prefix: "../evil" } }, {}),
    /id_prefix/,
  );
  assert.throws(
    () => parseConfig({ tracker: { kind: "local", id_prefix: "a/b" } }, {}),
    /id_prefix/,
  );
});

test("config validation accepts project_slugs as an alternative to project_slug", () => {
  const settings = parseConfig(
    {
      tracker: {
        kind: "linear",
        api_key: "token",
        project_slugs: ["slug-a", "slug-b"],
        active_states: ["Todo"],
      },
      agent: { kind: "codex" },
      agents: { codex: { command: "codex" } },
    },
    {},
  );

  assert.deepEqual(settings.tracker.projectSlugs, ["slug-a", "slug-b"]);
  validateDispatchConfig(settings);
});

test("config validation accepts project_labels as an alternative to project_slug", () => {
  const settings = parseConfig(
    {
      tracker: {
        kind: "linear",
        api_key: "token",
        project_labels: ["team:backend"],
        active_states: ["Todo"],
      },
      agent: { kind: "codex" },
      agents: { codex: { command: "codex" } },
    },
    {},
  );

  assert.deepEqual(settings.tracker.projectLabels, ["team:backend"]);
  validateDispatchConfig(settings);
});

test("config validation rejects when no project config is provided for linear tracker", () => {
  const settings = parseConfig(
    {
      tracker: {
        kind: "linear",
        api_key: "token",
        active_states: ["Todo"],
      },
      agent: { kind: "codex" },
      agents: { codex: { command: "codex" } },
    },
    {},
  );

  assert.throws(
    () => validateDispatchConfig(settings),
    /tracker.project_slug, tracker.project_slugs, or tracker.project_labels is required/,
  );
});

test("config validation rejects when multiple project configs are provided", () => {
  const settings = parseConfig(
    {
      tracker: {
        kind: "linear",
        api_key: "token",
        project_slug: "mono",
        project_slugs: ["slug-a"],
        active_states: ["Todo"],
      },
      agent: { kind: "codex" },
      agents: { codex: { command: "codex" } },
    },
    {},
  );

  assert.throws(
    () => validateDispatchConfig(settings),
    /tracker.project_slug, tracker.project_slugs, and tracker.project_labels are mutually exclusive/,
  );
});
