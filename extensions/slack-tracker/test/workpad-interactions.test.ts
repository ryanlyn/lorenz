import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { parseSlackConfig } from "./helpers.js";

import {
  executeSlackTool,
  handleSlackInteraction,
  InMemorySlackTransport,
  renderWorkpadBlocks,
  SlackApiError,
  SlackTrackerClient,
  SlackWebTransport,
  stateFromThread,
  stripBroadcastMentions,
  STATUS_METADATA_EVENT,
  upsertWorkpad,
  WORKPAD_METADATA_EVENT,
  type SlackMessage,
} from "@lorenz/slack-tracker";

function settings() {
  return parseSlackConfig(
    {
      tracker: {
        kind: "slack",
        channels: ["C1"],
        bot_user_id: "U_BOT",
        active_states: ["Todo", "In Progress"],
        terminal_states: ["Done", "Cancelled"],
      },
    },
    { SLACK_BOT_TOKEN: "xoxb" },
  );
}

const silentLogger = { warn: () => {} };

// ------------------------------------------------------------------ sanitize

test("broadcast tokens are rewritten to inert text; user mentions survive", () => {
  assert.equal(
    stripBroadcastMentions("hey <!channel> and <!here|@here> and <!everyone>, ping <@U123>"),
    "hey @channel and @here and @everyone, ping <@U123>",
  );
  assert.equal(
    stripBroadcastMentions("cc <!subteam^S042ABC|@eng> and <!subteam^S042DEF>"),
    "cc @group and @group",
  );
  assert.equal(stripBroadcastMentions("<!subteam^S0|<!>channel>"), "@groupchannel>");
});

test("postReply sanitizes agent-authored bodies unconditionally", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.0", text: "<@U_BOT> do it", user: "U2" }] },
    { botUserId: "U_BOT" },
  );
  await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.0", body: "done, telling <!channel> about it" },
    settings(),
    transport,
  );
  assert.equal(transport.replies[0]!.body, "done, telling @channel about it");
});

test("workpad blocks and metadata sanitize broadcast tokens", () => {
  const rendered = renderWorkpadBlocks(
    {
      issueId: "C1:1.0",
      plan: "- [ ] tell <!channel> and <!subteam^S123|@eng>",
      note: "waiting on <!here>",
    },
    settings(),
  );
  const serialized = JSON.stringify(rendered);
  assert.ok(!serialized.includes("<!"));
  assert.ok(serialized.includes("@channel"));
  assert.ok(serialized.includes("@group"));
  assert.ok(serialized.includes("@here"));
  assert.ok(!serialized.includes("lorenz_cancel"));
});

test("workpad actions render only when Socket Mode can deliver interactions", () => {
  const withSocket = parseSlackConfig(
    {
      tracker: {
        kind: "slack",
        channels: ["C1"],
        bot_user_id: "U_BOT",
        app_token: "xapp-test",
      },
    },
    { SLACK_BOT_TOKEN: "xoxb" },
  );

  const rendered = renderWorkpadBlocks({ issueId: "C1:1.0" }, withSocket);

  assert.ok(JSON.stringify(rendered.blocks).includes("lorenz_cancel"));
});

// ------------------------------------------------------------------ fold: metadata + asides

test("the fold prefers status metadata over text, so attributions can ride along", () => {
  const root: SlackMessage = {
    channel: "C1",
    ts: "1.0",
    text: "<@U_BOT> fix it",
    reactions: [],
    botReactions: [],
    user: "U2",
  };
  const replies = [
    {
      ts: "1.5",
      // The multi-line body is not a text-only status line; metadata carries the state.
      text: "status: Cancelled\n(requested by <@U9> via the workpad Cancel button)",
      user: "U_BOT",
      metadata: {
        eventType: STATUS_METADATA_EVENT,
        payload: { issue: "C1:1.0", state: "Cancelled", seq: "s1" },
      },
    },
  ];
  const thread = stateFromThread(root, replies, settings());
  assert.equal(thread.state, "Cancelled");
  assert.deepEqual(thread.events, [{ ts: "1.5", state: "Cancelled", actor: "U_BOT" }]);
});

