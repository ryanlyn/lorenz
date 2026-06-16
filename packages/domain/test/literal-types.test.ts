import { test } from "vitest";
import { AGENT_UPDATE_TYPES, ISSUE_STATE_TYPES, RUNTIME_EVENT_TYPES } from "@lorenz/cli";
import type { AgentUpdate, CodexSettings, Issue, RuntimeEvent } from "@lorenz/cli";
import { assert } from "@lorenz/test-utils";

const codexSettingsFixture: CodexSettings = {
  command: "codex-acp",
  turnTimeoutMs: 1,
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
  // @ts-expect-error Issue state type is normalized to known tracker buckets.
  const _issue: Issue = { ...issueFixture, stateType: "needs-review" };
  // @ts-expect-error Codex settings only retain command and timeout fields.
  const _codexSettings: CodexSettings = {
    ...codexSettingsFixture,
    threadSandbox: "workspaceWrite",
  };
});

test("AGENT_UPDATE_TYPES contains no duplicate entries", () => {
  const unique = new Set(AGENT_UPDATE_TYPES);
  assert.equal(unique.size, AGENT_UPDATE_TYPES.length);
});

test("ISSUE_STATE_TYPES contains no duplicate entries", () => {
  const unique = new Set(ISSUE_STATE_TYPES);
  assert.equal(unique.size, ISSUE_STATE_TYPES.length);
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

  const runtimeEventTypes = RUNTIME_EVENT_TYPES as readonly string[];
  assert.ok(runtimeEventTypes.includes(validRuntimeEvent.type));

  const issueStateTypes = ISSUE_STATE_TYPES as readonly string[];
  assert.ok(
    issueFixture.stateType !== undefined && issueStateTypes.includes(issueFixture.stateType),
  );

  // Exhaustiveness: verify array lengths match expected union member counts.
  // If a value is added to or removed from the array without updating the type,
  // the length assertion fails, catching drift that single-value includes checks miss.
  assert.equal(AGENT_UPDATE_TYPES.length, 17, "AGENT_UPDATE_TYPES length mismatch");
  assert.equal(ISSUE_STATE_TYPES.length, 6, "ISSUE_STATE_TYPES length mismatch");
  // RUNTIME_EVENT_TYPES = AGENT_UPDATE_TYPES + runtime-only entries
  assert.equal(
    RUNTIME_EVENT_TYPES.length,
    AGENT_UPDATE_TYPES.length + 19,
    "RUNTIME_EVENT_TYPES should be AGENT_UPDATE_TYPES plus 19 runtime-only events",
  );
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

  const issueStateTypes = ISSUE_STATE_TYPES as readonly string[];
  assert.ok(
    !issueStateTypes.includes("needs-review"),
    "bogus 'needs-review' should not be in ISSUE_STATE_TYPES",
  );
});
