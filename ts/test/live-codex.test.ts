import path from "node:path";

import { test } from "vitest";
import { CodexAppServerExecutor, parseConfig } from "@symphony/cli";

import { assert } from "./assert.js";
import { sampleIssue, tempDir } from "./helpers.js";

test(
  "live Codex app-server smoke",
  { timeout: 180_000, skip: process.env.SYMPHONY_TS_RUN_REAL_CODEX_E2E !== "1" },
  async () => {
    const workspace = await tempDir("symphony-ts-live-codex");
    const settings = parseConfig({
      workspace: { root: path.dirname(workspace) },
      codex: {
        command: process.env.SYMPHONY_TS_CODEX_COMMAND ?? "codex app-server",
        approval_policy: "never",
        turn_timeout_ms: 180_000,
        read_timeout_ms: 30_000,
      },
    });
    const executor = new CodexAppServerExecutor();
    const session = await executor.startSession({ workspace, settings, issue: sampleIssue });
    const updates = await executor.runTurn(
      session,
      "Reply exactly TS_CODEX_E2E_OK and do not modify files.",
      sampleIssue,
    );
    await session.stop();

    assert.ok(session.resumeId);
    assert.ok(updates.some((update) => update.type === "turn_completed"));
  },
);