test("a workpad reply is recognized by metadata and never folds as a status event", () => {
  const root: SlackMessage = {
    channel: "C1",
    ts: "1.0",
    text: "<@U_BOT> fix it",
    reactions: [],
    botReactions: [],
    user: "U2",
  };
  const replies = [
    {
      ts: "1.2",
      text: "Lorenz workpad",
      user: "U_BOT",
      metadata: {
        eventType: WORKPAD_METADATA_EVENT,
        payload: { issue: "C1:1.0", seq: "w1", plan: "- [ ] step", note: "starting" },
      },
    },
  ];
  const thread = stateFromThread(root, replies, settings());
  // Workpad metadata is display-only and never creates a status event.
  assert.equal(thread.state, "Todo");
  assert.deepEqual(thread.workpad, { ts: "1.2", plan: "- [ ] step", note: "starting" });
});

test("asides never transition and never re-open a terminal issue", () => {
  const root: SlackMessage = {
    channel: "C1",
    ts: "1.0",
    text: "<@U_BOT> fix it",
    reactions: [],
    botReactions: [],
    user: "U2",
  };
  const replies = [
    { ts: "1.1", text: "status: Done", user: "U_BOT" },
    // A terminal issue plus a trailing bare mention would normally re-open; the aside marker
    // opts this reply out of the fold entirely.
    { ts: "1.2", text: "<@U_BOT> !aside fyi we shipped this in v2", user: "U3" },
  ];
  assert.equal(stateFromThread(root, replies, settings()).state, "Done");
});

// ------------------------------------------------------------------ slack_workpad tool

test("slack_workpad creates one message, then partial updates preserve the other section", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.0", text: "<@U_BOT> do it", user: "U2" }] },
    { botUserId: "U_BOT" },
  );
  const s = settings();

  const created = await executeSlackTool(
    "slack_workpad",
    { issueId: "C1:1.0", plan: "- [ ] reproduce\n- [ ] fix" },
    s,
    transport,
  );
  assert.equal(created.success, true);
  const createdTs = (created.result as { workpadTs: string }).workpadTs;

  const updated = await executeSlackTool(
    "slack_workpad",
    { issueId: "C1:1.0", note: "tests running" },
    s,
    transport,
  );
  assert.equal(updated.success, true);
  // Same message edited in place, not a second workpad.
  assert.equal((updated.result as { workpadTs: string }).workpadTs, createdTs);

  const replies = await transport.getThread("C1", "1.0");
  const workpads = replies.filter((r) => r.metadata?.eventType === WORKPAD_METADATA_EVENT);
  assert.equal(workpads.length, 1);
  assert.equal(workpads[0]!.metadata!.payload.plan, "- [ ] reproduce\n- [ ] fix");
  assert.equal(workpads[0]!.metadata!.payload.note, "tests running");
  assert.ok(transport.replies[0]!.body.includes("- [ ] reproduce"));
});

test("the workpad fallback carries plan and note text", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.0", text: "<@U_BOT> do it", user: "U2" }] },
    { botUserId: "U_BOT" },
  );

  await upsertWorkpad(
    settings(),
    transport,
    "C1",
    "1.0",
    {
      issueId: "C1:1.0",
      plan: "- [ ] verify accessibility",
      note: "reviewing",
    },
    undefined,
  );

  assert.equal(
    transport.replies[0]!.body,
    "Lorenz workpad\n\n- [ ] verify accessibility\n\nreviewing",
  );
});

test("the workpad shares one bounded budget across plan, note, fallback, and metadata", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.0", text: "<@U_BOT> do it", user: "U2" }] },
    { botUserId: "U_BOT" },
  );

  await upsertWorkpad(
    settings(),
    transport,
    "C1",
    "1.0",
    {
      issueId: "C1:1.0",
      plan: "p".repeat(2_000),
      note: "n".repeat(2_000),
    },
    undefined,
  );

  const reply = (await transport.getThread("C1", "1.0"))[0]!;
  const plan = reply.metadata!.payload.plan as string;
  const note = reply.metadata!.payload.note as string;
  assert.equal(plan.length + note.length, 2_800);
  assert.ok(note.endsWith("… (clipped)"));
  assert.ok(transport.replies[0]!.body.length < 4_000);
});

