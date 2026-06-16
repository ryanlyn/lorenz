import { test, describe } from "vitest";
import fc from "fast-check";
import { normalizeRouteName } from "@lorenz/config";
import { assert, issueWith, settingsWith as makeSettings } from "@lorenz/test-utils";

import { routeNames, routedToThisWorker } from "@lorenz/dispatch";

const arbRouteName = fc.oneof(
  fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0),
  fc.constantFrom(
    "team-alpha",
    "deploy_v2",
    "ci.main",
    "backend",
    "frontend-3",
    "ops_infra.prod",
    "release-2024.01",
    "ML-pipeline",
  ),
);
const arbRouteNameNoColon = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => s.trim().length > 0 && !s.includes(":"));
const arbWhitespace = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 0, maxLength: 5 })
  .map((a) => a.join(""));

describe("INVARIANT: When route name normalization is applied twice, the result SHALL be the same (idempotent).", () => {
  test("normalizeRouteName - normalization is idempotent", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 100 }), (input) => {
        const once = normalizeRouteName(input);
        assert.equal(normalizeRouteName(once), once);
      }),
      { numRuns: 50 },
    );
  });
});

describe("INVARIANT: When route names are normalized, normalization SHALL be case-insensitive. INVARIANT: When route names are normalized, leading and trailing whitespace SHALL be stripped.", () => {
  test("normalizeRouteName - output is always lowercase and trimmed", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 80 }), (input) => {
        const result = normalizeRouteName(input);
        assert.equal(result, result.toLowerCase());
        assert.equal(result, result.trim());
      }),
      { numRuns: 50 },
    );
  });
});

