import { test } from "vitest";
import {
  AGENT_UPDATE_TYPES,
  CODEX_APPROVAL_POLICY_NAMES,
  CODEX_SANDBOX_MODES,
  ISSUE_STATE_TYPES,
  RUNTIME_EVENT_TYPES,
  SESSION_UPDATE_KINDS,
} from "@symphony/cli";
import type { AgentUpdate, CodexSettings, Issue, RuntimeEvent, SessionUpdate } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

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

// Compile-time type checks: @ts-expect-error proves that invalid literals are
// rejected by tsc. Wrapping them in a test avoids unused-variable warnings.
test("literal types reject invalid values at compile time", () => {
  // @ts-expect-error Agent updates must use the canonical event vocabulary.
  const _agentUpdate: AgentUpdate = { type: "event" };
  // @ts-expect-error Runtime events must use the canonical runtime event vocabulary.
  const _runtimeEvent: RuntimeEvent = {
    type: "event",
    message: "event",
    at: "2026-05-13T00:00:00.000Z",
  };
  // @ts-expect-error Session updates must use the canonical protocol update vocabulary.
  const _sessionUpdate: SessionUpdate = { kind: "event" };
  // @ts-expect-error Issue state type is normalized to known tracker buckets.
  const _issue: Issue = { ...issueFixture, stateType: "needs-review" };
  // @ts-expect-error Codex thread sandbox accepts only app-server sandbox mode names.
  const _codexSettings: CodexSettings = {
    ...codexSettingsFixture,
    threadSandbox: "workspaceWrite",
  };
});

test("AGENT_UPDATE_TYPES contains no duplicate entries", () => {
  const unique = new Set(AGENT_UPDATE_TYPES);
  assert.equal(unique.size, AGENT_UPDATE_TYPES.length);
});

test("CODEX_APPROVAL_POLICY_NAMES contains no duplicate entries", () => {
  const unique = new Set(CODEX_APPROVAL_POLICY_NAMES);
  assert.equal(unique.size, CODEX_APPROVAL_POLICY_NAMES.length);
});

test("CODEX_SANDBOX_MODES contains no duplicate entries", () => {
  const unique = new Set(CODEX_SANDBOX_MODES);
  assert.equal(unique.size, CODEX_SANDBOX_MODES.length);
});

test("ISSUE_STATE_TYPES contains no duplicate entries", () => {
  const unique = new Set(ISSUE_STATE_TYPES);
  assert.equal(unique.size, ISSUE_STATE_TYPES.length);
});

test("SESSION_UPDATE_KINDS contains no duplicate entries", () => {
  const unique = new Set(SESSION_UPDATE_KINDS);
  assert.equal(unique.size, SESSION_UPDATE_KINDS.length);
});

test("RUNTIME_EVENT_TYPES contains no duplicate entries", () => {
  const unique = new Set(RUNTIME_EVENT_TYPES);
  assert.equal(unique.size, RUNTIME_EVENT_TYPES.length);
});

test("RUNTIME_EVENT_TYPES is a strict superset of AGENT_UPDATE_TYPES", () => {
  const runtimeSet = new Set<string>(RUNTIME_EVENT_TYPES);
  for (const agentType of AGENT_UPDATE_TYPES) {
    assert.ok(runtimeSet.has(agentType));
  }
  // Runtime events must include additional entries beyond agent updates.
  assert.ok(RUNTIME_EVENT_TYPES.length > AGENT_UPDATE_TYPES.length);
});

test("RUNTIME_EVENT_TYPES includes runtime-only events not in AGENT_UPDATE_TYPES", () => {
  const agentSet = new Set<string>(AGENT_UPDATE_TYPES);
  const runtimeOnly = RUNTIME_EVENT_TYPES.filter((t) => !agentSet.has(t));
  // Verify that runtime-specific events like run lifecycle are present.
  assert.ok(runtimeOnly.includes("run_started"));
  assert.ok(runtimeOnly.includes("run_completed"));
  assert.ok(runtimeOnly.includes("run_failed"));
  assert.ok(runtimeOnly.includes("poll_error"));
});

