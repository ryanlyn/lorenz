import { test, vi } from "vitest";
import { settingsForIssueState } from "@lorenz/config";
import { assert } from "@lorenz/test-utils";

import { registerSlackRuntimeTransport } from "../src/toolTransport.js";
import { slackToolProvider } from "../src/tools.js";

import { parseSlackConfig } from "./helpers.js";

import {
  InMemorySlackTransport,
  MirrorBackedSlackTransport,
  SlackTrackerClient,
  stateFromThread,
  TRACKING_METADATA_EVENT,
  WORKPAD_METADATA_EVENT,
  type SlackMessage,
  type SlackTransport,
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

/** Wrap a transport, counting the reads the mirror is supposed to be saving. */
function counting(inner: SlackTransport): SlackTransport & {
  scans: number;
  threadReads: number;
  messageReads: number;
} {
  const wrapper = Object.create(inner) as SlackTransport & {
    scans: number;
    threadReads: number;
    messageReads: number;
  };
  wrapper.scans = 0;
  wrapper.threadReads = 0;
  wrapper.messageReads = 0;
  wrapper.scanChannels = async (channels) => {
    wrapper.scans += 1;
    return inner.scanChannels(channels);
  };
  wrapper.getThread = async (channel, ts) => {
    wrapper.threadReads += 1;
    return inner.getThread(channel, ts);
  };
  wrapper.getMessage = async (channel, ts) => {
    wrapper.messageReads += 1;
    return inner.getMessage(channel, ts);
  };
  return wrapper;
}

function mirrored(inner: SlackTransport, now: () => number = () => 0) {
  const mirror = new MirrorBackedSlackTransport(inner, settings(), {
    reconcileIntervalMs: 60_000,
    now,
    logger: { warn: () => {} },
  });
  mirror.setSocketHealthy(true);
  return mirror;
}

function messageEvent(event: Record<string, unknown>): Record<string, unknown> {
  return { event };
}

const silent = { warn: () => {} };
void silent;

test("mirror serves repeat scans and new events from memory after one bootstrap scan", async () => {
  const inner = counting(
    new InMemorySlackTransport(
      { C1: [{ ts: "1.0", text: "<@U_BOT> fix the build", user: "U2" }] },
      { botUserId: "U_BOT" },
    ),
  );
  const mirror = mirrored(inner);

  const first = await mirror.scanChannels(["C1"]);
  assert.equal(first.mentions.length, 1);
  assert.equal(inner.scans, 1);

  // Fresh mirror: the second scan is a memory read.
  const second = await mirror.scanChannels(["C1"]);
  assert.equal(second.mentions.length, 1);
  assert.equal(inner.scans, 1);

  // A new root mention arrives as an EVENT (never lands in the inner transport at all) and is
  // discovered without any API read - the payload is the data.
  mirror.applyEvent(
    messageEvent({
      type: "message",
      channel: "C1",
      ts: "2.0",
      text: "<@U_BOT> also do X",
      user: "U3",
    }),
  );
  const third = await mirror.scanChannels(["C1"]);
  assert.equal(inner.scans, 1);
  assert.deepEqual(third.mentions.map((m) => m.ts).sort(), ["1.0", "2.0"]);
});

test("an event arriving during reconciliation is applied after the API snapshot", async () => {
  const raw = new InMemorySlackTransport(
    { C1: [{ ts: "1.0", text: "<@U_BOT> bootstrap", user: "U2" }] },
    { botUserId: "U_BOT" },
  );
  const inner = counting(raw);
  const scan = inner.scanChannels.bind(inner);
  let delayScan = false;
  let releaseScan!: () => void;
  let reportScanStarted!: () => void;
  const scanGate = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });
  const scanStarted = new Promise<void>((resolve) => {
    reportScanStarted = resolve;
  });
  inner.scanChannels = async (channels) => {
    const snapshot = await scan(channels);
    if (delayScan) {
      reportScanStarted();
      await scanGate;
    }
    return snapshot;
  };
  let clock = 0;
  const mirror = mirrored(inner, () => clock);
  await mirror.scanChannels(["C1"]);

  clock = 120_000;
  delayScan = true;
  const reconciling = mirror.scanChannels(["C1"]);
  await scanStarted;
  mirror.applyEvent(
    messageEvent({
      type: "message",
      channel: "C1",
      ts: "2.0",
      text: "<@U_BOT> arrived during reconciliation",
      user: "U3",
    }),
  );
  mirror.applyEvent(
    messageEvent({
      type: "message",
      channel: "C1",
      ts: "1.5",
      thread_ts: "1.0",
      text: "<@U_BOT> !cancel",
      user: "U2",
    }),
  );
  let markerSettled = false;
  const markerWrite = mirror.addReaction("C1", "1.0", "robot_face").then(() => {
    markerSettled = true;
  });
  try {
    await vi.waitFor(() => assert.equal(markerSettled, true));
  } finally {
    releaseScan();
  }

  await markerWrite;
  const result = await reconciling;
  assert.deepEqual(
    result.mentions.map((message) => message.ts),
    ["1.0", "2.0"],
  );
  assert.deepEqual(result.mentions[0]!.botReactions, ["robot_face"]);
  assert.equal(result.mentions[0]!.replyCount, 1);
  assert.equal(result.mentions[0]!.latestReply, "1.5");
  assert.equal(
    stateFromThread(result.mentions[0]!, await mirror.getThread("C1", "1.0"), settings()).state,
    "Cancelled",
  );
});

