import { test } from "vitest";
import fc from "fast-check";
import { selectLeastLoadedHost } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

// --- Helper arbitraries ---

/** Generate a non-empty host name with diverse characters */
const arbHostName = () =>
  fc.oneof(
    { weight: 4, arbitrary: fc.string({ minLength: 1, maxLength: 20 }) },
    { weight: 2, arbitrary: fc.string({ unit: "grapheme", minLength: 1, maxLength: 12 }) },
    {
      weight: 1,
      arbitrary: fc.constantFrom(
        "host-a",
        "host-b",
        "host-c",
        "us-east-1",
        "192.168.0.1",
        "\u{1F600}",
        " ",
        "\t",
        "\n",
        "null",
        "undefined",
        "__proto__",
        "constructor",
        "toString",
      ),
    },
    { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 1 }) },
  );

/** Generate a list of hosts (possibly with duplicates) */
const arbHosts = () => fc.array(arbHostName(), { minLength: 0, maxLength: 12 });

/** Generate a non-empty list of hosts */
const arbNonEmptyHosts = () => fc.array(arbHostName(), { minLength: 1, maxLength: 12 });

/** Generate a unique non-empty list of hosts */
const arbUniqueHosts = () => fc.uniqueArray(arbHostName(), { minLength: 1, maxLength: 12 });

/** Generate a cap value (including edge values like 0 and large numbers) */
const arbCap = () =>
  fc.oneof(
    fc.integer({ min: 0, max: 100 }),
    fc.constantFrom(0, 1, 2, 1000, Number.MAX_SAFE_INTEGER),
  );

/** Generate a running count for a single host - shrink-friendly */
const arbCount = () =>
  fc.oneof(
    fc.nat({ max: 50 }),
    fc.constantFrom(0, 1, 2, 100, Number.MAX_SAFE_INTEGER),
  );

/**
 * Generate running counts for a set of hosts as a proper arbitrary.
 * This is shrink-friendly unlike the original fc.sample approach.
 */
const arbRunningCountsFor = (hosts: string[]) =>
  fc.tuple(...hosts.map(() => arbCount())).map((counts) => {
    const map = new Map<string, number>();
    hosts.forEach((h, i) => map.set(h, counts[i]!));
    return map;
  });

// --- Invariant 1 ---
// When a host is selected, it SHALL be from the configured list or "no host available" SHALL be returned.
test("Invariant 1: selected host is from configured list, or null/undefined is returned", () => {
  fc.assert(
    fc.property(arbHosts(), arbCap(), (hosts, cap) => {
      // Use proper shrink-friendly arbitrary for running counts
      const runningCounts = new Map<string, number>();
      for (const h of hosts) {
        if (!runningCounts.has(h)) runningCounts.set(h, 0);
      }
      const result = selectLeastLoadedHost({ hosts, runningCounts, cap });

      // Result must be null (empty list), undefined (all at cap), or a member of hosts
      if (result === null || result === undefined) return;
      assert.ok(hosts.includes(result));
    }),
    { numRuns: 200 },
  );
});

