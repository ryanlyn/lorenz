import { test } from "vitest";
import { parseConfig } from "@lorenz/config";
import type { Settings } from "@lorenz/domain";
import { assert } from "@lorenz/test-utils";
import { TrackerRegistry } from "@lorenz/tracker-sdk";

import {
  jiraMcpTrackerProvider,
  jiraTrackerOptions,
  jiraTrackerProvider,
} from "@lorenz/jira-tracker";

const trackers = new TrackerRegistry();
trackers.register(jiraTrackerProvider);
trackers.register(jiraMcpTrackerProvider);

test("Jira config parsing produces the stable normalized options contract", () => {
  const settings = parseConfig(
    {
      tracker: {
        kind: "jira-mcp",
        base_url: "https://example.atlassian.net",
        project_keys: ["ENG"],
        mcp: {
          url: "$MCP_URL",
          token: "$MCP_TOKEN",
          headers: { "x-atlassian-cloud-id": "cloud-1" },
          tools: {
            read_issue: "atlassian_get_issue",
            update_status: "atlassian_transition_issue",
          },
        },
      },
    },
    {
      MCP_URL: "http://127.0.0.1:5123/mcp",
      MCP_TOKEN: "mcp-token",
    },
    {},
    trackers,
  );

  const options = jiraTrackerOptions(settings);

  assert.equal(options, settings.tracker.options);
  assert.equal(jiraTrackerOptions(settings), options);
  assert.deepEqual(options, {
    baseUrl: "https://example.atlassian.net",
    projectKeys: ["ENG"],
    mcp: {
      url: "http://127.0.0.1:5123/mcp",
      token: "mcp-token",
      headers: { "x-atlassian-cloud-id": "cloud-1" },
      tools: {
        readIssue: "atlassian_get_issue",
        updateStatus: "atlassian_transition_issue",
      },
    },
  });
});

test("config normalization does not reuse environment-specific results for raw input", () => {
  const raw = {
    tracker: {
      kind: "jira-mcp",
      project_keys: ["ENG"],
      mcp: {
        url: "$MCP_URL",
        token: "$MCP_TOKEN",
      },
    },
  };

  const first = parseConfig(
    raw,
    { MCP_URL: "https://first.example/mcp", MCP_TOKEN: "first-token" },
    {},
    trackers,
  );
  const second = parseConfig(
    raw,
    { MCP_URL: "https://second.example/mcp", MCP_TOKEN: "second-token" },
    {},
    trackers,
  );

  assert.equal(jiraTrackerOptions(first).mcp?.url, "https://first.example/mcp");
  assert.equal(jiraTrackerOptions(first).mcp?.token, "first-token");
  assert.equal(jiraTrackerOptions(second).mcp?.url, "https://second.example/mcp");
  assert.equal(jiraTrackerOptions(second).mcp?.token, "second-token");
});

test("the explicit options boundary normalizes programmatic settings once", () => {
  const raw: Record<string, unknown> = {
    baseUrl: "https://example.atlassian.net",
    projectKeys: ["ENG"],
    mcp: {
      url: "http://127.0.0.1:5123/mcp",
      token: "literal-token",
      headers: { authorization: "custom" },
      tools: { read_issue: "atlassian_get_issue" },
    },
  };
  const settings = programmaticSettings(raw);

  const options = jiraTrackerOptions(settings);
  const tools = (raw.mcp as Record<string, unknown>).tools as Record<string, unknown>;
  tools.read_issue = 42;

  assert.notEqual(options, raw);
  assert.equal(jiraTrackerOptions(settings), options);
  assert.equal(options.mcp?.token, "literal-token");
  assert.deepEqual(options.mcp?.headers, { authorization: "custom" });
  assert.deepEqual(options.mcp?.tools, { readIssue: "atlassian_get_issue" });
});

test("the explicit options boundary validates programmatic Jira MCP settings", () => {
  const invalidOptions: Array<[Record<string, unknown>, RegExp]> = [
    [{ unexpected: true }, /unsupported tracker option\(s\).*unexpected/],
    [{ mcp: "not-a-map" }, /tracker\.mcp must be a map/],
    [{ mcp: { unexpected: true } }, /unsupported tracker\.mcp key\(s\): unexpected/],
    [{ mcp: { headers: { authorization: 42 } } }, /tracker\.mcp\.headers must be a map of strings/],
    [
      { mcp: { tools: { unexpected: "tool" } } },
      /unsupported tracker\.mcp\.tools key\(s\): unexpected/,
    ],
    [{ mcp: { tools: { search: 42 } } }, /tracker\.mcp\.tools\.search must be a string/],
  ];

  for (const [options, message] of invalidOptions) {
    assert.throws(() => jiraTrackerOptions(programmaticSettings(options)), message);
  }
});

function programmaticSettings(options: Record<string, unknown>): Settings {
  const parsed = parseConfig(
    {
      tracker: {
        kind: "jira-mcp",
        project_keys: ["ENG"],
        mcp: { url: "http://127.0.0.1:5123/mcp" },
      },
    },
    {},
    {},
    trackers,
  );
  return {
    ...parsed,
    tracker: {
      ...parsed.tracker,
      options,
    },
  };
}