test("an event arriving during a thread read survives snapshot installation", async () => {
  const raw = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: "1.0",
          text: "<@U_BOT> bootstrap",
          user: "U2",
          replies: [{ ts: "1.1", text: "existing", user: "U2" }],
        },
      ],
    },
    { botUserId: "U_BOT" },
  );
  const inner = counting(raw);
  const read = inner.getThread.bind(inner);
  let releaseRead!: () => void;
  let reportReadStarted!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const readStarted = new Promise<void>((resolve) => {
    reportReadStarted = resolve;
  });
  inner.getThread = async (channel, ts) => {
    const snapshot = await read(channel, ts);
    reportReadStarted();
    await readGate;
    return snapshot;
  };
  const mirror = mirrored(inner);
  await mirror.scanChannels(["C1"]);

  const reading = mirror.getThread("C1", "1.0");
  await readStarted;
  mirror.applyEvent(
    messageEvent({
      type: "message",
      channel: "C1",
      ts: "1.2",
      thread_ts: "1.0",
      text: "arrived during the read",
      user: "U3",
    }),
  );
  releaseRead();

  const replies = await reading;
  assert.deepEqual(
    replies.map((reply) => reply.ts),
    ["1.1", "1.2"],
  );
});

test("an event-built thread folds without a conversations.replies read", async () => {
  const inner = counting(
    new InMemorySlackTransport(
      { C1: [{ ts: "1.0", text: "<@U_BOT> fix the build", user: "U2" }] },
      { botUserId: "U_BOT" },
    ),
  );
  const mirror = mirrored(inner);
  await mirror.scanChannels(["C1"]);

  mirror.applyEvent(
    messageEvent({
      type: "message",
      channel: "C1",
      ts: "1.5",
      thread_ts: "1.0",
      text: "<@U_BOT> !in progress",
      user: "U2",
    }),
  );
  const replies = await mirror.getThread("C1", "1.0");
  assert.equal(inner.threadReads, 0);
  assert.equal(replies.length, 1);

  const scan = await mirror.scanChannels(["C1"]);
  const root = scan.mentions.find((m) => m.ts === "1.0") as SlackMessage;
  assert.equal(root.replyCount, 1);
  assert.equal(root.latestReply, "1.5");
  assert.equal(stateFromThread(root, replies, settings()).state, "In Progress");
});

