import { test } from "vitest";
import type { Issue, Settings } from "@symphony/domain";
import type { ToolProvider } from "@symphony/tool-sdk";
import { TrackerRegistry, type TrackerProvider, type TrackerToolOps } from "@symphony/tracker-sdk";
import { assert, makeSettings } from "@symphony/test-utils";

import { createTrackerToolProvider } from "@symphony/tracker-sdk";

const TRACKER_TOOL_NAMES = [
  "tracker_read_issue",
  "tracker_query",
  "tracker_update_status",
  "tracker_comment",
  "tracker_create_issue",
];

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "id-1",
    identifier: "STUB-1",
    title: "First",
    description: null,
    state: "Todo",
    stateType: "unstarted",
    labels: [],
    blockers: [],
    url: "https://tracker.example/STUB-1",
    ...overrides,
  };
}

function stubProvider(kind: string, ops: TrackerToolOps | undefined): TrackerProvider {
  return {
    kind,
    createClient: () => {
      throw new Error("not under test");
    },
    createToolOps: () => ops,
  };
}

function packFor(
  kind: string,
  ops: TrackerToolOps | undefined,
): { pack: ToolProvider; settings: Settings } {
  const trackers = new TrackerRegistry();
  trackers.register(stubProvider(kind, ops));
  const settings = makeSettings({ tracker: { kind } });
  return { pack: createTrackerToolProvider(trackers), settings };
}

function execute(pack: ToolProvider, settings: Settings, name: string, input: unknown) {
  return pack.executeTool(name, input, { settings, fetchImpl: fetch });
}

test("tracker pack advertises no tools when the provider exposes no tool ops", () => {
  const { pack, settings } = packFor("memory", undefined);
  assert.deepEqual(pack.toolSpecs(settings), []);

  // An unregistered kind has no provider and therefore no tools either.
  const empty = createTrackerToolProvider(new TrackerRegistry());
  assert.deepEqual(empty.toolSpecs(settings), []);
});

test("tracker pack advertises the five tracker_* tools when the provider has ops", () => {
  const { pack, settings } = packFor("stub", {});
  assert.deepEqual(
    pack.toolSpecs(settings).map((spec) => spec.name),
    TRACKER_TOOL_NAMES,
  );
});

test("tracker tools fail with a clear message when ops or the specific op are missing", async () => {
  const { pack, settings } = packFor("memory", undefined);
  const result = await execute(pack, settings, "tracker_read_issue", { issueId: "STUB-1" });
  assert.deepEqual(result, {
    success: false,
    error: "tracker tools are unavailable for memory tracker",
    result: { error: { message: "tracker tools are unavailable for memory tracker" } },
  });

  // Ops exist but the specific operation is not implemented.
  const partial = packFor("stub", { readIssue: async () => issue() });
  const comment = await execute(partial.pack, partial.settings, "tracker_comment", {
    issueId: "STUB-1",
    body: "hello",
  });
  assert.equal(comment.success, false);
  assert.equal(comment.error, "tracker tools are unavailable for stub tracker");
});

test("tracker tools validate arguments and reject unknown names", async () => {
  const { pack, settings } = packFor("stub", { readIssue: async () => issue() });

  const missingArg = await execute(pack, settings, "tracker_read_issue", {});
  assert.equal(missingArg.success, false);
  assert.equal(missingArg.error, "'issueId' is required");

  const unknown = await execute(pack, settings, "tracker_bogus", {});
  assert.deepEqual(unknown, {
    success: false,
    error: 'Unsupported tool: "tracker_bogus".',
    result: {
      error: {
        message: 'Unsupported tool: "tracker_bogus".',
        supportedTools: TRACKER_TOOL_NAMES,
      },
    },
  });
});

test("tracker_read_issue, tracker_update_status, and tracker_create_issue return the issue", async () => {
  const calls: unknown[] = [];
  const { pack, settings } = packFor("stub", {
    readIssue: async (issueId) => {
      calls.push(["read", issueId]);
      return issue();
    },
    updateStatus: async (issueId, status) => {
      calls.push(["update", issueId, status]);
      return issue({ state: status, stateType: "started" });
    },
    createIssue: async (input) => {
      calls.push(["create", input]);
      return issue({ title: input.title });
    },
  });

  const read = await execute(pack, settings, "tracker_read_issue", { issueId: "STUB-1" });
  assert.deepEqual(read.result, { issue: issue() });

  const updated = await execute(pack, settings, "tracker_update_status", {
    issueId: "STUB-1",
    status: "In Progress",
  });
  assert.deepEqual(updated.result, {
    issue: issue({ state: "In Progress", stateType: "started" }),
  });

  const created = await execute(pack, settings, "tracker_create_issue", { title: "New" });
  assert.deepEqual(created.result, { issue: issue({ title: "New" }) });

  assert.deepEqual(calls, [
    ["read", "STUB-1"],
    ["update", "STUB-1", "In Progress"],
    ["create", { title: "New" }],
  ]);
});

test("tracker_comment returns ok and passes the body through", async () => {
  const calls: unknown[] = [];
  const { pack, settings } = packFor("stub", {
    addComment: async (issueId, body) => {
      calls.push([issueId, body]);
    },
  });

  const result = await execute(pack, settings, "tracker_comment", {
    issueId: "STUB-1",
    body: "done",
  });
  assert.deepEqual(result, { success: true, result: { ok: true } });
  assert.deepEqual(calls, [["STUB-1", "done"]]);
});

test("tracker_query passes natively projected rows through unchanged", async () => {
  const payload = {
    rows: [{ id: "STUB-1", custom: "kept" }],
    total: 7,
    skipped: [{ id: "STUB-9" }],
  };
  const { pack, settings } = packFor("stub", { queryRows: async () => payload });

  const result = await execute(pack, settings, "tracker_query", { select: ["id"] });
  assert.equal(result.success, true);
  assert.deepEqual(result.result, payload);
});

test("tracker_query projects whole issues with select, filter, order, and paging", async () => {
  const issues = [
    issue(),
    issue({
      id: "id-2",
      identifier: "STUB-2",
      title: "Second",
      state: "Done",
      stateType: "completed",
    }),
    issue({ id: "id-3", identifier: "STUB-3", title: "Third" }),
  ];
  const { pack, settings } = packFor("stub", { queryIssues: async () => issues });

  const projected = await execute(pack, settings, "tracker_query", {
    where: { field: "state", op: "eq", value: "Todo" },
    select: ["identifier", "title"],
    order_by: [{ field: "title", dir: "desc" }],
  });
  assert.deepEqual(projected.result, {
    rows: [
      { identifier: "STUB-3", title: "Third" },
      { identifier: "STUB-1", title: "First" },
    ],
    total: 2,
  });

  // The default projection keeps the shared issue summary fields.
  const defaulted = await execute(pack, settings, "tracker_query", {
    where: { field: "identifier", op: "eq", value: "STUB-2" },
  });
  assert.deepEqual(defaulted.result, {
    rows: [
      {
        id: "id-2",
        identifier: "STUB-2",
        title: "Second",
        state: "Done",
        stateType: "completed",
        labels: [],
        url: "https://tracker.example/STUB-1",
      },
    ],
    total: 1,
  });
});

test("tracker tool failures surface as failed results, not thrown errors", async () => {
  const { pack, settings } = packFor("stub", {
    readIssue: async () => {
      throw new Error("backend exploded");
    },
  });
  const result = await execute(pack, settings, "tracker_read_issue", { issueId: "STUB-1" });
  assert.deepEqual(result, {
    success: false,
    error: "backend exploded",
    result: { error: { message: "backend exploded" } },
  });
});
