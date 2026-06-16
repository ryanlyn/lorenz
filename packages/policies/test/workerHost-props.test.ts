import { test } from "vitest";
import fc from "fast-check";
import { assert } from "@lorenz/test-utils";

import { selectLeastLoadedHost } from "@lorenz/policies";

const arbCap = () => fc.integer({ min: 0, max: 20 });

/** Generates hosts together with their running counts as a single arbitrary. */
const arbHostsWithCounts = (capArb: fc.Arbitrary<number>) =>
  capArb.chain((cap) =>
    fc
      .array(fc.tuple(fc.string({ minLength: 1, maxLength: 10 }), fc.nat({ max: cap + 5 })), {
        maxLength: 8,
      })
      .map((pairs) => ({
        hosts: pairs.map((p) => p[0]),
        runningCounts: new Map(pairs),
        cap,
      })),
  );

test("INVARIANT: When a host is selected, it SHALL be from the configured list or null/undefined SHALL be returned", () => {
  fc.assert(
    fc.property(arbHostsWithCounts(arbCap()), ({ hosts, runningCounts, cap }) => {
      const result = selectLeastLoadedHost({ hosts, runningCounts, cap });
      if (result === null || result === undefined) return;
      assert.ok(hosts.includes(result));
    }),
  );
});

test("INVARIANT: When a host is selected, its load SHALL be strictly below the cap", () => {
  fc.assert(
    fc.property(arbHostsWithCounts(arbCap()), ({ hosts, runningCounts, cap }) => {
      const result = selectLeastLoadedHost({ hosts, runningCounts, cap });
      if (typeof result !== "string") return;
      const count = runningCounts.get(result) ?? 0;
      assert.ok(count < cap);
    }),
  );
});

test("INVARIANT: When a host is selected, no other host below cap SHALL have a lower load", () => {
  fc.assert(
    fc.property(arbHostsWithCounts(arbCap()), ({ hosts, runningCounts, cap }) => {
      const result = selectLeastLoadedHost({ hosts, runningCounts, cap });
      if (typeof result !== "string") return;
      const selectedCount = runningCounts.get(result) ?? 0;
      for (const host of hosts) {
        const count = runningCounts.get(host) ?? 0;
        if (count < cap) {
          assert.ok(count >= selectedCount);
        }
      }
    }),
  );
});

test("INVARIANT: When the host list is empty, null SHALL be returned", () => {
  fc.assert(
    fc.property(arbCap(), (cap) => {
      assert.equal(selectLeastLoadedHost({ hosts: [], runningCounts: new Map(), cap }), null);
    }),
  );
});

test("selectLeastLoadedHost keeps an available preferred host even when another host is less loaded", () => {
  const input = {
    hosts: ["worker-a", "worker-b"],
    runningCounts: new Map([
      ["worker-a", 1],
      ["worker-b", 0],
    ]),
    cap: 2,
    preferredHost: "worker-a",
  };
  const result = selectLeastLoadedHost(input);

  assert.equal(result, "worker-a");
});

test("selectLeastLoadedHost falls back when the preferred host is at capacity", () => {
  const input = {
    hosts: ["worker-a", "worker-b"],
    runningCounts: new Map([
      ["worker-a", 2],
      ["worker-b", 0],
    ]),
    cap: 2,
    preferredHost: "worker-a",
  };
  const result = selectLeastLoadedHost(input);

  assert.equal(result, "worker-b");
});

test("INVARIANT: When at least one host is below the cap, the system SHALL always select a host", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 20 }).chain((cap) =>
        fc
          .uniqueArray(
            fc.tuple(fc.string({ minLength: 1, maxLength: 10 }), fc.nat({ max: cap + 5 })),
            {
              minLength: 1,
              maxLength: 8,
              selector: ([host]) => host,
            },
          )
          .map((pairs) => ({
            hosts: pairs.map((p) => p[0]),
            counts: pairs.map((p) => p[1]),
            cap,
          })),
      ),
      ({ hosts, counts, cap }) => {
        const runningCounts = new Map<string, number>();
        // Ensure at least one host is below cap
        runningCounts.set(hosts[0]!, 0);
        for (let i = 1; i < hosts.length; i++) {
          runningCounts.set(hosts[i]!, counts[i]!);
        }
        const result = selectLeastLoadedHost({ hosts, runningCounts, cap });
        assert.equal(typeof result, "string");
      },
    ),
  );
});
