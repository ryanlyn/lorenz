import { test } from "vitest";
import fc from "fast-check";
import { selectLeastLoadedHost } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

const arbHosts = () => fc.array(fc.string({ minLength: 1, maxLength: 10 }), { maxLength: 8 });
const arbCap = () => fc.integer({ min: 0, max: 20 });

test("selectLeastLoadedHost — result is from input.hosts or null/undefined", () => {
  fc.assert(
    fc.property(arbHosts(), arbCap(), (hosts, cap) => {
      const runningCounts = new Map(
        hosts.map((h) => [h, fc.sample(fc.nat({ max: cap + 5 }), 1)[0]!]),
      );
      const result = selectLeastLoadedHost({ hosts, runningCounts, cap });
      if (result === null || result === undefined) return;
      assert.ok(hosts.includes(result));
    }),
  );
});

test("selectLeastLoadedHost — selected host has count < cap", () => {
  fc.assert(
    fc.property(arbHosts(), arbCap(), (hosts, cap) => {
      const runningCounts = new Map(
        hosts.map((h) => [h, fc.sample(fc.nat({ max: cap + 5 }), 1)[0]!]),
      );
      const result = selectLeastLoadedHost({ hosts, runningCounts, cap });
      if (typeof result !== "string") return;
      const count = runningCounts.get(result) ?? 0;
      assert.ok(count < cap);
    }),
  );
});

test("selectLeastLoadedHost — no other host has a lower count below cap", () => {
  fc.assert(
    fc.property(arbHosts(), arbCap(), (hosts, cap) => {
      const runningCounts = new Map(
        hosts.map((h) => [h, fc.sample(fc.nat({ max: cap + 5 }), 1)[0]!]),
      );
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

test("selectLeastLoadedHost — empty hosts returns null", () => {
  fc.assert(
    fc.property(arbCap(), (cap) => {
      assert.equal(selectLeastLoadedHost({ hosts: [], runningCounts: new Map(), cap }), null);
    }),
  );
});

test("selectLeastLoadedHost — at least one host below cap means result is a string", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 8 }),
      fc.integer({ min: 1, max: 20 }),
      (hosts, cap) => {
        const runningCounts = new Map<string, number>();
        // Ensure at least one host is below cap
        runningCounts.set(hosts[0]!, 0);
        for (let i = 1; i < hosts.length; i++) {
          runningCounts.set(hosts[i]!, fc.sample(fc.nat({ max: cap + 5 }), 1)[0]!);
        }
        const result = selectLeastLoadedHost({ hosts, runningCounts, cap });
        assert.equal(typeof result, "string");
      },
    ),
  );
});
