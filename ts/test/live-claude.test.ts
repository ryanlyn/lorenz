import { test } from "vitest";
import { Executor, parseConfig as parseConfigWith } from "@symphony/cli";
import { acpExecutorProvider } from "@symphony/acp";
import { AgentExecutorRegistry } from "@symphony/agent-sdk";
import { assert, sampleIssue, tempDir } from "@symphony/test-utils";

// Parsing resolves the ACP option vocabulary through an explicit registry; the executor
// under test is constructed directly.
const executors = new AgentExecutorRegistry();
executors.register(acpExecutorProvider);

function parseConfig(raw: Record<string, unknown>): ReturnType<typeof parseConfigWith> {
  return parseConfigWith(raw, {}, {}, undefined, executors);
}

const claudeBridge = process.env.SYMPHONY_TS_CLAUDE_ACP_BRIDGE_COMMAND;
const runLiveClaude = process.env.SYMPHONY_TS_RUN_REAL_CLAUDE_E2E === "1" && Boolean(claudeBridge);

test("live Claude ACP bridge smoke", { timeout: 180_000, skip: !runLiveClaude }, async () => {
  const workspace = await tempDir("symphony-ts-live-claude");
  const settings = liveClaudeSettings(180_000);
  const executor = new Executor("claude");
  const session = await executor.startSession({ workspace, settings, issue: sampleIssue });
  const updates = await executor.runTurn(
    session,
    "Reply exactly TS_CLAUDE_E2E_OK and do not modify files.",
  );
  await session.stop();

  assert.ok(updates.some((update) => update.type === "turn_completed"));
});

test(
  "live Claude ACP bridge uses MCP tool endpoint",
  { timeout: 240_000, skip: !runLiveClaude },
  async () => {
    assert.ok(process.env.LINEAR_API_KEY, "LINEAR_API_KEY is required for live MCP E2E");
    const workspace = await tempDir("symphony-ts-live-mcp");
    const settings = liveClaudeSettings(240_000, {
      tracker: {
        api_key: "$LINEAR_API_KEY",
        project_slug: "symphony-414bf2e49ff2",
      },
    });
    const executor = new Executor("claude");
    const session = await executor.startSession({ workspace, settings, issue: sampleIssue });
    try {
      const updates = await executor.runTurn(
        session,
        [
          "This is a live Symphony TypeScript MCP canary.",
          "Use the mcp__symphony_linear__linear_graphql tool once with this exact query:",
          "query SymphonyTsClaudeMcpCanary { viewer { id } }",
          "After the tool result returns, reply exactly TS_CLAUDE_MCP_E2E_OK and do not modify files.",
        ].join("\n"),
      );

      const serialized = JSON.stringify(updates);
      assert.ok(updates.some((update) => update.type === "turn_completed"));
      assert.match(serialized, /linear_graphql|mcp__symphony_linear/);
      assert.match(serialized, /viewer|TS_CLAUDE_MCP_E2E_OK/);
    } finally {
      await session.stop();
    }
  },
);

function liveClaudeSettings(timeoutMs: number, extra: Record<string, unknown> = {}) {
  return parseConfig({
    ...extra,
    agent: { kind: "claude" },
    agents: {
      claude: {
        executor: "acp",
        bridge_command: claudeBridgeCommand(),
        turn_timeout_ms: timeoutMs,
        stall_timeout_ms: 300_000,
      },
    },
  });
}

function claudeBridgeCommand(): string {
  const base = claudeBridge ?? "claude-agent-acp";
  const raw = process.env.SYMPHONY_TS_CLAUDE_ACP_BRIDGE_ARGS;
  if (!raw) return base;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("SYMPHONY_TS_CLAUDE_ACP_BRIDGE_ARGS must be a JSON string array");
  }
  return [base, ...parsed].join(" ");
}