describe("INVARIANT: When a route name after prefix removal is whitespace-only, it SHALL not be valid.", () => {
  test("routeNames - whitespace-only suffix is not valid", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("Lorenz:", "Route:", "Team:", "X:"),
        arbWhitespace,
        (prefix, ws) => {
          assert.equal(
            routeNames(
              issueWith({ labels: [`${prefix}${ws}`] }),
              makeSettings({ routeLabelPrefix: prefix }),
            ).length,
            0,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("INVARIANT: When prefix matching is performed, matching SHALL be case-insensitive.", () => {
  test("routeNames - prefix matching is case-insensitive", () => {
    fc.assert(
      fc.property(
        arbRouteNameNoColon,
        fc.constantFrom("Lorenz:", "Route:", "Team:"),
        (routeSuffix, prefix) => {
          const prefixBase = prefix.slice(0, -1);
          const s = makeSettings({ routeLabelPrefix: prefix });
          const fromUpper = routeNames(
            issueWith({ labels: [`${prefix.toUpperCase()}${routeSuffix}`] }),
            s,
          );
          const fromLower = routeNames(
            issueWith({ labels: [`${prefix.toLowerCase()}${routeSuffix}`] }),
            s,
          );
          const fromMixed = routeNames(
            issueWith({
              labels: [
                `${prefixBase[0]!.toUpperCase()}${prefixBase.slice(1).toLowerCase()}:${routeSuffix}`,
              ],
            }),
            s,
          );
          assert.deepEqual(fromUpper, fromLower);
          assert.deepEqual(fromLower, fromMixed);
          assert.ok(fromUpper.length > 0);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When routes are extracted from labels, the output SHALL always be in normalized form.", () => {
  test("routeNames - extracted route is always normalized", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
        (routeSuffix) => {
          const routes = routeNames(
            issueWith({ labels: [`Lorenz:${routeSuffix}`] }),
            makeSettings({ routeLabelPrefix: "Lorenz:" }),
          );
          for (const route of routes) {
            assert.equal(route, route.toLowerCase());
            assert.equal(route, route.trim());
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When the allowlist is null, the system SHALL accept all routes.", () => {
  test("routedToThisWorker - null allowlist accepts all routes", () => {
    fc.assert(
      fc.property(arbRouteName, (routeName) => {
        assert.ok(
          routedToThisWorker(
            issueWith({ labels: [`Lorenz:${routeName}`] }),
            makeSettings({ onlyRoutes: null }),
          ),
        );
      }),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When the allowlist is empty, the system SHALL reject all routes.", () => {
  test("routedToThisWorker - empty allowlist rejects all routes", () => {
    fc.assert(
      fc.property(arbRouteName, (routeName) => {
        assert.ok(
          !routedToThisWorker(
            issueWith({ labels: [`Lorenz:${routeName}`] }),
            makeSettings({ onlyRoutes: [] }),
          ),
        );
      }),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When no route label is present and unrouted dispatch is disabled, the dispatch SHALL be ineligible.", () => {
  test("routedToThisWorker - no route label and unrouted disabled means ineligible", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .string({ minLength: 1, maxLength: 20 })
            .filter((l) => !l.toLowerCase().startsWith("lorenz:")),
          { maxLength: 5 },
        ),
        (labels) => {
          assert.ok(
            !routedToThisWorker(issueWith({ labels }), makeSettings({ acceptUnrouted: false })),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When no route label is present and unrouted dispatch is enabled, the dispatch SHALL be eligible.", () => {
  test("routedToThisWorker - no route label with unrouted enabled accepts", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .string({ minLength: 1, maxLength: 20 })
            .filter((l) => !l.toLowerCase().startsWith("lorenz:")),
          { maxLength: 5 },
        ),
        (labels) => {
          assert.ok(
            routedToThisWorker(issueWith({ labels }), makeSettings({ acceptUnrouted: true })),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When prefix matching succeeds but the remaining name is whitespace-only, the route SHALL be rejected as routed-but-invalid.", () => {
  test("routedToThisWorker - whitespace-only suffix means rejected", () => {
    const arbWs = fc
      .array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 0, maxLength: 5 })
      .map((a) => a.join(""));
    fc.assert(
      fc.property(fc.constantFrom("Lorenz:", "Route:", "Team:"), arbWs, (prefix, ws) => {
        assert.ok(
          !routedToThisWorker(
            issueWith({ labels: [`${prefix}${ws}`] }),
            makeSettings({ routeLabelPrefix: prefix, acceptUnrouted: true }),
          ),
        );
      }),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When allowlist matching is performed, matching SHALL be case-insensitive.", () => {
  test("routedToThisWorker - allowlist matching is case-insensitive", () => {
    fc.assert(
      fc.property(arbRouteNameNoColon, (routeName) => {
        const issue = issueWith({ labels: [`Lorenz:${routeName}`] });
        assert.ok(
          routedToThisWorker(issue, makeSettings({ onlyRoutes: [routeName.toUpperCase()] })),
        );
        assert.ok(
          routedToThisWorker(issue, makeSettings({ onlyRoutes: [routeName.toLowerCase()] })),
        );
      }),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When an issue is not assigned to the worker, routing SHALL always reject regardless of other settings.", () => {
  test("routedToThisWorker - assignedToWorker false always rejects", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 }),
        fc.boolean(),
        fc.oneof(
          fc.constant(null),
          fc.array(fc.string({ minLength: 1, maxLength: 10 }), { maxLength: 3 }),
        ),
        (labels, acceptUnrouted, onlyRoutes) => {
          assert.ok(
            !routedToThisWorker(
              issueWith({ labels, assignedToWorker: false }),
              makeSettings({ acceptUnrouted, onlyRoutes }),
            ),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When an issue's route appears in the allowlist, the dispatch SHALL be eligible.", () => {
  test("routedToThisWorker - route in allowlist is accepted", () => {
    fc.assert(
      fc.property(
        arbRouteNameNoColon,
        fc.array(arbRouteNameNoColon, { minLength: 0, maxLength: 4 }),
        (routeName, others) => {
          assert.ok(
            routedToThisWorker(
              issueWith({ labels: [`Lorenz:${routeName}`] }),
              makeSettings({ onlyRoutes: [routeName, ...others] }),
            ),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When an issue's route does not appear in the allowlist, the dispatch SHALL be ineligible.", () => {
  test("routedToThisWorker - route NOT in allowlist is rejected", () => {
    const poolA = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    const poolB = ["one", "two", "three", "four", "five", "six"];
    fc.assert(
      fc.property(
        fc.constantFrom(...poolA),
        fc.array(fc.constantFrom(...poolB), { minLength: 1, maxLength: 4 }),
        (routeName, allowlist) => {
          assert.ok(
            !routedToThisWorker(
              issueWith({ labels: [`Lorenz:${routeName}`] }),
              makeSettings({ onlyRoutes: allowlist }),
            ),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When multiple route labels are present, matching ANY route in the allowlist SHALL be sufficient for eligibility.", () => {
  test("routedToThisWorker - multiple labels, accepted if ANY in allowlist", () => {
    fc.assert(
      fc.property(
        arbRouteNameNoColon,
        fc.array(arbRouteNameNoColon, { minLength: 1, maxLength: 4 }),
        (allowedRoute, others) => {
          const nonColliding = others.filter(
            (r) => normalizeRouteName(r) !== normalizeRouteName(allowedRoute),
          );
          assert.ok(
            routedToThisWorker(
              issueWith({
                labels: [...nonColliding.map((r) => `Lorenz:${r}`), `Lorenz:${allowedRoute}`],
              }),
              makeSettings({ onlyRoutes: [allowedRoute] }),
            ),
          );
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("INVARIANT: When labels do not match the route prefix, they SHALL not produce route names.", () => {
  test("routeNames - non-matching labels are ignored", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("Lorenz:", "Route:", "Team:"),
        fc.array(
          fc.string({ minLength: 1, maxLength: 20 }).filter((l) => {
            const lo = l.toLowerCase();
            return !lo.startsWith("lorenz:") && !lo.startsWith("route:") && !lo.startsWith("team:");
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (prefix, labels) => {
          assert.equal(
            routeNames(issueWith({ labels }), makeSettings({ routeLabelPrefix: prefix })).length,
            0,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
