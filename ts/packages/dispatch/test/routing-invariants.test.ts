import { test } from "vitest";
import fc from "fast-check";
import {
  routeNames,
  routedToThisWorker,
  normalizeRouteName,
  defaultSettings,
} from "@symphony/cli";
import type { Issue, Settings } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

function makeSettings(
  overrides: {
    acceptUnrouted?: boolean;
    onlyRoutes?: string[] | null;
    routeLabelPrefix?: string;
    activeStates?: string[];
    terminalStates?: string[];
  } = {},
): Settings {
  const s = defaultSettings();
  s.tracker.dispatch.acceptUnrouted = overrides.acceptUnrouted ?? true;
  s.tracker.dispatch.onlyRoutes = overrides.onlyRoutes ?? null;
  s.tracker.dispatch.routeLabelPrefix = overrides.routeLabelPrefix ?? "Symphony:";
  if (overrides.activeStates) s.tracker.activeStates = overrides.activeStates;
  if (overrides.terminalStates) s.tracker.terminalStates = overrides.terminalStates;
  return s;
}

function issueWith(overrides: Partial<Issue>): Issue {
  return {
    id: "id-1",
    identifier: "TEST-1",
    title: "Test issue",
    state: "Todo",
    stateType: "unstarted",
    description: null,
    branchName: null,
    url: null,
    priority: 1,
    createdAt: null,
    updatedAt: null,
    labels: [],
    blockers: [],
    assigneeId: null,
    assignedToWorker: true,
    ...overrides,
  };
}

// Arbitrary for strings with unicode grapheme clusters
const _arbUnicode = fc.string({ unit: "grapheme", maxLength: 50 });

// Arbitrary for strings with control characters and special whitespace
const arbWithControlChars = fc.oneof(
  fc.string({ maxLength: 50 }),
  fc.constantFrom(
    "\x00test\x01",
    "\x7fhello",
    "a\x00b\x01c",
    "\t\n\r",
    "normal",
    "  spaces  ",
    "\x00",
    "",
  ),
);

// Arbitrary for whitespace characters
const arbWhitespace = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 0, maxLength: 5 })
  .map((a) => a.join(""));

// --- Invariant 1: normalization is case-insensitive ---

test("normalizeRouteName - normalization SHALL be case-insensitive", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 50 }), (input) => {
      const fromUpper = normalizeRouteName(input.toUpperCase());
      const fromLower = normalizeRouteName(input.toLowerCase());
      assert.equal(fromUpper, fromLower);
    }),
    { numRuns: 200 },
  );
});

test("normalizeRouteName - case-insensitive with unicode inputs", () => {
  // Use strings that have stable round-trip case folding in JavaScript.
  // Some Unicode graphemes (e.g. ligatures, special case mappings) do not
  // produce the same result through toUpperCase().toLowerCase() vs toLowerCase()
  // directly, so we restrict to the BMP Latin/Greek/Cyrillic ranges which behave well.
  const stableUnicode = fc.string({ minLength: 1, maxLength: 50 }).filter((s) => {
    // Verify this string has stable case folding
    return s.toUpperCase().toLowerCase() === s.toLowerCase().toUpperCase().toLowerCase();
  });
  fc.assert(
    fc.property(stableUnicode, (input) => {
      const fromUpper = normalizeRouteName(input.toUpperCase());
      const fromLower = normalizeRouteName(input.toLowerCase());
      assert.equal(fromUpper, fromLower);
    }),
    { numRuns: 200 },
  );
});

test("normalizeRouteName - output is always fully lowercase", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 80 }), (input) => {
      const result = normalizeRouteName(input);
      assert.equal(result, result.toLowerCase());
    }),
    { numRuns: 200 },
  );
});

// --- Invariant 2: normalization is idempotent ---

