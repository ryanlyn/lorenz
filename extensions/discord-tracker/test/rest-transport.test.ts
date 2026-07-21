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

import { chunkDiscordText, DiscordRestTransport, workpadMessage } from "@lorenz/discord-tracker";

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

test("REST discovers messages marked by the bot even when the source has no mention", async () => {
  const marked = rawMessage({
    id: "799999999999999999",
    mentions: [],
    content: "track this existing message",
    reactions: [{ name: "🤖", me: true }],
  });
  const unmarked = rawMessage({
    id: "799999999999999998",
    mentions: [],
    content: "ordinary channel chatter",
    reactions: [{ name: "🤖", me: false }],
  });
  const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([marked, unmarked]));
  const transport = new DiscordRestTransport(
    parseDiscordConfig(),
    fetchMock as unknown as typeof fetch,
  );

  const scan = await transport.scanChannels([CHANNEL_ID]);

  assert.deepEqual(
    scan.mentions.map((candidate) => candidate.id),
    [marked.id],
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

test("REST preserves attachment metadata and reads the Discord CDN without bot auth", async () => {
  const attachment = {
    id: "923456789012345678",
    filename: "memory-report.md",
    description: "Heap growth report",
    content_type: "text/markdown; charset=utf-8",
    size: 21,
    url: "https://cdn.discordapp.com/attachments/1/2/memory-report.md?ex=abc",
    proxy_url: "https://media.discordapp.net/attachments/1/2/memory-report.md?ex=abc",
    height: null,
    width: null,
    ephemeral: false,
  };
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse(rawMessage({ id: "723456789012345678", attachments: [attachment] })),
    )
    .mockResolvedValueOnce(
      jsonResponse(rawMessage({ id: "723456789012345678", attachments: [attachment] })),
    )
    .mockResolvedValueOnce(
      new Response("retained heap report\n", {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      }),
    );
  const transport = new DiscordRestTransport(
    parseDiscordConfig(),
    fetchMock as unknown as typeof fetch,
  );

  const root = await transport.getMessage(CHANNEL_ID, "723456789012345678");

  assert.deepEqual(root?.attachments, [
    {
      id: attachment.id,
      filename: attachment.filename,
      description: attachment.description,
      contentType: attachment.content_type,
      size: attachment.size,
    },
  ]);
  const read = await transport.readAttachment(CHANNEL_ID, "723456789012345678", attachment.id);
  assert.deepEqual(read.attachment, root?.attachments[0]);
  assert.equal(new TextDecoder().decode(read.body), "retained heap report\n");
  const request = fetchMock.mock.calls[2];
  assert.equal(String(request?.[0]), attachment.url);
  assert.equal(
    ((request?.[1] as RequestInit).headers as Record<string, string>).authorization,
    undefined,
  );
});

test("REST posts the Workpad using Components V2 and suppressed mentions", async () => {
  const settings = parseDiscordConfig();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse(rawMessage({ id: "823456789012345678" })));
  const transport = new DiscordRestTransport(settings, fetchMock as unknown as typeof fetch);
  const workpad = {
    environment: "host:/workspace@abc1234",
    plan: ["Reproduce", "Implement"],
    acceptanceCriteria: ["Native controls work"],
    validationCommands: ["mise run check"],
    progress: [],
  };

  assert.equal(await transport.postWorkpad("723456789012345678", workpad), "823456789012345678");
  const request = fetchMock.mock.calls[0];
  assert.deepEqual(
    JSON.parse(String((request?.[1] as RequestInit).body)),
    workpadMessage(settings, workpad),
  );
});

test("REST registers guild commands idempotently and acknowledges interactions without bot auth", async () => {
  const settings = parseDiscordConfig();
  const command = { type: 1, name: "done", description: "Mark this issue done" };
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ id: "323456789012345678" }))
    .mockResolvedValueOnce(jsonResponse([]))
    .mockResolvedValueOnce(jsonResponse({ id: "command-id", ...command }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(jsonResponse({ id: "response-id" }));
  const transport = new DiscordRestTransport(settings, fetchMock as unknown as typeof fetch);

  await transport.registerApplicationCommands([command]);
  await transport.deferInteraction("623456789012345678", "interaction-token");
  await transport.completeInteraction("323456789012345678", "interaction-token", {
    title: "Status updated",
    description: "This issue is now **Done**.",
    color: 0x57f287,
  });

  const registerRequest = fetchMock.mock.calls[2];
  assert.equal((registerRequest?.[1] as RequestInit).method, "POST");
  assert.deepEqual(JSON.parse(String((registerRequest?.[1] as RequestInit).body)), command);

  const deferRequest = fetchMock.mock.calls[3];
  assert.equal(
    String(deferRequest?.[0]),
    "https://discord.com/api/v10/interactions/623456789012345678/interaction-token/callback",
  );
  const deferHeaders = (deferRequest?.[1] as RequestInit).headers as Record<string, string>;
  assert.equal(deferHeaders.authorization, undefined);
  assert.deepEqual(JSON.parse(String((deferRequest?.[1] as RequestInit).body)), {
    type: 5,
    data: { flags: 64 },
  });

  const completeRequest = fetchMock.mock.calls[4];
  assert.equal((completeRequest?.[1] as RequestInit).method, "PATCH");
  assert.equal(
    ((completeRequest?.[1] as RequestInit).headers as Record<string, string>).authorization,
    undefined,
  );
  assert.deepEqual(JSON.parse(String((completeRequest?.[1] as RequestInit).body)), {
    embeds: [
      {
        title: "Status updated",
        description: "This issue is now **Done**.",
        color: 0x57f287,
      },
    ],
    allowed_mentions: { parse: [] },
  });
});

test("REST does not rewrite application commands that already match", async () => {
  const command = { type: 1, name: "done", description: "Mark this issue done" };
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ id: "323456789012345678" }))
    .mockResolvedValueOnce(jsonResponse([{ id: "command-id", ...command }]));
  const transport = new DiscordRestTransport(
    parseDiscordConfig(),
    fetchMock as unknown as typeof fetch,
  );

  await transport.registerApplicationCommands([command]);

  assert.equal(fetchMock.mock.calls.length, 2);
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
  reactions?: Array<{ name: string; me: boolean }>;
  attachments?: unknown[];
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
    attachments: options.attachments ?? [],
    embeds: [],
    pinned: false,
    type: 0,
    reactions: options.reactions?.map((reaction) => ({
      count: 1,
      me: reaction.me,
      emoji: { id: null, name: reaction.name },
    })),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
