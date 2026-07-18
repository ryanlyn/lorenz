import { test } from "vitest";
import type { Settings } from "@lorenz/domain";
import { assert, issueWith, settingsWith } from "@lorenz/test-utils";

import {
  agentKindForIssue,
  routeAgentKind,
  routedToThisWorker,
  settingsWithRouteAgent,
} from "@lorenz/dispatch";

function settingsWithRouteAgents(
  routeAgents: Record<string, string>,
  overrides: Parameters<typeof settingsWith>[0] = {},
): Settings {
  const settings = settingsWith({ routeLabelPrefix: "route-", ...overrides });
  settings.tracker.dispatch.routeAgents = routeAgents;
  return settings;
}

test("routeAgentKind resolves one mapped route and ignores unmapped routes", () => {
  const settings = settingsWithRouteAgents({ claude: "claude", codex: "codex" });

  assert.deepEqual(routeAgentKind(issueWith({ labels: ["route-claude"] }), settings), {
    agentKind: "claude",
    conflicts: null,
  });
  assert.deepEqual(routeAgentKind(issueWith({ labels: ["route-backend"] }), settings), {
    agentKind: null,
    conflicts: null,
  });
  assert.deepEqual(routeAgentKind(issueWith({ labels: [] }), settings), {
    agentKind: null,
    conflicts: null,
  });
});

test("routeAgentKind matches normalized route labels case-insensitively", () => {
  const settings = settingsWithRouteAgents({ claude: "claude" });
  assert.equal(
    routeAgentKind(issueWith({ labels: ["Route-Claude"] }), settings).agentKind,
    "claude",
  );
});

test("routeAgentKind reports conflicting mapped routes instead of guessing", () => {
  const settings = settingsWithRouteAgents({ claude: "claude", codex: "codex" });

  assert.deepEqual(
    routeAgentKind(issueWith({ labels: ["route-claude", "route-codex"] }), settings),
    {
      agentKind: null,
      conflicts: [
        { route: "claude", agentKind: "claude" },
        { route: "codex", agentKind: "codex" },
      ],
    },
  );
});

test("routeAgentKind accepts several routes that agree on one kind", () => {
  const settings = settingsWithRouteAgents({ backend: "claude", frontend: "claude" });
  assert.deepEqual(
    routeAgentKind(issueWith({ labels: ["route-backend", "route-frontend"] }), settings),
    { agentKind: "claude", conflicts: null },
  );
});

test("agent kind precedence is route, then state override, then default", () => {
  const settings = settingsWithRouteAgents({ claude: "claude" });
  settings.statusOverrides.set("todo", { agent: { kind: "state-kind" } });

  assert.equal(
    agentKindForIssue(settings, issueWith({ state: "Todo", labels: ["route-claude"] })),
    "claude",
  );
  assert.equal(
    agentKindForIssue(settings, issueWith({ state: "Todo", labels: ["route-backend"] })),
    "state-kind",
  );
  assert.equal(agentKindForIssue(settings, issueWith({ state: "In Progress" })), "codex");
});

test("a route conflict falls back to the state or default kind", () => {
  const settings = settingsWithRouteAgents({ claude: "claude", codex: "codex" });
  settings.statusOverrides.set("todo", { agent: { kind: "state-kind" } });

  assert.equal(
    agentKindForIssue(
      settings,
      issueWith({ state: "Todo", labels: ["route-claude", "route-codex"] }),
    ),
    "state-kind",
  );
});

test("settingsWithRouteAgent preserves identity when no mapping applies", () => {
  const settings = settingsWithRouteAgents({ claude: "claude" });
  assert.equal(
    settingsWithRouteAgent(settings, issueWith({ labels: ["route-backend"] })),
    settings,
  );
  const bare = settingsWith({ routeLabelPrefix: "route-" });
  assert.equal(settingsWithRouteAgent(bare, issueWith({ labels: ["route-claude"] })), bare);
});

test("settingsWithRouteAgent pins the kind and keeps other override fields", () => {
  const settings = settingsWithRouteAgents({ claude: "claude" });
  settings.statusOverrides.set("todo", {
    agent: { kind: "state-kind", maxTurns: 7 },
    agents: { claude: { turnTimeoutMs: 1_234 } },
  });

  const pinned = settingsWithRouteAgent(settings, issueWith({ labels: ["route-claude"] }));
  assert.equal(pinned.agent.kind, "claude");
  assert.deepEqual(pinned.statusOverrides.get("todo")?.agent, { maxTurns: 7 });
  assert.deepEqual(pinned.statusOverrides.get("todo")?.agents, {
    claude: { turnTimeoutMs: 1_234 },
  });
  assert.equal(settings.statusOverrides.get("todo")?.agent?.kind, "state-kind");
  assert.equal(settings.agent.kind, "codex");
});

test("route_agents does not change routing eligibility", () => {
  const issue = issueWith({ labels: ["route-claude"] });
  const filtered = settingsWithRouteAgents({ claude: "claude" }, { onlyRoutes: ["backend"] });
  assert.equal(routedToThisWorker(issue, filtered), false);

  const open = settingsWithRouteAgents({ claude: "claude" }, { onlyRoutes: null });
  const bare = settingsWith({ routeLabelPrefix: "route-", onlyRoutes: null });
  assert.equal(routedToThisWorker(issue, open), routedToThisWorker(issue, bare));
});
