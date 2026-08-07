import { test, vi } from "vitest";
import { assert } from "@lorenz/test-utils";

import { resolveThreadState } from "../src/threadState.js";

import { parseSlackConfig } from "./helpers.js";

import {
  isAsideText,
  parseStatusCommand,
  stateFromThread,
  type SlackMessage,
  type SlackThreadReply,
  type SlackTransport,
} from "@lorenz/slack-tracker";


function settings(overrides: Record<string, unknown> = {}) {
  return parseSlackConfig(
    {
      tracker: {
        kind: "slack",
        channels: ["C1"],
        bot_user_id: "U_BOT",
        active_states: ["Todo", "In Progress"],
        terminal_states: ["Done", "Cancelled"],
        ...overrides,
      },
    },
    { SLACK_BOT_TOKEN: "xoxb" },
  );
}

function root(text: string, botReactions: string[] = []): SlackMessage {
  return { channel: "C1", ts: "100.000100", text, reactions: botReactions, botReactions };
}

function reply(ts: string, text: string, user?: string): SlackThreadReply {
  return user === undefined ? { ts, text } : { ts, text, user };
}

test("command grammar: keywords, explicit status, punctuation, and non-commands", () => {
  const s = settings();
  assert.deepEqual(parseStatusCommand("<@U_BOT> !done", "U_BOT", s), { state: "Done" });
  assert.deepEqual(parseStatusCommand("<@U_BOT> !Done!", "U_BOT", s), { state: "Done" });
  assert.deepEqual(parseStatusCommand("<@U_BOT> !cancel", "U_BOT", s), { state: "Cancelled" });
  assert.deepEqual(parseStatusCommand("<@U_BOT> !reopen", "U_BOT", s), { state: "Todo" });
  assert.deepEqual(parseStatusCommand("<@U_BOT> !in progress", "U_BOT", s), {
    state: "In Progress",
  });
  assert.deepEqual(parseStatusCommand("<@U_BOT> !status In Progress", "U_BOT", s), {
    state: "In Progress",
  });
  assert.deepEqual(parseStatusCommand("<@U_BOT|bot> !status: done", "U_BOT", s), {
    state: "Done",
  });
  // Free text after the mention is a bare mention, not a command.
  assert.equal(parseStatusCommand("<@U_BOT> thanks, looks done to me", "U_BOT", s), null);
  // Without the bang, even an exact keyword is an ordinary prompt, not a transition.
  assert.equal(parseStatusCommand("<@U_BOT> done", "U_BOT", s), null);
  assert.equal(parseStatusCommand("<@U_BOT> status In Progress", "U_BOT", s), null);
  // The mention must lead the message for a command form.
  assert.equal(parseStatusCommand("please <@U_BOT> !done", "U_BOT", s), null);
  // Unknown explicit status names are not commands.
  assert.equal(parseStatusCommand("<@U_BOT> !status Shipped", "U_BOT", s), null);
});

test("asides are recognized and do not reopen or transition an issue", () => {
  const s = settings();
  assert.equal(isAsideText("!aside context only", "U_BOT"), true);
  assert.equal(isAsideText("<@U_BOT> !ASIDE context only", "U_BOT"), true);
  assert.equal(isAsideText("!aside-ish is ordinary text", "U_BOT"), false);

  const result = stateFromThread(
    root("<@U_BOT> fix it"),
    [
      reply("101.1", "status: Done", "U_BOT"),
      reply("102.1", "<@U_BOT> !aside this should not reopen the issue", "U_HUMAN"),
    ],
    s,
  );
  assert.equal(result.state, "Done");
});

test("the latest command or bot status reply wins by ts order", () => {
  const s = settings();
  const thread = [
    reply("101.1", "status: In Progress", "U_BOT"),
    reply("102.1", "<@U_BOT> !done", "U_HUMAN"),
    reply("103.1", "status: In Progress", "U_BOT"),
  ];
  assert.equal(stateFromThread(root("<@U_BOT> fix it"), thread, s).state, "In Progress");
  // Reverse the order: the human command is now last and wins.
  const reversed = [
    reply("101.1", "status: In Progress", "U_BOT"),
    reply("103.1", "<@U_BOT> !done", "U_HUMAN"),
  ];
  assert.equal(stateFromThread(root("<@U_BOT> fix it"), reversed, s).state, "Done");
});

test("a bare mention after a terminal event reopens; before it, it does not", () => {
  const s = settings();
  const reopened = stateFromThread(
    root("<@U_BOT> fix it"),
    [
      reply("101.1", "status: Done", "U_BOT"),
      reply("102.1", "<@U_BOT> broke again, please look", "U_HUMAN"),
    ],
    s,
  );
  assert.equal(reopened.state, "Todo");
  assert.deepEqual(reopened.events, [
    { ts: "101.1", state: "Done", actor: "U_BOT" },
    { ts: "102.1", state: "Todo", actor: "U_HUMAN" },
  ]);

  const settled = stateFromThread(
    root("<@U_BOT> fix it"),
    [reply("101.1", "<@U_BOT> any update?", "U_HUMAN"), reply("102.1", "status: Done", "U_BOT")],
    s,
  );
  assert.equal(settled.state, "Done");
});

test("the audit trail retains an effective reopen followed by another status", () => {
  const result = stateFromThread(
    root("<@U_BOT> fix it"),
    [
      reply("101.1", "status: Done", "U_BOT"),
      reply("102.1", "<@U_BOT> one more fix", "U_HUMAN"),
      reply("103.1", "status: Done", "U_BOT"),
    ],
    settings(),
  );

  assert.equal(result.state, "Done");
  assert.deepEqual(result.events, [
    { ts: "101.1", state: "Done", actor: "U_BOT" },
    { ts: "102.1", state: "Todo", actor: "U_HUMAN" },
    { ts: "103.1", state: "Done", actor: "U_BOT" },
  ]);
});

