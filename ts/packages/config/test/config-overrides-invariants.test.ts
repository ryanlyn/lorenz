import { test, describe } from "vitest";
import fc from "fast-check";
import {
  defaultSettings,
  settingsForIssueState,
  parseConfig,
  normalizeStateName,
} from "@symphony/cli";
import { MAX_TURNS_MAX } from "@symphony/domain";
import { assert } from "@symphony/test-utils";

// --- Helper arbitraries ---

/** Generates non-empty state names from safe characters (avoids blank after trim). */
const stateNameArb = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_- "), {
    minLength: 1,
    maxLength: 15,
  })
  .map((a) => a.join(""))
  .filter((s) => s.trim().length > 0);

/**
 * Generates state names with unicode, control chars, and mixed whitespace for
 * stress-testing normalization boundaries.
 */
const exoticStateNameArb = fc
  .oneof(
    // Basic alphanumeric with leading/trailing whitespace
    stateNameArb.map((s) => `  ${s}  `),
    // Tab/newline padding
    stateNameArb.map((s) => `\t${s}\t`),
    // Mixed case with unicode letters
    fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
    // Emoji/special chars
    fc.constantFrom("in progress", "In Progress", "IN PROGRESS", "todo", "TODO", "To Do"),
  )
  .filter((s) => s.trim().length > 0);

/** Generates a positive integer suitable for timeout/concurrency fields. */
const positiveIntArb = fc.integer({ min: 1, max: 10_000_000 });

/** Boundary-focused positive integer arbitrary. */
const boundaryPositiveIntArb = fc.oneof(
  fc.constant(1),
  fc.constant(2),
  fc.constant(Number.MAX_SAFE_INTEGER),
  fc.integer({ min: 1, max: 10_000_000 }),
  fc.integer({ min: 9_999_999, max: 10_000_000 }),
);

/** Generates a maxTurns value within schema bounds for parseConfig tests. */
const schemaMaxTurnsArb = fc.integer({ min: 1, max: MAX_TURNS_MAX });

/** Generates a pair of distinct state names (normalized). */
const distinctStateNamesArb = fc
  .tuple(stateNameArb, stateNameArb)
  .filter(([a, b]) => normalizeStateName(a) !== normalizeStateName(b));

describe("INVARIANT: When no override is present, the base settings SHALL remain unchanged", () => {
  test("no override present — base settings remain unchanged", () => {
    fc.assert(
      fc.property(stateNameArb, (state) => {
        // Create settings with empty statusOverrides (default)
        const settings = defaultSettings();
        // Ensure the map has no entry for any normalized state
        assert.equal(settings.statusOverrides.size, 0);

        const result = settingsForIssueState(settings, state);

        // Agent settings preserved
        assert.equal(result.agent.kind, settings.agent.kind);
        assert.equal(result.agent.maxConcurrentAgents, settings.agent.maxConcurrentAgents);
        assert.equal(result.agent.maxTurns, settings.agent.maxTurns);
        assert.equal(result.agent.maxRetryBackoffMs, settings.agent.maxRetryBackoffMs);
        assert.equal(result.agent.ensembleSize, settings.agent.ensembleSize);

        // Codex settings preserved
        assert.equal(
          result.agents.codex.options.bridgeCommand,
          settings.agents.codex.options.bridgeCommand,
        );
        assert.equal(result.agents.codex.turnTimeoutMs, settings.agents.codex.turnTimeoutMs);
        assert.equal(result.agents.codex.stallTimeoutMs, settings.agents.codex.stallTimeoutMs);

        // Claude settings preserved
        assert.equal(
          result.agents.claude.options.bridgeCommand,
          settings.agents.claude.options.bridgeCommand,
        );
        assert.equal(result.agents.claude.turnTimeoutMs, settings.agents.claude.turnTimeoutMs);
        assert.equal(result.agents.claude.stallTimeoutMs, settings.agents.claude.stallTimeoutMs);
      }),
      { numRuns: 200 },
    );
  });
});

