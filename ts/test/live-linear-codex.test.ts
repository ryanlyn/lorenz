import path from "node:path";

import { test } from "vitest";
import { CodexAppServerExecutor, executeTool, LinearClient, parseConfig } from "@symphony/cli";
import type { AgentUpdate } from "@symphony/cli";

import { assert } from "./assert.js";
import { tempDir } from "./helpers.js";

const runLive = process.env.SYMPHONY_TS_RUN_LINEAR_CODEX_E2E === "1";

test(
  "live Linear plus Codex E2E covers create, poll, refresh, tool call, turn, and cleanup",
  { timeout: 300_000, skip: !runLive },
  async () => {
    assert.ok(process.env.LINEAR_API_KEY, "LINEAR_API_KEY is required for live Linear E2E");

    const marker = `TS_LINEAR_CODEX_E2E_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const workspace = await tempDir("symphony-ts-live-linear-codex");
    const settings = parseConfig(
      {
        workspace: { root: path.dirname(workspace) },
        tracker: {
          kind: "linear",
          api_key: "$LINEAR_API_KEY",
          project_slug: "$LINEAR_PROJECT_SLUG",
          active_states: ["Todo"],
          terminal_states: ["Done", "Canceled", "Cancelled", "Duplicate", "Closed"],
          assignee: "$LINEAR_VIEWER_ID",
        },
        codex: {
          command: process.env.SYMPHONY_TS_CODEX_COMMAND ?? "codex app-server",
          approval_policy: "never",
          turn_timeout_ms: 180_000,
          read_timeout_ms: 30_000,
          turn_sandbox_policy: {
            type: "workspaceWrite",
            writableRoots: [],
            readOnlyAccess: { type: "fullAccess" },
            networkAccess: true,
          },
        },
      },
      {
        ...process.env,
        LINEAR_VIEWER_ID: "placeholder-filled-after-viewer",
      },
    );

    const preflightClient = new LinearClient(settings);
    const viewer = await preflightClient.viewer();
    settings.tracker.assignee = viewer.id;
    const client = new LinearClient(settings);
    const project = await client.projectBySlug();
    const team = project.teams.find((candidate) => candidate.key === "MONO") ?? project.teams[0];
    assert.ok(team, "project must expose a team");
    const todo =
      team.states.find((state) => state.name === "Todo") ??
      team.states.find((state) => state.type === "unstarted");
    const done =
      team.states.find((state) => state.name === "Done") ??
      team.states.find((state) => state.type === "completed");
    assert.ok(todo, "team must expose a Todo/unstarted state");
    assert.ok(done, "team must expose a Done/completed state");

    let issueId: string | null = null;
    let issueIdentifier: string;

    try {
      const created = await client.createIssue({
        teamId: team.id,
        projectId: project.id,
        stateId: todo.id,
        title: `${marker} live TS Linear+Codex E2E`,
        description: [
          "Temporary issue created by the TypeScript Symphony live E2E.",
          `Marker: ${marker}`,
          "The test will close this issue automatically.",
        ].join("\n"),
        assigneeId: viewer.id,
      });
      issueId = created.id;
      issueIdentifier = created.identifier;

      assert.equal(created.state, "Todo");
      assert.equal(created.stateType, "unstarted");
      assert.equal(created.assignedToWorker, true);
      assert.equal(created.assigneeId, viewer.id);
      assert.match(created.description ?? "", new RegExp(marker));

      const candidates = await client.fetchCandidateIssues();
      const candidate = candidates.find((issue) => issue.id === created.id);
      assert.ok(candidate, "freshly created Todo issue should be returned by candidate poll");
      assert.equal(candidate.identifier, created.identifier);
      assert.equal(candidate.assignedToWorker, true);

      const refreshed = await client.fetchIssuesByIds([created.id]);
      assert.equal(refreshed.length, 1);
      assert.equal(refreshed[0]?.id, created.id);
      assert.equal(refreshed[0]?.stateType, "unstarted");
      assert.deepEqual(await client.fetchIssuesByIds([]), []);

      const duplicateRefresh = await client.fetchIssuesByIds([created.id, created.id]);
      assert.equal(duplicateRefresh.length, 1);
      assert.equal(duplicateRefresh[0]?.id, created.id);

      settings.tracker.assignee = `not-${viewer.id}`;
      const mismatchedAssigneeClient = new LinearClient(settings);
      const mismatched = await mismatchedAssigneeClient.fetchIssuesByIds([created.id]);
      assert.equal(mismatched[0]?.assignedToWorker, false);
      settings.tracker.assignee = viewer.id;

      const dynamicToolResult = await executeTool(
        "linear_graphql",
        {
          query: `
            query SymphonyTsLiveTool($ids: [ID!]!) {
              issues(filter: {id: {in: $ids}}, first: 1) {
                nodes {
                  id
                  identifier
                  title
                  description
                  state { name type }
                }
              }
            }
          `,
          variables: { ids: [created.id] },
        },
        settings,
      );
      assert.deepEqual(
        { success: dynamicToolResult.success, error: dynamicToolResult.error },
        { success: true, error: undefined },
      );
      assert.match(JSON.stringify(dynamicToolResult.result), new RegExp(marker));
      assert.match(JSON.stringify(dynamicToolResult.result), new RegExp(created.identifier));

      const unsupportedTool = await executeTool("not_a_real_tool", {}, settings);
      assert.equal(unsupportedTool.success, false);
      assert.match(unsupportedTool.error ?? "", /Unsupported tool/);

      const invalidGraphql = await executeTool(
        "linear_graphql",
        { query: "query SymphonyTsBroken { definitelyNotAField }" },
        settings,
      );
      assert.equal(invalidGraphql.success, false);
      assert.equal(invalidGraphql.error, undefined);
      assert.match(JSON.stringify(invalidGraphql.result), /definitelyNotAField/);

      const executor = new CodexAppServerExecutor();
      const updates: AgentUpdate[] = [];
      const session = await executor.startSession({
        workspace,
        settings,
        issue: created,
        onUpdate: (update) => updates.push(update),
      });

      try {
        const prompt = `
This is a live TypeScript Symphony E2E validation run.

The TypeScript Linear client fetched a real Linear issue and passed it into this real Codex app-server turn.
Reply with exactly:
${marker} ${issueIdentifier}

Do not edit files.
`;

        const turnUpdates = await executor.runTurn(session, prompt, created);
        assert.ok(turnUpdates.some((update) => update.type === "turn_completed"));
        assert.ok(updates.some((update) => update.type === "session_started"));
      } finally {
        await session.stop();
      }

      const closed = await client.updateIssueState(created.id, done.id);
      assert.equal(closed.id, created.id);
      assert.equal(closed.state, done.name);
      assert.equal(closed.stateType, done.type);

      const afterClose = await client.fetchIssuesByIds([created.id]);
      assert.equal(afterClose[0]?.state, done.name);
      assert.equal(afterClose[0]?.stateType, done.type);
      const activeAfterClose = await client.fetchCandidateIssues();
      assert.equal(
        activeAfterClose.some((issue) => issue.id === created.id),
        false,
      );
      await client.archiveIssue(created.id);
      issueId = null;
    } finally {
      if (issueId) {
        await client.updateIssueState(issueId, done.id);
        await client.archiveIssue(issueId);
      }
    }
  },
);
