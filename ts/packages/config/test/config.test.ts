import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { test } from "vitest";
import { PROVIDER_KINDS } from "@symphony/domain";
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
  assert.equal(settings.agents.codex?.executor, "acp");
  const codexAgent = settings.agents.codex as any;
  assert.equal(codexAgent.bridgeCommand, "codex-acp");
  assert.equal(settings.agents.claude?.executor, "acp");
});

test("partial codex agent override preserves bridgeCommand codex-acp", () => {
  const settings = parseConfig({
    agents: { codex: { stall_timeout_ms: 60000 } },
  });

  const codexAgent = settings.agents.codex as any;
  assert.equal(codexAgent.executor, "acp");
  assert.equal(codexAgent.bridgeCommand, "codex-acp");
  assert.equal(codexAgent.usageAccounting, "per-turn");
  assert.equal(codexAgent.stallTimeoutMs, 60000);
  assert.equal(codexAgent.providerConfig, undefined);
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

test("non-Linear tracker configs ignore Linear secret env fallbacks", () => {
  for (const kind of ["local", "memory"] as const) {
    const settings = parseConfig(
      { tracker: { kind } },
      {
        LINEAR_API_KEY: "op://vault/item/key",
        LINEAR_ASSIGNEE: "op://vault/item/assignee",
        PATH: "/nonexistent",
      },
    );
    assert.equal(settings.tracker.kind, kind);
    assert.equal(settings.tracker.apiKey, undefined);
    assert.equal(settings.tracker.assignee, undefined);
  }
});

test("non-Linear tracker configs still resolve explicitly configured secrets", async () => {
  const root = await tempDir("symphony-op-mock");
  const opScript = path.join(root, "op");
  await fs.writeFile(
    opScript,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.0.0"; else echo "resolved-secret"; fi\n',
  );
  await fs.chmod(opScript, 0o755);

  const settings = parseConfig(
    {
      tracker: {
        kind: "local",
        api_key: "op://vault/item/key",
        assignee: "op://vault/item/assignee",
      },
    },
    { PATH: `${root}:${process.env.PATH}` },
  );
  assert.equal(settings.tracker.apiKey, "resolved-secret");
  assert.equal(settings.tracker.assignee, "resolved-secret");
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

test("config defaults and validation match expected defaults", () => {
  const settings = parseConfig({}, {});

  assert.equal(settings.tracker.kind, undefined);
  assert.deepEqual(settings.claude.providerConfig, { permissions: { defaultMode: "dontAsk" } });
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

test("workspace defaults to per-agent isolation", () => {
  assert.equal(parseConfig({}).workspace.isolation, "per-agent");
});

test('workspace.isolation = "none" runs every agent in the configured root', () => {
  const settings = parseConfig(
    { workspace: { root: "~/agents", isolation: "none" } },
    { HOME: os.homedir() },
  );
  assert.equal(settings.workspace.isolation, "none");
  assert.equal(settings.workspace.root, path.join(os.homedir(), "agents"));
  assert.equal(settings.workspace.rootExpression, "~/agents");
});

test("workspace.root accepts an explicit per-agent isolation override", () => {
  const settings = parseConfig({ workspace: { root: "/srv/agents", isolation: "per-agent" } });
  assert.equal(settings.workspace.isolation, "per-agent");
  assert.equal(settings.workspace.root, "/srv/agents");
});

test("workspace.isolation rejects unknown values", () => {
  assert.throws(() => parseConfig({ workspace: { isolation: "per-issue" } }), /isolation/);
});

test('workspace.isolation = "none" rejects every lifecycle hook', () => {
  for (const hook of ["after_create", "before_run", "after_run", "before_remove"]) {
    assert.throws(
      () =>
        parseConfig({
          workspace: { root: "/srv/agents", isolation: "none" },
          hooks: { [hook]: "echo hi" },
        }),
      new RegExp(`workspace.isolation = "none" does not support hooks; remove ${hook}`),
    );
  }
});

test('workspace.isolation = "none" error lists all configured hooks', () => {
  assert.throws(
    () =>
      parseConfig({
        workspace: { root: "/srv/agents", isolation: "none" },
        hooks: { before_run: "a", after_run: "b" },
      }),
    /remove before_run, after_run/,
  );
});

test('workspace.isolation = "none" allows a hooks block with only a timeout', () => {
  const settings = parseConfig({
    workspace: { root: "/srv/agents", isolation: "none" },
    hooks: { timeout_ms: 1_000 },
  });
  assert.equal(settings.workspace.isolation, "none");
  assert.equal(settings.hooks.timeoutMs, 1_000);
});

test("per-agent workspaces still accept hooks", () => {
  const settings = parseConfig({
    workspace: { root: "/srv/agents" },
    hooks: { after_create: "echo hi" },
  });
  assert.equal(settings.workspace.isolation, "per-agent");
  assert.equal(settings.hooks.afterCreate, "echo hi");
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

test("server.host falls back to loopback when configured as an empty string", () => {
  const settings = parseConfig({ server: { host: "" } });
  assert.equal(settings.server.host, "127.0.0.1");
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

test("config validates literal-only backend names and rejects removed Codex keys", () => {
  const settings = parseConfig({
    tracker: { kind: "memory" },
  });

  assert.equal(settings.tracker.kind, "memory");

  assert.throws(
    () => parseConfig({ tracker: { kind: "github" } }),
    /unsupported tracker.kind: github/,
  );
  assert.throws(
    () => parseConfig({ codex: { approval_policy: "never" } }),
    /codex contains unsupported keys: approval_policy/,
  );
  assert.throws(
    () => parseConfig({ codex: { thread_sandbox: "workspaceWrite" } }),
    /codex contains unsupported keys: thread_sandbox/,
  );
  assert.throws(
    () =>
      parseConfig({
        status_overrides: {
          Todo: { codex: { thread_sandbox: "workspaceWrite" } },
        },
      }),
    /status_overrides.todo.codex contains unsupported keys: thread_sandbox/,
  );
});

test("agents map overrides known runtime settings via ACP records", () => {
  const settings = parseConfig({
    agent: { kind: "codex" },
    codex: { turn_timeout_ms: 60_000 },
    claude: {
      command: "legacy-claude",
      provider_config: { permissions: { defaultMode: "acceptEdits" } },
    },
    agents: {
      codex: {
        bridge_command: "codex-custom",
        turn_timeout_ms: 120_000,
        stall_timeout_ms: 42_000,
      },
      claude: {
        bridge_command: "claude-agent-acp",
        provider_config: { permissions: { defaultMode: "acceptEdits" } },
      },
      pi: {
        bridge_command: "pi-acp",
        provider_config: { safe_mode: true },
        usage_accounting: "cumulative",
      },
    },
  });

  assert.equal(settings.agents.codex.bridgeCommand, "codex-custom");
  assert.equal(settings.agents.codex.turnTimeoutMs, 120_000);
  assert.equal(settings.agents.codex.stallTimeoutMs, 42_000);
  assert.equal(settings.codex.command, "codex-custom");
  assert.equal(settings.codex.turnTimeoutMs, 120_000);
  assert.equal(settings.codex.stallTimeoutMs, 42_000);
  assert.equal(settings.claude.command, "claude-agent-acp");
  assert.deepEqual(settings.claude.providerConfig, { permissions: { defaultMode: "acceptEdits" } });
  assert.deepEqual(settings.agents.pi, {
    executor: "acp",
    bridgeCommand: "pi-acp",
    providerConfig: { safe_mode: true },
    usageAccounting: "cumulative",
    turnTimeoutMs: 3_600_000,
    stallTimeoutMs: 300_000,
    strictMcpConfig: true,
  });
});

test("custom ACP agents default to cumulative usage unless using a known per-turn bridge", () => {
  const settings = parseConfig({
    agents: {
      pi: { bridge_command: "pi-acp" },
      codex_alias: { bridge_command: "codex-acp" },
      claude_alias: { bridge_command: "claude-agent-acp" },
    },
  });

  assert.equal(settings.agents.pi.usageAccounting, "cumulative");
  assert.equal(settings.agents.pi.providerConfig, undefined);
  assert.equal(settings.agents.codex_alias.usageAccounting, "per-turn");
  assert.equal(settings.agents.codex_alias.providerConfig, undefined);
  assert.equal(settings.agents.claude_alias.usageAccounting, "per-turn");
  assert.deepEqual(settings.agents.claude_alias.providerConfig, {
    permissions: { defaultMode: "dontAsk" },
  });
});

test("agents map accepts shared timeout defaults with legacy per-agent overrides", () => {
  const settings = parseConfig({
    agents: {
      turn_timeout_ms: 90_000,
      stall_timeout_ms: 0,
      claude: {
        turn_timeout_ms: 120_000,
        stall_timeout_ms: 5_000,
      },
      pi: {
        bridge_command: "pi-acp",
      },
    },
  });

  assert.equal(settings.agents.codex.turnTimeoutMs, 90_000);
  assert.equal(settings.agents.codex.stallTimeoutMs, 0);
  assert.equal(settings.agents.claude.turnTimeoutMs, 120_000);
  assert.equal(settings.agents.claude.stallTimeoutMs, 5_000);
  assert.equal(settings.claude.turnTimeoutMs, 120_000);
  assert.equal(settings.claude.stallTimeoutMs, 5_000);
  assert.equal(settings.agents.pi.turnTimeoutMs, 90_000);
  assert.equal(settings.agents.pi.stallTimeoutMs, 0);
});

test("legacy top-level claude timeouts remain fallback when agents defaults are omitted", () => {
  const settings = parseConfig({
    claude: {
      turn_timeout_ms: 130_000,
      stall_timeout_ms: 7_000,
    },
    agents: {
      pi: {
        bridge_command: "pi-acp",
      },
    },
  });

  assert.equal(settings.agents.claude.turnTimeoutMs, 130_000);
  assert.equal(settings.agents.claude.stallTimeoutMs, 7_000);
  assert.equal(settings.agents.pi.turnTimeoutMs, 130_000);
  assert.equal(settings.agents.pi.stallTimeoutMs, 7_000);
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
  assert.equal(settings.codex.command, "codex-acp");
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

test("status overrides normalize state names and merge backend timeout settings", () => {
  const settings = parseConfig({
    status_overrides: {
      "In Progress": {
        agent: { kind: "claude", max_turns: 5 },
        codex: { turn_timeout_ms: 120_000 },
      },
    },
  });

  const effective = settingsForIssueState(settings, "in progress");
  assert.equal(effective.agent.kind, "claude");
  assert.equal(effective.agent.maxTurns, 5);
  assert.equal(effective.codex.turnTimeoutMs, 120_000);
});

test("status overrides rederive agents timeout records from overridden backend blocks", () => {
  const settings = parseConfig({
    status_overrides: {
      Todo: {
        codex: { turn_timeout_ms: 120_000, stall_timeout_ms: 45_000 },
        claude: { turn_timeout_ms: 180_000, stall_timeout_ms: 60_000 },
      },
    },
  });

  const effective = settingsForIssueState(settings, "todo");

  assert.equal(effective.codex.turnTimeoutMs, 120_000);
  assert.equal(effective.codex.stallTimeoutMs, 45_000);
  assert.equal(effective.agents.codex?.turnTimeoutMs, 120_000);
  assert.equal(effective.agents.codex?.stallTimeoutMs, 45_000);
  assert.equal(effective.claude.turnTimeoutMs, 180_000);
  assert.equal(effective.claude.stallTimeoutMs, 60_000);
  assert.equal(effective.agents.claude?.turnTimeoutMs, 180_000);
  assert.equal(effective.agents.claude?.stallTimeoutMs, 60_000);
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
    () => parseConfig({ agents: { pi: { executor: "foo" } } }),
    /unsupported agents\.pi\.executor/,
  );
});

test("config ignores custom logging.log_file and uses default path", () => {
  const settings = parseConfig({
    logging: { log_file: "tmp/custom/symphony.log" },
  });

  assert.equal(settings.logging.logFile, path.join(os.homedir(), ".symphony/log/symphony.log"));
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

test("workflow path defaults match SYMPHONY_WORKFLOW then cwd WORKFLOW.md", async () => {
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

test("workflow parsing treats front matter as optional", () => {
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

test("worker.box_pool parses all keys with snake_case aliasing", () => {
  const settings = parseConfig({
    worker: {
      box_pool: {
        enabled: true,
        provider: "static-ssh",
        min: 1,
        max: 4,
        warm: 2,
        max_in_flight: 3,
        ttl_ms: 7_200_000,
        idle_reap_ms: 120_000,
        acquire_timeout_ms: 45_000,
        reap_interval_ms: 10_000,
        stale_heartbeat_ms: 900_000,
        drain_deadline_ms: 20_000,
        max_boxes_per_issue: 2,
        spend: {
          max_concurrent_boxes: 5,
          max_box_seconds: 7_200,
          daily_box_seconds: 86_400,
        },
        provider_options: {
          ssh_hosts: ["user@host-a:22", "user@host-b:22"],
        },
      },
    },
  });

  const boxPool = settings.worker.boxPool;
  assert.ok(boxPool);
  assert.equal(boxPool?.enabled, true);
  assert.equal(boxPool?.provider, "static-ssh");
  assert.equal(boxPool?.min, 1);
  assert.equal(boxPool?.max, 4);
  assert.equal(boxPool?.warm, 2);
  assert.equal(boxPool?.slotsPerMachine, 3);
  assert.equal(boxPool?.maxInFlight, 3);
  assert.equal(boxPool?.ttlMs, 7_200_000);
  assert.equal(boxPool?.idleReapMs, 120_000);
  assert.equal(boxPool?.acquireTimeoutMs, 45_000);
  assert.equal(boxPool?.reapIntervalMs, 10_000);
  assert.equal(boxPool?.staleHeartbeatMs, 900_000);
  assert.equal(boxPool?.drainDeadlineMs, 20_000);
  assert.equal(boxPool?.maxBoxesPerIssue, 2);
  assert.deepEqual(boxPool?.spend, {
    maxConcurrentBoxes: 5,
    maxBoxSeconds: 7_200,
    dailyBoxSeconds: 86_400,
  });
  assert.deepEqual(boxPool?.providerOptions, {
    ssh_hosts: ["user@host-a:22", "user@host-b:22"],
  });
});

test("worker.box_pool parses co_residence and max_concurrent_tunnels (snake->camel)", () => {
  const settings = parseConfig({
    worker: {
      box_pool: {
        enabled: true,
        provider: "fake",
        max_in_flight: 2,
        co_residence: true,
        max_concurrent_tunnels: 8,
      },
    },
  });

  const boxPool = settings.worker.boxPool;
  assert.ok(boxPool);
  assert.equal(boxPool?.coResidence, true);
  assert.equal(boxPool?.maxConcurrentTunnels, 8);

  // cloneSettings (via the issue-state clone) copies both new optionals.
  const clone = settingsForIssueState(settings, "Todo").worker.boxPool;
  assert.ok(clone);
  assert.equal(clone?.coResidence, true);
  assert.equal(clone?.maxConcurrentTunnels, 8);
});

test("worker.box_pool co_residence and max_concurrent_tunnels default absent", () => {
  const settings = parseConfig({
    worker: { box_pool: { enabled: true, provider: "fake" } },
  });

  const boxPool = settings.worker.boxPool;
  assert.ok(boxPool);
  assert.equal(boxPool?.coResidence, undefined);
  assert.equal(boxPool?.maxConcurrentTunnels, undefined);
  assert.equal("coResidence" in boxPool!, false);
  assert.equal("maxConcurrentTunnels" in boxPool!, false);
});

test("worker.box_pool rejects non-positive max_concurrent_tunnels", () => {
  assert.throws(
    () => parseConfig({ worker: { box_pool: { max_concurrent_tunnels: 0 } } }),
    /worker\.box_pool\.max_concurrent_tunnels must be a positive integer/,
  );
});

test("worker.box_pool applies defaults when keys omitted", () => {
  const settings = parseConfig({
    worker: {
      box_pool: { enabled: true, provider: "fake" },
    },
  });

  const boxPool = settings.worker.boxPool;
  assert.ok(boxPool);
  assert.equal(boxPool?.enabled, true);
  assert.equal(boxPool?.provider, "fake");
  assert.equal(boxPool?.min, 0);
  assert.equal(boxPool?.max, 1);
  assert.equal(boxPool?.warm, 1);
  assert.equal(boxPool?.slotsPerMachine, 1);
  assert.equal(boxPool?.maxInFlight, 1);
  assert.equal(boxPool?.ttlMs, 3_600_000);
  assert.equal(boxPool?.idleReapMs, 300_000);
  assert.equal(boxPool?.acquireTimeoutMs, 30_000);
  assert.equal(boxPool?.reapIntervalMs, 15_000);
  assert.equal(boxPool?.staleHeartbeatMs, 600_000);
  assert.equal(boxPool?.drainDeadlineMs, 30_000);
  assert.equal(boxPool?.maxBoxesPerIssue, undefined);
  assert.equal(boxPool?.spend, undefined);
  assert.equal(boxPool?.providerOptions, undefined);
});

test("worker.box_pool max_in_flight parses into slotsPerMachine with maxInFlight mirroring it", () => {
  const settings = parseConfig({
    worker: {
      box_pool: { enabled: true, provider: "fake", max_in_flight: 3 },
    },
  });

  const boxPool = settings.worker.boxPool;
  assert.ok(boxPool);
  assert.equal(boxPool?.slotsPerMachine, 3);
  assert.equal(boxPool?.maxInFlight, 3);
  assert.equal(boxPool?.maxInFlight, boxPool?.slotsPerMachine);

  const clone = settingsForIssueState(settings, "Todo").worker.boxPool;
  assert.ok(clone);
  assert.equal(clone?.slotsPerMachine, 3);
  assert.equal(clone?.maxInFlight, 3);
  assert.equal(clone?.maxInFlight, clone?.slotsPerMachine);
});

test("absent box_pool leaves settings.worker.boxPool undefined", () => {
  const settings = parseConfig({ worker: { ssh_timeout_ms: 1_000 } });
  assert.equal(settings.worker.boxPool, undefined);
  assert.equal("boxPool" in settings.worker, false);
});

test("REGRESSION: absent box_pool Settings clone deep-equals the issue-state clone", () => {
  const settings = parseConfig({});
  const clone = settingsForIssueState(settings, "Todo");
  assert.deepEqual(clone, settings);
  assert.equal("boxPool" in clone.worker, false);
});

test("worker.box_pool provider enum rejects unknown value", () => {
  assert.throws(
    () => parseConfig({ worker: { box_pool: { provider: "kubernetes" } } }),
    /worker\.box_pool\.provider is invalid: Invalid option/,
  );

  for (const kind of PROVIDER_KINDS) {
    if (kind === "static-ssh") continue;
    const settings = parseConfig({ worker: { box_pool: { provider: kind } } });
    assert.equal(settings.worker.boxPool?.provider, kind);
  }
});

test("worker.box_pool rejects max < min", () => {
  assert.throws(
    () => parseConfig({ worker: { box_pool: { min: 3, max: 2 } } }),
    /worker\.box_pool\.max must be >= worker\.box_pool\.min/,
  );
});

test("worker.box_pool rejects warm > max", () => {
  assert.throws(
    () => parseConfig({ worker: { box_pool: { max: 2, warm: 3 } } }),
    /worker\.box_pool\.warm must be <= worker\.box_pool\.max/,
  );
});

test("worker.box_pool rejects non-positive integers where positive is required", () => {
  assert.throws(
    () => parseConfig({ worker: { box_pool: { max: 0 } } }),
    /worker\.box_pool\.max must be a positive integer/,
  );
  assert.throws(
    () => parseConfig({ worker: { box_pool: { max_in_flight: -1 } } }),
    /worker\.box_pool\.max_in_flight must be a positive integer/,
  );
  assert.throws(
    () => parseConfig({ worker: { box_pool: { drain_deadline_ms: 0 } } }),
    /worker\.box_pool\.drain_deadline_ms must be a positive integer/,
  );
});

test("worker.box_pool enabled cannot be combined with non-empty ssh_hosts", () => {
  assert.throws(
    () =>
      parseConfig({
        worker: {
          ssh_hosts: ["user@host:22"],
          box_pool: { enabled: true, provider: "fake" },
        },
      }),
    /worker\.box_pool\.enabled cannot be combined with worker\.ssh_hosts/,
  );

  const ok = parseConfig({
    worker: {
      ssh_hosts: ["user@host:22"],
      box_pool: { enabled: false, provider: "fake" },
    },
  });
  assert.deepEqual(ok.worker.sshHosts, ["user@host:22"]);
  assert.equal(ok.worker.boxPool?.enabled, false);
});

test("static-ssh enabled without provider_options.ssh_hosts throws", () => {
  assert.throws(
    () => parseConfig({ worker: { box_pool: { enabled: true, provider: "static-ssh" } } }),
    /worker\.box_pool\.provider_options\.ssh_hosts is required for static-ssh/,
  );

  assert.throws(
    () =>
      parseConfig({
        worker: {
          box_pool: {
            enabled: true,
            provider: "static-ssh",
            provider_options: { ssh_hosts: [] },
          },
        },
      }),
    /worker\.box_pool\.provider_options\.ssh_hosts is required for static-ssh/,
  );

  const camel = parseConfig({
    worker: {
      box_pool: {
        enabled: true,
        provider: "static-ssh",
        provider_options: { sshHosts: ["user@host:22"] },
      },
    },
  });
  assert.deepEqual(camel.worker.boxPool?.providerOptions, {
    sshHosts: ["user@host:22"],
  });
});

test("unknown key under box_pool throws (strict schema)", () => {
  assert.throws(
    () => parseConfig({ worker: { box_pool: { provider: "fake", bogus: 1 } } }),
    /unsupported keys: bogus/,
  );
});

test("cloneSettings deep-copies providerOptions nested ssh_hosts array", () => {
  const settings = parseConfig({
    worker: {
      box_pool: {
        enabled: true,
        provider: "static-ssh",
        provider_options: { ssh_hosts: ["user@host-a:22", "user@host-b:22"] },
      },
    },
  });

  const clone = settingsForIssueState(settings, "Todo");
  const cloneHosts = clone.worker.boxPool?.providerOptions?.ssh_hosts as string[];
  cloneHosts[0] = "mutated@host:22";

  const originalHosts = settings.worker.boxPool?.providerOptions?.ssh_hosts as string[];
  assert.equal(originalHosts[0], "user@host-a:22");
  assert.notEqual(clone.worker.boxPool, settings.worker.boxPool);
  assert.notEqual(clone.worker.boxPool?.providerOptions, settings.worker.boxPool?.providerOptions);
});

test("cloneSettings deep-copies spend so mutating the clone leaves the original intact", () => {
  const settings = parseConfig({
    worker: {
      box_pool: {
        enabled: true,
        provider: "fake",
        spend: { max_box_seconds: 7_200 },
      },
    },
  });

  const clone = settingsForIssueState(settings, "Todo");
  assert.notEqual(clone.worker.boxPool?.spend, settings.worker.boxPool?.spend);
  if (clone.worker.boxPool?.spend) clone.worker.boxPool.spend.maxBoxSeconds = 1;
  assert.equal(settings.worker.boxPool?.spend?.maxBoxSeconds, 7_200);
});

test("worker.box_pool spend.* parse in seconds while ttl/idle/drain stay in ms", () => {
  const settings = parseConfig({
    worker: {
      box_pool: {
        enabled: true,
        provider: "fake",
        ttl_ms: 1_800_000,
        idle_reap_ms: 60_000,
        drain_deadline_ms: 15_000,
        spend: { max_box_seconds: 600, daily_box_seconds: 3_600 },
      },
    },
  });

  const boxPool = settings.worker.boxPool;
  assert.equal(boxPool?.ttlMs, 1_800_000);
  assert.equal(boxPool?.idleReapMs, 60_000);
  assert.equal(boxPool?.drainDeadlineMs, 15_000);
  assert.equal(boxPool?.spend?.maxBoxSeconds, 600);
  assert.equal(boxPool?.spend?.dailyBoxSeconds, 3_600);
});

test("worker.box_pool provider_options keys pass through un-normalized", () => {
  const settings = parseConfig({
    worker: {
      box_pool: {
        enabled: true,
        provider: "static-ssh",
        provider_options: {
          ssh_hosts: ["user@host:22"],
          max_in_flight: 9,
          nested: { deep_key: "value" },
        },
      },
    },
  });

  assert.deepEqual(settings.worker.boxPool?.providerOptions, {
    ssh_hosts: ["user@host:22"],
    max_in_flight: 9,
    nested: { deep_key: "value" },
  });
});