test("first-seen wins: an edited command does not rewrite the fold, and a notice posts once", async () => {
  const raw = new InMemorySlackTransport(
    { C1: [{ ts: "1.0", text: "<@U_BOT> fix the build", user: "U2" }] },
    { botUserId: "U_BOT" },
  );
  const inner = counting(raw);
  const mirror = mirrored(inner);
  await mirror.scanChannels(["C1"]);

  mirror.applyEvent(
    messageEvent({
      type: "message",
      channel: "C1",
      ts: "1.5",
      thread_ts: "1.0",
      text: "<@U_BOT> !done",
      user: "U2",
    }),
  );
  // The author edits the folded command afterwards - twice, to prove the notice fires once.
  for (const edited of ["<@U_BOT> !cancel", "<@U_BOT> !cancel now please"]) {
    mirror.applyEvent(
      messageEvent({
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        message: { ts: "1.5", text: edited, user: "U2" },
      }),
    );
  }

  const replies = await mirror.getThread("C1", "1.0");
  assert.equal(replies[0]!.firstSeenText, "<@U_BOT> !done");
  assert.equal(replies[0]!.text, "<@U_BOT> !cancel now please");
  const scan = await mirror.scanChannels(["C1"]);
  const root = scan.mentions.find((m) => m.ts === "1.0") as SlackMessage;
  assert.equal(stateFromThread(root, replies, settings()).state, "Done");
  // Exactly one in-thread notice about the ignored edit.
  assert.equal(raw.replies.filter((r) => r.body.includes("edited `!` command")).length, 1);
});

test("message_changed refreshes reply metadata even when fallback text is unchanged", async () => {
  const mirror = mirrored(
    counting(
      new InMemorySlackTransport(
        { C1: [{ ts: "1.0", text: "<@U_BOT> fix the build", user: "U2" }] },
        { botUserId: "U_BOT" },
      ),
    ),
  );
  await mirror.scanChannels(["C1"]);
  mirror.applyEvent(
    messageEvent({
      type: "message",
      channel: "C1",
      ts: "1.5",
      thread_ts: "1.0",
      text: "Lorenz workpad",
      user: "U_BOT",
      metadata: {
        event_type: WORKPAD_METADATA_EVENT,
        event_payload: { plan: "old" },
      },
    }),
  );
  mirror.applyEvent(
    messageEvent({
      type: "message",
      subtype: "message_changed",
      channel: "C1",
      message: {
        ts: "1.5",
        text: "Lorenz workpad",
        user: "U_BOT",
        metadata: {
          event_type: WORKPAD_METADATA_EVENT,
          event_payload: { plan: "new" },
        },
      },
    }),
  );

  const replies = await mirror.getThread("C1", "1.0");
  assert.equal(replies[0]!.metadata?.payload.plan, "new");
});

test("a deleted command is tombstoned: the fold stays stable until reconciliation", async () => {
  const inner = counting(
    new InMemorySlackTransport(
      { C1: [{ ts: "1.0", text: "<@U_BOT> fix the build", user: "U2" }] },
      { botUserId: "U_BOT" },
    ),
  );
  let clock = 0;
  const mirror = mirrored(inner, () => clock);
  await mirror.scanChannels(["C1"]);

  mirror.applyEvent(
    messageEvent({
      type: "message",
      channel: "C1",
      ts: "1.5",
      thread_ts: "1.0",
      text: "<@U_BOT> !done",
      user: "U2",
    }),
  );
  mirror.applyEvent(
    messageEvent({
      type: "message",
      subtype: "message_deleted",
      channel: "C1",
      deleted_ts: "1.5",
    }),
  );

  let replies = await mirror.getThread("C1", "1.0");
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.deleted, true);
  let scan = await mirror.scanChannels(["C1"]);
  let root = scan.mentions.find((m) => m.ts === "1.0") as SlackMessage;
  assert.equal(stateFromThread(root, replies, settings()).state, "Done");

  // Reconciliation (interval elapsed -> real scan) is where the deletion takes effect: the
  // substrate never had the reply, so the tombstone drops and the fold re-derives.
  clock = 120_000;
  scan = await mirror.scanChannels(["C1"]);
  assert.equal(inner.scans, 2);
  root = scan.mentions.find((m) => m.ts === "1.0") as SlackMessage;
  replies = await mirror.getThread("C1", "1.0");
  assert.equal(replies.length, 0);
  assert.equal(stateFromThread(root, replies, settings()).state, "Todo");
});