test("Invariant 1 (strengthened): with diverse running counts, selected host is always from configured list", () => {
  fc.assert(
    fc.property(
      arbNonEmptyHosts().chain((hosts) =>
        fc.tuple(fc.constant(hosts), arbRunningCountsFor(hosts), arbCap()),
      ),
      ([hosts, runningCounts, cap]) => {
        const result = selectLeastLoadedHost({ hosts, runningCounts, cap });

        if (result === null || result === undefined) return;
        assert.ok(hosts.includes(result));
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 2 ---
// When hosts are evaluated, only hosts with load strictly below the cap SHALL be considered.
test("Invariant 2: selected host always has load strictly below the cap", () => {
  fc.assert(
    fc.property(
      arbNonEmptyHosts().chain((hosts) =>
        fc.tuple(fc.constant(hosts), arbRunningCountsFor(hosts), arbCap()),
      ),
      ([hosts, runningCounts, cap]) => {
        const result = selectLeastLoadedHost({ hosts, runningCounts, cap });

        if (typeof result !== "string") return;
        const count = runningCounts.get(result) ?? 0;
        assert.ok(count < cap);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 2 (negative): when all hosts are at or above cap, undefined is returned", () => {
  fc.assert(
    fc.property(
      arbUniqueHosts(),
      fc.integer({ min: 1, max: 50 }),
      (hosts, cap) => {
        // Set all hosts at or above cap
        const runningCounts = new Map<string, number>();
        for (const h of hosts) {
          runningCounts.set(h, cap); // exactly at cap, not below
        }
        const result = selectLeastLoadedHost({ hosts, runningCounts, cap });
        assert.equal(result, undefined);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 2 (negative): when all hosts are strictly above cap, undefined is returned", () => {
  fc.assert(
    fc.property(
      arbUniqueHosts(),
      fc.integer({ min: 1, max: 50 }),
      fc.integer({ min: 1, max: 50 }),
      (hosts, cap, extraAbove) => {
        const runningCounts = new Map<string, number>();
        for (const h of hosts) {
          runningCounts.set(h, cap + extraAbove);
        }
        const result = selectLeastLoadedHost({ hosts, runningCounts, cap });
        assert.equal(result, undefined);
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 3 ---
// When multiple hosts are below the cap, the host with the lowest load SHALL be selected.
test("Invariant 3: selected host has the lowest load among all hosts below cap", () => {
  fc.assert(
    fc.property(
      arbUniqueHosts().chain((hosts) =>
        fc.tuple(fc.constant(hosts), arbRunningCountsFor(hosts), arbCap()),
      ),
      ([hosts, runningCounts, cap]) => {
        const result = selectLeastLoadedHost({ hosts, runningCounts, cap });

        if (typeof result !== "string") return;

        const selectedCount = runningCounts.get(result) ?? 0;

        // No other host in the list should have a count that is both below cap and strictly less than selectedCount
        for (const host of hosts) {
          const count = runningCounts.get(host) ?? 0;
          if (count < cap) {
            assert.ok(count >= selectedCount);
          }
        }
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 3 (forced scenario): with explicit distinct loads, lowest-loaded host is picked", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(arbHostName(), { minLength: 2, maxLength: 8 }),
      fc.integer({ min: 10, max: 100 }),
      (hosts, cap) => {
        // Assign incrementing counts: host[0]=0, host[1]=1, host[2]=2, etc.
        const runningCounts = new Map<string, number>();
        hosts.forEach((h, i) => runningCounts.set(h, i));

        const result = selectLeastLoadedHost({ hosts, runningCounts, cap });

        // Since cap >= 10 and host[0] has count 0, host[0] must be selected
        assert.equal(result, hosts[0]);
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 3 (with duplicates in host list): still picks lowest-loaded", () => {
  fc.assert(
    fc.property(
      arbNonEmptyHosts().chain((hosts) =>
        fc.tuple(fc.constant(hosts), arbRunningCountsFor(hosts), arbCap()),
      ),
      ([hosts, runningCounts, cap]) => {
        const result = selectLeastLoadedHost({ hosts, runningCounts, cap });

        if (typeof result !== "string") return;

        const selectedCount = runningCounts.get(result) ?? 0;

        // Even with duplicate hosts, the selected host must be minimal among those below cap
        for (const host of hosts) {
          const count = runningCounts.get(host) ?? 0;
          if (count < cap) {
            assert.ok(count >= selectedCount);
          }
        }
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 4 ---
// When the host list is empty, "no host available" SHALL be returned.
test("Invariant 4: empty host list returns null (no host available)", () => {
  fc.assert(
    fc.property(arbCap(), (cap) => {
      const result = selectLeastLoadedHost({
        hosts: [],
        runningCounts: new Map(),
        cap,
      });
      assert.equal(result, null);
    }),
    { numRuns: 200 },
  );
});

test("Invariant 4 (with non-empty runningCounts): empty host list still returns null", () => {
  fc.assert(
    fc.property(
      arbCap(),
      fc.array(fc.tuple(arbHostName(), arbCount()), { minLength: 1, maxLength: 5 }),
      (cap, entries) => {
        // runningCounts has entries, but hosts is empty
        const runningCounts = new Map(entries);
        const result = selectLeastLoadedHost({
          hosts: [],
          runningCounts,
          cap,
        });
        assert.equal(result, null);
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 5 ---
// When at least one host is below the cap, the system SHALL always select a host (no false starvation).
test("Invariant 5: if at least one host is below cap, a host string is returned (no false starvation)", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(arbHostName(), { minLength: 1, maxLength: 12 }),
      fc.integer({ min: 1, max: 100 }),
      (hosts, cap) => {
        // Construct running counts ensuring at least one host is strictly below cap
        const runningCounts = new Map<string, number>();
        // Force the first host to have count 0 (below any cap >= 1)
        runningCounts.set(hosts[0]!, 0);
        for (let i = 1; i < hosts.length; i++) {
          runningCounts.set(hosts[i]!, cap + 10); // others above cap
        }

        const result = selectLeastLoadedHost({ hosts, runningCounts, cap });
        assert.equal(typeof result, "string");
      },
    ),
    { numRuns: 200 },
  );
});

test("Invariant 5 (all below cap): every host is below cap, a string must be returned", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(arbHostName(), { minLength: 1, maxLength: 12 }),
      fc.integer({ min: 1, max: 100 }),
      (hosts, cap) => {
        const runningCounts = new Map<string, number>();
        for (const h of hosts) {
          // All hosts are strictly below cap
          runningCounts.set(h, 0);
        }

        const result = selectLeastLoadedHost({ hosts, runningCounts, cap });
        assert.equal(typeof result, "string");
        assert.ok(hosts.includes(result as string));
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 6 (additional) ---
// When cap is 0, no host can be below it, so undefined must be returned (for non-empty lists).
test("Invariant 6: cap of 0 means no host can be selected (undefined for non-empty lists)", () => {
  fc.assert(
    fc.property(
      arbNonEmptyHosts().chain((hosts) =>
        fc.tuple(fc.constant(hosts), arbRunningCountsFor(hosts)),
      ),
      ([hosts, runningCounts]) => {
        const result = selectLeastLoadedHost({ hosts, runningCounts, cap: 0 });
        // No non-negative count is < 0, so no host qualifies
        assert.equal(result, undefined);
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 7 (additional) ---
// Hosts not in runningCounts map are treated as having count 0.
test("Invariant 7: hosts absent from runningCounts are treated as count 0", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(arbHostName(), { minLength: 2, maxLength: 8 }),
      fc.integer({ min: 1, max: 100 }),
      (hosts, cap) => {
        // Only set counts for hosts after the first one, leaving first host absent from map
        const runningCounts = new Map<string, number>();
        for (let i = 1; i < hosts.length; i++) {
          runningCounts.set(hosts[i]!, cap); // at cap, not eligible
        }
        // hosts[0] is not in the map, so it should be treated as 0, which is < cap
        const result = selectLeastLoadedHost({ hosts, runningCounts, cap });
        assert.equal(result, hosts[0]);
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 8 (additional) ---
// Determinism: same inputs always produce same output.
test("Invariant 8: selectLeastLoadedHost is deterministic", () => {
  fc.assert(
    fc.property(
      arbUniqueHosts().chain((hosts) =>
        fc.tuple(fc.constant(hosts), arbRunningCountsFor(hosts), arbCap()),
      ),
      ([hosts, runningCounts, cap]) => {
        const result1 = selectLeastLoadedHost({ hosts, runningCounts, cap });
        const result2 = selectLeastLoadedHost({ hosts, runningCounts, cap });
        assert.equal(result1, result2);
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 9 (additional) ---
// When there is exactly one host below cap, that exact host must be returned.
test("Invariant 9: single eligible host is always selected", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(arbHostName(), { minLength: 1, maxLength: 8 }),
      fc.integer({ min: 1, max: 100 }),
      fc.integer({ min: 0, max: 99 }),
      (hosts, cap, eligibleIdx) => {
        const idx = eligibleIdx % hosts.length;
        const runningCounts = new Map<string, number>();
        for (let i = 0; i < hosts.length; i++) {
          if (i === idx) {
            runningCounts.set(hosts[i]!, 0); // below cap
          } else {
            runningCounts.set(hosts[i]!, cap); // at cap, not eligible
          }
        }
        const result = selectLeastLoadedHost({ hosts, runningCounts, cap });
        assert.equal(result, hosts[idx]);
      },
    ),
    { numRuns: 200 },
  );
});
