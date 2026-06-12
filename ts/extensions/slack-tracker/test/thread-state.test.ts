import { test } from "vitest";
import { assert } from "@symphony/test-utils";

import { parseSlackConfig } from "./helpers.js";

import {
  parseStatusCommand,
  stateFromThread,
  type SlackMessage,
  type SlackThreadReply,
} from "@symphony/slack-tracker";

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

function root(text: string, reactions: string[] = []): SlackMessage {
  return { channel: "C1", ts: "100.000100", text, reactions };
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

  const settled = stateFromThread(
    root("<@U_BOT> fix it"),
    [reply("101.1", "<@U_BOT> any update?", "U_HUMAN"), reply("102.1", "status: Done", "U_BOT")],
    s,
  );
  assert.equal(settled.state, "Done");
});

test("threads without commands fall back to the reaction-derived state (legacy)", () => {
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
