import { test } from "vitest";
import { parseConfig, validateDispatchConfig } from "@symphony/config";
import type { Issue, RuntimeTrackerClient, Settings } from "@symphony/domain";
import { AgentExecutorRegistry, type AgentExecutorProvider } from "@symphony/agent-sdk";
import { executeTool, toolSpecs } from "@symphony/mcp";
import { ToolRegistry } from "@symphony/tool-sdk";
import { createTrackerToolProvider } from "@symphony/tracker-sdk";
import {
  TrackerRegistry,
  rejectUnknownOptions,
  stringOption,
  type TrackerProvider,
  type TrackerToolOps,
} from "@symphony/tracker-sdk";
import { assert } from "@symphony/test-utils";

// Stand-in for the composition root's executor registration; the default agent records
// select the "acp" executor, and this test only needs validation to pass.
const stubExecutorProvider: AgentExecutorProvider = {
  executor: "acp",
  createExecutor: () => {
    throw new Error("not under test");
  },
};

function executorRegistry(): AgentExecutorRegistry {
  const registry = new AgentExecutorRegistry();
  registry.register(stubExecutorProvider);
  return registry;
}

/**
 * Architectural regression test for the extension contract: a brand-new tracker backend
 * is one TrackerProvider implementation plus one registry registration. Everything below
 * uses only the SDK surface - if this test needs core (domain/config/mcp/cli) changes to
 * keep passing for a new backend, the provider boundary has regressed. Agent-facing tools
 * arrive through the same provider via `createToolOps`, served by the provider-neutral
 * `tracker` pack mounted in a ToolRegistry.
 */

const fakeIssue: Issue = {
  id: "notion-1",
  identifier: "NTN-1",
  title: "Wire the flux capacitor",
  state: "To Do",
  stateType: "unstarted",
  labels: [],
  blockers: [],
};

class FakeNotionClient implements RuntimeTrackerClient {
  constructor(readonly baseUrl: string) {}
  async fetchCandidateIssues(): Promise<Issue[]> {
    return [fakeIssue];
  }
  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    return ids.includes(fakeIssue.id) ? [fakeIssue] : [];
  }
}

/** Issues created through the fake's tool ops, proving writes round-trip per provider instance. */
function fakeNotionToolOps(): TrackerToolOps {
  const created = new Map<string, Issue>([[fakeIssue.id, fakeIssue]]);
  return {
    async readIssue(issueId) {
      const issue = created.get(issueId);
      if (!issue) throw new Error(`notion issue not found: ${issueId}`);
      return issue;
    },
    async createIssue(input) {
      const issue: Issue = {
        id: `notion-${created.size + 1}`,
        identifier: `NTN-${created.size + 1}`,
        title: input.title,
        state: input.status ?? "To Do",
        stateType: "unstarted",
        description: input.body ?? null,
        labels: [],
        blockers: [],
      };
      created.set(issue.id, issue);
      return issue;
    },
  };
}

function fakeNotionProvider(): TrackerProvider {
  const toolOps = fakeNotionToolOps();
  return {
    kind: "notion",
    configAliases: { database_id: "databaseId" },
    envFallbacks: { apiKey: "NOTION_API_KEY" },
    defaultEndpoint: "https://api.notion.example",
    parseOptions(options) {
      rejectUnknownOptions(options, ["databaseId"], "notion");
      const databaseId = stringOption(options, "databaseId");
      return databaseId === undefined ? {} : { databaseId };
    },
    validateDispatch(settings) {
      if (!settings.tracker.apiKey) throw new Error("tracker.api_key is required");
      if (!settings.tracker.options.databaseId) throw new Error("tracker.database_id is required");
    },
    createClient(settings) {
      return new FakeNotionClient(settings.tracker.endpoint!);
    },
    createToolOps: () => toolOps,
    projectUrl: (settings) =>
      `https://notion.example/${String(settings.tracker.options.databaseId)}`,
  };
}

function registryWithFakeNotion(): TrackerRegistry {
  const registry = new TrackerRegistry();
  registry.register(fakeNotionProvider());
  return registry;
}

/** The MCP mount for this test: just the neutral `tracker` pack over the private registry. */
function toolRegistryFor(trackers: TrackerRegistry): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register(createTrackerToolProvider(trackers));
  return tools;
}