test("markAllDirty and an unhealthy socket both force real scans", async () => {
  const inner = counting(
    new InMemorySlackTransport(
      { C1: [{ ts: "1.0", text: "<@U_BOT> fix the build", user: "U2" }] },
      { botUserId: "U_BOT" },
    ),
  );
  const mirror = mirrored(inner);
  await mirror.scanChannels(["C1"]);
  assert.equal(inner.scans, 1);

  mirror.markAllDirty("socket reconnected");
  await mirror.scanChannels(["C1"]);
  assert.equal(inner.scans, 2);

  // Healthy again and freshly synced: memory.
  await mirror.scanChannels(["C1"]);
  assert.equal(inner.scans, 2);

  // A disconnected socket means events may be missing, so the mirror must not serve.
  mirror.setSocketHealthy(false);
  await mirror.scanChannels(["C1"]);
  assert.equal(inner.scans, 3);
});

test("reconnect invalidation survives an in-flight history snapshot", async () => {
  const raw = new InMemorySlackTransport(
    { C1: [{ ts: "1.0", text: "<@U_BOT> fix the build", user: "U2" }] },
    { botUserId: "U_BOT" },
  );
  const inner = counting(raw);
  const scan = inner.scanChannels.bind(inner);
  let delayScan = false;
  let releaseScan!: () => void;
  let reportScanStarted!: () => void;
  const scanGate = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });
  const scanStarted = new Promise<void>((resolve) => {
    reportScanStarted = resolve;
  });
  inner.scanChannels = async (channels) => {
    const snapshot = await scan(channels);
    if (delayScan) {
      reportScanStarted();
      await scanGate;
    }
    return snapshot;
  };
  let clock = 0;
  const mirror = mirrored(inner, () => clock);
  await mirror.scanChannels(["C1"]);

  clock = 120_000;
  delayScan = true;
  const reconciling = mirror.scanChannels(["C1"]);
  await scanStarted;
  mirror.markAllDirty("socket reconnected during snapshot");
  releaseScan();
  await reconciling;
  assert.equal(inner.scans, 2);

  await mirror.scanChannels(["C1"]);
  assert.equal(inner.scans, 3);
});

test("reaction events maintain the bot marker on threaded roots", async () => {
  const inner = counting(
    new InMemorySlackTransport(
      {
        C1: [
          {
            ts: "1.0",
            text: "no mention here",
            user: "U2",
            replies: [{ ts: "1.5", text: "<@U_BOT> please take this", user: "U2" }],
          },
        ],
      },
      { botUserId: "U_BOT" },
    ),
  );
  const mirror = mirrored(inner);
  const before = await mirror.scanChannels(["C1"]);
  assert.equal(before.threadedRoots[0]!.botReactions.length, 0);

  mirror.applyEvent(
    messageEvent({
      type: "reaction_added",
      user: "U_BOT",
      reaction: "robot_face",
      item: { channel: "C1", ts: "1.0" },
    }),
  );
  const after = await mirror.scanChannels(["C1"]);
  assert.deepEqual(after.threadedRoots[0]!.botReactions, ["robot_face"]);

  // A HUMAN reaction updates the display list only, never the bot set.
  mirror.applyEvent(
    messageEvent({
      type: "reaction_added",
      user: "U9",
      reaction: "white_check_mark",
      item: { channel: "C1", ts: "1.0" },
    }),
  );
  const display = await mirror.scanChannels(["C1"]);
  assert.deepEqual(display.threadedRoots[0]!.botReactions, ["robot_face"]);
  assert.ok(display.threadedRoots[0]!.reactions.includes("white_check_mark"));
});