test("normalizeRouteName - applying normalization twice SHALL yield the same result (idempotent)", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 100 }), (input) => {
      const once = normalizeRouteName(input);
      const twice = normalizeRouteName(once);
      assert.equal(twice, once);
    }),
    { numRuns: 200 },
  );
});

test("normalizeRouteName - idempotent with unicode inputs", () => {
  fc.assert(
    fc.property(fc.string({ unit: "grapheme", maxLength: 50 }), (input) => {
      const once = normalizeRouteName(input);
      const twice = normalizeRouteName(once);
      assert.equal(twice, once);
    }),
    { numRuns: 200 },
  );
});

test("normalizeRouteName - idempotent with control characters", () => {
  fc.assert(
    fc.property(arbWithControlChars, (input) => {
      const once = normalizeRouteName(input);
      const twice = normalizeRouteName(once);
      assert.equal(twice, once);
    }),
    { numRuns: 200 },
  );
});

// --- Invariant 3: leading and trailing whitespace is stripped ---

test("normalizeRouteName - leading and trailing whitespace SHALL be stripped", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 30 }),
      arbWhitespace,
      arbWhitespace,
      (core, leading, trailing) => {
        const withWhitespace = `${leading}${core}${trailing}`;
        const normalized = normalizeRouteName(withWhitespace);
        // The result should equal normalizing the core without surrounding whitespace
        assert.equal(normalized, normalizeRouteName(core));
        // The result itself should have no leading or trailing whitespace
        assert.equal(normalized, normalized.trim());
      },
    ),
    { numRuns: 200 },
  );
});

test("normalizeRouteName - output never has leading or trailing whitespace regardless of input", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 100 }), (input) => {
      const result = normalizeRouteName(input);
      assert.equal(result, result.trim());
    }),
    { numRuns: 200 },
  );
});

test("normalizeRouteName - empty string input yields empty string output", () => {
  assert.equal(normalizeRouteName(""), "");
});

test("normalizeRouteName - whitespace-only input yields empty string output", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 1, maxLength: 10 }).map(
        (a) => a.join(""),
      ),
      (ws) => {
        assert.equal(normalizeRouteName(ws), "");
      },
    ),
    { numRuns: 100 },
  );
});

// --- Invariant 4: whitespace-only after prefix removal is not valid ---

test("routeNames - when route name after prefix removal is whitespace-only, it SHALL not be valid", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("Symphony:", "Route:", "Team:", "X:"),
      arbWhitespace,
      (prefix, whitespace) => {
        // Label = prefix + whitespace (so the suffix is whitespace-only)
        const issue = issueWith({ labels: [`${prefix}${whitespace}`] });
        const settings = makeSettings({ routeLabelPrefix: prefix });
        const routes = routeNames(issue, settings);
        assert.equal(routes.length, 0);
      },
    ),
    { numRuns: 200 },
  );
});

test("routeNames - exact prefix with no suffix produces no routes", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("Symphony:", "Route:", "Team:", "X:", "deploy:"),
      (prefix) => {
        const issue = issueWith({ labels: [prefix] });
        const settings = makeSettings({ routeLabelPrefix: prefix });
        const routes = routeNames(issue, settings);
        assert.equal(routes.length, 0);
      },
    ),
  );
});

// --- Invariant 5: prefix matching is case-insensitive ---

test("routeNames - prefix matching SHALL be case-insensitive", () => {
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 1, maxLength: 10 })
        .map((a) => a.join("")),
      fc
        .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 1, maxLength: 6 })
        .map((a) => a.join("")),
      (routeSuffix, prefixBase) => {
        const prefix = `${prefixBase}:`;
        const upperLabel = `${prefix.toUpperCase()}${routeSuffix}`;
        const lowerLabel = `${prefix.toLowerCase()}${routeSuffix}`;
        const mixedLabel = `${prefixBase[0]!.toUpperCase()}${prefixBase.slice(1).toLowerCase()}:${routeSuffix}`;

        const settingsObj = makeSettings({ routeLabelPrefix: prefix });

        const fromUpper = routeNames(issueWith({ labels: [upperLabel] }), settingsObj);
        const fromLower = routeNames(issueWith({ labels: [lowerLabel] }), settingsObj);
        const fromMixed = routeNames(issueWith({ labels: [mixedLabel] }), settingsObj);

        // All case variants should produce the same routes
        assert.deepEqual(fromUpper, fromLower);
        assert.deepEqual(fromLower, fromMixed);
        // And they should all find the route
        assert.ok(fromUpper.length > 0);
      },
    ),
    { numRuns: 200 },
  );
});

