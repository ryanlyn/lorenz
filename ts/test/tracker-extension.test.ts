import { test } from "vitest";
import { parseConfig, validateDispatchConfig } from "@symphony/config";
import type { Issue, RuntimeTrackerClient, Settings } from "@symphony/domain";
import { executeTool, toolSpecs } from "@symphony/mcp";
import {
  TrackerRegistry,
  rejectUnknownOptions,
  stringOption,
  toolSuccess,
  type TrackerProvider,
} from "@symphony/tracker-sdk";

import { assert } from "./assert.js";

/**
 * Architectural regression test for the extension contract: a brand-new tracker backend
 * is one TrackerProvider implementation plus one registry registration. Everything below
 * uses only the SDK surface - if this test needs core (domain/config/mcp/cli) changes to
 * keep passing for a new backend, the provider boundary has regressed.
 */

const fakeIssue: Issue = {
  id: "jira-1",
  identifier: "ENG-1",
  title: "Wire the flux capacitor",
  state: "To Do",
  stateType: "unstarted",
  labels: [],
  blockers: [],
};

class FakeJiraClient implements RuntimeTrackerClient {
  constructor(readonly baseUrl: string) {}
  async fetchCandidateIssues(): Promise<Issue[]> {
    return [fakeIssue];
  }
  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    return ids.includes(fakeIssue.id) ? [fakeIssue] : [];
  }
}

const fakeJiraProvider: TrackerProvider = {
  kind: "fake-jira",
  configAliases: { project_key: "projectKey" },
  envFallbacks: { apiKey: "FAKE_JIRA_API_KEY" },
  defaultEndpoint: "https://example.atlassian.net",
  parseOptions(options) {
    rejectUnknownOptions(options, ["projectKey"], "fake-jira");
    const projectKey = stringOption(options, "projectKey");
    return projectKey === undefined ? {} : { projectKey };
  },
  validateDispatch(settings) {
    if (!settings.tracker.apiKey) throw new Error("tracker.api_key is required");
    if (!settings.tracker.options.projectKey) throw new Error("tracker.project_key is required");
  },
  createClient(settings) {
    return new FakeJiraClient(settings.tracker.endpoint!);
  },
  toolSpecs: () => [
    {
      name: "fake_jira_search",
      description: "Search issues with JQL.",
      inputSchema: { type: "object", properties: { jql: { type: "string" } } },
    },
  ],
  executeTool: async (name, input) => toolSuccess({ tool: name, echo: input }),
  projectUrl: (settings) =>
    `https://example.atlassian.net/browse/${String(settings.tracker.options.projectKey)}`,
};

function registryWithFakeJira(): TrackerRegistry {
  const registry = new TrackerRegistry();
  registry.register(fakeJiraProvider);
  return registry;
}

function parseFakeJira(env: NodeJS.ProcessEnv = {}, registry = registryWithFakeJira()): Settings {
  return parseConfig(
    {
      tracker: {
        kind: "fake-jira",
        project_key: "ENG",
        active_states: ["To Do"],
      },
    },
    env,
    {},
    registry,
  );
}

test("a new provider's config section parses through its aliases, options, and env fallbacks", () => {
  const settings = parseFakeJira({ FAKE_JIRA_API_KEY: "jira-token" });

  assert.equal(settings.tracker.kind, "fake-jira");
  assert.equal(settings.tracker.apiKey, "jira-token");
  assert.equal(settings.tracker.endpoint, "https://example.atlassian.net");
  assert.deepEqual(settings.tracker.options, { projectKey: "ENG" });
});

test("a new provider's option typos and dispatch requirements are enforced", () => {
  const registry = registryWithFakeJira();
  assert.throws(
    () => parseConfig({ tracker: { kind: "fake-jira", project_keey: "ENG" } }, {}, {}, registry),
    /unsupported tracker option\(s\) for kind "fake-jira": project_keey/,
  );

  const missingKey = parseConfig({ tracker: { kind: "fake-jira" } }, {}, {}, registry);
  assert.throws(() => validateDispatchConfig(missingKey, registry), /tracker.api_key is required/);
});

test("a new provider supplies the runtime client and agent tools without core changes", async () => {
  const registry = registryWithFakeJira();
  const settings = parseFakeJira({ FAKE_JIRA_API_KEY: "jira-token" }, registry);
  validateDispatchConfig(settings, registry);

  const client = registry.require(settings.tracker.kind).createClient(settings, { env: {} });
  assert.deepEqual(
    (await client.fetchCandidateIssues()).map((issue) => issue.identifier),
    ["ENG-1"],
  );

  assert.deepEqual(
    toolSpecs(settings, registry).map((spec) => spec.name),
    ["fake_jira_search"],
  );
  const result = await executeTool(
    "fake_jira_search",
    { jql: "assignee = currentUser()" },
    settings,
    fetch,
    registry,
  );
  assert.deepEqual(result, {
    success: true,
    result: { tool: "fake_jira_search", echo: { jql: "assignee = currentUser()" } },
  });

  assert.equal(
    registry.providerFor(settings)?.projectUrl?.(settings),
    "https://example.atlassian.net/browse/ENG",
  );
});

test("unknown kinds parse leniently and fail dispatch validation with the known-kind list", () => {
  const registry = registryWithFakeJira();
  const settings = parseConfig({ tracker: { kind: "github", anything: true } }, {}, {}, registry);
  assert.deepEqual(settings.tracker.options, { anything: true });
  assert.throws(
    () => validateDispatchConfig(settings, registry),
    /unsupported tracker.kind: github \(known kinds: fake-jira\)/,
  );
});