test("a reply into an unknown root fetches the root instead of dirtying the channel", async () => {
  // Root 5.0 exists upstream but is invisible to the bootstrap scan's tracked view (no mention,
  // no thread yet - the in-memory scan still lists it as a plain message, but a threadless
  // non-mention never reaches the mirror's roots as a candidate). Its first reply-mention
  // arrives as an event; the mirror point-fetches the root rather than re-scanning.
  const inner = counting(
    new InMemorySlackTransport(
      {
        C1: [
          { ts: "1.0", text: "<@U_BOT> tracked", user: "U2" },
          { ts: "5.0", text: "plain root", user: "U3" },
        ],
      },
      { botUserId: "U_BOT" },
    ),
  );
  const mirror = mirrored(inner);
  await mirror.scanChannels(["C1"]);

  mirror.applyEvent(
    messageEvent({
      type: "message",
      channel: "C1",
      ts: "5.5",
      thread_ts: "5.0",
      text: "<@U_BOT> take this thread",
      user: "U3",
    }),
  );
  const scan = await mirror.scanChannels(["C1"]);
  assert.equal(inner.scans, 1); // still served from memory: the root was point-fetched
  const threaded = scan.threadedRoots.find((m) => m.ts === "5.0");
  assert.ok(threaded !== undefined);
  assert.equal(threaded!.replyCount, 1);
  assert.equal(inner.messageReads, 1);
});

test("an irrelevant reply into an unknown root performs no serialized point read", async () => {
  const inner = counting(
    new InMemorySlackTransport(
      {
        C1: [
          { ts: "1.0", text: "<@U_BOT> tracked", user: "U2" },
          { ts: "5.0", text: "plain root", user: "U3" },
        ],
      },
      { botUserId: "U_BOT" },
    ),
  );
  const mirror = mirrored(inner);
  await mirror.scanChannels(["C1"]);

  mirror.applyEvent(
    messageEvent({
      type: "message",
      channel: "C1",
      ts: "5.5",
      thread_ts: "5.0",
      text: "ordinary thread discussion",
      user: "U3",
    }),
  );
  const scan = await mirror.scanChannels(["C1"]);

  assert.equal(inner.messageReads, 0);
  assert.equal(inner.scans, 1);
  assert.equal(
    scan.threadedRoots.some((message) => message.ts === "5.0"),
    false,
  );
});

test("an unrelated bot reply into an unknown root performs no serialized point read", async () => {
  const inner = counting(
    new InMemorySlackTransport(
      {
        C1: [
          { ts: "1.0", text: "<@U_BOT> tracked", user: "U2" },
          { ts: "5.0", text: "plain root", user: "U3" },
        ],
      },
      { botUserId: "U_BOT" },
    ),
  );
  const mirror = mirrored(inner);
  await mirror.scanChannels(["C1"]);

  mirror.applyEvent(
    messageEvent({
      type: "message",
      subtype: "bot_message",
      bot_id: "B_OTHER",
      user: "U_OTHER_BOT",
      channel: "C1",
      ts: "5.5",
      thread_ts: "5.0",
      text: "unrelated automation",
    }),
  );
  await mirror.scanChannels(["C1"]);

  assert.equal(inner.messageReads, 0);
  assert.equal(inner.scans, 1);
});

test("standing reconciliation refetches threads whose replies may have been edited", async () => {
  const raw = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: "1.0",
          text: "<@U_BOT> tracked",
          user: "U2",
          replies: [
            {
              ts: "1.5",
              text: "Lorenz workpad",
              user: "U_BOT",
              metadata: {
                eventType: WORKPAD_METADATA_EVENT,
                payload: { issue: "C1:1.0", plan: "- [ ] old" },
              },
            },
          ],
        },
      ],
    },
    { botUserId: "U_BOT" },
  );
  const inner = counting(raw);
  let clock = 0;
  const mirror = mirrored(inner, () => clock);
  await mirror.scanChannels(["C1"]);
  const initial = await mirror.getThread("C1", "1.0");
  assert.equal(initial[0]!.metadata!.payload.plan, "- [ ] old");

  await raw.updateMessage("C1", "1.5", "Lorenz workpad", {
    metadata: {
      eventType: WORKPAD_METADATA_EVENT,
      payload: { issue: "C1:1.0", plan: "- [x] repaired" },
    },
  });
  clock = 60_001;
  await mirror.scanChannels(["C1"]);
  const repaired = await mirror.getThread("C1", "1.0");

  assert.equal(inner.threadReads, 2);
  assert.equal(repaired[0]!.metadata!.payload.plan, "- [x] repaired");
});

