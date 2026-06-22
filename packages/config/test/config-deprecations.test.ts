import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import {
  collectConfigDeprecations,
  formatConfigDeprecation,
  warnConfigDeprecations,
} from "@lorenz/config";

test("collects deprecations for the legacy top-level codex section", () => {
  const deprecations = collectConfigDeprecations({
    codex: { command: "codex-acp", turn_timeout_ms: 1000, stall_timeout_ms: 0 },
  });
  assert.deepEqual(
    deprecations.map((dep) => [dep.configPath, dep.replacement]),
    [
      ["codex.command", "agents.codex.bridge_command"],
      ["codex.turn_timeout_ms", "agents.codex.turn_timeout_ms"],
      ["codex.stall_timeout_ms", "agents.codex.stall_timeout_ms"],
    ],
  );
});

test("collects deprecations for the legacy top-level claude section, including model and camelCase", () => {
  const deprecations = collectConfigDeprecations({
    claude: { model: "claude-opus", strictMcpConfig: true, providerConfig: {} },
  });
  assert.deepEqual(
    deprecations.map((dep) => [dep.configPath, dep.replacement]),
    [
      ["claude.model", "agents.claude.provider_config.model"],
      ["claude.strict_mcp_config", "agents.claude.strict_mcp_config"],
      ["claude.provider_config", "agents.claude.provider_config"],
    ],
  );
});

test("flags provider options written under tracker in the flat shape", () => {
  const deprecations = collectConfigDeprecations({
    tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slugs: ["backend"] },
  });
  assert.deepEqual(
    deprecations.map((dep) => [dep.configPath, dep.replacement]),
    [["tracker.project_slugs", "trackers.linear.project_slugs"]],
  );
});

test("flags the singular tracker.project_slug as a flat-shape provider option", () => {
  const [deprecation] = collectConfigDeprecations({
    tracker: { kind: "linear", project_slug: "backend" },
  });
  assert.equal(deprecation?.configPath, "tracker.project_slug");
  assert.equal(deprecation?.replacement, "trackers.linear.project_slug");
  assert.match(String(deprecation?.detail), /flat shape\) are deprecated/);
});

test("falls back to a placeholder bundle name when tracker.kind is unset", () => {
  const [deprecation] = collectConfigDeprecations({ tracker: { base_url: "https://example" } });
  assert.equal(deprecation?.replacement, "trackers.<name>.base_url");
});

test("does not flag the current tracker selector keys or the agent section", () => {
  const deprecations = collectConfigDeprecations({
    tracker: { kind: "linear", endpoint: "https://api", assignee: "me" },
    trackers: { linear: { provider: "linear", project_slugs: ["backend"] } },
    agent: { kind: "codex", max_concurrent_agents: 4, ensemble_size: 2, skills: ["x"] },
    agents: { codex: { bridge_command: "codex-acp" } },
  });
  assert.deepEqual(deprecations, []);
});

test("formats a deprecation with its recommendation and detail", () => {
  assert.equal(
    formatConfigDeprecation({
      configPath: "codex.command",
      replacement: "agents.codex.bridge_command",
      detail: "Use the agents block.",
    }),
    "`codex.command` is deprecated; use `agents.codex.bridge_command` instead. Use the agents block.",
  );
});

test("warnConfigDeprecations emits each formatted message and returns the list", () => {
  const messages: string[] = [];
  const deprecations = warnConfigDeprecations(
    { codex: { command: "codex-acp" } },
    (message) => messages.push(message),
  );
  assert.equal(deprecations.length, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /^`codex\.command` is deprecated/);
});
