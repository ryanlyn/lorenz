import { describe, test } from "vitest";

import { assert } from "../../../test/assert.js";

import { SESSION_UPDATE_KINDS } from "@symphony/protocol";
import type {
  StopReason,
  SessionUpdate,
  SessionUpdateKind,
  UsageUpdate,
  TurnUpdate,
  TurnResult,
  UsageTotals,
  SymphonyMeta,
} from "@symphony/protocol";

describe("SESSION_UPDATE_KINDS", () => {
  test("contains exactly the expected set of kinds in the expected order", () => {
    // This is a snapshot-style assertion: if any kind is added, removed,
    // or reordered, this test will fail and force a conscious update.
    assert.deepEqual(
      [...SESSION_UPDATE_KINDS],
      [
        "usage_update",
        "session_started",
        "turn_started",
        "turn_completed",
        "turn_failed",
        "turn_cancelled",
        "tool_call",
        "tool_result",
        "notification",
      ],
    );
  });

  test("SessionUpdateKind type is derivable from the runtime array", () => {
    // Verify that the runtime array can be used to validate a kind string
    // This tests the pattern used in real code: checking if a value is a valid kind.
    const validKind: string = "usage_update";
    const invalidKind: string = "nonexistent_kind";

    const isValidKind = (k: string): k is SessionUpdateKind =>
      (SESSION_UPDATE_KINDS as readonly string[]).includes(k);

    assert.ok(isValidKind(validKind));
    assert.equal(isValidKind(invalidKind), false);
  });

  test("can be used to exhaustively enumerate all SessionUpdateKinds", () => {
    // Build a Set from the runtime constant and verify membership of
    // every documented kind. This ensures the runtime array stays in sync
    // with the expected protocol contract.
    const kindSet = new Set<string>(SESSION_UPDATE_KINDS);

    // These are the kinds that TurnUpdate declares in its `kind` union
    const turnUpdateKinds = [
      "session_started",
      "turn_started",
      "turn_completed",
      "turn_failed",
      "turn_cancelled",
      "tool_call",
      "tool_result",
      "notification",
    ];
    for (const k of turnUpdateKinds) {
      assert.ok(kindSet.has(k));
    }

    // UsageUpdate's kind
    assert.ok(kindSet.has("usage_update"));

    // Verify these account for all entries (no extra kinds beyond these two groups)
    const allExpected = new Set([...turnUpdateKinds, "usage_update"]);
    assert.equal(allExpected.size, kindSet.size);
    for (const k of kindSet) {
      assert.ok(allExpected.has(k));
    }
  });
});

describe("SessionUpdate type structure", () => {
  test("SESSION_UPDATE_KINDS can be used as a runtime discriminator for SessionUpdate.kind", () => {
    // The primary runtime use of this module: using the constant array to
    // validate incoming data (e.g., from JSON deserialization).
    const isValidSessionUpdate = (data: unknown): data is SessionUpdate => {
      if (typeof data !== "object" || data === null) return false;
      const obj = data as Record<string, unknown>;
      return (
        typeof obj.kind === "string" &&
        (SESSION_UPDATE_KINDS as readonly string[]).includes(obj.kind)
      );
    };

    // Valid updates
    assert.ok(isValidSessionUpdate({ kind: "usage_update", usage: {} }));
    assert.ok(isValidSessionUpdate({ kind: "turn_started" }));
    assert.ok(isValidSessionUpdate({ kind: "notification", message: "hi" }));

    // Invalid data rejected at runtime
    assert.equal(isValidSessionUpdate({ kind: "invalid_kind" }), false);
    assert.equal(isValidSessionUpdate({ kind: 123 }), false);
    assert.equal(isValidSessionUpdate(null), false);
    assert.equal(isValidSessionUpdate("not an object"), false);
    assert.equal(isValidSessionUpdate({ noKind: true }), false);
  });

  test("SESSION_UPDATE_KINDS partitions cleanly into UsageUpdate vs TurnUpdate kinds", () => {
    // Verify that usage_update is the only kind not in TurnUpdate's kind union.
    // This tests the runtime constant matches the protocol's discriminated union design.
    const turnKinds: TurnUpdate["kind"][] = [
      "session_started",
      "turn_started",
      "turn_completed",
      "turn_failed",
      "turn_cancelled",
      "tool_call",
      "tool_result",
      "notification",
    ];
    const usageKinds: UsageUpdate["kind"][] = ["usage_update"];

    // The union of both sets should exactly equal SESSION_UPDATE_KINDS
    const combined = new Set([...turnKinds, ...usageKinds]);
    const fromConst = new Set<string>(SESSION_UPDATE_KINDS);

    assert.equal(combined.size, fromConst.size);
    for (const k of combined) {
      assert.ok(fromConst.has(k), `expected SESSION_UPDATE_KINDS to contain "${k}"`);
    }
    for (const k of fromConst) {
      assert.ok(combined.has(k), `unexpected kind "${k}" in SESSION_UPDATE_KINDS`);
    }
  });

  test("kind-based discriminator filters UsageUpdate from TurnUpdate at runtime", () => {
    // Simulates the pattern consumers use to branch on update type
    const updates: SessionUpdate[] = [
      { kind: "usage_update", usage: { totalTokens: 100 } },
      { kind: "turn_started", message: "starting" },
      { kind: "turn_completed" },
      { kind: "turn_failed", message: "timeout" },
      { kind: "notification", message: "info" },
    ];

    const usageUpdates = updates.filter((u): u is UsageUpdate => u.kind === "usage_update");
    const turnUpdates = updates.filter((u): u is TurnUpdate => u.kind !== "usage_update");

    assert.equal(usageUpdates.length, 1);
    assert.equal(turnUpdates.length, 4);
    // Verify runtime narrowing gives access to UsageUpdate-specific field
    assert.deepEqual(usageUpdates[0].usage, { totalTokens: 100 });
  });
});