test("editing an unmirrored root to mention the bot makes it immediately discoverable", async () => {
  const raw = new InMemorySlackTransport(
    { C1: [{ ts: "5.0", text: "plain root", user: "U3" }] },
    { botUserId: "U_BOT" },
  );
  const inner = counting(raw);
  const getMessage = inner.getMessage.bind(inner);
  inner.getMessage = async (channel, ts) => {
    const message = await getMessage(channel, ts);
    return message === null ? null : { ...message, text: "<@U_BOT> edited into a request" };
  };
  const mirror = mirrored(inner);
  const initial = await mirror.scanChannels(["C1"]);
  assert.equal(initial.mentions.length, 0);

  mirror.applyEvent(
    messageEvent({
      type: "message",
      subtype: "message_changed",
      channel: "C1",
      message: { ts: "5.0", text: "<@U_BOT> edited into a request", user: "U3" },
    }),
  );

  const updated = await mirror.scanChannels(["C1"]);
  assert.deepEqual(
    updated.mentions.map((message) => message.ts),
    ["5.0"],
  );
  assert.equal(inner.messageReads, 1);
});

test("an irrelevant edit to an unmirrored root performs no serialized point read", async () => {
  const inner = counting(
    new InMemorySlackTransport(
      {
        C1: [
          { ts: "1.0", text: "<@U_BOT> tracked", user: "U2" },
          { ts: "5.0", text: "plain root", user: "U3" },
        ],
      },
      { botUserId: "U_BOT" },
    ),
  );
  const mirror = mirrored(inner);
  await mirror.scanChannels(["C1"]);

  mirror.applyEvent(
    messageEvent({
      type: "message",
      subtype: "message_changed",
      channel: "C1",
      message: { ts: "5.0", text: "still plain", user: "U3" },
    }),
  );
  const scan = await mirror.scanChannels(["C1"]);

  assert.equal(inner.messageReads, 0);
  assert.equal(inner.scans, 1);
  assert.equal(scan.mentions.length, 1);
  assert.equal(scan.threadedRoots.length, 0);
});

test("editing a root mention away cannot survive on its tracking marker", async () => {
  const raw = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: "1.0",
          text: "<@U_BOT> tracked",
          user: "U2",
          reactions: ["robot_face", "eyes"],
          replies: [{ ts: "1.5", text: "status: In Progress", user: "U_BOT" }],
        },
      ],
    },
    { botUserId: "U_BOT" },
  );
  let clock = 0;
  const mirror = mirrored(raw, () => clock);
  await mirror.scanChannels(["C1"]);
  await raw.updateMessage("C1", "1.0", "mention removed");

  mirror.applyEvent(
    messageEvent({
      type: "message",
      subtype: "message_changed",
      channel: "C1",
      message: { ts: "1.0", text: "mention removed", user: "U2" },
    }),
  );

  let scan = await mirror.scanChannels(["C1"]);
  assert.equal(scan.mentions.length, 0);
  assert.deepEqual(scan.threadedRoots[0]!.botReactions, ["robot_face", "eyes"]);
  const client = new SlackTrackerClient(settings(), mirror);
  assert.deepEqual(await client.fetchIssuesByIds(["C1:1.0"]), []);

  clock = 60_001;
  scan = await mirror.scanChannels(["C1"]);
  assert.deepEqual(scan.threadedRoots[0]!.botReactions, ["robot_face", "eyes"]);
  assert.deepEqual(await client.fetchIssuesByIds(["C1:1.0"]), []);
});

