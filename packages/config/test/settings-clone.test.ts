import { test } from "vitest";
import { withDerivedMaxInFlight } from "@lorenz/domain";
import { assert } from "@lorenz/test-utils";

import { defaultSettings } from "../src/defaults.js";
import { cloneSettings } from "../src/settings-clone.js";

test("settings cloning preserves accessors and Maps while isolating nested options", () => {
  const settings = defaultSettings();
  settings.tracker.activeStates = ["Todo"];
  settings.tracker.dispatch.onlyRoutes = ["docs"];
  settings.tracker.options = {
    nested: { values: ["tracker-source"] },
    lookup: new Map([["tracker", { enabled: true }]]),
  };
  settings.trackers.chat = {
    ...settings.tracker,
    kind: "memory",
    activeStates: ["Queued"],
    terminalStates: ["Archived"],
    dispatch: { ...settings.tracker.dispatch, onlyRoutes: ["chat"] },
    options: { nested: { values: ["source-bundle"] } },
  };
  settings.worker.sshHosts = ["worker-source"];
  settings.worker.workerPool = withDerivedMaxInFlight({
    enabled: true,
    driver: "fake",
    min: 0,
    max: 2,
    warm: 0,
    slotsPerMachine: 2,
    ttlMs: 60_000,
    idleReapMs: 30_000,
    acquireTimeoutMs: 5_000,
    reapIntervalMs: 1_000,
    staleHeartbeatMs: 10_000,
    drainDeadlineMs: 5_000,
    spend: { maxWorkerSeconds: 120 },
    driverOptions: {
      nested: { hosts: ["driver-source"] },
      lookup: new Map([["driver", { region: "source" }]]),
    },
  });
  settings.agent.skills = ["skill-source"];
  settings.agents.codex!.options.nested = { values: ["agent-source"] };
  settings.toolOptions = {
    example: {
      nested: { values: ["tool-source"] },
      lookup: new Map([["tool", { enabled: true }]]),
    },
  };
  settings.statusOverrides.set("review", { agent: { maxTurns: 3 } });

  const clone = cloneSettings(settings);

  assert.notEqual(clone, settings);
  assert.ok(clone.statusOverrides instanceof Map);
  assert.notEqual(clone.statusOverrides, settings.statusOverrides);
  assert.deepEqual([...clone.statusOverrides], [...settings.statusOverrides]);
  clone.statusOverrides.set("todo", { agent: { maxTurns: 1 } });
  assert.equal(settings.statusOverrides.has("todo"), false);

  const clonePool = clone.worker.workerPool!;
  const sourcePool = settings.worker.workerPool!;
  assert.equal(typeof Object.getOwnPropertyDescriptor(clonePool, "maxInFlight")?.get, "function");
  assert.notEqual(clonePool, sourcePool);
  clonePool.slotsPerMachine = 4;
  assert.equal(clonePool.maxInFlight, 4);
  assert.equal(sourcePool.maxInFlight, 2);

  (clone.tracker.options.nested as { values: string[] }).values[0] = "tracker-clone";
  (clone.agents.codex!.options.nested as { values: string[] }).values[0] = "agent-clone";
  (clone.toolOptions!.example!.nested as { values: string[] }).values[0] = "tool-clone";
  (clonePool.driverOptions!.nested as { hosts: string[] }).hosts[0] = "driver-clone";
  clonePool.spend!.maxWorkerSeconds = 1;
  clone.tracker.activeStates[0] = "Review";
  clone.tracker.dispatch.onlyRoutes![0] = "runtime";
  clone.trackers.chat!.activeStates[0] = "Running";
  (clone.trackers.chat!.options.nested as { values: string[] }).values[0] = "bundle-clone";
  clone.worker.sshHosts[0] = "worker-clone";
  clone.agent.skills[0] = "skill-clone";

  assert.deepEqual(settings.tracker.options.nested, { values: ["tracker-source"] });
  assert.deepEqual(settings.agents.codex!.options.nested, { values: ["agent-source"] });
  assert.deepEqual(settings.toolOptions.example!.nested, { values: ["tool-source"] });
  assert.deepEqual(sourcePool.driverOptions!.nested, { hosts: ["driver-source"] });
  assert.equal(sourcePool.spend!.maxWorkerSeconds, 120);
  assert.deepEqual(settings.tracker.activeStates, ["Todo"]);
  assert.deepEqual(settings.tracker.dispatch.onlyRoutes, ["docs"]);
  assert.deepEqual(settings.trackers.chat!.activeStates, ["Queued"]);
  assert.deepEqual(settings.trackers.chat!.options.nested, { values: ["source-bundle"] });
  assert.deepEqual(settings.worker.sshHosts, ["worker-source"]);
  assert.deepEqual(settings.agent.skills, ["skill-source"]);

  const trackerLookup = clone.tracker.options.lookup;
  const driverLookup = clonePool.driverOptions!.lookup;
  const toolLookup = clone.toolOptions.example!.lookup;
  assert.ok(trackerLookup instanceof Map);
  assert.ok(driverLookup instanceof Map);
  assert.ok(toolLookup instanceof Map);
  assert.notEqual(trackerLookup, settings.tracker.options.lookup);
  assert.notEqual(driverLookup, sourcePool.driverOptions!.lookup);
  assert.notEqual(toolLookup, settings.toolOptions.example!.lookup);

  (trackerLookup as Map<string, { enabled: boolean }>).get("tracker")!.enabled = false;
  (driverLookup as Map<string, { region: string }>).get("driver")!.region = "clone";
  (toolLookup as Map<string, { enabled: boolean }>).get("tool")!.enabled = false;
  assert.deepEqual(
    (settings.tracker.options.lookup as Map<string, { enabled: boolean }>).get("tracker"),
    { enabled: true },
  );
  assert.deepEqual(
    (sourcePool.driverOptions!.lookup as Map<string, { region: string }>).get("driver"),
    { region: "source" },
  );
  assert.deepEqual(
    (settings.toolOptions.example!.lookup as Map<string, { enabled: boolean }>).get("tool"),
    { enabled: true },
  );
});
