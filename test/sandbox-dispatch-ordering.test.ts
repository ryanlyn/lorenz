import { describe, test, expect } from "vitest";

import { runScenario, makeIssue, checkAssertions } from "../sandbox/sandbox.js";

/**
 * Integration tests for dispatch ordering invariants via full sandbox runs.
 *
 * These exercise the complete runtime pipeline (polling, dispatch, sorting, running)
 * rather than unit-testing the sort function alone.
 *
 * Non-integer priority scenarios verify that normalizeIssue correctly rejects
 * floats, preventing the original prioritySort bug.
 */
describe("Sandbox: Dispatch Ordering", () => {
  test("lower priority number dispatches first", async () => {
    const result = await runScenario({
      issues: [makeIssue("a", "A-1", { priority: 4 }), makeIssue("b", "B-1", { priority: 1 })],
      settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
      pollTicks: 1,
      assertions: [{ type: "dispatch_order", issueIds: ["b", "a"] }],
    });
    const assertionResults = checkAssertions(result, [
      { type: "dispatch_order", issueIds: ["b", "a"] },
    ]);
    for (const r of assertionResults) expect(r.passed).toBe(true);
  });

  test("all 4 priority levels sorted correctly from reverse input", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("d", "D-1", { priority: 4 }),
        makeIssue("c", "C-1", { priority: 3 }),
        makeIssue("b", "B-1", { priority: 2 }),
        makeIssue("a", "A-1", { priority: 1 }),
      ],
      settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
      pollTicks: 1,
      assertions: [{ type: "dispatch_order", issueIds: ["a", "b", "c", "d"] }],
    });
    const assertionResults = checkAssertions(result, [
      { type: "dispatch_order", issueIds: ["a", "b", "c", "d"] },
    ]);
    for (const r of assertionResults) expect(r.passed).toBe(true);
  });

  test("zero priority sorts after valid priorities (1-4) but before null", async () => {
    const result = await runScenario({
      issues: [makeIssue("a", "A-1", { priority: 0 }), makeIssue("b", "B-1", { priority: 4 })],
      settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
      pollTicks: 1,
      assertions: [{ type: "dispatch_order", issueIds: ["b", "a"] }],
    });
    const assertionResults = checkAssertions(result, [
      { type: "dispatch_order", issueIds: ["b", "a"] },
    ]);
    for (const r of assertionResults) expect(r.passed).toBe(true);
  });

  test("null priority sorts last", async () => {
    const result = await runScenario({
      issues: [makeIssue("a", "A-1", { priority: null }), makeIssue("b", "B-1", { priority: 4 })],
      settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
      pollTicks: 1,
      assertions: [{ type: "dispatch_order", issueIds: ["b", "a"] }],
    });
    const assertionResults = checkAssertions(result, [
      { type: "dispatch_order", issueIds: ["b", "a"] },
    ]);
    for (const r of assertionResults) expect(r.passed).toBe(true);
  });

  test("same priority uses earlier createdAt", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("a", "A-1", { priority: 2, createdAt: "2024-06-01" }),
        makeIssue("b", "B-1", { priority: 2, createdAt: "2024-01-01" }),
      ],
      settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
      pollTicks: 1,
      assertions: [{ type: "dispatch_order", issueIds: ["b", "a"] }],
    });
    const assertionResults = checkAssertions(result, [
      { type: "dispatch_order", issueIds: ["b", "a"] },
    ]);
    for (const r of assertionResults) expect(r.passed).toBe(true);
  });

  test("same priority+time uses lexicographic identifier", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("a", "MT-9", { priority: 2, createdAt: "2024-01-01" }),
        makeIssue("b", "MT-10", { priority: 2, createdAt: "2024-01-01" }),
      ],
      settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
      pollTicks: 1,
      assertions: [{ type: "dispatch_order", issueIds: ["b", "a"] }],
    });
    const assertionResults = checkAssertions(result, [
      { type: "dispatch_order", issueIds: ["b", "a"] },
    ]);
    for (const r of assertionResults) expect(r.passed).toBe(true);
  });

  test("null creation time sorts last within priority group", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("a", "A-1", { priority: 2, createdAt: null }),
        makeIssue("b", "B-1", { priority: 2, createdAt: "2024-01-01" }),
      ],
      settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
      pollTicks: 1,
      assertions: [{ type: "dispatch_order", issueIds: ["b", "a"] }],
    });
    const assertionResults = checkAssertions(result, [
      { type: "dispatch_order", issueIds: ["b", "a"] },
    ]);
    for (const r of assertionResults) expect(r.passed).toBe(true);
  });

  // Float priority bugs
  //
  // The YAML marks these FAILED because sortForDispatch alone lacks Number.isInteger().
  // In the full integration path, normalizeIssue (via priorityOrNull) rejects non-integer
  // priorities and normalizes them to null BEFORE sorting. So at integration level, floats
  // become null and correctly sort last.
  //
  // test.fails() documents the YAML FAILED status. Each test asserts the BUGGY behavior
  // (floats sorting numerically as valid priorities). Since normalizeIssue converts them
  // to null, the actual order differs from the buggy assertion, causing test failure --
  // which is what test.fails() expects.

  test.fails(
    "non-integer priority 2.5 should sort last (BUG: masked by normalizeIssue)",
    async () => {
      const result = await runScenario({
        issues: [makeIssue("a", "A-1", { priority: 2.5 }), makeIssue("b", "B-1", { priority: 3 })],
        settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
        pollTicks: 1,
      });
      // Assert buggy order: a(2.5) before b(3) numerically. Fails because a becomes null.
      const assertionResults = checkAssertions(result, [
        { type: "dispatch_order", issueIds: ["a", "b"] },
      ]);
      for (const r of assertionResults) expect(r.passed).toBe(true);
    },
  );

  test.fails(
    "non-integer priority 1.5 should sort last (BUG: masked by normalizeIssue)",
    async () => {
      const result = await runScenario({
        issues: [makeIssue("a", "A-1", { priority: 1.5 }), makeIssue("b", "B-1", { priority: 2 })],
        settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
        pollTicks: 1,
      });
      // Assert buggy order: a(1.5) before b(2) numerically. Fails because a becomes null.
      const assertionResults = checkAssertions(result, [
        { type: "dispatch_order", issueIds: ["a", "b"] },
      ]);
      for (const r of assertionResults) expect(r.passed).toBe(true);
    },
  );

  test.fails(
    "non-integer priority 3.9 should sort last (BUG: masked by normalizeIssue)",
    async () => {
      const result = await runScenario({
        issues: [makeIssue("a", "A-1", { priority: 3.9 }), makeIssue("b", "B-1", { priority: 4 })],
        settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
        pollTicks: 1,
      });
      // Assert buggy order: a(3.9) before b(4) numerically. Fails because a becomes null.
      const assertionResults = checkAssertions(result, [
        { type: "dispatch_order", issueIds: ["a", "b"] },
      ]);
      for (const r of assertionResults) expect(r.passed).toBe(true);
    },
  );

  test.fails(
    "priority 1.001 should sort last, not before priority 2 (BUG: masked by normalizeIssue)",
    async () => {
      const result = await runScenario({
        issues: [
          makeIssue("a", "A-1", { priority: 1.001 }),
          makeIssue("b", "B-1", { priority: 2 }),
        ],
        settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
        pollTicks: 1,
      });
      // Assert buggy order: a(1.001) before b(2) numerically. Fails because a becomes null.
      const assertionResults = checkAssertions(result, [
        { type: "dispatch_order", issueIds: ["a", "b"] },
      ]);
      for (const r of assertionResults) expect(r.passed).toBe(true);
    },
  );

  test.fails(
    "multiple non-integer priorities all treated as valid (BUG: masked by normalizeIssue)",
    async () => {
      const result = await runScenario({
        issues: [
          makeIssue("a", "A-1", { priority: 1.1 }),
          makeIssue("b", "B-1", { priority: 2.3 }),
          makeIssue("c", "C-1", { priority: 3.8 }),
          makeIssue("d", "D-1", { priority: 4 }),
        ],
        settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
        pollTicks: 1,
      });
      // Assert buggy order: a(1.1), b(2.3), c(3.8), d(4) numerically.
      // Fails because a,b,c become null and d(valid) dispatches first.
      const assertionResults = checkAssertions(result, [
        { type: "dispatch_order", issueIds: ["a", "b", "c", "d"] },
      ]);
      for (const r of assertionResults) expect(r.passed).toBe(true);
    },
  );

  // Back to passing scenarios

  test("multiple null priorities use date tiebreak", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("a", "A-1", { priority: null, createdAt: "2024-06-01" }),
        makeIssue("b", "B-1", { priority: null, createdAt: "2024-01-01" }),
      ],
      settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
      pollTicks: 1,
      assertions: [{ type: "dispatch_order", issueIds: ["b", "a"] }],
    });
    const assertionResults = checkAssertions(result, [
      { type: "dispatch_order", issueIds: ["b", "a"] },
    ]);
    for (const r of assertionResults) expect(r.passed).toBe(true);
  });

  test("idempotency - second poll tick dispatches same order", async () => {
    const issues = [
      makeIssue("a", "A-1", { priority: 3, createdAt: "2024-03-01" }),
      makeIssue("b", "B-1", { priority: 1, createdAt: "2024-06-01" }),
      makeIssue("c", "C-1", { priority: 2, createdAt: "2024-01-01" }),
    ];

    // First run
    const result1 = await runScenario({
      issues,
      settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
      pollTicks: 1,
    });

    // Second run with same issues -- order should be identical
    const result2 = await runScenario({
      issues,
      settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
      pollTicks: 1,
    });

    // Extract dispatch order from run_started events
    const getDispatchOrder = (result: typeof result1) =>
      result.events
        .filter((e) => e.type === "run_started")
        .map((e) => {
          const identifier = e.message.split(" ")[0];
          const hist = result.finalSnapshot.runHistory.find(
            (h) => h.issueIdentifier === identifier,
          );
          return hist?.issueId;
        })
        .filter(Boolean);

    const order1 = getDispatchOrder(result1);
    const order2 = getDispatchOrder(result2);

    expect(order1).toEqual(order2);
    // Also verify the expected order: b(1) < c(2) < a(3)
    expect(order1).toEqual(["b", "c", "a"]);
  });

  test("large same-priority group sorted by date ascending", async () => {
    const issues = Array.from({ length: 10 }, (_, i) =>
      makeIssue(`issue-${i}`, `ISS-${i}`, {
        priority: 2,
        createdAt: `2024-${String(i + 1).padStart(2, "0")}-15`,
      }),
    );

    const result = await runScenario({
      issues,
      settingsOverrides: { agent: { maxConcurrentAgents: 15 } },
      pollTicks: 1,
    });

    // Expected order: issue-0 (Jan) through issue-9 (Oct) by date
    const expectedOrder = Array.from({ length: 10 }, (_, i) => `issue-${i}`);
    const assertionResults = checkAssertions(result, [
      { type: "dispatch_order", issueIds: expectedOrder },
    ]);
    for (const r of assertionResults) expect(r.passed).toBe(true);
  });

  test("mix of null, 0, 5, and valid 1-4 priorities", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("a", "A-1", { priority: 0, createdAt: "2024-01-01" }),
        makeIssue("b", "B-1", { priority: 5, createdAt: "2024-01-02" }),
        makeIssue("c", "C-1", { priority: 2, createdAt: "2024-01-03" }),
        makeIssue("d", "D-1", { priority: null, createdAt: "2024-01-04" }),
        makeIssue("e", "E-1", { priority: 1, createdAt: "2024-01-05" }),
      ],
      settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
      pollTicks: 1,
      // Valid priorities first: e(1), c(2); then invalid last: a(0), b(5), d(null) by date
      assertions: [{ type: "dispatch_order", issueIds: ["e", "c", "a", "b", "d"] }],
    });
    const assertionResults = checkAssertions(result, [
      { type: "dispatch_order", issueIds: ["e", "c", "a", "b", "d"] },
    ]);
    for (const r of assertionResults) expect(r.passed).toBe(true);
  });

  test("large set with two priority groups maintains ordering", async () => {
    // 5 issues with priority 1, 5 issues with priority 4
    const issues = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeIssue(`hi-${i}`, `HI-${i}`, {
          priority: 1,
          createdAt: `2024-01-${String(i + 1).padStart(2, "0")}`,
        }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        makeIssue(`lo-${i}`, `LO-${i}`, {
          priority: 4,
          createdAt: `2024-01-${String(i + 1).padStart(2, "0")}`,
        }),
      ),
    ];

    const result = await runScenario({
      issues,
      settingsOverrides: { agent: { maxConcurrentAgents: 15 } },
      pollTicks: 1,
    });

    // All priority-1 issues should dispatch before all priority-4 issues
    const expectedOrder = [
      ...Array.from({ length: 5 }, (_, i) => `hi-${i}`),
      ...Array.from({ length: 5 }, (_, i) => `lo-${i}`),
    ];
    const assertionResults = checkAssertions(result, [
      { type: "dispatch_order", issueIds: expectedOrder },
    ]);
    for (const r of assertionResults) expect(r.passed).toBe(true);
  });

  test("constant priority falls through to date comparison", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("a", "A-1", { priority: 2, createdAt: "2024-01-15" }),
        makeIssue("b", "B-1", { priority: 2, createdAt: "2024-02-15" }),
        makeIssue("c", "C-1", { priority: 2, createdAt: "2024-03-15" }),
      ],
      settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
      pollTicks: 1,
      assertions: [{ type: "dispatch_order", issueIds: ["a", "b", "c"] }],
    });
    const assertionResults = checkAssertions(result, [
      { type: "dispatch_order", issueIds: ["a", "b", "c"] },
    ]);
    for (const r of assertionResults) expect(r.passed).toBe(true);
  });

  test("lexicographic identifier as final tiebreak (A < M < Z)", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("z", "Z-1", { priority: 2, createdAt: "2024-01-01" }),
        makeIssue("m", "M-1", { priority: 2, createdAt: "2024-01-01" }),
        makeIssue("a", "A-1", { priority: 2, createdAt: "2024-01-01" }),
      ],
      settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
      pollTicks: 1,
      assertions: [{ type: "dispatch_order", issueIds: ["a", "m", "z"] }],
    });
    const assertionResults = checkAssertions(result, [
      { type: "dispatch_order", issueIds: ["a", "m", "z"] },
    ]);
    for (const r of assertionResults) expect(r.passed).toBe(true);
  });

  test("lexicographic identifier '10' < '9'", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("a", "PROJ-9", { priority: 2, createdAt: "2024-01-01" }),
        makeIssue("b", "PROJ-10", { priority: 2, createdAt: "2024-01-01" }),
      ],
      settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
      pollTicks: 1,
      // "PROJ-10" < "PROJ-9" lexicographically (because "1" < "9")
      assertions: [{ type: "dispatch_order", issueIds: ["b", "a"] }],
    });
    const assertionResults = checkAssertions(result, [
      { type: "dispatch_order", issueIds: ["b", "a"] },
    ]);
    for (const r of assertionResults) expect(r.passed).toBe(true);
  });
});