test("state present but NOT in overrides map — base settings remain unchanged", () => {
  fc.assert(
    fc.property(stateNameArb, positiveIntArb, (state, cap) => {
      const settings = defaultSettings();
      // Add an override for a DIFFERENT state
      settings.statusOverrides.set("__unrelated_state__", {
        agent: { maxConcurrentAgents: cap },
      });

      // Query a state that is NOT in the overrides map
      const normalizedQuery = state.trim().toLowerCase();
      if (normalizedQuery === "__unrelated_state__") return; // skip collision

      const result = settingsForIssueState(settings, state);

      // Should match base defaults
      assert.equal(result.agent.maxConcurrentAgents, settings.agent.maxConcurrentAgents);
      assert.equal(result.agents.codex.turnTimeoutMs, settings.agents.codex.turnTimeoutMs);
      assert.equal(result.agents.claude.turnTimeoutMs, settings.agents.claude.turnTimeoutMs);
    }),
    { numRuns: 200 },
  );
});

test("settingsForIssueState returns a clone, not the same object reference", () => {
  fc.assert(
    fc.property(stateNameArb, (state) => {
      const settings = defaultSettings();
      const result = settingsForIssueState(settings, state);

      // Even when no override, the result must be a distinct object (clone)
      assert.ok(result !== settings);
      assert.ok(result.agent !== settings.agent);
      assert.ok(result.agents.codex !== settings.agents.codex);
      assert.ok(result.agents.claude !== settings.agents.claude);
    }),
    { numRuns: 100 },
  );
});

describe("INVARIANT: When override lookup is performed, it SHALL be case-insensitive", () => {
  test("override lookup is case-insensitive — upper/lower/mixed match", () => {
    fc.assert(
      fc.property(
        stateNameArb.filter((s) => /[a-z]/.test(s)),
        positiveIntArb,
        (state, maxTurns) => {
          const settings = defaultSettings();
          const normalizedKey = state.trim().toLowerCase();
          settings.statusOverrides.set(normalizedKey, {
            agent: { maxTurns },
          });

          // Look up with all-uppercase
          const upper = settingsForIssueState(settings, state.toUpperCase());
          assert.equal(upper.agent.maxTurns, maxTurns);

          // Look up with all-lowercase
          const lower = settingsForIssueState(settings, state.toLowerCase());
          assert.equal(lower.agent.maxTurns, maxTurns);

          // Look up with mixed case (first char upper, rest lower)
          const mixed = state.charAt(0).toUpperCase() + state.slice(1).toLowerCase();
          const mixedResult = settingsForIssueState(settings, mixed);
          assert.equal(mixedResult.agent.maxTurns, maxTurns);
        },
      ),
      { numRuns: 200 },
    );
  });
});

test("lookup is whitespace-insensitive (leading/trailing trimmed)", () => {
  fc.assert(
    fc.property(
      stateNameArb,
      positiveIntArb,
      fc.constantFrom("  ", "\t", " \t ", "   "),
      (state, maxTurns, pad) => {
        const settings = defaultSettings();
        const normalizedKey = normalizeStateName(state);
        settings.statusOverrides.set(normalizedKey, {
          agent: { maxTurns },
        });

        // Look up with leading/trailing whitespace padding
        const padded = pad + state + pad;
        const result = settingsForIssueState(settings, padded);
        assert.equal(result.agent.maxTurns, maxTurns);
      },
    ),
    { numRuns: 200 },
  );
});

test("normalizeStateName is idempotent", () => {
  fc.assert(
    fc.property(exoticStateNameArb, (state) => {
      const once = normalizeStateName(state);
      const twice = normalizeStateName(once);
      assert.equal(once, twice);
    }),
    { numRuns: 200 },
  );
});

test("parseConfig normalizes state names in statusOverrides map keys", () => {
  fc.assert(
    fc.property(
      stateNameArb.filter((s) => /[a-z]/.test(s)),
      schemaMaxTurnsArb,
      (state, maxTurns) => {
        // Use mixed case in the raw config
        const mixedCase = state.charAt(0).toUpperCase() + state.slice(1);
        const raw = {
          status_overrides: {
            [mixedCase]: {
              agent: { max_turns: maxTurns },
            },
          },
        };

        const settings = parseConfig(raw);
        // The key should be normalized (lowercased, trimmed) in the map
        const normalizedKey = state.trim().toLowerCase();
        const override = settings.statusOverrides.get(normalizedKey);
        assert.ok(override !== undefined);
        assert.equal(override!.agent?.maxTurns, maxTurns);
      },
    ),
    { numRuns: 200 },
  );
});