test("routeNames - extracted route is always normalized (lowercase, trimmed)", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
      (routeSuffix) => {
        const label = `Symphony:${routeSuffix}`;
        const issue = issueWith({ labels: [label] });
        const settings = makeSettings({ routeLabelPrefix: "Symphony:" });
        const routes = routeNames(issue, settings);
        for (const route of routes) {
          assert.equal(route, route.toLowerCase());
          assert.equal(route, route.trim());
        }
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 6: when allowlist is null, system accepts all routes ---

test("routedToThisWorker - when onlyRoutes is null, the system SHALL accept all routes", () => {
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"), {
          minLength: 1,
          maxLength: 12,
        })
        .map((a) => a.join("")),
      (routeName) => {
        const issue = issueWith({ labels: [`Symphony:${routeName}`] });
        const settings = makeSettings({ onlyRoutes: null });
        assert.ok(routedToThisWorker(issue, settings));
      },
    ),
    { numRuns: 200 },
  );
});

test("routedToThisWorker - when onlyRoutes is null, accepts unicode route names", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
      (routeName) => {
        const issue = issueWith({ labels: [`Symphony:${routeName}`] });
        const settings = makeSettings({ onlyRoutes: null });
        assert.ok(routedToThisWorker(issue, settings));
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 7: when allowlist is empty, system rejects all routes ---

test("routedToThisWorker - when onlyRoutes is empty, the system SHALL reject all routes", () => {
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"), {
          minLength: 1,
          maxLength: 12,
        })
        .map((a) => a.join("")),
      (routeName) => {
        const issue = issueWith({ labels: [`Symphony:${routeName}`] });
        const settings = makeSettings({ onlyRoutes: [] });
        assert.ok(!routedToThisWorker(issue, settings));
      },
    ),
    { numRuns: 200 },
  );
});

test("routedToThisWorker - when onlyRoutes is empty, rejects even with multiple route labels", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc
          .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 1, maxLength: 8 })
          .map((a) => `Symphony:${a.join("")}`),
        { minLength: 1, maxLength: 5 },
      ),
      (labels) => {
        const issue = issueWith({ labels });
        const settings = makeSettings({ onlyRoutes: [] });
        assert.ok(!routedToThisWorker(issue, settings));
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 8: no route label and unrouted dispatch disabled means ineligible ---

test("routedToThisWorker - when no route label is present and unrouted dispatch is disabled, dispatch SHALL be ineligible", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc
          .string({ minLength: 1, maxLength: 20 })
          .filter((l) => !l.toLowerCase().startsWith("symphony:")),
        { maxLength: 5 },
      ),
      (labels) => {
        const issue = issueWith({ labels });
        const settings = makeSettings({ acceptUnrouted: false });
        assert.ok(!routedToThisWorker(issue, settings));
      },
    ),
    { numRuns: 200 },
  );
});

test("routedToThisWorker - no route label with various prefixes and unrouted disabled rejects", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("Symphony:", "Route:", "Deploy:", "Team:"),
      fc.array(
        fc
          .string({ minLength: 1, maxLength: 15 })
          .filter((l) => !l.toLowerCase().includes(":")),
        { maxLength: 3 },
      ),
      (prefix, labels) => {
        const issue = issueWith({ labels });
        const settings = makeSettings({ routeLabelPrefix: prefix, acceptUnrouted: false });
        assert.ok(!routedToThisWorker(issue, settings));
      },
    ),
    { numRuns: 200 },
  );
});