test("concurrent partial workpad updates serialize into one merged message", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.0", text: "<@U_BOT> do it", user: "U2" }] },
    { botUserId: "U_BOT" },
  );
  const originalPostReply = transport.postReply.bind(transport);
  let reportPostStarted!: () => void;
  let releasePost!: () => void;
  const postStarted = new Promise<void>((resolve) => {
    reportPostStarted = resolve;
  });
  const postGate = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  transport.postReply = async (...args) => {
    reportPostStarted();
    await postGate;
    return originalPostReply(...args);
  };
  const s = settings();

  const planUpdate = executeSlackTool(
    "slack_workpad",
    { issueId: "C1:1.0", plan: "- [ ] reproduce" },
    s,
    transport,
  );
  await postStarted;
  const noteUpdate = executeSlackTool(
    "slack_workpad",
    { issueId: "C1:1.0", note: "investigating" },
    s,
    transport,
  );
  releasePost();
  const [planResult, noteResult] = await Promise.all([planUpdate, noteUpdate]);

  assert.equal(planResult.success, true);
  assert.equal(noteResult.success, true);
  const replies = await transport.getThread("C1", "1.0");
  const workpads = replies.filter((reply) => reply.metadata?.eventType === WORKPAD_METADATA_EVENT);
  assert.equal(workpads.length, 1);
  assert.equal(workpads[0]!.metadata!.payload.plan, "- [ ] reproduce");
  assert.equal(workpads[0]!.metadata!.payload.note, "investigating");
});

test("a transient workpad update failure propagates without posting a duplicate", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.0", text: "<@U_BOT> do it", user: "U2" }] },
    { botUserId: "U_BOT" },
  );
  transport.updateMessage = async () => {
    throw new Error("temporary failure");
  };

  await assert.rejects(
    () =>
      upsertWorkpad(
        settings(),
        transport,
        "C1",
        "1.0",
        { issueId: "C1:1.0", plan: "- [ ] keep this" },
        { ts: "1.5", plan: "- [ ] keep this" },
      ),
    /temporary failure/,
  );
  assert.equal(transport.replies.length, 0);
});

test("a definitive missing-message error reposts the workpad", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.0", text: "<@U_BOT> do it", user: "U2" }] },
    { botUserId: "U_BOT" },
  );
  transport.updateMessage = async () => {
    throw new SlackApiError("chat.update", "message_not_found");
  };

  const ts = await upsertWorkpad(
    settings(),
    transport,
    "C1",
    "1.0",
    { issueId: "C1:1.0", plan: "- [ ] keep this" },
    { ts: "1.5", plan: "- [ ] keep this" },
  );

  assert.ok(ts !== "1.5");
  assert.equal(transport.replies.length, 1);
});

// ------------------------------------------------------------------ interactions

test("the Cancel button posts an attributed authoritative status reply and nudges", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.0", text: "<@U_BOT> do it", user: "U2" }] },
    { botUserId: "U_BOT" },
  );
  let nudges = 0;
  await handleSlackInteraction(
    {
      type: "block_actions",
      user: { id: "U9" },
      actions: [{ action_id: "lorenz_cancel", value: "C1:1.0" }],
    },
    { settings: settings(), transport, logger: silentLogger, nudge: () => (nudges += 1) },
  );
  assert.equal(nudges, 1);
  const replies = await transport.getThread("C1", "1.0");
  const status = replies.find((r) => r.metadata?.eventType === STATUS_METADATA_EVENT);
  assert.ok(status !== undefined);
  assert.equal(status!.metadata!.payload.state, "Cancelled");
  assert.equal(status!.metadata!.payload.actor, "U9");
  assert.ok(status!.text.includes("<@U9>"));
  // And the fold agrees: the button IS the `!cancel` path.
  const root = (await transport.getMessage("C1", "1.0"))!;
  const folded = stateFromThread(root, replies, settings());
  assert.equal(folded.state, "Cancelled");
  assert.equal(folded.events.at(-1)?.actor, "U9");
});

