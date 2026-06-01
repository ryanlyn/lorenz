import { test } from "vitest";
import fc from "fast-check";
import {
  normalizeStateName,
  normalizeRouteName,
  defaultSettings,
  settingsForIssueState,
  parseConfig,
} from "@symphony/cli";

import { assert } from "../../../test/assert.js";

// --- normalizeStateName ---

test("INVARIANT: normalizeStateName SHALL be idempotent", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 30 }), (input) => {
      const once = normalizeStateName(input);
      const twice = normalizeStateName(once);
      assert.equal(twice, once);
    }),
  );
});

test("INVARIANT: normalizeStateName SHALL be case-insensitive", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 20 }), (input) => {
      assert.equal(
        normalizeStateName(input.toUpperCase()),
        normalizeStateName(input.toLowerCase()),
      );
    }),
  );
});

test("INVARIANT: normalizeStateName SHALL trim leading and trailing whitespace", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 20 }), (input) => {
      assert.equal(normalizeStateName(`  ${input}  `), normalizeStateName(input));
    }),
  );
});

// --- normalizeRouteName ---

test("normalizeRouteName — null and undefined produce empty string", () => {
  fc.assert(
    fc.property(fc.oneof(fc.constant(null), fc.constant(undefined)), (input) => {
      assert.equal(normalizeRouteName(input), "");
    }),
  );
});

test("INVARIANT: normalizeRouteName SHALL be idempotent", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 30 }), (input) => {
      const once = normalizeRouteName(input);
      const twice = normalizeRouteName(once);
      assert.equal(twice, once);
    }),
  );
});

test("INVARIANT: normalizeRouteName SHALL be case-insensitive", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 20 }), (input) => {
      assert.equal(
        normalizeRouteName(input.toUpperCase()),
        normalizeRouteName(input.toLowerCase()),
      );
    }),
  );
});

test("INVARIANT: normalizeRouteName SHALL trim leading and trailing whitespace", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 20 }), (input) => {
      assert.equal(normalizeRouteName(`  ${input}  `), normalizeRouteName(input));
    }),
  );
});

// --- settingsForIssueState with status overrides ---

test("INVARIANT: When no override is present, settingsForIssueState SHALL return base settings unchanged", () => {
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(..."abcdefghijklmnop"), { minLength: 1, maxLength: 10 })
        .map((a) => a.join("")),
      (state) => {
        const settings = defaultSettings();
        const result = settingsForIssueState(settings, state);
        assert.equal(result.agent.maxConcurrentAgents, settings.agent.maxConcurrentAgents);
        assert.equal(result.codex.turnTimeoutMs, settings.codex.turnTimeoutMs);
      },
    ),
  );
});

test("INVARIANT: settingsForIssueState state name lookup SHALL be case-insensitive", () => {
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(..."abcdefghij"), { minLength: 1, maxLength: 10 })
        .map((a) => a.join("")),
      fc.integer({ min: 1, max: 5 }),
      (state, cap) => {
        const settings = defaultSettings();
        settings.statusOverrides.set(state.toLowerCase(), {
          agent: { maxConcurrentAgents: cap },
        });
        const upper = settingsForIssueState(settings, state.toUpperCase());
        const lower = settingsForIssueState(settings, state.toLowerCase());
        assert.equal(upper.agent.maxConcurrentAgents, cap);
        assert.equal(lower.agent.maxConcurrentAgents, cap);
      },
    ),
  );
});

test("INVARIANT: settingsForIssueState overrides for different states SHALL be isolated", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 10 }), fc.integer({ min: 11, max: 20 }), (capA, capB) => {
      const settings = defaultSettings();
      settings.statusOverrides.set("todo", { agent: { maxConcurrentAgents: capA } });
      settings.statusOverrides.set("review", { agent: { maxConcurrentAgents: capB } });
      const todo = settingsForIssueState(settings, "Todo");
      const review = settingsForIssueState(settings, "Review");
      assert.equal(todo.agent.maxConcurrentAgents, capA);
      assert.equal(review.agent.maxConcurrentAgents, capB);
    }),
  );
});

test("INVARIANT: settingsForIssueState partial overrides SHALL preserve unmentioned fields", () => {
  fc.assert(
    fc.property(fc.integer({ min: 100_000, max: 9_000_000 }), (timeout) => {
      const settings = defaultSettings();
      settings.statusOverrides.set("review", { codex: { turnTimeoutMs: timeout } });
      const result = settingsForIssueState(settings, "review");
      assert.equal(result.codex.turnTimeoutMs, timeout);
      assert.equal(result.codex.readTimeoutMs, settings.codex.readTimeoutMs);
      assert.equal(result.codex.stallTimeoutMs, settings.codex.stallTimeoutMs);
    }),
  );
});

// --- parseConfig deep merge for status_overrides ---

test("parseConfig — status_overrides deep merges codex approval_policy", () => {
  fc.assert(
    fc.property(fc.boolean(), fc.boolean(), (sandbox, rules) => {
      const raw = {
        tracker: { kind: "memory", project_slug: "test" },
        status_overrides: {
          "in progress": {
            codex: {
              approval_policy: {
                reject: { sandbox_approval: sandbox, rules },
              },
            },
          },
        },
      };
      const settings = parseConfig(raw);
      const effective = settingsForIssueState(settings, "in progress");
      const policy = effective.codex.approvalPolicy as Record<string, unknown> | null;
      assert.ok(policy !== null && typeof policy === "object");
      const reject = (policy as { reject?: Record<string, unknown> }).reject;
      assert.ok(reject !== undefined);
      assert.equal(reject.sandbox_approval, sandbox);
      assert.equal(reject.rules, rules);
    }),
  );
});