test("routedToThisWorker - no route label with unrouted enabled SHALL accept", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc
          .string({ minLength: 1, maxLength: 20 })
          .filter((l) => !l.toLowerCase().startsWith("symphony:")),
        { maxLength: 5 },
      ),
      (labels) => {
        const issue = issueWith({ labels });
        const settings = makeSettings({ acceptUnrouted: true });
        assert.ok(routedToThisWorker(issue, settings));
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 9: prefix matches but remaining name is whitespace-only means rejected as routed-but-invalid ---

test("routedToThisWorker - when prefix matching succeeds but remaining name is whitespace-only, the route SHALL be rejected", () => {
  const arbWs = fc
    .array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 0, maxLength: 5 })
    .map((a) => a.join(""));

  fc.assert(
    fc.property(
      fc.constantFrom("Symphony:", "Route:", "Team:"),
      arbWs,
      (prefix, whitespace) => {
        // The label matches the prefix but the suffix is only whitespace
        const issue = issueWith({ labels: [`${prefix}${whitespace}`] });
        const settings = makeSettings({ routeLabelPrefix: prefix, acceptUnrouted: true });
        // hasRouteLabel returns true (prefix matched), but routeNames yields empty
        // so routedToThisWorker should treat it as "routed but invalid" and return false
        assert.ok(!routedToThisWorker(issue, settings));
      },
    ),
    { numRuns: 200 },
  );
});

test("routedToThisWorker - whitespace-only suffix with onlyRoutes null still rejected", () => {
  const arbWs = fc
    .array(fc.constantFrom(" ", "\t"), { minLength: 0, maxLength: 4 })
    .map((a) => a.join(""));

  fc.assert(
    fc.property(arbWs, (whitespace) => {
      const issue = issueWith({ labels: [`Symphony:${whitespace}`] });
      const settings = makeSettings({ onlyRoutes: null });
      // Even with null allowlist (accept all), a whitespace-only route name
      // means the label matched the prefix but produced no valid route name
      assert.ok(!routedToThisWorker(issue, settings));
    }),
    { numRuns: 200 },
  );
});

// --- Invariant 10: allowlist matching is case-insensitive ---

