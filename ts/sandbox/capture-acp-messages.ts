/**
 * Capture all AgentUpdate messages from a real ACP session to NDJSON files.
 *
 * Runs both Claude and Codex backends against the prompt "what is the weather
 * in Australia today" and writes the raw AgentUpdate objects to:
 *   ./acp-messages-claude.ndjson
 *   ./acp-messages-codex.ndjson
 *
 * Usage:
 *   npx tsx sandbox/capture-acp-messages.ts
 *   npx tsx sandbox/capture-acp-messages.ts --agent claude
 *   npx tsx sandbox/capture-acp-messages.ts --agent codex
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig, Executor } from "@symphony/cli";
import type { AgentUpdate, Settings } from "@symphony/cli";

// const PROMPT = "What is the weather in Australia today (do a web search). Create a new file called weather.txt with the weather report.";
const PROMPT = "Which model are we on?";

function createWorkspace(): string {
  const root = path.join(os.tmpdir(), "acp-capture");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  return root;
}

function settingsForAgent(kind: "claude" | "codex", workspaceRoot: string): Settings {
  if (kind === "claude") {
    return parseConfig({
      workspace: { root: workspaceRoot },
      agent: { kind: "claude" },
      agents: {
        claude: {
          executor: "acp",
          bridge_command: "claude-agent-acp",
          provider_config: {
            permission_mode: "dontAsk",
          },
          turn_timeout_ms: 120_000,
          stall_timeout_ms: 60_000,
          strict_mcp_config: true,
        },
      },
    });
  }
  return parseConfig({
    workspace: { root: workspaceRoot },
    agent: { kind: "codex" },
    agents: {
      codex: {
        executor: "acp",
        bridge_command: "codex-acp",
        provider_config: {
          model: "gpt-5.5",
          model_reasoning_effort: "xhigh",
        },
        turn_timeout_ms: 300_000,
        stall_timeout_ms: 0,
      },
    },
  });
}

function serialize(update: AgentUpdate): string {
  return JSON.stringify(update, (_key, value) => {
    if (value instanceof Date) return value.toISOString();
    return value;
  });
}

async function captureSession(kind: "claude" | "codex"): Promise<void> {
  const workspaceRoot = createWorkspace();
  const workspace = path.join(workspaceRoot, "workspace");
  const outFile = path.resolve(`acp-messages-${kind}.ndjson`);
  const settings = settingsForAgent(kind, workspaceRoot);
  const executor = new Executor(kind);
  const updates: AgentUpdate[] = [];
  const stream = fs.createWriteStream(outFile);

  console.log(`[${kind}] Starting ACP session...`);
  console.log(`[${kind}] Workspace: ${workspace}`);
  const session = await executor.startSession({
    workspace,
    settings,
    onUpdate: (update) => {
      updates.push(update);
      stream.write(serialize(update) + "\n");
    },
  });

  try {
    console.log(`[${kind}] Running turn with prompt: "${PROMPT}"`);
    await executor.runTurn(session, PROMPT);
    console.log(`[${kind}] Turn completed. ${updates.length} updates captured.`);
  } catch (err) {
    console.error(`[${kind}] Turn error:`, err instanceof Error ? err.message : err);
  } finally {
    await session.stop();
    stream.end();
    console.log(`[${kind}] Wrote ${updates.length} updates to ${outFile}`);
  }
}

async function main(): Promise<void> {
  const agentArg = process.argv.find((_, i) => process.argv[i - 1] === "--agent");
  const agents: Array<"claude" | "codex"> =
    agentArg === "claude" ? ["claude"] :
    agentArg === "codex" ? ["codex"] :
    ["claude", "codex"];

  for (const kind of agents) {
    await captureSession(kind);
    console.log();
  }

  console.log("Done. Inspect the NDJSON files to see message shapes:");
  for (const kind of agents) {
    console.log(`  acp-messages-${kind}.ndjson`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