test("the Cancel button nudges after the status post without waiting for a root read", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.0", text: "<@U_BOT> do it", user: "U2" }] },
    { botUserId: "U_BOT" },
  );
  const getMessage = transport.getMessage.bind(transport);
  let reportReadStarted!: () => void;
  let releaseRead!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    reportReadStarted = resolve;
  });
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  transport.getMessage = async (channel, ts) => {
    assert.equal(nudges, 1);
    reportReadStarted();
    await readGate;
    return getMessage(channel, ts);
  };
  let nudges = 0;

  await handleSlackInteraction(
    {
      type: "block_actions",
      user: { id: "U9" },
      actions: [{ action_id: "lorenz_cancel", value: "C1:1.0" }],
    },
    { settings: settings(), transport, logger: silentLogger, nudge: () => (nudges += 1) },
  );

  await readStarted;
  assert.equal(nudges, 1);
  assert.equal(transport.replies.length, 1);
  releaseRead();
});

test("the Cancel button reports a failed status write to the clicker", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.0", text: "<@U_BOT> do it", user: "U2" }] },
    { botUserId: "U_BOT" },
  );
  transport.postReply = async () => {
    throw new Error("status write unavailable");
  };

  await handleSlackInteraction(
    {
      type: "block_actions",
      user: { id: "U9" },
      actions: [{ action_id: "lorenz_cancel", value: "C1:1.0" }],
    },
    { settings: settings(), transport, logger: silentLogger },
  );

  assert.equal(transport.ephemerals.length, 1);
  assert.equal(transport.ephemerals[0]!.user, "U9");
  assert.ok(transport.ephemerals[0]!.body.includes("status write unavailable"));
});

test("the Details button opens the session modal; refresh re-renders in place", async () => {
  const transport = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: "1.0",
          text: "<@U_BOT> do it",
          user: "U2",
          replies: [{ ts: "1.5", text: "status: In Progress", user: "U_BOT" }],
        },
      ],
    },
    { botUserId: "U_BOT" },
  );
  const context = { settings: settings(), transport, logger: silentLogger };
  await handleSlackInteraction(
    {
      type: "block_actions",
      trigger_id: "trig-1",
      user: { id: "U9" },
      actions: [{ action_id: "lorenz_details", value: "C1:1.0" }],
    },
    context,
  );
  assert.equal(transport.openedViews.length, 1);
  assert.equal(transport.openedViews[0]!.triggerId, "trig-1");
  assert.ok(JSON.stringify(transport.openedViews[0]!.view).includes("Loading session details"));
  assert.equal(transport.updatedViews.length, 1);
  assert.equal(transport.updatedViews[0]!.viewId, "V_OPEN_1");
  const rendered = JSON.stringify(transport.updatedViews[0]!.view.blocks);
  assert.ok(rendered.includes("In Progress"));
  assert.ok(rendered.includes("C1:1.0"));

  await handleSlackInteraction(
    {
      type: "block_actions",
      view: { id: "V123" },
      user: { id: "U9" },
      actions: [{ action_id: "lorenz_modal_refresh", value: "C1:1.0" }],
    },
    context,
  );
  assert.equal(transport.updatedViews.length, 2);
  assert.equal(transport.updatedViews[1]!.viewId, "V123");
});

// ------------------------------------------------------------------ steering feed