function parseFakeNotion(
  env: NodeJS.ProcessEnv = {},
  registry = registryWithFakeNotion(),
): Settings {
  return parseConfig(
    {
      tracker: {
        kind: "notion",
        database_id: "db-eng",
        active_states: ["To Do"],
      },
    },
    env,
    {},
    registry,
  );
}

test("a new provider's config section parses through its aliases, options, and env fallbacks", () => {
  const settings = parseFakeNotion({ NOTION_API_KEY: "notion-token" });

  assert.equal(settings.tracker.kind, "notion");
  assert.equal(settings.tracker.apiKey, "notion-token");
  assert.equal(settings.tracker.endpoint, "https://api.notion.example");
  assert.deepEqual(settings.tracker.options, { databaseId: "db-eng" });
});

test("a new provider's option typos and dispatch requirements are enforced", () => {
  const registry = registryWithFakeNotion();
  assert.throws(
    () => parseConfig({ tracker: { kind: "notion", database_idd: "db-eng" } }, {}, {}, registry),
    /unsupported tracker option\(s\) for kind "notion": database_idd/,
  );

  const missingKey = parseConfig({ tracker: { kind: "notion" } }, {}, {}, registry);
  assert.throws(
    () => validateDispatchConfig(missingKey, registry, executorRegistry()),
    /tracker.api_key is required/,
  );
});

test("a new provider supplies the runtime client and tracker tools without core changes", async () => {
  const registry = registryWithFakeNotion();
  const tools = toolRegistryFor(registry);
  const settings = parseFakeNotion({ NOTION_API_KEY: "notion-token" }, registry);
  validateDispatchConfig(settings, registry, executorRegistry(), tools);

  const client = registry.require(settings.tracker.kind).createClient(settings, { env: {} });
  assert.deepEqual(
    (await client.fetchCandidateIssues()).map((issue) => issue.identifier),
    ["NTN-1"],
  );

  // The neutral pack advertises the full tracker_* surface as soon as the provider
  // exposes tool ops; ops the provider omits fail per call with a clear message.
  assert.deepEqual(
    toolSpecs(settings, tools).map((spec) => spec.name),
    [
      "tracker_read_issue",
      "tracker_query",
      "tracker_update_status",
      "tracker_comment",
      "tracker_create_issue",
    ],
  );

  const read = await executeTool(
    "tracker_read_issue",
    { issueId: "notion-1" },
    settings,
    fetch,
    tools,
  );
  assert.equal(read.success, true);
  assert.equal((read.result as { issue: Issue }).issue.identifier, "NTN-1");

  const created = await executeTool(
    "tracker_create_issue",
    { title: "Calibrate the deflector", body: "Before Tuesday." },
    settings,
    fetch,
    tools,
  );
  assert.equal(created.success, true);
  const createdIssue = (created.result as { issue: Issue }).issue;
  assert.equal(createdIssue.title, "Calibrate the deflector");

  const reread = await executeTool(
    "tracker_read_issue",
    { issueId: createdIssue.id },
    settings,
    fetch,
    tools,
  );
  assert.equal(reread.success, true);
  assert.equal((reread.result as { issue: Issue }).issue.id, createdIssue.id);

  const unsupportedOp = await executeTool(
    "tracker_update_status",
    { issueId: "notion-1", status: "Done" },
    settings,
    fetch,
    tools,
  );
  assert.equal(unsupportedOp.success, false);
  assert.match(unsupportedOp.error ?? "", /tracker tools are unavailable for notion tracker/);

  assert.equal(
    registry.providerFor(settings)?.projectUrl?.(settings),
    "https://notion.example/db-eng",
  );
});

test("unknown kinds parse leniently and fail dispatch validation with the known-kind list", () => {
  const registry = registryWithFakeNotion();
  const settings = parseConfig({ tracker: { kind: "github", anything: true } }, {}, {}, registry);
  assert.deepEqual(settings.tracker.options, { anything: true });
  assert.throws(
    () => validateDispatchConfig(settings, registry, executorRegistry()),
    /unsupported tracker.kind: github \(known kinds: notion\)/,
  );
});
