import { assert } from "@lorenz/test-utils";
import { test, vi } from "vitest";

import {
  BOT_ID,
  BOT_ROLE_ID,
  CHANNEL_ID,
  GUILD_ID,
  USER_ID,
  message,
  parseDiscordConfig,
} from "./helpers.js";

import { chunkDiscordText, DiscordRestTransport } from "@lorenz/discord-tracker";

test("REST scans paginate Discord history and enforce exact bot and author ids", async () => {
  const settings = parseDiscordConfig({ users: [USER_ID] });
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    rawMessage({
      id: String(900000000000000000n - BigInt(index)),
      authorId: index === 0 ? USER_ID : "623456789012345678",
      mentions: index === 0 ? [BOT_ID] : [],
    }),
  );
  const secondPage = [
    rawMessage({ id: "799999999999999999", authorId: USER_ID, mentions: [BOT_ID] }),
    rawMessage({
      id: "799999999999999998",
      authorId: USER_ID,
      authorBot: true,
      mentions: [BOT_ID],
    }),
  ];
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse(firstPage))
    .mockResolvedValueOnce(jsonResponse(secondPage));
  const transport = new DiscordRestTransport(settings, fetchMock as unknown as typeof fetch);

  const scan = await transport.scanChannels([CHANNEL_ID]);

  assert.deepEqual(
    scan.mentions.map((candidate) => candidate.id),
    ["900000000000000000", "799999999999999999"],
  );
  assert.match(String(fetchMock.mock.calls[1]?.[0]), /before=899999999999999901/);
});

test("REST honors Discord retry_after without bypassing the authoritative rescan", async () => {
  const settings = parseDiscordConfig();
  let now = 0;
  const sleep = vi.fn(async (delayMs: number) => {
    now += delayMs;
  });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse({ message: "rate limited", retry_after: 64.57, global: true }, 429),
    )
    .mockResolvedValueOnce(jsonResponse([]));
  const warnings: string[] = [];
  const transport = new DiscordRestTransport(
    settings,
    fetchMock as unknown as typeof fetch,
    sleep,
    { warn: (warning) => warnings.push(warning) },
    { now: () => now },
  );

  assert.deepEqual(await transport.scanChannels([CHANNEL_ID]), { mentions: [] });
  assert.deepEqual(
    sleep.mock.calls.map(([delay]) => delay),
    [64_570],
  );
  assert.match(warnings[0] ?? "", /HTTP 429/);
});

test("REST recognizes the configured bot managed role and rejects unrelated roles", async () => {
  const otherRoleId = "673456789012345678";
  const roleMention = rawMessage({
    id: "799999999999999999",
    mentions: [],
    mentionRoles: [BOT_ROLE_ID],
    content: `<@&${BOT_ROLE_ID}> investigate`,
  });
  const unrelatedRoleMention = rawMessage({
    id: "799999999999999998",
    mentions: [],
    mentionRoles: [otherRoleId],
    content: `<@&${otherRoleId}> not for Lorenz`,
  });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse([roleMention, unrelatedRoleMention]))
    .mockResolvedValueOnce(
      jsonResponse([
        { id: BOT_ROLE_ID, name: "Lorenz", tags: { bot_id: BOT_ID } },
        { id: otherRoleId, name: "Other", tags: {} },
      ]),
    );
  const transport = new DiscordRestTransport(
    parseDiscordConfig(),
    fetchMock as unknown as typeof fetch,
  );

  const scan = await transport.scanChannels([CHANNEL_ID]);

  assert.deepEqual(
    scan.mentions.map((candidate) => candidate.id),
    [roleMention.id],
  );
  assert.deepEqual(scan.mentions[0]?.botRoleIds, [BOT_ROLE_ID]);
  assert.equal(
    String(fetchMock.mock.calls[1]?.[0]),
    `https://discord.com/api/v10/guilds/${GUILD_ID}/roles`,
  );
});

test("REST uses exponential backoff when a retryable response omits Retry-After", async () => {
  const sleep = vi.fn(async () => {});
  const fetchMock = vi.fn(async () => jsonResponse({ message: "unavailable" }, 503));
  const transport = new DiscordRestTransport(
    parseDiscordConfig(),
    fetchMock as unknown as typeof fetch,
    sleep,
    { warn() {} },
  );

  await assert.rejects(() => transport.getMessage(CHANNEL_ID, "723456789012345678"), /status 503/);
  assert.deepEqual(
    sleep.mock.calls.map(([delay]) => delay),
    [250, 500, 1000, 2000],
  );
});

test("REST creates the source-message thread and suppresses outbound mentions", async () => {
  const settings = parseDiscordConfig();
  const root = message({ id: "723456789012345678" });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ message: "Unknown Channel" }, 404))
    .mockResolvedValueOnce(jsonResponse({ id: root.id, type: 11, name: "issue" }))
    .mockResolvedValueOnce(jsonResponse(rawMessage({ id: "823456789012345678" })));
  const transport = new DiscordRestTransport(settings, fetchMock as unknown as typeof fetch);

  assert.equal(await transport.ensureThread(root, "Investigate the failure"), root.id);
  await transport.postThreadMessage(root.id, "Completed @everyone");

  const createRequest = fetchMock.mock.calls[1];
  assert.equal(
    String(createRequest?.[0]),
    `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${root.id}/threads`,
  );
  assert.deepEqual(JSON.parse(String((createRequest?.[1] as RequestInit).body)), {
    name: "Investigate the failure",
    auto_archive_duration: 10080,
  });
  assert.equal(
    (createRequest?.[1] as RequestInit).headers &&
      ((createRequest?.[1] as RequestInit).headers as Record<string, string>)["user-agent"],
    "DiscordBot (https://github.com/ryanlyn/lorenz, 0.1.1)",
  );
  const postRequest = fetchMock.mock.calls[2];
  assert.deepEqual(JSON.parse(String((postRequest?.[1] as RequestInit).body)), {
    content: "Completed @everyone",
    allowed_mentions: { parse: [] },
  });
});

test("Discord message chunking respects the 2000-character limit and Unicode code points", () => {
  const chunks = chunkDiscordText(`${"a".repeat(1998)}\n${"🦀".repeat(10)}`);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 2000));
  assert.equal(chunks.join(""), `${"a".repeat(1998)}${"🦀".repeat(10)}`);
});

test("REST encodes every caller-provided route segment", async () => {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    assert.match(String(input), /\/users\/\.\.%2F\.\.%2Fchannels$/);
    return jsonResponse({}, 404);
  });
  const transport = new DiscordRestTransport(parseDiscordConfig(), fetchImpl);

  assert.equal(await transport.getUser("../../channels"), null);
  assert.equal(fetchImpl.mock.calls.length, 1);
});

function rawMessage(options: {
  id: string;
  authorId?: string;
  authorBot?: boolean;
  mentions?: string[];
  mentionRoles?: string[];
  content?: string;
}) {
  return {
    id: options.id,
    channel_id: CHANNEL_ID,
    author: {
      id: options.authorId ?? USER_ID,
      username: "requester",
      discriminator: "0",
      avatar: null,
      bot: options.authorBot ?? false,
    },
    content: options.content ?? `<@${BOT_ID}> investigate`,
    timestamp: "2026-07-16T00:00:00.000Z",
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: (options.mentions ?? [BOT_ID]).map((id) => ({
      id,
      username: "bot",
      discriminator: "0",
      avatar: null,
    })),
    mention_roles: options.mentionRoles ?? [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: 0,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