test("fetchIssueEvents returns human context only, ascending, above the watermark", async () => {
  const transport = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: "1.0",
          text: "<@U_BOT> do it",
          user: "U2",
          replies: [
            { ts: "1.1", text: "old context", user: "U2" },
            { ts: "1.2", text: "status: In Progress", user: "U_BOT" },
            { ts: "1.3", text: "<@U_BOT> !done", user: "U2" },
            { ts: "1.4", text: "!aside internal chatter", user: "U3" },
            { ts: "1.5", text: "also handle the edge case", user: "U3" },
          ],
        },
      ],
    },
    { botUserId: "U_BOT" },
  );
  const client = new SlackTrackerClient(settings(), transport);
  const page = await client.fetchIssueEvents("C1:1.0", "1.1", {
    maxEvents: 10,
    maxBytes: 64 * 1024,
  });
  // Bot replies, `!` commands (they act through the fold), and asides are all excluded.
  assert.deepEqual(page, {
    events: [
      {
        authorizedForSteering: true,
        ts: "1.5",
        text: "also handle the edge case",
        author: "U3",
      },
    ],
    hasMore: false,
  });
});

// ------------------------------------------------------------------ send reconciliation

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("an ambiguous status post reconciles by its metadata marker instead of failing", async () => {
  const calls: string[] = [];
  let posted = false;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("chat.postMessage")) {
      const body = JSON.parse(String(init?.body)) as {
        metadata?: { event_payload?: { seq?: string } };
      };
      posted = true;
      // Slack processed the post... but the response is lost: a gateway 502.
      void body;
      return jsonResponse({ ok: false }, 502);
    }
    if (u.includes("conversations.replies")) {
      // The reconcile scan finds the marker: the "failed" post actually landed.
      return jsonResponse({
        ok: true,
        messages: [
          { ts: "1.0", text: "<@U1> root" },
          {
            ts: "1.9",
            text: "status: Done",
            user: "U1",
            metadata: {
              event_type: STATUS_METADATA_EVENT,
              event_payload: { issue: "C1:1.0", state: "Done", seq: "seq-fixed" },
            },
          },
        ],
      });
    }
    return jsonResponse({ ok: true, messages: [] });
  }) as typeof fetch;

  const transport = new SlackWebTransport(
    parseSlackConfig(
      { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
      { SLACK_BOT_TOKEN: "xoxb" },
    ),
    fetchImpl,
    () => Promise.resolve(),
    silentLogger,
  );
  const ts = await transport.postReply("C1", "1.0", "status: Done", {
    metadata: {
      eventType: STATUS_METADATA_EVENT,
      payload: { issue: "C1:1.0", state: "Done", seq: "seq-fixed" },
    },
  });
  assert.equal(ts, "1.9");
  assert.ok(posted);
  // Exactly one post attempt: reconciliation proved delivery, so no duplicate was sent.
  assert.equal(calls.filter((u) => u.includes("chat.postMessage")).length, 1);
});

test("when the marker is absent the post provably failed and is safely retried", async () => {
  let postAttempts = 0;
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("chat.postMessage")) {
      postAttempts += 1;
      if (postAttempts === 1) return jsonResponse({ ok: false }, 503);
      return jsonResponse({ ok: true, ts: "2.5" });
    }
    if (u.includes("conversations.replies")) {
      return jsonResponse({ ok: true, messages: [{ ts: "1.0", text: "root" }] });
    }
    return jsonResponse({ ok: true, messages: [] });
  }) as typeof fetch;

  const transport = new SlackWebTransport(
    parseSlackConfig(
      { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
      { SLACK_BOT_TOKEN: "xoxb" },
    ),
    fetchImpl,
    () => Promise.resolve(),
    silentLogger,
  );
  const ts = await transport.postReply("C1", "1.0", "status: Done", {
    metadata: {
      eventType: STATUS_METADATA_EVENT,
      payload: { issue: "C1:1.0", state: "Done", seq: "seq-2" },
    },
  });
  assert.equal(ts, "2.5");
  assert.equal(postAttempts, 2);
});