test("delayed root create events cannot undo an edit or resurrect a deletion", async () => {
  const raw = new InMemorySlackTransport(
    { C1: [{ ts: "5.0", text: "<@U_BOT> original request", user: "U3" }] },
    { botUserId: "U_BOT" },
  );
  let clock = 0;
  const mirror = mirrored(raw, () => clock);
  await mirror.scanChannels(["C1"]);

  await raw.updateMessage("C1", "5.0", "mention removed");
  mirror.applyEvent(
    messageEvent({
      type: "message",
      subtype: "message_changed",
      channel: "C1",
      message: { ts: "5.0", text: "mention removed", user: "U3" },
    }),
  );
  mirror.applyEvent(
    messageEvent({
      type: "message",
      channel: "C1",
      ts: "5.0",
      text: "<@U_BOT> original request",
      user: "U3",
    }),
  );
  const edited = await mirror.scanChannels(["C1"]);
  assert.equal(edited.mentions.length, 0);

  clock = 60_001;
  await mirror.scanChannels(["C1"]);
  mirror.applyEvent(
    messageEvent({
      type: "app_mention",
      channel: "C1",
      ts: "5.0",
      text: "<@U_BOT> original request",
      user: "U3",
    }),
  );
  const agedOut = await mirror.scanChannels(["C1"]);
  assert.equal(agedOut.mentions.length, 0);

  mirror.applyEvent(
    messageEvent({
      type: "message",
      subtype: "message_deleted",
      channel: "C1",
      deleted_ts: "5.0",
      previous_message: { ts: "5.0", text: "mention removed", user: "U3" },
    }),
  );
  mirror.applyEvent(
    messageEvent({
      type: "app_mention",
      channel: "C1",
      ts: "5.0",
      text: "<@U_BOT> original request",
      user: "U3",
    }),
  );
  const deleted = await mirror.scanChannels(["C1"]);
  assert.equal(deleted.mentions.length, 0);
  assert.equal(deleted.threadedRoots.length, 0);
});

test("reconciliation does not promote a deleted status event's reaction mirror", async () => {
  const raw = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: "1.0",
          text: "<@U_BOT> tracked",
          user: "U2",
          replies: [
            {
              ts: "1.1",
              text: "Lorenz tracking record.",
              user: "U_BOT",
              metadata: {
                eventType: TRACKING_METADATA_EVENT,
                payload: { origin: "root" },
              },
            },
          ],
        },
      ],
    },
    { botUserId: "U_BOT" },
  );
  await raw.addReaction("C1", "1.0", "white_check_mark");
  await raw.addReaction("C1", "1.0", "robot_face");
  let clock = 0;
  const mirror = mirrored(raw, () => clock);
  await mirror.scanChannels(["C1"]);
  mirror.applyEvent(
    messageEvent({
      type: "message",
      channel: "C1",
      ts: "1.5",
      thread_ts: "1.0",
      text: "<@U_BOT> !done",
      user: "U2",
    }),
  );
  await mirror.getThread("C1", "1.0");
  mirror.applyEvent(
    messageEvent({
      type: "message",
      subtype: "message_deleted",
      channel: "C1",
      deleted_ts: "1.5",
      previous_message: {
        ts: "1.5",
        thread_ts: "1.0",
        text: "<@U_BOT> !done",
        user: "U2",
      },
    }),
  );

  clock = 60_001;
  const scan = await mirror.scanChannels(["C1"]);
  const root = scan.mentions[0]!;
  const replies = await mirror.getThread("C1", "1.0");

  assert.deepEqual(root.botReactions, ["white_check_mark", "robot_face"]);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.metadata?.eventType, TRACKING_METADATA_EVENT);
  assert.equal(stateFromThread(root, replies, settings()).state, "Todo");
});

test("agent thread reads share the mirror's first-seen command classification", async () => {
  const s = settings();
  const raw = new InMemorySlackTransport(
    { C1: [{ ts: "1.0", text: "<@U_BOT> tracked", user: "U2" }] },
    { botUserId: "U_BOT" },
  );
  const mirror = new MirrorBackedSlackTransport(raw, s, {
    reconcileIntervalMs: 60_000,
    now: () => 0,
    logger: silent,
  });
  mirror.setSocketHealthy(true);
  await mirror.scanChannels(["C1"]);
  mirror.applyEvent(
    messageEvent({
      type: "message",
      channel: "C1",
      ts: "1.5",
      thread_ts: "1.0",
      text: "<@U_BOT> !done",
      user: "U2",
    }),
  );
  mirror.applyEvent(
    messageEvent({
      type: "message",
      subtype: "message_changed",
      channel: "C1",
      message: {
        ts: "1.5",
        thread_ts: "1.0",
        text: "<@U_BOT> !cancel",
        user: "U2",
      },
    }),
  );
  registerSlackRuntimeTransport(s, mirror);

  const result = await slackToolProvider.executeTool(
    "slack_read_thread",
    { issueId: "C1:1.0" },
    {
      settings: settingsForIssueState(s, "Todo"),
      fetchImpl: (async () => {
        throw new Error("unexpected direct Slack read");
      }) as typeof fetch,
    },
  );

  assert.equal(result.success, true);
  assert.equal((result.result as { status: string }).status, "Done");
});