describe("TurnResult", () => {
  test("can be serialized to JSON and deserialized back preserving all fields", () => {
    const result: TurnResult = {
      stopReason: "end_turn",
      sessionId: "sess-xyz",
      _meta: {
        executorPid: "proc-1",
        usage: { inputTokens: 200, outputTokens: 100 },
        rateLimits: { rpm: 60 },
      },
    };

    const json = JSON.stringify(result);
    const parsed = JSON.parse(json) as TurnResult;

    assert.equal(parsed.stopReason, "end_turn");
    assert.equal(parsed.sessionId, "sess-xyz");
    assert.equal(parsed._meta!.executorPid, "proc-1");
    assert.deepEqual(parsed._meta!.usage, { inputTokens: 200, outputTokens: 100 });
    assert.deepEqual(parsed._meta!.rateLimits, { rpm: 60 });
  });

  test("JSON round-trip of TurnResult without _meta produces clean object", () => {
    const result: TurnResult = {
      stopReason: "max_tokens",
      sessionId: "sess-1",
    };

    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);

    // _meta should not appear in serialized output when undefined
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, "_meta"), false);
    assert.deepEqual(Object.keys(parsed).sort(), ["sessionId", "stopReason"]);
  });

  test("stopReason values are distinct strings usable as discriminators", () => {
    const stopReasons: StopReason[] = [
      "end_turn",
      "max_tokens",
      "max_turn_requests",
      "refusal",
      "cancelled",
    ];
    // Verify all values are unique (no duplicates in the union type at runtime)
    const unique = new Set(stopReasons);
    assert.equal(unique.size, stopReasons.length);

    // Verify they can be used in a switch/map pattern (common consumer usage)
    const labelMap: Record<StopReason, string> = {
      end_turn: "completed",
      max_tokens: "truncated",
      max_turn_requests: "loop_limit",
      refusal: "refused",
      cancelled: "aborted",
    };
    for (const reason of stopReasons) {
      assert.ok(labelMap[reason].length > 0);
    }
  });
});

describe("SymphonyMeta", () => {
  test("survives JSON round-trip with all fields populated", () => {
    const meta: SymphonyMeta = {
      executorPid: "pid-99",
      rateLimits: { requestsPerMinute: 60, tokensPerMinute: 100000 },
      usage: { inputTokens: 500, outputTokens: 250, totalTokens: 750, secondsRunning: 3 },
    };

    const parsed = JSON.parse(JSON.stringify(meta)) as SymphonyMeta;
    assert.equal(parsed.executorPid, "pid-99");
    assert.deepEqual(parsed.rateLimits, { requestsPerMinute: 60, tokensPerMinute: 100000 });
    assert.deepEqual(parsed.usage, {
      inputTokens: 500,
      outputTokens: 250,
      totalTokens: 750,
      secondsRunning: 3,
    });
  });

  test("null executorPid serializes distinctly from undefined executorPid", () => {
    // null vs undefined matters for JSON serialization -- null is preserved, undefined is stripped
    const withNull: SymphonyMeta = { executorPid: null };
    const withUndefined: SymphonyMeta = { executorPid: undefined };

    const nullJson = JSON.stringify(withNull);
    const undefinedJson = JSON.stringify(withUndefined);

    assert.ok(nullJson.includes('"executorPid":null'));
    assert.equal(undefinedJson, "{}");
  });
});

describe("UsageTotals", () => {
  test("JSON serialization preserves all numeric fields without loss", () => {
    const usage: UsageTotals = {
      inputTokens: 1500,
      outputTokens: 750,
      totalTokens: 2250,
      secondsRunning: 12,
    };

    const parsed = JSON.parse(JSON.stringify(usage)) as UsageTotals;
    assert.equal(parsed.inputTokens, 1500);
    assert.equal(parsed.outputTokens, 750);
    assert.equal(parsed.totalTokens, 2250);
    assert.equal(parsed.secondsRunning, 12);
  });

  test("totalTokens is a plain data field with no auto-computation from input + output", () => {
    // Demonstrates that totalTokens is not derived — consumers must compute it themselves.
    // This guards against someone adding a getter/setter that auto-computes totalTokens.
    const usage: UsageTotals = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 999,
      secondsRunning: 1,
    };

    const parsed = JSON.parse(JSON.stringify(usage)) as UsageTotals;
    // After round-trip, totalTokens should remain 999, not be recomputed as 150
    assert.equal(parsed.totalTokens, 999);
    assert.notEqual(parsed.totalTokens, parsed.inputTokens + parsed.outputTokens);
  });
});