test("the final ambiguous post attempt is reconciled before failing", async () => {
  let postAttempts = 0;
  let replyReads = 0;
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("chat.postMessage")) {
      postAttempts += 1;
      return jsonResponse({ ok: false }, 503);
    }
    if (u.includes("conversations.replies")) {
      replyReads += 1;
      return jsonResponse({
        ok: true,
        messages:
          postAttempts === 3
            ? [
                { ts: "1.0", text: "root" },
                {
                  ts: "1.9",
                  text: "status: Done",
                  user: "U1",
                  metadata: {
                    event_type: STATUS_METADATA_EVENT,
                    event_payload: { issue: "C1:1.0", state: "Done", seq: "seq-final" },
                  },
                },
              ]
            : [{ ts: "1.0", text: "root" }],
      });
    }
    return jsonResponse({ ok: true, messages: [] });
  }) as typeof fetch;
  const transport = new SlackWebTransport(
    parseSlackConfig(
      { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
      { SLACK_BOT_TOKEN: "xoxb" },
    ),
    fetchImpl,
    () => Promise.resolve(),
    silentLogger,
  );

  const ts = await transport.postReply("C1", "1.0", "status: Done", {
    metadata: {
      eventType: STATUS_METADATA_EVENT,
      payload: { issue: "C1:1.0", state: "Done", seq: "seq-final" },
    },
  });

  assert.equal(ts, "1.9");
  assert.equal(postAttempts, 3);
  assert.equal(replyReads, 3);
});

test("a failed reconciliation read never retries an ambiguous post", async () => {
  let postAttempts = 0;
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("chat.postMessage")) {
      postAttempts += 1;
      return jsonResponse({ ok: false }, 503);
    }
    if (u.includes("conversations.replies")) {
      return jsonResponse({ ok: false }, 503);
    }
    return jsonResponse({ ok: true, messages: [] });
  }) as typeof fetch;

  const transport = new SlackWebTransport(
    parseSlackConfig(
      { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
      { SLACK_BOT_TOKEN: "xoxb" },
    ),
    fetchImpl,
    () => Promise.resolve(),
    silentLogger,
  );

  await assert.rejects(
    () =>
      transport.postReply("C1", "1.0", "status: Done", {
        metadata: {
          eventType: STATUS_METADATA_EVENT,
          payload: { issue: "C1:1.0", state: "Done", seq: "seq-read-failure" },
        },
      }),
    /conversations\.replies/,
  );
  assert.equal(postAttempts, 1);
});

test("a truncated reconciliation scan never retries an ambiguous post", async () => {
  let postAttempts = 0;
  let replyReads = 0;
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("chat.postMessage")) {
      postAttempts += 1;
      return jsonResponse({ ok: false }, 503);
    }
    if (u.includes("conversations.replies")) {
      replyReads += 1;
      return jsonResponse({
        ok: true,
        messages: [{ ts: `1.${replyReads}`, text: "unrelated", user: "U1" }],
        response_metadata: { next_cursor: `page-${replyReads + 1}` },
      });
    }
    return jsonResponse({ ok: true, messages: [] });
  }) as typeof fetch;

  const transport = new SlackWebTransport(
    parseSlackConfig(
      { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
      { SLACK_BOT_TOKEN: "xoxb" },
    ),
    fetchImpl,
    () => Promise.resolve(),
    silentLogger,
    { maxHistoryPages: 2 },
  );

  await assert.rejects(
    () =>
      transport.postReply("C1", "1.0", "status: Done", {
        metadata: {
          eventType: STATUS_METADATA_EVENT,
          payload: { issue: "C1:1.0", state: "Done", seq: "seq-truncated" },
        },
      }),
    /reconciliation.*safety cap/,
  );
  assert.equal(postAttempts, 1);
  assert.equal(replyReads, 2);
});

test("a marker-less post fails loudly on an ambiguous outcome", async () => {
  const fetchImpl = (async (url: string | URL) => {
    if (String(url).includes("chat.postMessage")) return jsonResponse({ ok: false }, 502);
    return jsonResponse({ ok: true, messages: [] });
  }) as typeof fetch;
  const transport = new SlackWebTransport(
    parseSlackConfig(
      { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
      { SLACK_BOT_TOKEN: "xoxb" },
    ),
    fetchImpl,
    () => Promise.resolve(),
    silentLogger,
  );
  let failed = false;
  try {
    await transport.postReply("C1", "1.0", "plain comment");
  } catch {
    failed = true;
  }
  assert.equal(failed, true);
});
