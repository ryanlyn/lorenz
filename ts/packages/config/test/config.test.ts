import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { test } from "vitest";
import {
  loadWorkflow,
  parseConfig as parseConfigWith,
  parseWorkflowContent,
  settingsForIssueState,
  validateDispatchConfig as validateDispatchConfigWith,
  workflowFilePath,
} from "@symphony/cli";
import { acpExecutorProvider } from "@symphony/acp";
import { AgentExecutorRegistry, type AgentExecutorProvider } from "@symphony/agent-sdk";
import type { Settings } from "@symphony/domain";
import { jiraTrackerOptions, registerJiraTrackers } from "@symphony/jira-tracker";
import { registerLinearTracker } from "@symphony/linear-tracker";
import { registerLocalTracker } from "@symphony/local-tracker";
import { registerMemoryTracker } from "@symphony/memory-tracker";
import { ToolRegistry } from "@symphony/tool-sdk";
import { createTrackerToolProvider, TrackerRegistry } from "@symphony/tracker-sdk";
import { assert, tempDir } from "@symphony/test-utils";

import type { DefaultSettingsOptions } from "@symphony/config";

// Private registries keep these tests hermetic: the process-wide default registries belong
// to the composition root and stay untouched here.
const trackers = new TrackerRegistry();
const tools = new ToolRegistry();
registerLinearTracker({ trackers, tools });
registerLocalTracker({ trackers, tools });
registerMemoryTracker({ trackers });
registerJiraTrackers({ trackers });
tools.register(createTrackerToolProvider(trackers));
const executors = new AgentExecutorRegistry();
executors.register(acpExecutorProvider);

function parseConfig(
  raw: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = {},
  defaults: DefaultSettingsOptions = {},
): Settings {
  return parseConfigWith(raw, env, defaults, trackers, executors);
}

function validateDispatchConfig(settings: Settings, tools?: ToolRegistry): void {
  validateDispatchConfigWith(settings, trackers, executors, tools);
}

test("config resolves env-backed Linear token and assignee", () => {
  const settings = parseConfig(
    {
      tracker: {
        kind: "dispatch",
      },
      trackers: {
        dispatch: {
          provider: "linear",
          api_key: "$LINEAR_API_KEY",
          project_slug: "mono",
          assignee: "$LINEAR_ASSIGNEE",
        },
      },
    },
    { LINEAR_API_KEY: "linear-token", LINEAR_ASSIGNEE: "worker@example.com" },
  );

  assert.equal(settings.tracker.kind, "linear");
  assert.equal(settings.tracker.apiKey, "linear-token");
  assert.equal(settings.tracker.assignee, "worker@example.com");
  assert.equal(settings.agent.kind, "codex");
  assert.equal(settings.agent.maxTurns, 20);
  assert.equal(settings.agent.ensembleSize, 1);
  assert.equal(settings.agents.codex?.executor, "acp");
  assert.equal(settings.agents.codex?.options.bridgeCommand, "codex-acp");
  assert.equal(settings.agents.claude?.executor, "acp");
});

test("partial codex agent override preserves bridgeCommand codex-acp", () => {
  const settings = parseConfig({
    agents: { codex: { stall_timeout_ms: 60000 } },
  });

  const codexAgent = settings.agents.codex!;
  assert.equal(codexAgent.executor, "acp");
  assert.equal(codexAgent.options.bridgeCommand, "codex-acp");
  assert.equal(codexAgent.options.usageAccounting, "per-turn");
  assert.equal(codexAgent.stallTimeoutMs, 60000);
  assert.equal(codexAgent.options.providerConfig, undefined);
});