describe("INVARIANT: When overrides are defined for different states, they SHALL apply independently", () => {
  test("overrides for different states apply independently", () => {
    fc.assert(
      fc.property(
        positiveIntArb,
        positiveIntArb,
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 51, max: 100 }),
        (timeoutA, timeoutB, turnsA, turnsB) => {
          const settings = defaultSettings();
          settings.statusOverrides.set("state_alpha", {
            agent: { maxTurns: turnsA },
            agents: { codex: { turnTimeoutMs: timeoutA } },
          });
          settings.statusOverrides.set("state_beta", {
            agent: { maxTurns: turnsB },
            agents: { codex: { turnTimeoutMs: timeoutB } },
          });

          const alpha = settingsForIssueState(settings, "state_alpha");
          const beta = settingsForIssueState(settings, "state_beta");

          // Each state gets its own override values
          assert.equal(alpha.agent.maxTurns, turnsA);
          assert.equal(alpha.agents.codex.turnTimeoutMs, timeoutA);

          assert.equal(beta.agent.maxTurns, turnsB);
          assert.equal(beta.agents.codex.turnTimeoutMs, timeoutB);

          // They don't bleed into each other
          if (turnsA !== turnsB) {
            assert.notEqual(alpha.agent.maxTurns, beta.agent.maxTurns);
          }
          if (timeoutA !== timeoutB) {
            assert.notEqual(alpha.agents.codex.turnTimeoutMs, beta.agents.codex.turnTimeoutMs);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

test("one state override does not affect querying another state", () => {
  fc.assert(
    fc.property(positiveIntArb, (cap) => {
      const settings = defaultSettings();
      settings.statusOverrides.set("overridden", {
        agent: { maxConcurrentAgents: cap },
      });

      // Query a state that has no override
      const unaffected = settingsForIssueState(settings, "not_overridden");
      // Should get the base default, not the override
      assert.equal(unaffected.agent.maxConcurrentAgents, settings.agent.maxConcurrentAgents);

      // Query the overridden state
      const affected = settingsForIssueState(settings, "overridden");
      assert.equal(affected.agent.maxConcurrentAgents, cap);
    }),
    { numRuns: 200 },
  );
});

test("multiple distinct overrides each resolve to their own values", () => {
  fc.assert(
    fc.property(
      distinctStateNamesArb,
      boundaryPositiveIntArb,
      boundaryPositiveIntArb,
      fc.boolean(),
      ([stateA, stateB], turnsA, turnsB, strictMcp) => {
        const settings = defaultSettings();
        const normA = normalizeStateName(stateA);
        const normB = normalizeStateName(stateB);

        settings.statusOverrides.set(normA, {
          agent: { maxTurns: turnsA },
        });
        settings.statusOverrides.set(normB, {
          agent: { maxTurns: turnsB },
          agents: { claude: { options: { strictMcpConfig: strictMcp } } },
        });

        const resultA = settingsForIssueState(settings, stateA);
        const resultB = settingsForIssueState(settings, stateB);

        assert.equal(resultA.agent.maxTurns, turnsA);
        assert.equal(resultB.agent.maxTurns, turnsB);
        assert.equal(resultB.agents.claude.options.strictMcpConfig, strictMcp);
        // State A should not have state B's claude override
        assert.equal(
          resultA.agents.claude.options.strictMcpConfig,
          settings.agents.claude.options.strictMcpConfig,
        );
      },
    ),
    { numRuns: 200 },
  );
});

test("querying override does not mutate the source settings object", () => {
  fc.assert(
    fc.property(positiveIntArb, positiveIntArb, (turnsOverride, timeoutOverride) => {
      const settings = defaultSettings();
      const originalMaxTurns = settings.agent.maxTurns;
      const originalTimeout = settings.agents.codex.turnTimeoutMs;

      settings.statusOverrides.set("mutate_check", {
        agent: { maxTurns: turnsOverride },
        agents: { codex: { turnTimeoutMs: timeoutOverride } },
      });

      // Query the overridden state
      const _ = settingsForIssueState(settings, "mutate_check");

      // The base settings must not be mutated
      assert.equal(settings.agent.maxTurns, originalMaxTurns);
      assert.equal(settings.agents.codex.turnTimeoutMs, originalTimeout);
    }),
    { numRuns: 200 },
  );
});

describe("INVARIANT: When a partial override is applied, unmentioned fields SHALL be preserved", () => {
  test("partial agent override preserves unmentioned agent fields", () => {
    fc.assert(
      fc.property(boundaryPositiveIntArb, (maxTurns) => {
        const settings = defaultSettings();
        // Only override maxTurns
        settings.statusOverrides.set("partial", {
          agent: { maxTurns },
        });

        const result = settingsForIssueState(settings, "partial");

        // Overridden field
        assert.equal(result.agent.maxTurns, maxTurns);

        // Unmentioned fields preserved from base
        assert.equal(result.agent.kind, settings.agent.kind);
        assert.equal(result.agent.maxConcurrentAgents, settings.agent.maxConcurrentAgents);
        assert.equal(result.agent.maxRetryBackoffMs, settings.agent.maxRetryBackoffMs);
        assert.equal(result.agent.ensembleSize, settings.agent.ensembleSize);
      }),
      { numRuns: 200 },
    );
  });
});

test("partial codex override preserves unmentioned codex fields", () => {
  fc.assert(
    fc.property(boundaryPositiveIntArb, (turnTimeoutMs) => {
      const settings = defaultSettings();
      settings.statusOverrides.set("partial_codex", {
        agents: { codex: { turnTimeoutMs } },
      });

      const result = settingsForIssueState(settings, "partial_codex");

      // Overridden field
      assert.equal(result.agents.codex.turnTimeoutMs, turnTimeoutMs);

      // Unmentioned fields preserved
      assert.equal(
        result.agents.codex.options.bridgeCommand,
        settings.agents.codex.options.bridgeCommand,
      );
      assert.equal(result.agents.codex.stallTimeoutMs, settings.agents.codex.stallTimeoutMs);
    }),
    { numRuns: 200 },
  );
});

test("partial claude override preserves unmentioned claude fields", () => {
  fc.assert(
    fc.property(boundaryPositiveIntArb, (turnTimeoutMs) => {
      const settings = defaultSettings();
      settings.statusOverrides.set("partial_claude", {
        agents: { claude: { turnTimeoutMs } },
      });

      const result = settingsForIssueState(settings, "partial_claude");

      // Overridden field
      assert.equal(result.agents.claude.turnTimeoutMs, turnTimeoutMs);

      // Unmentioned fields preserved
      assert.equal(
        result.agents.claude.options.bridgeCommand,
        settings.agents.claude.options.bridgeCommand,
      );
      assert.equal(result.agents.claude.stallTimeoutMs, settings.agents.claude.stallTimeoutMs);
      assert.equal(
        result.agents.claude.options.strictMcpConfig,
        settings.agents.claude.options.strictMcpConfig,
      );
    }),
    { numRuns: 200 },
  );
});

test("override with only agent section leaves codex and claude untouched", () => {
  fc.assert(
    fc.property(boundaryPositiveIntArb, (maxTurns) => {
      const settings = defaultSettings();
      settings.statusOverrides.set("agent_only", {
        agent: { maxTurns },
      });

      const result = settingsForIssueState(settings, "agent_only");

      // Codex entirely untouched
      assert.equal(
        result.agents.codex.options.bridgeCommand,
        settings.agents.codex.options.bridgeCommand,
      );
      assert.equal(result.agents.codex.turnTimeoutMs, settings.agents.codex.turnTimeoutMs);
      assert.equal(result.agents.codex.stallTimeoutMs, settings.agents.codex.stallTimeoutMs);

      // Claude entirely untouched
      assert.equal(
        result.agents.claude.options.bridgeCommand,
        settings.agents.claude.options.bridgeCommand,
      );
      assert.equal(result.agents.claude.turnTimeoutMs, settings.agents.claude.turnTimeoutMs);
      assert.equal(result.agents.claude.stallTimeoutMs, settings.agents.claude.stallTimeoutMs);
    }),
    { numRuns: 200 },
  );
});

test("overriding multiple agent fields at once preserves remaining fields", () => {
  fc.assert(
    fc.property(boundaryPositiveIntArb, boundaryPositiveIntArb, (maxTurns, maxConcurrent) => {
      const settings = defaultSettings();
      settings.statusOverrides.set("multi_agent_override", {
        agent: { maxTurns, maxConcurrentAgents: maxConcurrent },
      });

      const result = settingsForIssueState(settings, "multi_agent_override");

      // Both overridden fields take new values
      assert.equal(result.agent.maxTurns, maxTurns);
      assert.equal(result.agent.maxConcurrentAgents, maxConcurrent);

      // Unmentioned fields preserved
      assert.equal(result.agent.kind, settings.agent.kind);
      assert.equal(result.agent.maxRetryBackoffMs, settings.agent.maxRetryBackoffMs);
      assert.equal(result.agent.ensembleSize, settings.agent.ensembleSize);
    }),
    { numRuns: 200 },
  );
});

test("partial override via parseConfig preserves fields not in raw config", () => {
  fc.assert(
    fc.property(schemaMaxTurnsArb, (turns) => {
      const raw = {
        status_overrides: {
          review: {
            agent: { max_turns: turns },
          },
        },
      };

      const settings = parseConfig(raw);
      const result = settingsForIssueState(settings, "review");

      // Overridden
      assert.equal(result.agent.maxTurns, turns);
      // All other agent fields use defaults
      assert.equal(result.agent.maxConcurrentAgents, settings.agent.maxConcurrentAgents);
      assert.equal(result.agent.maxRetryBackoffMs, settings.agent.maxRetryBackoffMs);
      assert.equal(result.agent.ensembleSize, settings.agent.ensembleSize);
      // Codex and claude completely default
      assert.equal(result.agents.codex.turnTimeoutMs, settings.agents.codex.turnTimeoutMs);
      assert.equal(result.agents.claude.turnTimeoutMs, settings.agents.claude.turnTimeoutMs);
    }),
    { numRuns: 200 },
  );
});

test("Robustness: settingsForIssueState is deterministic for same input", () => {
  fc.assert(
    fc.property(stateNameArb, boundaryPositiveIntArb, (state, maxTurns) => {
      const settings = defaultSettings();
      const normalizedKey = normalizeStateName(state);
      settings.statusOverrides.set(normalizedKey, {
        agent: { maxTurns },
      });

      const result1 = settingsForIssueState(settings, state);
      const result2 = settingsForIssueState(settings, state);

      assert.equal(result1.agent.maxTurns, result2.agent.maxTurns);
      assert.equal(result1.agents.codex.turnTimeoutMs, result2.agents.codex.turnTimeoutMs);
      assert.equal(result1.agents.claude.turnTimeoutMs, result2.agents.claude.turnTimeoutMs);
    }),
    { numRuns: 200 },
  );
});

test("Robustness: override with all three sections applies each independently", () => {
  fc.assert(
    fc.property(
      boundaryPositiveIntArb,
      boundaryPositiveIntArb,
      boundaryPositiveIntArb,
      (agentTurns, codexTimeout, claudeTimeout) => {
        const settings = defaultSettings();
        settings.statusOverrides.set("all_sections", {
          agent: { maxTurns: agentTurns },
          agents: {
            codex: { turnTimeoutMs: codexTimeout },
            claude: { turnTimeoutMs: claudeTimeout },
          },
        });

        const result = settingsForIssueState(settings, "all_sections");

        // All three overrides applied
        assert.equal(result.agent.maxTurns, agentTurns);
        assert.equal(result.agents.codex.turnTimeoutMs, codexTimeout);
        assert.equal(result.agents.claude.turnTimeoutMs, claudeTimeout);

        // Unmentioned fields in each section preserved
        assert.equal(result.agent.maxConcurrentAgents, settings.agent.maxConcurrentAgents);
        assert.equal(
          result.agents.codex.options.bridgeCommand,
          settings.agents.codex.options.bridgeCommand,
        );
        assert.equal(
          result.agents.claude.options.bridgeCommand,
          settings.agents.claude.options.bridgeCommand,
        );
      },
    ),
    { numRuns: 200 },
  );
});
