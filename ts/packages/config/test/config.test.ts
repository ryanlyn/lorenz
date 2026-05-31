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

test("config parses slack bot_user_id and resolves SLACK_BOT_USER_ID fallback", () => {
  const explicit = parseConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U_EXPLICIT" } },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
  assert.equal(explicit.tracker.botUserId, "U_EXPLICIT");

  const fromEnv = parseConfig(
    { tracker: { kind: "slack", channels: ["C1"] } },
    { SLACK_BOT_TOKEN: "xoxb-test", SLACK_BOT_USER_ID: "U_ENV" },
  );
  assert.equal(fromEnv.tracker.botUserId, "U_ENV");

  const fromEnvRef = parseConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "$SLACK_BOT_USER_ID" } },
    { SLACK_BOT_TOKEN: "xoxb-test", SLACK_BOT_USER_ID: "U_REF" },
  );
  assert.equal(fromEnvRef.tracker.botUserId, "U_REF");

  const unset = parseConfig(
    { tracker: { kind: "slack", channels: ["C1"] } },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
  assert.equal(unset.tracker.botUserId, undefined);
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
    () => parseConfig({ polling: { interval_ms: true } }),
    /polling.interval_ms must be a positive integer/,
  );
  assert.throws(
    () => parseConfig({ observability: { dashboard_enabled: "" } }),
    /expected a boolean/,
  );
  assert.throws(() => parseConfig({ tracker: { kind: "" } }), /unsupported tracker.kind/);
});

test("stall timeout zero and workflow logging extension match Elixir config semantics", () => {
  const settings = parseConfig({
    codex: { stall_timeout_ms: 0 },
    claude: { stall_timeout_ms: 0 },
    logging: { log_file: "tmp/custom/symphony.log" },
    status_overrides: {
      Todo: {
        codex: { stall_timeout_ms: 0 },
        claude: { stall_timeout_ms: 0 },
      },
    },
  });

  assert.equal(settings.codex.stallTimeoutMs, 0);
  assert.equal(settings.claude.stallTimeoutMs, 0);
  assert.equal(settings.logging.logFile, "./log/symphony.log");

  const effective = settingsForIssueState(settings, "Todo");
  assert.equal(effective.codex.stallTimeoutMs, 0);
  assert.equal(effective.claude.stallTimeoutMs, 0);
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
    { tracker: { kind: "local", path: ".symphony/board", active_states: ["Todo"] } },
    {},
  );
  assert.equal(settings.tracker.kind, "local");
  assert.equal(settings.tracker.path, ".symphony/board");
});

test("parses slack tracker config with channels, emoji overrides, and token env", () => {
  const settings = parseConfig(
    { tracker: { kind: "slack", channels: ["C1", "C2"], emoji_states: { rocket: "Shipped" } } },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
  assert.equal(settings.tracker.kind, "slack");
  assert.equal(settings.tracker.endpoint, "https://slack.com/api");
  assert.equal(settings.tracker.apiKey, "xoxb-test");
  assert.deepEqual(settings.tracker.channels, ["C1", "C2"]);
  assert.deepEqual(settings.tracker.emojiStates, { rocket: "Shipped" });
});

test("cloned settings deep-copy slack channels and emoji states", () => {
  const settings = parseConfig(
    { tracker: { kind: "slack", channels: ["C1", "C2"], emoji_states: { rocket: "Shipped" } } },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
  const clone = settingsForIssueState(settings, "Todo");

  clone.tracker.channels!.push("C3");
  clone.tracker.emojiStates!.rocket = "Mutated";

  assert.deepEqual(settings.tracker.channels, ["C1", "C2"]);
  assert.deepEqual(settings.tracker.emojiStates, { rocket: "Shipped" });
});

test("slack tracker requires a token and at least one channel", () => {
  assert.throws(
    () =>
      validateDispatchConfig(
        parseConfig({ tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U_BOT" } }, {}),
      ),
    /SLACK_BOT_TOKEN/,
  );
  assert.throws(
    () =>
      validateDispatchConfig(
        parseConfig(
          { tracker: { kind: "slack", bot_user_id: "U_BOT" } },
          { SLACK_BOT_TOKEN: "xoxb-test" },
        ),
      ),
    /channels is required/,
  );
});

test("slack tracker requires bot_user_id so mentions are scoped to the bot (fail closed)", () => {
  // Without a bot user id the mention matcher would fall back to matching ANY <@U...> mention,
  // spawning agents on ordinary human-to-human chatter. Validation must reject that config.
  assert.throws(
    () =>
      validateDispatchConfig(
        parseConfig({ tracker: { kind: "slack", channels: ["C1"] } }, { SLACK_BOT_TOKEN: "xoxb" }),
      ),
    /bot_user_id.*required|SLACK_BOT_USER_ID/,
  );
  // An empty SLACK_BOT_USER_ID env value must not satisfy the requirement either.
  assert.throws(
    () =>
      validateDispatchConfig(
        parseConfig(
          { tracker: { kind: "slack", channels: ["C1"] } },
          { SLACK_BOT_TOKEN: "xoxb", SLACK_BOT_USER_ID: "" },
        ),
      ),
    /bot_user_id.*required|SLACK_BOT_USER_ID/,
  );
  // With a bot user id present (explicit or via env), validation passes.
  validateDispatchConfig(
    parseConfig(
      { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U_BOT" } },
      { SLACK_BOT_TOKEN: "xoxb" },
    ),
  );
  validateDispatchConfig(
    parseConfig(
      { tracker: { kind: "slack", channels: ["C1"] } },
      { SLACK_BOT_TOKEN: "xoxb", SLACK_BOT_USER_ID: "U_ENV" },
    ),
  );
});