test("config honors logging.log_file with alias and home expansion", () => {
  const direct = parseConfig({ logging: { log_file: "/var/log/sym/symphony.log" } });
  assert.equal(direct.logging.logFile, "/var/log/sym/symphony.log");

  const camel = parseConfig({ logging: { logFile: "/var/log/sym/camel.log" } });
  assert.equal(camel.logging.logFile, "/var/log/sym/camel.log");

  const expanded = parseConfig(
    { logging: { log_file: "~/logs/symphony.log" } },
    { HOME: "/home/agent" },
  );
  assert.equal(expanded.logging.logFile, "/home/agent/logs/symphony.log");

  const fallback = parseConfig({});
  assert.match(fallback.logging.logFile, /\.symphony\/log\/symphony\.log$/);
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
    { tracker: { kind: "linear" } },
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
        kind: "linear",
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

test("jira tracker config resolves canonical env fallbacks", () => {
  const settings = parseConfig(
    {
      tracker: {
        kind: "dispatch",
      },
      trackers: {
        dispatch: {
          provider: "jira",
          project_keys: ["ENG"],
        },
      },
    },
    {
      JIRA_BASE_URL: "https://example.atlassian.net",
      JIRA_EMAIL: "bot@example.com",
      JIRA_API_KEY: "jira-token",
    },
  );

  const options = jiraTrackerOptions(settings);
  assert.equal(options.baseUrl, "https://example.atlassian.net");
  assert.equal(options.email, "bot@example.com");
  assert.equal(settings.tracker.apiKey, "jira-token");
  assert.deepEqual(options.projectKeys, ["ENG"]);
  validateDispatchConfig(settings);
});

test("jira tracker options reject wrong types with tracker.<key> messages", () => {
  assert.throws(
    () =>
      parseConfig({
        tracker: { kind: "dispatch" },
        trackers: { dispatch: { provider: "jira", base_url: 5 } },
      }),
    /tracker.baseUrl must be a string/,
  );
  assert.throws(
    () =>
      parseConfig({
        tracker: { kind: "dispatch" },
        trackers: { dispatch: { provider: "jira", project_keys: "ENG" } },
      }),
    /tracker.projectKeys must be a list of strings/,
  );
  assert.throws(
    () =>
      parseConfig({
        tracker: { kind: "dispatch" },
        trackers: { dispatch: { provider: "jira", issue_type: "Task", surprise: true } },
      }),
    /unsupported tracker option\(s\) for kind "jira": surprise/,
  );
});

test("jira-mcp tracker config parses MCP settings and tool aliases", () => {
  const settings = parseConfig(
    {
      tracker: {
        kind: "dispatch",
      },
      trackers: {
        dispatch: {
          provider: "jira-mcp",
          project_keys: ["ENG"],
          mcp: {
            url: "http://127.0.0.1:5123/mcp",
            token: "$MCP_TOKEN",
            tools: {
              read_issue: "jira_get",
              update_status: "jira_transition",
              create_issue: "jira_create",
            },
          },
        },
      },
    },
    { MCP_TOKEN: "mcp-token" },
  );

  const options = jiraTrackerOptions(settings);
  assert.equal(options.mcp?.url, "http://127.0.0.1:5123/mcp");
  assert.equal(options.mcp?.token, "mcp-token");
  assert.equal(options.mcp?.tools?.readIssue, "jira_get");
  assert.equal(options.mcp?.tools?.updateStatus, "jira_transition");
  assert.equal(options.mcp?.tools?.createIssue, "jira_create");
  validateDispatchConfig(settings);
});

test("config defaults and validation match expected defaults", () => {
  const settings = parseConfig({}, {});

  assert.equal(settings.tracker.kind, undefined);
  assert.deepEqual(settings.agents.claude.options.providerConfig, {
    model: "claude-opus-4-6[1m]",
    permissions: { defaultMode: "dontAsk" },
  });
  assert.equal(settings.observability.renderIntervalMs, 16);
  assert.throws(() => validateDispatchConfig(settings), /tracker.kind is required/);
});

test("tracker.kind selects a named trackers bundle with its own provider", () => {
  const settings = parseConfig({
    tracker: { kind: "primary" },
    trackers: {
      primary: {
        provider: "local",
        path: "/tmp/board",
        id_prefix: "BOARD-",
        active_states: ["Ready"],
        dispatch: { only_routes: ["docs"] },
      },
    },
  });

  assert.equal(settings.tracker.kind, "local");
  assert.deepEqual(settings.tracker.options, { path: "/tmp/board", idPrefix: "BOARD-" });
  assert.deepEqual(settings.tracker.activeStates, ["Ready"]);
  assert.deepEqual(settings.tracker.dispatch.onlyRoutes, ["docs"]);

  assert.throws(
    () => parseConfig({ tracker: { kind: "primary" }, trackers: { primary: {} } }),
    /trackers\.primary\.provider is required/,
  );
  assert.throws(
    () => parseConfig({ tracker: { kind: "primary" }, trackers: { dispatch: {} } }),
    /trackers\.primary is required by tracker\.kind/,
  );
  assert.throws(
    () =>
      parseConfig({
        tracker: { kind: "primary" },
        trackers: { primary: { provider: "linear", active_states: "Todo" } },
      }),
    /trackers\.primary\.active_states must be a list of strings/,
  );
});

test("unselected trackers bundles can coexist without being validated", () => {
  const settings = parseConfig({
    tracker: { kind: "primary", id_prefix: "LEGACY-" },
    trackers: {
      primary: { provider: "local", path: "/tmp/board", id_prefix: "BOARD-" },
      linear: { active_states: "not a list", surprise: true },
    },
  });

  assert.equal(settings.tracker.kind, "local");
  assert.deepEqual(settings.tracker.options, { path: "/tmp/board", idPrefix: "BOARD-" });
});

test("claude.model overrides the pinned model in the provider config", () => {
  const settings = parseConfig({ claude: { model: "claude-haiku-4-5" } });

  assert.deepEqual(settings.agents.claude?.options.providerConfig, {
    model: "claude-haiku-4-5",
    permissions: { defaultMode: "dontAsk" },
  });
});

test("claude provider_config without a model key picks up claude.model", () => {
  const settings = parseConfig({
    claude: {
      model: "claude-haiku-4-5",
      provider_config: { permissions: { defaultMode: "acceptEdits" } },
    },
  });

  assert.deepEqual(settings.agents.claude.options.providerConfig, {
    model: "claude-haiku-4-5",
    permissions: { defaultMode: "acceptEdits" },
  });
});

test("explicit claude provider_config model wins over claude.model", () => {
  const settings = parseConfig({
    claude: { provider_config: { model: "claude-sonnet-4-6" } },
  });

  assert.deepEqual(settings.agents.claude.options.providerConfig, { model: "claude-sonnet-4-6" });
});

test("status override of claude.model re-pins the provider config", () => {
  const settings = parseConfig({
    status_overrides: {
      "In Review": { claude: { model: "claude-haiku-4-5" } },
    },
  });

  const effective = settingsForIssueState(settings, "In Review");
  assert.deepEqual(effective.agents.claude?.options.providerConfig, {
    model: "claude-haiku-4-5",
    permissions: { defaultMode: "dontAsk" },
  });
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

test("agent skills resolve, expand, and dedupe", () => {
  const configDir = path.join(os.tmpdir(), "symphony-config-skills");
  const settings = parseConfig(
    {
      agent: {
        skills: [
          "./.codex/skills/symphony-linear",
          "./.codex/skills/symphony-linear",
          "~/shared-skill",
          "$SKILL_SOURCE",
        ],
      },
    },
    { HOME: "/home/tester", SKILL_SOURCE: "/opt/skill-source" },
    { configDir },
  );

  assert.deepEqual(settings.agent.skills, [
    path.join(configDir, ".codex", "skills", "symphony-linear"),
    "/home/tester/shared-skill",
    "/opt/skill-source",
  ]);
});

test("agent skills default to empty and reject per-state overrides", () => {
  assert.deepEqual(parseConfig({}).agent.skills, []);
  assert.throws(
    () => parseConfig({ statusOverrides: { "In Progress": { agent: { skills: ["./x"] } } } }),
    /skills/,
  );
});

test("loadWorkflow resolves agent skills relative to the workflow file", async () => {
  const root = await tempDir("symphony-workflow-skills");
  const workflowDir = path.join(root, "workflows");
  await fs.mkdir(workflowDir);
  const workflowPath = path.join(workflowDir, "WORKFLOW.md");
  await fs.writeFile(
    workflowPath,
    `---
agent:
  skills:
    - ../.codex/skills/symphony-land
---

Do work.
`,
  );

  const workflow = await loadWorkflow(workflowPath);

  assert.deepEqual(workflow.settings.agent.skills, [
    path.join(root, ".codex", "skills", "symphony-land"),
  ]);
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
    () => validateDispatchConfig(parseConfig({ tracker: { kind: "github" } })),
    /unsupported tracker.kind: github \(known kinds: jira, jira-mcp, linear, local, memory\)/,
  );
  assert.throws(
    () =>
      validateDispatchConfigWith(
        parseConfig({ tracker: { kind: "github" } }),
        new TrackerRegistry(),
        executors,
      ),
    /unsupported tracker.kind: github \(no tracker providers registered - register tracker extensions at the composition root\)/,
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

  assert.equal(settings.agents.codex.options.bridgeCommand, "codex-custom");
  assert.equal(settings.agents.codex.turnTimeoutMs, 120_000);
  assert.equal(settings.agents.codex.stallTimeoutMs, 42_000);
  assert.equal(settings.agents.claude.options.bridgeCommand, "claude-agent-acp");
  assert.deepEqual(settings.agents.claude.options.providerConfig, {
    permissions: { defaultMode: "acceptEdits" },
  });
  assert.deepEqual(settings.agents.pi, {
    executor: "acp",
    turnTimeoutMs: 3_600_000,
    stallTimeoutMs: 300_000,
    options: {
      bridgeCommand: "pi-acp",
      providerConfig: { safe_mode: true },
      usageAccounting: "cumulative",
      strictMcpConfig: true,
    },
  });
});

test("agents map accepts flat executor options and legacy command aliases", () => {
  const settings = parseConfig({
    agents: {
      codex: { command: "custom-codex" },
      claude: {
        bridge_command: "custom-claude",
        provider_config: { model: "claude-haiku-4-5" },
      },
      pi: {
        command: "legacy-pi",
        usage_accounting: "cumulative",
      },
    },
  });

  assert.equal(settings.agents.codex.options.bridgeCommand, "custom-codex");
  assert.equal(settings.agents.codex.options.providerConfig, undefined);
  assert.equal(settings.agents.claude.options.bridgeCommand, "custom-claude");
  assert.deepEqual(settings.agents.claude.options.providerConfig, { model: "claude-haiku-4-5" });
  assert.equal(settings.agents.pi.options.bridgeCommand, "legacy-pi");
  assert.equal(settings.agents.pi.options.usageAccounting, "cumulative");
});

test("custom ACP agents default to cumulative usage unless using a known per-turn bridge", () => {
  const settings = parseConfig({
    agents: {
      pi: { bridge_command: "pi-acp" },
      codex_alias: { bridge_command: "codex-acp" },
      claude_alias: { bridge_command: "claude-agent-acp" },
    },
  });

  assert.equal(settings.agents.pi.options.usageAccounting, "cumulative");
  assert.equal(settings.agents.pi.options.providerConfig, undefined);
  assert.equal(settings.agents.codex_alias.options.usageAccounting, "per-turn");
  assert.equal(settings.agents.codex_alias.options.providerConfig, undefined);
  assert.equal(settings.agents.claude_alias.options.usageAccounting, "per-turn");
  assert.deepEqual(settings.agents.claude_alias.options.providerConfig, {
    model: "claude-opus-4-6[1m]",
    permissions: { defaultMode: "dontAsk" },
  });
});

test("records selecting a non-default executor do not inherit ACP option defaults", () => {
  const received: Array<Record<string, unknown>> = [];
  const otherProvider: AgentExecutorProvider = {
    executor: "other",
    parseOptions: (options) => {
      received.push(structuredClone(options));
      const unknown = Object.keys(options).filter((key) => key !== "workerCount");
      if (unknown.length > 0) {
        throw new Error(
          `unsupported agent option(s) for the other executor: ${unknown.join(", ")}`,
        );
      }
      return { ...options };
    },
    createExecutor: () => {
      throw new Error("not under test");
    },
  };
  const privateExecutors = new AgentExecutorRegistry();
  privateExecutors.register(acpExecutorProvider);
  privateExecutors.register(otherProvider);

  const settings = parseConfigWith(
    { agents: { pi: { executor: "other", turn_timeout_ms: 120_000 } } },
    {},
    {},
    trackers,
    privateExecutors,
  );

  // The ACP-flavored defaults (bridgeCommand, providerConfig, ...) never reach the foreign
  // executor's parser; only the record's own keys do.
  assert.deepEqual(received, [{}]);
  assert.deepEqual(settings.agents.pi?.options, {});
  assert.equal(settings.agents.pi?.executor, "other");
  // Shared timeouts still inherit and parse normally.
  assert.equal(settings.agents.pi?.turnTimeoutMs, 120_000);
  assert.equal(settings.agents.pi?.stallTimeoutMs, 300_000);
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
  assert.equal(settings.agents.claude.turnTimeoutMs, 120_000);
  assert.equal(settings.agents.claude.stallTimeoutMs, 5_000);
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

test("top-level tools map parses per-pack option bags and deep-copies them", () => {
  const rawToolOptions = { local: { path: "/tmp/pack-board", id_prefix: "PACK-" } };
  const settings = parseConfig({
    tracker: { kind: "local" },
    tools: rawToolOptions,
  });

  assert.deepEqual(settings.toolOptions, {
    local: { path: "/tmp/pack-board", id_prefix: "PACK-" },
  });
  validateDispatchConfig(settings, tools);

  // The parsed settings own a copy; later mutation of the raw config must not leak in.
  rawToolOptions.local.path = "/tmp/elsewhere";
  assert.equal(settings.toolOptions?.local?.path, "/tmp/pack-board");

  assert.equal(parseConfig({ tracker: { kind: "memory" } }).toolOptions, undefined);
});

test("tools secret references resolve at parse time; unresolvable refs are omitted", () => {
  const settings = parseConfig(
    {
      tracker: { kind: "dispatch" },
      trackers: { dispatch: { provider: "linear", project_slug: "mono" } },
      tools: { linear: { api_key: "$PACK_KEY", endpoint: "https://linear.example" } },
    },
    { PACK_KEY: "resolved-token" },
  );
  assert.equal(settings.toolOptions?.["linear"]?.api_key, "resolved-token");

  const unresolved = parseConfig(
    {
      tracker: { kind: "dispatch" },
      trackers: { dispatch: { provider: "linear", project_slug: "mono" } },
      tools: { linear: { api_key: "$PACK_KEY", endpoint: "https://linear.example" } },
    },
    {},
  );
  assert.equal("api_key" in (unresolved.toolOptions?.["linear"] ?? {}), false);
  assert.equal(unresolved.toolOptions?.["linear"]?.endpoint, "https://linear.example");
});

test("tools map can explicitly mount a pack outside the dispatch tracker", () => {
  const settings = parseConfig({
    tracker: { kind: "memory" },
    tools: { local: { path: "/tmp/board" } },
  });
  validateDispatchConfig(settings, tools);
  assert.deepEqual(settings.toolOptions, { local: { path: "/tmp/board" } });
});

test("tool options for an unknown pack fail with the known pack list", () => {
  const settings = parseConfig({
    tracker: { kind: "local" },
    tools: { gitlab: {} },
  });
  assert.throws(
    () => validateDispatchConfig(settings, tools),
    /unsupported tool pack: gitlab \(known tool packs: linear, local, tracker\)/,
  );
});

test("tools options for a pack without a validator are rejected rather than silently ignored", () => {
  const settings = parseConfig({
    tracker: { kind: "memory" },
    tools: { tracker: { surprise: true } },
  });
  assert.throws(
    () => validateDispatchConfig(settings, tools),
    /tools\.tracker is not supported by the "tracker" pack/,
  );
});

test("the local pack rejects unknown tools keys and wrong types", () => {
  const unknownKey = parseConfig({
    tracker: { kind: "local" },
    tools: { local: { surprise: true } },
  });
  assert.throws(
    () => validateDispatchConfig(unknownKey, tools),
    /tools\.local\.surprise is not supported \(known keys: path, idPrefix, id_prefix\)/,
  );

  const wrongType = parseConfig({
    tracker: { kind: "local" },
    tools: { local: { path: 5 } },
  });
  assert.throws(
    () => validateDispatchConfig(wrongType, tools),
    /tools\.local\.path must be a string/,
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
  assert.equal(settings.agents.codex.options.bridgeCommand, "codex-acp");
  assert.notEqual(settings.workspace.root, "/tmp/legacy-root");
  assert.equal(settings.hooks.beforeRun, null);
});

test("known workflow sections reject unsupported nested keys after alias normalization", () => {
  assert.throws(
    () =>
      parseConfig({
        tracker: { kind: "memory", project_slug: "mono", surprise: true },
      }),
    /unsupported tracker option\(s\) for kind "memory": project_slug, surprise/,
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
  assert.equal(effective.agents.codex.turnTimeoutMs, 120_000);
});

test("per-state agent overrides store provider-normalized option values", () => {
  const settings = parseConfig({
    status_overrides: {
      Todo: { agents: { claude: { strict_mcp_config: "false" } } },
    },
  });

  // The provider coerces the YAML-friendly string to a boolean; the stored overlay must
  // carry the coerced value, not the raw fragment.
  const effective = settingsForIssueState(settings, "todo");
  assert.equal(effective.agents.claude?.options.strictMcpConfig, false);
  // Unrelated states keep the base record untouched.
  assert.equal(
    settingsForIssueState(settings, "done").agents.claude?.options.strictMcpConfig,
    true,
  );
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

  assert.equal(effective.agents.codex.turnTimeoutMs, 120_000);
  assert.equal(effective.agents.codex.stallTimeoutMs, 45_000);
  assert.equal(effective.agents.codex?.turnTimeoutMs, 120_000);
  assert.equal(effective.agents.codex?.stallTimeoutMs, 45_000);
  assert.equal(effective.agents.claude.turnTimeoutMs, 180_000);
  assert.equal(effective.agents.claude.stallTimeoutMs, 60_000);
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
  // A blank kind parses as "unset" and is rejected when dispatch is validated.
  assert.throws(
    () => validateDispatchConfig(parseConfig({ tracker: { kind: "" } })),
    /tracker.kind is required/,
  );
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

  assert.equal(settings.agents.codex.stallTimeoutMs, 0);
  assert.equal(settings.agents.claude.stallTimeoutMs, 0);

  const effective = settingsForIssueState(settings, "Todo");
  assert.equal(effective.agents.codex.stallTimeoutMs, 0);
  assert.equal(effective.agents.claude.stallTimeoutMs, 0);
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
    () =>
      validateDispatchConfig(
        parseConfig({
          tracker: { kind: "memory" },
          agent: { kind: "pi" },
          agents: { pi: { executor: "foo", bridge_command: "pi-bridge" } },
        }),
      ),
    /unsupported agents\.pi\.executor: foo \(known executors: acp\)/,
  );
});

test("config falls back to the default log path when logging.log_file is unset", () => {
  const settings = parseConfig({});

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
    const workflow = await loadWorkflow(
      path.join(root, "ts", name),
      { LINEAR_API_KEY: "test-token", LINEAR_ASSIGNEE: "worker@example.com" },
      { trackers, executors },
    );
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

  const workflow = await loadWorkflow(
    undefined,
    { SYMPHONY_WORKFLOW: workflowPath, LINEAR_API_KEY: "test-token" },
    { trackers, executors },
  );
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
  assert.equal(settings.tracker.options.path, ".symphony/local");
});

test("local tracker id_prefix defaults to BOARD- and can be overridden", () => {
  const def = parseConfig({ tracker: { kind: "local" } }, {});
  assert.equal(def.tracker.options.idPrefix, "BOARD-");

  const custom = parseConfig({ tracker: { kind: "local", id_prefix: "XXX-" } }, {});
  assert.equal(custom.tracker.options.idPrefix, "XXX-");
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

  assert.deepEqual(settings.tracker.options.projectSlugs, ["slug-a", "slug-b"]);
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

  assert.deepEqual(settings.tracker.options.projectLabels, ["team:backend"]);
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

test("worker.worker_pool parses all keys with snake_case aliasing", () => {
  const settings = parseConfig({
    worker: {
      kind: "static-prod",
      worker_pool: {
        enabled: true,
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
        max_workers_per_issue: 2,
        spend: {
          max_concurrent_workers: 5,
          max_worker_seconds: 7_200,
          daily_worker_seconds: 86_400,
        },
      },
    },
    workers: {
      "static-prod": {
        driver: "static-ssh",
        ssh_hosts: ["user@host-a:22", "user@host-b:22"],
      },
    },
  });

  const workerPool = settings.worker.workerPool;
  assert.equal(settings.worker.kind, "static-prod");
  assert.ok(workerPool);
  assert.equal(workerPool?.enabled, true);
  assert.equal(workerPool?.driver, "static-ssh");
  assert.equal(workerPool?.min, 1);
  assert.equal(workerPool?.max, 4);
  assert.equal(workerPool?.warm, 2);
  assert.equal(workerPool?.slotsPerMachine, 3);
  assert.equal(workerPool?.maxInFlight, 3);
  assert.equal(workerPool?.ttlMs, 7_200_000);
  assert.equal(workerPool?.idleReapMs, 120_000);
  assert.equal(workerPool?.acquireTimeoutMs, 45_000);
  assert.equal(workerPool?.reapIntervalMs, 10_000);
  assert.equal(workerPool?.staleHeartbeatMs, 900_000);
  assert.equal(workerPool?.drainDeadlineMs, 20_000);
  assert.equal(workerPool?.maxWorkersPerIssue, 2);
  assert.deepEqual(workerPool?.spend, {
    maxConcurrentWorkers: 5,
    maxWorkerSeconds: 7_200,
    dailyWorkerSeconds: 86_400,
  });
  assert.deepEqual(workerPool?.driverOptions, {
    ssh_hosts: ["user@host-a:22", "user@host-b:22"],
  });
});

test("worker.worker_pool parses co_residence and max_concurrent_tunnels (snake->camel)", () => {
  const settings = parseConfig({
    worker: {
      worker_pool: {
        enabled: true,
        driver: "fake",
        max_in_flight: 2,
        co_residence: true,
        max_concurrent_tunnels: 8,
      },
    },
  });

  const workerPool = settings.worker.workerPool;
  assert.ok(workerPool);
  assert.equal(workerPool?.coResidence, true);
  assert.equal(workerPool?.maxConcurrentTunnels, 8);

  // cloneSettings (via the issue-state clone) copies both new optionals.
  const clone = settingsForIssueState(settings, "Todo").worker.workerPool;
  assert.ok(clone);
  assert.equal(clone?.coResidence, true);
  assert.equal(clone?.maxConcurrentTunnels, 8);
});

test("worker.worker_pool co_residence and max_concurrent_tunnels default absent", () => {
  const settings = parseConfig({
    worker: { worker_pool: { enabled: true, driver: "fake" } },
  });

  const workerPool = settings.worker.workerPool;
  assert.ok(workerPool);
  assert.equal(workerPool?.coResidence, undefined);
  assert.equal(workerPool?.maxConcurrentTunnels, undefined);
  assert.equal("coResidence" in workerPool!, false);
  assert.equal("maxConcurrentTunnels" in workerPool!, false);
});

test("worker.worker_pool rejects non-positive max_concurrent_tunnels", () => {
  assert.throws(
    () => parseConfig({ worker: { worker_pool: { max_concurrent_tunnels: 0 } } }),
    /worker\.worker_pool\.max_concurrent_tunnels must be a positive integer/,
  );
});

test("worker.worker_pool applies defaults when keys omitted", () => {
  const settings = parseConfig({
    worker: {
      worker_pool: { enabled: true, driver: "fake" },
    },
  });

  const workerPool = settings.worker.workerPool;
  assert.ok(workerPool);
  assert.equal(workerPool?.enabled, true);
  assert.equal(workerPool?.driver, "fake");
  assert.equal(workerPool?.min, 0);
  assert.equal(workerPool?.max, 1);
  assert.equal(workerPool?.warm, 1);
  assert.equal(workerPool?.slotsPerMachine, 1);
  assert.equal(workerPool?.maxInFlight, 1);
  assert.equal(workerPool?.ttlMs, 3_600_000);
  assert.equal(workerPool?.idleReapMs, 300_000);
  assert.equal(workerPool?.acquireTimeoutMs, 30_000);
  assert.equal(workerPool?.reapIntervalMs, 15_000);
  assert.equal(workerPool?.staleHeartbeatMs, 600_000);
  assert.equal(workerPool?.drainDeadlineMs, 30_000);
  assert.equal(workerPool?.maxWorkersPerIssue, undefined);
  assert.equal(workerPool?.spend, undefined);
  assert.equal(workerPool?.driverOptions, undefined);
});

test("worker.worker_pool max_in_flight parses into slotsPerMachine with maxInFlight mirroring it", () => {
  const settings = parseConfig({
    worker: {
      worker_pool: { enabled: true, driver: "fake", max_in_flight: 3 },
    },
  });

  const workerPool = settings.worker.workerPool;
  assert.ok(workerPool);
  assert.equal(workerPool?.slotsPerMachine, 3);
  assert.equal(workerPool?.maxInFlight, 3);
  assert.equal(workerPool?.maxInFlight, workerPool?.slotsPerMachine);

  const clone = settingsForIssueState(settings, "Todo").worker.workerPool;
  assert.ok(clone);
  assert.equal(clone?.slotsPerMachine, 3);
  assert.equal(clone?.maxInFlight, 3);
  assert.equal(clone?.maxInFlight, clone?.slotsPerMachine);
});

test("absent worker_pool leaves settings.worker.workerPool undefined", () => {
  const settings = parseConfig({ worker: { ssh_timeout_ms: 1_000 } });
  assert.equal(settings.worker.workerPool, undefined);
  assert.equal("workerPool" in settings.worker, false);
});

test("REGRESSION: absent worker_pool Settings clone deep-equals the issue-state clone", () => {
  const settings = parseConfig({});
  const clone = settingsForIssueState(settings, "Todo");
  assert.deepEqual(clone, settings);
  assert.equal("workerPool" in clone.worker, false);
});

test("worker.worker_pool driver is an open string resolved by the registry", () => {
  // Unknown kinds parse leniently (mirroring tracker.kind): whether the kind is
  // supported is the worker-driver registry's call at pool construction, which
  // fails loud with worker_pool_driver_unavailable and the registered set.
  const settings = parseConfig({ worker: { worker_pool: { driver: "acme-cloud" } } });
  assert.equal(settings.worker.workerPool?.driver, "acme-cloud");

  for (const kind of ["fake", "static-ssh", "docker", "fly", "e2b", "modal"]) {
    const parsed = parseConfig({ worker: { worker_pool: { driver: kind } } });
    assert.equal(parsed.worker.workerPool?.driver, kind);
  }

  // A blank driver is still a schema error.
  assert.throws(() => parseConfig({ worker: { worker_pool: { driver: "" } } }));
});

test("workers.<name> options are accepted for open driver names", () => {
  const settings = parseConfig({
    worker: {
      kind: "antarctica",
      worker_pool: { enabled: true },
    },
    workers: {
      antarctica: {
        driver: "acme-cloud",
        region: "antarctica-1",
        image_id: "img-123",
      },
    },
  });

  assert.deepEqual(settings.worker.workerPool?.driverOptions, {
    region: "antarctica-1",
    image_id: "img-123",
  });
});

test("worker.kind without an explicit worker_pool creates an enabled default worker pool", () => {
  const settings = parseConfig({
    worker: { kind: "docker-prod" },
    workers: { "docker-prod": { driver: "docker", image: "symphony-worker:latest" } },
  });

  assert.equal(settings.worker.kind, "docker-prod");
  assert.equal(settings.worker.workerPool?.enabled, true);
  assert.equal(settings.worker.workerPool?.driver, "docker");
  assert.deepEqual(settings.worker.workerPool?.driverOptions, {
    image: "symphony-worker:latest",
  });
});

test("worker.worker_pool rejects max < min", () => {
  assert.throws(
    () => parseConfig({ worker: { worker_pool: { min: 3, max: 2 } } }),
    /worker\.worker_pool\.max must be >= worker\.worker_pool\.min/,
  );
});

test("worker.worker_pool rejects warm > max", () => {
  assert.throws(
    () => parseConfig({ worker: { worker_pool: { max: 2, warm: 3 } } }),
    /worker\.worker_pool\.warm must be <= worker\.worker_pool\.max/,
  );
});

test("worker.worker_pool rejects non-positive integers where positive is required", () => {
  assert.throws(
    () => parseConfig({ worker: { worker_pool: { max: 0 } } }),
    /worker\.worker_pool\.max must be a positive integer/,
  );
  assert.throws(
    () => parseConfig({ worker: { worker_pool: { max_in_flight: -1 } } }),
    /worker\.worker_pool\.max_in_flight must be a positive integer/,
  );
  assert.throws(
    () => parseConfig({ worker: { worker_pool: { drain_deadline_ms: 0 } } }),
    /worker\.worker_pool\.drain_deadline_ms must be a positive integer/,
  );
});

test("worker.worker_pool enabled cannot be combined with non-empty ssh_hosts", () => {
  assert.throws(
    () =>
      parseConfig({
        worker: {
          ssh_hosts: ["user@host:22"],
          worker_pool: { enabled: true, driver: "fake" },
        },
      }),
    /worker\.worker_pool\.enabled cannot be combined with worker\.ssh_hosts/,
  );

  const ok = parseConfig({
    worker: {
      ssh_hosts: ["user@host:22"],
      worker_pool: { enabled: false, driver: "fake" },
    },
  });
  assert.deepEqual(ok.worker.sshHosts, ["user@host:22"]);
  assert.equal(ok.worker.workerPool?.enabled, false);
});

test("worker.kind cannot be combined with non-empty ssh_hosts", () => {
  assert.throws(
    () =>
      parseConfig({
        worker: {
          kind: "static-prod",
          ssh_hosts: ["user@host:22"],
        },
        workers: { "static-prod": { driver: "static-ssh", ssh_hosts: ["user@worker:22"] } },
      }),
    /worker\.kind cannot be combined with worker\.ssh_hosts/,
  );
});

test("static-ssh ssh_hosts validation belongs to the driver, not the parser", () => {
  // The static-ssh driver validates its own workers.<name> profile at pool construction
  // (the same fail-loud startup point as an unregistered kind); config parsing
  // passes the options through untouched, including camelCase spellings.
  const parsed = parseConfig({
    worker: { kind: "static-prod", worker_pool: { enabled: true } },
    workers: { "static-prod": { driver: "static-ssh" } },
  });
  assert.equal(parsed.worker.workerPool?.driverOptions, undefined);

  const camel = parseConfig({
    worker: { kind: "static-prod", worker_pool: { enabled: true } },
    workers: {
      "static-prod": { driver: "static-ssh", sshHosts: ["user@host:22"] },
    },
  });
  assert.deepEqual(camel.worker.workerPool?.driverOptions, {
    sshHosts: ["user@host:22"],
  });
});

test("unknown key under worker_pool throws (strict schema)", () => {
  assert.throws(
    () => parseConfig({ worker: { worker_pool: { driver: "fake", bogus: 1 } } }),
    /unsupported keys: bogus/,
  );
});

test("worker.worker_pool.driver_options is not supported", () => {
  assert.throws(
    () =>
      parseConfig({
        worker: {
          worker_pool: {
            driver: "static-ssh",
            driver_options: { ssh_hosts: ["user@host:22"] },
          },
        },
      }),
    /worker\.worker_pool contains unsupported keys: driver_options/,
  );
});

test("driver options are not supported under worker", () => {
  assert.throws(
    () =>
      parseConfig({
        worker: {
          worker_pool: { driver: "static-ssh" },
          "static-ssh": { ssh_hosts: ["user@host:22"] },
        },
      }),
    /worker contains unsupported keys: static-ssh/,
  );
});

test("worker.kind must select an existing workers entry", () => {
  assert.throws(
    () => parseConfig({ worker: { kind: "missing" } }),
    /worker\.kind "missing" does not match any workers entry/,
  );
});

test("worker.kind cannot be combined with worker.worker_pool.driver", () => {
  assert.throws(
    () =>
      parseConfig({
        worker: {
          kind: "docker-prod",
          worker_pool: { driver: "docker" },
        },
        workers: { "docker-prod": { driver: "docker", image: "symphony-worker:latest" } },
      }),
    /worker\.kind cannot be combined with worker\.worker_pool\.driver/,
  );
});

test("cloneSettings deep-copies driverOptions nested ssh_hosts array", () => {
  const settings = parseConfig({
    worker: {
      kind: "static-prod",
      worker_pool: {
        enabled: true,
      },
    },
    workers: {
      "static-prod": {
        driver: "static-ssh",
        ssh_hosts: ["user@host-a:22", "user@host-b:22"],
      },
    },
  });

  const clone = settingsForIssueState(settings, "Todo");
  const cloneHosts = clone.worker.workerPool?.driverOptions?.ssh_hosts as string[];
  cloneHosts[0] = "mutated@host:22";

  const originalHosts = settings.worker.workerPool?.driverOptions?.ssh_hosts as string[];
  assert.equal(originalHosts[0], "user@host-a:22");
  assert.notEqual(clone.worker.workerPool, settings.worker.workerPool);
  assert.notEqual(
    clone.worker.workerPool?.driverOptions,
    settings.worker.workerPool?.driverOptions,
  );
});

test("cloneSettings deep-copies spend so mutating the clone leaves the original intact", () => {
  const settings = parseConfig({
    worker: {
      worker_pool: {
        enabled: true,
        driver: "fake",
        spend: { max_worker_seconds: 7_200 },
      },
    },
  });

  const clone = settingsForIssueState(settings, "Todo");
  assert.notEqual(clone.worker.workerPool?.spend, settings.worker.workerPool?.spend);
  if (clone.worker.workerPool?.spend) clone.worker.workerPool.spend.maxWorkerSeconds = 1;
  assert.equal(settings.worker.workerPool?.spend?.maxWorkerSeconds, 7_200);
});

test("worker.worker_pool spend.* parse in seconds while ttl/idle/drain stay in ms", () => {
  const settings = parseConfig({
    worker: {
      worker_pool: {
        enabled: true,
        driver: "fake",
        ttl_ms: 1_800_000,
        idle_reap_ms: 60_000,
        drain_deadline_ms: 15_000,
        spend: { max_worker_seconds: 600, daily_worker_seconds: 3_600 },
      },
    },
  });

  const workerPool = settings.worker.workerPool;
  assert.equal(workerPool?.ttlMs, 1_800_000);
  assert.equal(workerPool?.idleReapMs, 60_000);
  assert.equal(workerPool?.drainDeadlineMs, 15_000);
  assert.equal(workerPool?.spend?.maxWorkerSeconds, 600);
  assert.equal(workerPool?.spend?.dailyWorkerSeconds, 3_600);
});

test("workers.<name> option keys pass through un-normalized", () => {
  const settings = parseConfig({
    worker: {
      kind: "static-prod",
      worker_pool: { enabled: true },
    },
    workers: {
      "static-prod": {
        driver: "static-ssh",
        ssh_hosts: ["user@host:22"],
        max_in_flight: 9,
        nested: { deep_key: "value" },
      },
    },
  });

  assert.deepEqual(settings.worker.workerPool?.driverOptions, {
    ssh_hosts: ["user@host:22"],
    max_in_flight: 9,
    nested: { deep_key: "value" },
  });
});
