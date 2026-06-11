import { test } from "vitest";
import fc from "fast-check";
import { parseConfig } from "@symphony/cli";
import { ONE_WEEK_MS, PORT_MAX } from "@symphony/domain";
import { assert } from "@symphony/test-utils";

// --- camelToSnake (tested indirectly via error labels) ---

test("camelToSnake — error labels use snake_case field names for numeric fields", () => {
  const camelFields = [
    { section: "polling", snake: "interval_ms" },
    { section: "worker", snake: "ssh_timeout_ms" },
    { section: "worker", snake: "max_concurrent_agents_per_host" },
    { section: "observability", snake: "render_interval_ms" },
    { section: "agent", snake: "max_retry_backoff_ms" },
    { section: "agents", snake: "turn_timeout_ms" },
    { section: "codex", snake: "turn_timeout_ms" },
  ];

  for (const { section, snake } of camelFields) {
    const input = { [section]: { [snake]: "not_valid_for_any_numeric" } };
    assert.throws(() => parseConfig(input), new RegExp(snake));
  }
});

// --- coercedIntervalMs (via polling.interval_ms) ---

test("INVARIANT: coercedPositiveInt SHALL accept any positive integer", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: ONE_WEEK_MS }), (n) => {
      const settings = parseConfig({ polling: { interval_ms: n } });
      assert.equal(settings.polling.intervalMs, n);
    }),
  );
});

test("INVARIANT: coercedPositiveInt SHALL accept positive integers as strings", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: ONE_WEEK_MS }), (n) => {
      const settings = parseConfig({ polling: { interval_ms: String(n) } });
      assert.equal(settings.polling.intervalMs, n);
    }),
  );
});

test("INVARIANT: coercedPositiveInt SHALL reject zero and negative integers", () => {
  fc.assert(
    fc.property(fc.integer({ min: -1_000_000, max: 0 }), (n) => {
      assert.throws(() => parseConfig({ polling: { interval_ms: n } }), /polling.interval_ms/);
    }),
  );
});

test("coercedPositiveInt — rejects non-integer numbers", () => {
  fc.assert(
    fc.property(
      fc.double({ min: 0.01, max: 1_000_000, noNaN: true }).filter((n) => !Number.isInteger(n)),
      (n) => {
        assert.throws(() => parseConfig({ polling: { interval_ms: n } }), /polling.interval_ms/);
      },
    ),
  );
});

test("coercedPositiveInt — rejects NaN", () => {
  assert.throws(
    () => parseConfig({ polling: { interval_ms: NaN } }),
    /must not be NaN|polling.interval_ms/,
  );
});

// --- coercedNonNegativeTimeoutMs (via codex.stall_timeout_ms) ---

test("INVARIANT: coercedNonNegativeInt SHALL accept zero and positive integers", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: ONE_WEEK_MS }), (n) => {
      const settings = parseConfig({ codex: { stall_timeout_ms: n } });
      assert.equal(settings.agents.codex!.stallTimeoutMs, n);
    }),
  );
});

test("coercedNonNegativeInt — accepts non-negative integer as string", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: ONE_WEEK_MS }), (n) => {
      const settings = parseConfig({ codex: { stall_timeout_ms: String(n) } });
      assert.equal(settings.agents.codex!.stallTimeoutMs, n);
    }),
  );
});

test("INVARIANT: coercedNonNegativeInt SHALL reject negative integers", () => {
  fc.assert(
    fc.property(fc.integer({ min: -1_000_000, max: -1 }), (n) => {
      assert.throws(
        () => parseConfig({ codex: { stall_timeout_ms: n } }),
        /codex.stall_timeout_ms/,
      );
    }),
  );
});

// --- coercedPort (via server.port) ---

test("INVARIANT: coercedPort SHALL accept valid port numbers 0-65535", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: PORT_MAX }), (n) => {
      const settings = parseConfig({ server: { port: n } });
      assert.equal(settings.server.port, n);
    }),
  );
});

test("coercedPort — accepts valid port as string", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: PORT_MAX }), (n) => {
      const settings = parseConfig({ server: { port: String(n) } });
      assert.equal(settings.server.port, n);
    }),
  );
});

test("INVARIANT: coercedPort SHALL reject ports above 65535", () => {
  fc.assert(
    fc.property(fc.integer({ min: PORT_MAX + 1, max: 1_000_000 }), (n) => {
      assert.throws(
        () => parseConfig({ server: { port: n } }),
        /server.port must be a valid port number/,
      );
    }),
  );
});

test("INVARIANT: coercedPort SHALL reject negative ports", () => {
  fc.assert(
    fc.property(fc.integer({ min: -1_000_000, max: -1 }), (n) => {
      assert.throws(
        () => parseConfig({ server: { port: n } }),
        /server.port must be a valid port number/,
      );
    }),
  );
});

// --- coercedBoolean (via observability.dashboard_enabled) ---

test("INVARIANT: coercedBoolean SHALL accept boolean values", () => {
  fc.assert(
    fc.property(fc.boolean(), (b) => {
      const settings = parseConfig({ observability: { dashboard_enabled: b } });
      assert.equal(settings.observability.dashboardEnabled, b);
    }),
  );
});

test("coercedBoolean — accepts string 'true' and 'false'", () => {
  fc.assert(
    fc.property(fc.boolean(), (b) => {
      const settings = parseConfig({ observability: { dashboard_enabled: String(b) } });
      assert.equal(settings.observability.dashboardEnabled, b);
    }),
  );
});

test("INVARIANT: coercedBoolean SHALL reject arbitrary strings", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s !== "true" && s !== "false"),
      (s) => {
        assert.throws(
          () => parseConfig({ observability: { dashboard_enabled: s } }),
          /expected a boolean/,
        );
      },
    ),
  );
});

test("coercedBoolean — rejects numbers", () => {
  fc.assert(
    fc.property(fc.integer({ min: -100, max: 100 }), (n) => {
      assert.throws(
        () => parseConfig({ observability: { dashboard_enabled: n } }),
        /expected a boolean/,
      );
    }),
  );
});

// --- numericInput string coercion roundtrip ---

test("numericInput — string-to-number coercion is exact for integers", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: ONE_WEEK_MS }), (n) => {
      const settings = parseConfig({ polling: { interval_ms: String(n) } });
      assert.equal(settings.polling.intervalMs, n);
    }),
  );
});

test("numericInput — rejects whitespace-only strings", () => {
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(" ", "\t", "\n"), { minLength: 1, maxLength: 5 })
        .map((a) => a.join("")),
      (ws) => {
        assert.throws(() => parseConfig({ polling: { interval_ms: ws } }), /polling.interval_ms/);
      },
    ),
  );
});

test("numericInput — rejects non-numeric strings", () => {
  fc.assert(
    fc.property(
      fc
        .string({ minLength: 1, maxLength: 10 })
        .filter((s) => s.trim() !== "" && Number.isNaN(Number(s))),
      (s) => {
        assert.throws(() => parseConfig({ polling: { interval_ms: s } }), /polling.interval_ms/);
      },
    ),
  );
});
