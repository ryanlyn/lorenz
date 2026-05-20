import { test } from "vitest";
import { assert } from "../../../test/assert.js";
import {
  AGENT_UPDATE_TYPES,
  CODEX_APPROVAL_POLICY_NAMES,
  CODEX_SANDBOX_MODES,
  ISSUE_STATE_TYPES,
} from "@symphony/cli";
import type { AgentUpdate, CodexSettings, Issue, RuntimeEvent, SessionUpdate } from "@symphony/cli";

const codexSettingsFixture: CodexSettings = {
  command: "codex app-server",
  approvalPolicy: "never",
  threadSandbox: "workspace-write",
  turnSandboxPolicy: null,
  turnTimeoutMs: 1,
  readTimeoutMs: 1,
  stallTimeoutMs: 0,
};

const issueFixture: Issue = {
  id: "issue-1",
  identifier: "MT-1",
  title: "Fixture",
  state: "Todo",
  stateType: "unstarted",
  labels: [],
  blockers: [],
};

const validAgentUpdate: AgentUpdate = { type: "turn_completed" };
const validRuntimeEvent: RuntimeEvent = {
  type: "run_completed",
  message: "completed",
  at: "2026-05-13T00:00:00.000Z",
};
const validSessionUpdate: SessionUpdate = { kind: "turn_completed", message: "completed" };

// @ts-expect-error Agent updates must use the canonical event vocabulary.
const invalidAgentUpdate: AgentUpdate = { type: "event" };
const invalidRuntimeEvent: RuntimeEvent = {
  // @ts-expect-error Runtime events must use the canonical runtime event vocabulary.
  type: "event",
  message: "event",
  at: "2026-05-13T00:00:00.000Z",
};
// @ts-expect-error Session updates must use the canonical protocol update vocabulary.
const invalidSessionUpdate: SessionUpdate = { kind: "event" };
// @ts-expect-error Issue state type is normalized to known tracker buckets.
const invalidIssue: Issue = { ...issueFixture, stateType: "needs-review" };
const invalidCodexSettings: CodexSettings = {
  ...codexSettingsFixture,
  // @ts-expect-error Codex thread sandbox accepts only app-server sandbox mode names.
  threadSandbox: "workspaceWrite",
};

test("literal vocabularies expose canonical runtime values", () => {
  assert.ok(AGENT_UPDATE_TYPES.includes(validAgentUpdate.type));
  assert.ok(CODEX_APPROVAL_POLICY_NAMES.includes("never"));
  assert.ok(CODEX_SANDBOX_MODES.includes(codexSettingsFixture.threadSandbox));
  assert.ok(ISSUE_STATE_TYPES.includes("unstarted"));
  assert.equal(validRuntimeEvent.type, "run_completed");
  assert.equal(validSessionUpdate.kind, "turn_completed");
  assert.equal(invalidAgentUpdate.type, "event");
  assert.equal(invalidRuntimeEvent.type, "event");
  assert.equal(invalidSessionUpdate.kind, "event");
  assert.equal(invalidIssue.stateType, "needs-review");
  assert.equal(invalidCodexSettings.threadSandbox, "workspaceWrite");
});