test("threads without commands fall back to the reaction-derived state", () => {
  const s = settings({
    emoji_states: { check_mark: "Done", "green-check-mark": "Done" },
  });
  // Slack canonicalizes custom emoji aliases; either alias still reads as Done.
  assert.equal(
    stateFromThread(root("<@U_BOT> ship docs", ["green-check-mark"]), [], s).state,
    "Done",
  );
  assert.equal(
    stateFromThread(
      root("<@U_BOT> ship docs", ["check_mark"]),
      [reply("101.1", "just a human note, no mention", "U_HUMAN")],
      s,
    ).state,
    "Done",
  );
});

test("a bare re-mention reopens even a reaction-derived terminal state", () => {
  const s = settings();
  const result = stateFromThread(
    root("<@U_BOT> fix it", ["white_check_mark"]),
    [reply("101.1", "<@U_BOT> still failing for me", "U_HUMAN")],
    s,
  );
  assert.equal(result.state, "Todo");
  assert.deepEqual(result.events, [{ ts: "101.1", state: "Todo", actor: "U_HUMAN" }]);
});

test("a reply mention in a non-mention thread is the request, not a transition", () => {
  const s = settings();
  const result = stateFromThread(
    root("we're seeing flaky deploys in prod"),
    [
      reply("101.1", "yeah, it's the cache layer", "U_OTHER"),
      reply("102.1", "<@U_BOT> please fix this #backend", "U_HUMAN"),
      reply("103.1", "<@U_BOT> !done", "U_HUMAN"),
    ],
    s,
  );
  // The first mention is the request; the later command still transitions.
  assert.equal(result.state, "Done");
  assert.equal(result.request?.ts, "102.1");
  assert.match(result.request?.text ?? "", /please fix this/);
});

test("authorized steering replies contribute durable thread attachments", () => {
  const issueRoot = {
    ...root("<@U_BOT> inspect the reports"),
    files: [{ id: "F_ROOT", name: "request.txt", mimetype: "text/plain" }],
  };
  const result = stateFromThread(
    issueRoot,
    [
      {
        ts: "101.1",
        text: "first report",
        user: "U_HUMAN",
        files: [{ id: "F1", name: "first.txt", size: 12 }],
      },
      {
        ts: "102.1",
        text: "replacement report",
        user: "U_HUMAN",
        subtype: "file_share",
        files: [
          { id: "F1", name: "renamed.txt", mimetype: "text/plain" },
          { id: "F2", title: "second image", mimetype: "image/png" },
        ],
      },
      {
        ts: "103.1",
        text: "<@U_BOT> !aside reference only",
        user: "U_HUMAN",
        files: [{ id: "F3", name: "aside.txt" }],
      },
      {
        ts: "104.1",
        text: "status: In Progress",
        user: "U_BOT",
        files: [{ id: "F4", name: "bot.txt" }],
      },
    ],
    settings(),
  );

  assert.deepEqual(result.attachments, [
    { id: "F_ROOT", name: "request.txt", mimetype: "text/plain" },
    { id: "F1", name: "renamed.txt", size: 12, mimetype: "text/plain" },
    { id: "F2", title: "second image", mimetype: "image/png" },
  ]);
});

test("attachment-bearing thread state is refreshed when a reply is edited", async () => {
  const issueRoot = {
    ...root("<@U_BOT> inspect the report"),
    replyCount: 1,
    latestReply: "101.1",
  };
  const getThread = vi
    .fn<SlackTransport["getThread"]>()
    .mockResolvedValueOnce([
      {
        ts: "101.1",
        text: "report",
        user: "U_HUMAN",
        files: [{ id: "F1", name: "report.txt" }],
      },
    ])
    .mockResolvedValueOnce([
      { ts: "101.1", text: "report removed", user: "U_HUMAN", edited: true },
    ]);
  const transport = { getThread } as unknown as SlackTransport;

  const first = await resolveThreadState(settings(), transport, issueRoot);
  const second = await resolveThreadState(settings(), transport, issueRoot);

  assert.deepEqual(first.attachments, [{ id: "F1", name: "report.txt" }]);
  assert.equal(second.attachments, undefined);
  assert.equal(getThread.mock.calls.length, 2);
});

test("reply-origin attachments prioritize the request and retain the latest overflow file", () => {
  const postRequestFiles = Array.from({ length: 10 }, (_, index) => ({
    id: `F_POST_${index + 1}`,
    name: `post-${index + 1}.txt`,
  }));
  const result = stateFromThread(
    {
      ...root("surrounding conversation"),
      files: [{ id: "F_ROOT", name: "root-only.txt" }],
    },
    [
      {
        ts: "101.1",
        text: "context before the request",
        user: "U_HUMAN",
        files: [{ id: "F_PRE", name: "pre-request.txt" }],
      },
      {
        ts: "102.1",
        text: "<@U_BOT> please inspect",
        user: "U_HUMAN",
        files: [
          { id: "F_REQUEST_1", name: "request-1.txt" },
          { id: "F_REQUEST_2", name: "request-2.txt" },
        ],
      },
      {
        ts: "103.1",
        text: "more evidence",
        user: "U_HUMAN",
        subtype: "file_share",
        files: postRequestFiles,
      },
    ],
    settings(),
  );

  assert.deepEqual(
    result.attachments?.map((file) => file.id),
    [
      "F_REQUEST_1",
      "F_REQUEST_2",
      "F_POST_1",
      "F_POST_2",
      "F_POST_3",
      "F_POST_4",
      "F_POST_5",
      "F_POST_6",
      "F_POST_7",
      "F_POST_8",
      "F_POST_10",
    ],
  );
});