test("routedToThisWorker - allowlist matching SHALL be case-insensitive", () => {
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 1, maxLength: 10 })
        .map((a) => a.join("")),
      (routeName) => {
        const issue = issueWith({ labels: [`Symphony:${routeName}`] });
        // Allowlist contains the uppercase version
        const settingsUpper = makeSettings({ onlyRoutes: [routeName.toUpperCase()] });
        // Allowlist contains the lowercase version
        const settingsLower = makeSettings({ onlyRoutes: [routeName.toLowerCase()] });
        // Both should accept
        assert.ok(routedToThisWorker(issue, settingsUpper));
        assert.ok(routedToThisWorker(issue, settingsLower));
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 11: assignedToWorker=false always rejects ---

test("routedToThisWorker - when assignedToWorker is false, dispatch SHALL always be rejected", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.string({ minLength: 1, maxLength: 20 }),
        { maxLength: 5 },
      ),
      fc.boolean(),
      fc.oneof(
        fc.constant(null),
        fc.array(fc.string({ minLength: 1, maxLength: 10 }), { maxLength: 3 }),
      ),
      (labels, acceptUnrouted, onlyRoutes) => {
        const issue = issueWith({ labels, assignedToWorker: false });
        const settings = makeSettings({ acceptUnrouted, onlyRoutes });
        assert.ok(!routedToThisWorker(issue, settings));
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 12: routeNames returns only unique normalized names for each label ---

test("routeNames - each returned route name is a valid non-empty normalized string", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.string({ minLength: 1, maxLength: 30 }),
        { minLength: 1, maxLength: 5 },
      ).map((suffixes) => suffixes.map((s) => `Symphony:${s}`)),
      (labels) => {
        const issue = issueWith({ labels });
        const settings = makeSettings({ routeLabelPrefix: "Symphony:" });
        const routes = routeNames(issue, settings);
        for (const route of routes) {
          // Every returned route is non-empty
          assert.ok(route.length > 0);
          // Every returned route is normalized (lowercase, trimmed)
          assert.equal(route, route.toLowerCase());
          assert.equal(route, route.trim());
        }
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 13: labels not matching prefix are ignored ---

test("routeNames - labels that do not start with the prefix SHALL be ignored", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("Symphony:", "Route:", "Team:"),
      fc.array(
        fc.string({ minLength: 1, maxLength: 20 }).filter((l) => {
          const lower = l.toLowerCase();
          return (
            !lower.startsWith("symphony:") &&
            !lower.startsWith("route:") &&
            !lower.startsWith("team:")
          );
        }),
        { minLength: 1, maxLength: 5 },
      ),
      (prefix, labels) => {
        const issue = issueWith({ labels });
        const settings = makeSettings({ routeLabelPrefix: prefix });
        const routes = routeNames(issue, settings);
        assert.equal(routes.length, 0);
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 14: route matching specificity (if route is in allowlist, it's accepted; if not, rejected) ---

test("routedToThisWorker - a route in the allowlist SHALL be accepted", () => {
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 1, maxLength: 10 })
        .map((a) => a.join("")),
      fc.array(
        fc
          .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 1, maxLength: 8 })
          .map((a) => a.join("")),
        { minLength: 0, maxLength: 4 },
      ),
      (routeName, otherRoutes) => {
        const issue = issueWith({ labels: [`Symphony:${routeName}`] });
        // Allowlist includes the route plus some others
        const settings = makeSettings({ onlyRoutes: [routeName, ...otherRoutes] });
        assert.ok(routedToThisWorker(issue, settings));
      },
    ),
    { numRuns: 200 },
  );
});

test("routedToThisWorker - a route NOT in the allowlist SHALL be rejected", () => {
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 1, maxLength: 10 })
        .map((a) => a.join("")),
      fc
        .array(
          fc
            .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 1, maxLength: 8 })
            .map((a) => a.join("")),
          { minLength: 1, maxLength: 4 },
        )
        .filter((arr) => arr.length > 0),
      (routeName, allowlist) => {
        // Ensure the route is NOT in the allowlist
        const filteredAllowlist = allowlist.filter(
          (r) => normalizeRouteName(r) !== normalizeRouteName(routeName),
        );
        // Only test when we actually have a non-matching allowlist
        if (filteredAllowlist.length === 0) return;
        const issue = issueWith({ labels: [`Symphony:${routeName}`] });
        const settings = makeSettings({ onlyRoutes: filteredAllowlist });
        assert.ok(!routedToThisWorker(issue, settings));
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 15: multiple route labels - accepted if ANY is in allowlist ---

test("routedToThisWorker - with multiple route labels, accepted if ANY route is in allowlist", () => {
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 1, maxLength: 8 })
        .map((a) => a.join("")),
      fc.array(
        fc
          .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 1, maxLength: 8 })
          .map((a) => a.join("")),
        { minLength: 1, maxLength: 4 },
      ),
      (allowedRoute, otherRoutes) => {
        // Ensure otherRoutes don't collide with the allowed route
        const nonColliding = otherRoutes.filter(
          (r) => normalizeRouteName(r) !== normalizeRouteName(allowedRoute),
        );
        const allLabels = [
          ...nonColliding.map((r) => `Symphony:${r}`),
          `Symphony:${allowedRoute}`,
        ];
        const issue = issueWith({ labels: allLabels });
        const settings = makeSettings({ onlyRoutes: [allowedRoute] });
        assert.ok(routedToThisWorker(issue, settings));
      },
    ),
    { numRuns: 200 },
  );
});
