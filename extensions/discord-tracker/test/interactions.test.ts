import { assert } from "@lorenz/test-utils";
import { test } from "vitest";

import { parseDiscordConfig } from "./helpers.js";

import {
  DISCORD_COMPONENTS_V2_FLAG,
  DISCORD_STATUS_SELECT_ID,
  DISCORD_TRACK_MESSAGE_COMMAND,
  discordApplicationCommands,
  interactionAction,
  statusButtonId,
  workpadMessage,
  type DiscordInteraction,
} from "@lorenz/discord-tracker";

test("defines native guild commands for status, common transitions, and message tracking", () => {
  const settings = parseDiscordConfig();
  const commands = discordApplicationCommands(settings);

  assert.deepEqual(
    commands.map((command) => [command.type, command.name]),
    [
      [1, "status"],
      [3, DISCORD_TRACK_MESSAGE_COMMAND],
      [1, "done"],
      [1, "cancel"],
      [1, "reopen"],
      [1, "start"],
    ],
  );
  assert.deepEqual(
    commands[0]?.options?.[0]?.choices?.map((choice) => choice.value),
    ["Todo", "In Progress", "Done", "Cancelled"],
  );
});

test("resolves slash commands and Workpad controls through configured workflow states", () => {
  const settings = parseDiscordConfig({
    active_states: ["Open", "Working"],
    terminal_states: ["Closed", "Abandoned"],
  });

  assert.deepEqual(
    interactionAction(commandInteraction("status", { state: "working" }), settings),
    { kind: "status", status: "Working" },
  );
  assert.deepEqual(interactionAction(commandInteraction("done"), settings), {
    kind: "status",
    status: "Closed",
  });
  assert.deepEqual(
    interactionAction(
      {
        ...commandInteraction("ignored"),
        type: "component",
        commandName: undefined,
        customId: statusButtonId("Abandoned"),
      },
      settings,
    ),
    { kind: "status", status: "Abandoned" },
  );
  assert.deepEqual(
    interactionAction(
      {
        ...commandInteraction("ignored"),
        type: "component",
        commandName: undefined,
        customId: DISCORD_STATUS_SELECT_ID,
        componentValues: ["working"],
      },
      settings,
    ),
    { kind: "status", status: "Working" },
  );
});

test("renders the Workpad with configured workflow statuses", () => {
  const payload = workpadMessage(
    parseDiscordConfig({
      active_states: ["Open", "Working"],
      terminal_states: ["Closed", "Abandoned"],
    }),
    {
      environment: "host:/workspace@abc1234",
      plan: ["Reproduce the issue", "Implement the fix"],
      acceptanceCriteria: ["The interaction is acknowledged immediately"],
      validationCommands: ["mise run test", "mise run check"],
      progress: ["23:10 - reproduced"],
    },
  );

  assert.equal(payload.flags, DISCORD_COMPONENTS_V2_FLAG);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.equal(payload.components[0]?.type, 17);
  assert.equal(payload.components[0]?.accent_color, 0x5865f2);
  const children = payload.components[0]?.components as Array<Record<string, unknown>>;
  assert.match(JSON.stringify(children), /# Workpad/);
  assert.match(JSON.stringify(children), /Acceptance criteria/);
  assert.match(JSON.stringify(children), /mise run check/);
  const actionRow = children.find((component) => component.type === 1);
  const components = actionRow?.components as Array<Record<string, unknown>>;
  const selector = components[0];
  const options = selector?.options as Array<Record<string, unknown>>;
  assert.equal(selector?.type, 3);
  assert.equal(selector?.custom_id, DISCORD_STATUS_SELECT_ID);
  assert.equal(selector?.placeholder, "Change status");
  assert.deepEqual(
    options.map((option) => [option.label, option.value]),
    [
      ["Open", "Open"],
      ["Working", "Working"],
      ["Closed", "Closed"],
      ["Abandoned", "Abandoned"],
    ],
  );
});

function commandInteraction(
  commandName: string,
  commandOptions?: Record<string, string>,
): DiscordInteraction {
  return {
    id: "623456789012345678",
    applicationId: "323456789012345678",
    token: "interaction-token",
    type: "command",
    guildId: "123456789012345678",
    channelId: "223456789012345678",
    userId: "523456789012345678",
    userBot: false,
    commandName,
    commandOptions,
  };
}