test("mirror thread pages preserve Slack microsecond timestamp ordering", async () => {
  const inner = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: "1700000000.000001",
          text: "<@U_BOT> preserve ordering",
          user: "U2",
          replies: [
            { ts: "1700000000.000003", text: "third", user: "U2" },
            { ts: "1700000000.000002", text: "second", user: "U2" },
          ],
        },
      ],
    },
    { botUserId: "U_BOT" },
  );
  const mirror = mirrored(inner);
  await mirror.scanChannels(["C1"]);
  await mirror.getThread("C1", "1700000000.000001");

  const page = await mirror.getThreadPage("C1", "1700000000.000001", {
    afterTs: "1700000000.000001",
    limit: 10,
  });

  assert.deepEqual(
    page.replies.map((reply) => reply.ts),
    ["1700000000.000002", "1700000000.000003"],
  );
});

test("a mirror page cursor resumes through the API after the socket becomes unhealthy", async () => {
  const inner = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: "1.0",
          text: "<@U_BOT> tracked",
          user: "U2",
          replies: [
            { ts: "1.1", text: "first", user: "U2" },
            { ts: "1.2", text: "second", user: "U2" },
          ],
        },
      ],
    },
    { botUserId: "U_BOT" },
  );
  const mirror = mirrored(inner);
  await mirror.scanChannels(["C1"]);
  await mirror.getThread("C1", "1.0");

  const first = await mirror.getThreadPage("C1", "1.0", { afterTs: "1.0", limit: 1 });
  assert.deepEqual(
    first.replies.map((reply) => reply.ts),
    ["1.1"],
  );
  assert.equal(first.nextCursor, "mirror:1.1");

  mirror.setSocketHealthy(false);
  const second = await mirror.getThreadPage("C1", "1.0", {
    afterTs: "1.0",
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    second.replies.map((reply) => reply.ts),
    ["1.2"],
  );
});

test("an API page cursor remains delegated when the mirror becomes authoritative", async () => {
  const inner = counting(
    new InMemorySlackTransport(
      {
        C1: [
          {
            ts: "1.0",
            text: "<@U_BOT> tracked",
            user: "U2",
            replies: [
              { ts: "1.1", text: "first", user: "U2" },
              { ts: "1.2", text: "second", user: "U2" },
            ],
          },
        ],
      },
      { botUserId: "U_BOT" },
    ),
  );
  const delegatedCursors: Array<string | undefined> = [];
  inner.getThreadPage = async (_channel, _ts, query) => {
    delegatedCursors.push(query.cursor);
    return query.cursor === undefined
      ? {
          replies: [{ ts: "1.1", text: "first", user: "U2" }],
          nextCursor: "OPAQUE",
        }
      : { replies: [{ ts: "1.2", text: "second", user: "U2" }] };
  };
  const mirror = mirrored(inner);
  await mirror.scanChannels(["C1"]);

  const first = await mirror.getThreadPage("C1", "1.0", { afterTs: "1.0", limit: 1 });
  assert.equal(first.nextCursor, "api:OPAQUE");
  await mirror.getThread("C1", "1.0");
  const second = await mirror.getThreadPage("C1", "1.0", {
    afterTs: "1.0",
    limit: 1,
    cursor: first.nextCursor,
  });

  assert.deepEqual(
    second.replies.map((reply) => reply.ts),
    ["1.2"],
  );
  assert.deepEqual(delegatedCursors, [undefined, "OPAQUE"]);
});
