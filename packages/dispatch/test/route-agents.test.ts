import { test } from "vitest";
import type { Settings } from "@lorenz/domain";
import { assert, issueWith, settingsWith } from "@lorenz/test-utils";

import {
  agentKindForIssue,
  routeAgentKind,
  routedToThisWorker,
  settingsWithRouteAgent,
} from "@lorenz/dispatch";

function settingsWithAgentKinds(
  agentKinds: string[],
  overrides: Parameters<typeof settingsWith>[0] = {},
): Settings {
  const settings = settingsWith({ routeLabelPrefix: "route-", ...overrides });
  for (const agentKind of agentKinds) {
    settings.agents[agentKind] = { ...settings.agents.claude! };
  }
  return settings;
}

test("routeAgentKind selects any configured agents key and ignores other routes", () => {
  const settings = settingsWithAgentKinds(["reviewer"]);

  assert.deepEqual(routeAgentKind(issueWith({ labels: ["route-reviewer"] }), settings), {
    agentKind: "reviewer",
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

test("routeAgentKind matches normalized route labels to agent keys case-insensitively", () => {
  const settings = settingsWithAgentKinds(["ReviewAgent"]);
  assert.equal(
    routeAgentKind(issueWith({ labels: ["Route-ReviewAgent"] }), settings).agentKind,
    "ReviewAgent",
  );
});

test("routeAgentKind reports conflicting agent routes instead of guessing", () => {
  const settings = settingsWith({ routeLabelPrefix: "route-" });

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

test("routeAgentKind deduplicates repeated labels for one agent", () => {
  const settings = settingsWith({ routeLabelPrefix: "route-" });
  assert.deepEqual(
    routeAgentKind(issueWith({ labels: ["route-claude", "route-claude"] }), settings),
    { agentKind: "claude", conflicts: null },
  );
});

test("agent kind precedence is route, then state override, then default", () => {
  const settings = settingsWith({ routeLabelPrefix: "route-" });
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
  const settings = settingsWith({ routeLabelPrefix: "route-" });
  settings.statusOverrides.set("todo", { agent: { kind: "state-kind" } });

  assert.equal(
    agentKindForIssue(
      settings,
      issueWith({ state: "Todo", labels: ["route-claude", "route-codex"] }),
    ),
    "state-kind",
  );
});

test("settingsWithRouteAgent preserves identity when no agent key matches", () => {
  const settings = settingsWith({ routeLabelPrefix: "route-" });
  assert.equal(
    settingsWithRouteAgent(settings, issueWith({ labels: ["route-backend"] })),
    settings,
  );
});

test("settingsWithRouteAgent pins the kind and keeps other override fields", () => {
  const settings = settingsWith({ routeLabelPrefix: "route-" });
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

test("agent route selection does not change routing eligibility", () => {
  const issue = issueWith({ labels: ["route-claude"] });
  const filtered = settingsWith({ routeLabelPrefix: "route-", onlyRoutes: ["backend"] });
  assert.equal(routedToThisWorker(issue, filtered), false);

  const open = settingsWith({ routeLabelPrefix: "route-", onlyRoutes: null });
  const bare = settingsWith({ routeLabelPrefix: "route-", onlyRoutes: null });
  assert.equal(routedToThisWorker(issue, open), routedToThisWorker(issue, bare));
});
