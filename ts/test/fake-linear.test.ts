import path from "node:path";

import { afterAll, beforeAll, describe, test } from "vitest";
import { setupServer } from "msw/node";
import { executeTool, LinearClient, parseConfig } from "@symphony/cli";

import { assert } from "./assert.js";
import { createFakeLinearHandlers } from "./fake-linear-server.js";
import { tempDir } from "./helpers.js";

const fakeViewer = { id: "viewer-001", name: "Fake User", email: "fake@example.com" };
const fakeProject = {
  id: "project-001",
  name: "Fake Project",
  slugId: "fake-project-slug",
  teams: [
    {
      id: "team-001",
      key: "FAKE",
      name: "Fake Team",
      states: [
        { id: "state-todo", name: "Todo", type: "unstarted" },
        { id: "state-progress", name: "In Progress", type: "started" },
        { id: "state-done", name: "Done", type: "completed" },
      ],
    },
  ],
};

const server = setupServer(
  ...createFakeLinearHandlers({ viewer: fakeViewer, project: fakeProject }),
);

describe("fake Linear MSW tests", () => {
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterAll(() => server.close());

  test("viewer, project, create, poll, refresh, update, archive, and tool", async () => {
    const workspace = await tempDir("symphony-ts-fake-linear");
    const settings = parseConfig(
      {
        workspace: { root: path.dirname(workspace) },
        tracker: {
          kind: "linear",
          api_key: "fake-api-key",
          project_slug: fakeProject.slugId,
          active_states: ["Todo"],
          terminal_states: ["Done", "Canceled", "Cancelled", "Duplicate", "Closed"],
          assignee: fakeViewer.id,
        },
      },
      { LINEAR_API_KEY: "fake-api-key" },
    );

    const client = new LinearClient(settings);

    const viewer = await client.viewer();
    assert.equal(viewer.id, fakeViewer.id);
    assert.equal(viewer.name, fakeViewer.name);
    assert.equal(viewer.email, fakeViewer.email);

    const project = await client.projectBySlug();
    assert.equal(project.id, fakeProject.id);
    assert.equal(project.slugId, fakeProject.slugId);
    const team = project.teams.find((t) => t.key === "FAKE");
    assert.ok(team);
    const todo = team!.states.find((s) => s.name === "Todo");
    const done = team!.states.find((s) => s.name === "Done");
    assert.ok(todo);
    assert.ok(done);

    const marker = `FAKE_LINEAR_${Date.now()}`;
    const created = await client.createIssue({
      teamId: team!.id,
      projectId: project.id,
      stateId: todo!.id,
      title: `${marker} fake linear test`,
      description: `Marker: ${marker}`,
      assigneeId: fakeViewer.id,
    });

    assert.equal(created.state, "Todo");
    assert.equal(created.stateType, "unstarted");
    assert.equal(created.assignedToWorker, true);
    assert.equal(created.assigneeId, fakeViewer.id);
    assert.match(created.title, new RegExp(marker));

    const candidates = await client.fetchCandidateIssues();
    const candidate = candidates.find((issue) => issue.id === created.id);
    assert.ok(candidate);
    assert.equal(candidate!.identifier, created.identifier);
    assert.equal(candidate!.assignedToWorker, true);

    const refreshed = await client.fetchIssuesByIds([created.id]);
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0]?.id, created.id);
    assert.equal(refreshed[0]?.stateType, "unstarted");
    assert.deepEqual(await client.fetchIssuesByIds([]), []);

    const duplicateRefresh = await client.fetchIssuesByIds([created.id, created.id]);
    assert.equal(duplicateRefresh.length, 1);
    assert.equal(duplicateRefresh[0]?.id, created.id);

    settings.tracker.assignee = `not-${fakeViewer.id}`;
    const mismatchedClient = new LinearClient(settings);
    const mismatched = await mismatchedClient.fetchIssuesByIds([created.id]);
    assert.equal(mismatched[0]?.assignedToWorker, false);
    settings.tracker.assignee = fakeViewer.id;

    const dynamicToolResult = await executeTool(
      "linear_graphql",
      {
        query: `
          query SymphonyTsIssuesById($ids: [ID!]!, $first: Int!) {
            issues(filter: {id: {in: $ids}}, first: $first) {
              nodes { id identifier title }
            }
          }
        `,
        variables: { ids: [created.id], first: 1 },
      },
      settings,
    );
    assert.deepEqual(
      { success: dynamicToolResult.success, error: dynamicToolResult.error },
      { success: true, error: undefined },
    );
    assert.match(JSON.stringify(dynamicToolResult.result), new RegExp(created.identifier));

    const unsupportedTool = await executeTool("not_a_real_tool", {}, settings);
    assert.equal(unsupportedTool.success, false);
    assert.match(unsupportedTool.error ?? "", /Unsupported tool/);

    const closed = await client.updateIssueState(created.id, done!.id);
    assert.equal(closed.id, created.id);
    assert.equal(closed.state, "Done");
    assert.equal(closed.stateType, "completed");

    const afterClose = await client.fetchIssuesByIds([created.id]);
    assert.equal(afterClose[0]?.state, "Done");
    assert.equal(afterClose[0]?.stateType, "completed");

    const activeAfterClose = await client.fetchCandidateIssues();
    assert.equal(
      activeAfterClose.some((issue) => issue.id === created.id),
      false,
    );

    await client.archiveIssue(created.id);
  });
});