test("typed fixture values are accepted by their respective runtime arrays", () => {
  // Verify that well-typed values are actually members of the runtime arrays.
  // This catches divergence between the type definitions and the const arrays.
  const agentUpdateTypes = AGENT_UPDATE_TYPES as readonly string[];
  assert.ok(agentUpdateTypes.includes(validAgentUpdate.type));

  const sandboxModes = CODEX_SANDBOX_MODES as readonly string[];
  assert.ok(sandboxModes.includes(codexSettingsFixture.threadSandbox));

  const runtimeEventTypes = RUNTIME_EVENT_TYPES as readonly string[];
  assert.ok(runtimeEventTypes.includes(validRuntimeEvent.type));

  const sessionKinds = SESSION_UPDATE_KINDS as readonly string[];
  assert.ok(sessionKinds.includes(validSessionUpdate.kind));

  const issueStateTypes = ISSUE_STATE_TYPES as readonly string[];
  assert.ok(
    issueFixture.stateType !== undefined && issueStateTypes.includes(issueFixture.stateType),
  );

  // Exhaustiveness: verify array lengths match expected union member counts.
  // If a value is added to or removed from the array without updating the type,
  // the length assertion fails, catching drift that single-value includes checks miss.
  assert.equal(AGENT_UPDATE_TYPES.length, 28, "AGENT_UPDATE_TYPES length mismatch");
  assert.equal(CODEX_SANDBOX_MODES.length, 3, "CODEX_SANDBOX_MODES length mismatch");
  assert.equal(SESSION_UPDATE_KINDS.length, 9, "SESSION_UPDATE_KINDS length mismatch");
  assert.equal(ISSUE_STATE_TYPES.length, 6, "ISSUE_STATE_TYPES length mismatch");
  // RUNTIME_EVENT_TYPES = AGENT_UPDATE_TYPES + runtime-only entries
  assert.equal(
    RUNTIME_EVENT_TYPES.length,
    AGENT_UPDATE_TYPES.length + 20,
    "RUNTIME_EVENT_TYPES should be AGENT_UPDATE_TYPES plus 20 runtime-only events",
  );
});

test("CODEX_APPROVAL_POLICY_NAMES covers all expected security policies", () => {
  // The approval policies represent an escalating trust ladder;
  // verify the expected ordering from most restrictive to least is present.
  const policies = CODEX_APPROVAL_POLICY_NAMES as readonly string[];
  assert.ok(policies.includes("untrusted"));
  assert.ok(policies.includes("on-failure"));
  assert.ok(policies.includes("on-request"));
  assert.ok(policies.includes("never"));
  // Should contain exactly these four canonical policies.
  assert.equal(CODEX_APPROVAL_POLICY_NAMES.length, 4);
});

test("CODEX_SANDBOX_MODES covers all expected isolation levels", () => {
  const modes = CODEX_SANDBOX_MODES as readonly string[];
  assert.ok(modes.includes("read-only"));
  assert.ok(modes.includes("workspace-write"));
  assert.ok(modes.includes("danger-full-access"));
  assert.equal(CODEX_SANDBOX_MODES.length, 3);
});

test("ISSUE_STATE_TYPES covers all tracker state buckets", () => {
  const types = ISSUE_STATE_TYPES as readonly string[];
  assert.ok(types.includes("backlog"));
  assert.ok(types.includes("unstarted"));
  assert.ok(types.includes("started"));
  assert.ok(types.includes("completed"));
  assert.ok(types.includes("canceled"));
  assert.ok(types.includes("triage"));
  assert.equal(ISSUE_STATE_TYPES.length, 6);
});

test("runtime arrays reject values outside the canonical vocabulary", () => {
  // Runtime complement to the compile-time @ts-expect-error checks above.
  // Ensures invalid values are not present even if the type checker is bypassed.
  const agentUpdateTypes = AGENT_UPDATE_TYPES as readonly string[];
  assert.ok(
    !agentUpdateTypes.includes("event"),
    "bogus 'event' should not be in AGENT_UPDATE_TYPES",
  );

  const runtimeEventTypes = RUNTIME_EVENT_TYPES as readonly string[];
  assert.ok(
    !runtimeEventTypes.includes("event"),
    "bogus 'event' should not be in RUNTIME_EVENT_TYPES",
  );

  const sessionKinds = SESSION_UPDATE_KINDS as readonly string[];
  assert.ok(!sessionKinds.includes("event"), "bogus 'event' should not be in SESSION_UPDATE_KINDS");

  const issueStateTypes = ISSUE_STATE_TYPES as readonly string[];
  assert.ok(
    !issueStateTypes.includes("needs-review"),
    "bogus 'needs-review' should not be in ISSUE_STATE_TYPES",
  );

  const sandboxModes = CODEX_SANDBOX_MODES as readonly string[];
  assert.ok(
    !sandboxModes.includes("workspaceWrite"),
    "bogus 'workspaceWrite' should not be in CODEX_SANDBOX_MODES",
  );
});
