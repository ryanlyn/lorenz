import path from "node:path";

import { test } from "vitest";
import { CodexAppServerExecutor, parseConfig } from "@symphony/cli";

import { assert } from "./assert.js";
import { initGitRepo, sampleIssue, tempDir } from "./helpers.js";

const runLive = process.env.SYMPHONY_TS_RUN_REAL_CODEX_RESUME_E2E === "1";

test("live Codex app-server resume smoke", { timeout: 240_000, skip: !runLive }, async () => {
  const workspace = await tempDir("symphony-ts-live-codex-resume");
  await initGitRepo(workspace);

  const settings = parseConfig({
    workspace: { root: path.dirname(workspace) },
    codex: {
      command: process.env.SYMPHONY_TS_CODEX_COMMAND ?? "codex app-server",
      approval_policy: "never",
      turn_timeout_ms: 180_000,
      read_timeout_ms: 30_000,
      turn_sandbox_policy: {
        type: "workspaceWrite",
        writableRoots: [workspace],
        readOnlyAccess: { type: "fullAccess" },
        networkAccess: true,
      },
    },
  });

  const executor = new CodexAppServerExecutor();
  const first = await executor.startSession({ workspace, settings, issue: sampleIssue });

  try {
    const firstUpdates = await executor.runTurn(
      first,
      "Reply exactly TS_CODEX_RESUME_FIRST_OK. Do not modify files.",
      sampleIssue,
    );
    assert.ok(firstUpdates.some((update) => update.type === "turn_completed"));
    assert.ok(first.resumeId);
  } finally {
    await first.stop();
  }

  const second = await executor.startSession({
    workspace,
    settings,
    issue: sampleIssue,
    resumeId: first.resumeId,
  });

  try {
    assert.equal(second.resumeId, first.resumeId);
    const secondUpdates = await executor.runTurn(
      second,
      "Reply exactly TS_CODEX_RESUME_SECOND_OK. Do not modify files.",
      sampleIssue,
    );
    assert.ok(secondUpdates.some((update) => update.type === "turn_completed"));
  } finally {
    await second.stop();
  }
});
