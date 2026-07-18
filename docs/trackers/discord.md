# Discord tracker

Use Discord guild channels as a source of work. A message that mentions the configured bot user or
its bot-managed role becomes an issue. The message's native Discord thread carries status changes,
progress notes, and human follow-up. Discord Gateway events wake Lorenz immediately, while REST
polling remains the authoritative source of truth and the recovery path for missed events.

The provider lives in `extensions/discord-tracker` and is selected with `provider: discord`.

## Issue model

- A non-bot message in a configured channel becomes an issue only when it mentions the configured
  bot user or a guild role Discord reports as managed by that bot.
- Lorenz resolves the managed bot role from the guild automatically. No separate role id is
  required.
- `users` can narrow issue creation to specific Discord user ids. It never removes the bot or
  managed-role mention requirement.
- The issue id is `<channel-id>:<message-id>`, for example
  `223456789012345678:723456789012345678`.
- The issue identifier is `DSC-<channel-id>-<message-id>`. It is a display label, not a tool input.
- Hashtags become lowercase labels. `#route-backend` therefore works with Lorenz's route-label
  dispatch rules.
- The first status is `Todo` unless the bot already owns a configured status reaction.

Discord creates a native thread from the source message on the first comment or status update. A
thread created from a message has the same id as that source message, so Lorenz can recover the
discussion after a restart without persisting a second identifier.

After Lorenz claims a new `Todo` issue, it starts a best-effort `👀` acknowledgement alongside
agent setup. The source message therefore shows activity without waiting for workspace preparation
or the agent's first tool call. The reaction provides the usual `In Progress` fallback until the
native thread has an authoritative status event. An acknowledgement failure is observable but never
fails the claimed run.

## Create the Discord bot

1. Create an application in the Discord Developer Portal and add a bot.
2. On the bot page, enable the **Message Content Intent**. Messages that mention the bot are visible
   without it, but complete human discussion in issue threads requires the intent.
3. Install the bot in the target guild with these channel permissions:
   - View Channels
   - Read Message History
   - Send Messages
   - Create Public Threads
   - Send Messages in Threads
   - Add Reactions
4. Enable Developer Mode in Discord, then copy the guild, channel, bot user, and permitted requester
   ids.
5. Export the token as `DISCORD_BOT_TOKEN`. Keep it out of workflow files and source control.

The configured channels must be guild text or announcement channels that support threads. Direct
messages, forum parents, and media parents are not tracker sources.

## Configure the tracker

```yaml
tracker:
  kind: work
trackers:
  work:
    provider: discord
    guild_id: $DISCORD_GUILD_ID
    channels:
      - $DISCORD_CHANNEL_ID
    bot_user_id: $DISCORD_BOT_USER_ID
    users:
      - $DISCORD_REQUESTER_ID
    emoji_states:
      "👀": In Progress
      "✅": Done
      "❌": Cancelled
    scan_lookback_days: 30
    active_states: [Todo, In Progress]
    terminal_states: [Done, Cancelled]
polling:
  interval_ms: 60000
```

`guild_id`, every `channels` entry, `bot_user_id`, and every `users` entry must be a 17-20 digit
Discord snowflake. `$VAR` references are resolved during config parsing. Unresolved list entries are
dropped, and dispatch validation fails if that leaves no channel.

| Key                  | Default                       | Meaning                                                            |
| -------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `api_key`            | `DISCORD_BOT_TOKEN`           | Bot token used for REST and Gateway authentication.                |
| `endpoint`           | `https://discord.com/api/v10` | REST base URL. Override only for a controlled test proxy.          |
| `guild_id`           | `DISCORD_GUILD_ID`            | Guild that scopes Gateway events and message permalinks. Required. |
| `channels`           | none                          | Guild text or announcement channel ids to scan. Required.          |
| `bot_user_id`        | `DISCORD_BOT_USER_ID`         | Bot id used for user and managed-role mentions. Required.          |
| `users`              | empty                         | Optional requester allowlist. Empty permits any non-bot author.    |
| `emoji_states`       | `👀`, `✅`, `❌`              | Emoji-to-state overrides merged over the defaults.                 |
| `scan_lookback_days` | `0`                           | Fixed trailing candidate window. Zero is unbounded.                |

`assignee` is rejected because Discord messages have no assignee field.

## Status and discussion

Status lives in the native thread. The latest valid event wins:

- `discord_update_status` posts `status: <Name>` as the bot.
- A human can mention the bot user or managed role in the thread with `!done`, `!cancel`, `!reopen`,
  `!in progress`, `!todo`, or `!status <Name>`.
- A later human mention without a status command reopens terminal work to the first active state.
- When no thread status exists, only reactions owned by the bot can provide state. Human reactions
  never change an issue.

The bot mirrors explicit `discord_update_status` transitions onto its own source-message reaction.
Polling also self-heals a stale mirror after a human status command or bare re-mention. These heals
run in a serialized background queue, so rate limits on reaction writes never delay issue discovery
or dispatch. Mirror failures do not change the thread-derived authoritative state.

## Agent tools

The tracker automatically mounts the `discord` tool pack:

| Tool                      | Purpose                                                                  |
| ------------------------- | ------------------------------------------------------------------------ |
| `discord_update_status`   | Post the authoritative status event and update the reaction mirror.      |
| `discord_comment`         | Post a progress note in the native issue thread.                         |
| `discord_read_thread`     | Read the source, resolved state, permalink, reactions, and thread.       |
| `discord_query`           | Query tracked mentions with filtering, projection, ordering, and paging. |
| `discord_user_info`       | Resolve a Discord user id.                                               |
| `discord_channel_context` | Read a bounded context window around the source message.                 |

Every per-issue tool validates that the issue references a configured channel and a currently
tracked bot-user or managed-role mention before reading or writing. `discord_query` intersects
requested channels with the configured channel allowlist.

## Gateway and polling

The Gateway connection subscribes only to guild, guild-message, guild-reaction, and message-content
intents. It filters events to configured source channels and already-known issue threads. A relevant
event asks the runtime to poll immediately. It never becomes a second source of issue state.

The connection heartbeats, checks acknowledgements, resumes with the last sequence after a
recoverable disconnect, and falls back to a fresh identify when the session cannot be resumed.
Fatal authentication or disallowed-intent close codes stop push wake-ups, but interval polling
continues.

REST requests retry HTTP 429 responses according to Discord's `retry_after` value. Idempotent reads
and reaction writes also retry bounded 5xx failures. Message posts are not retried after ambiguous
5xx responses, which prevents duplicate thread comments. Outbound comments disable mention parsing
so agent text cannot unexpectedly ping users, roles, or everyone.

## Troubleshooting

### No issues are discovered

- Confirm the message mentions the bot user or its bot-managed guild role in a configured channel.
- Confirm the author is present in `users`, when that allowlist is non-empty.
- Confirm the bot can view the channel and read message history.
- Increase `scan_lookback_days` or set it to `0` when the source message is older than the window.

### Thread comments fail

Confirm the channel supports native threads and the bot has Create Public Threads, Send Messages in
Threads, and Read Message History permissions.

### Push wake-ups stop

Enable Message Content Intent in the Developer Portal. A Gateway close code `4014` means the bot
requested a privileged intent that is not enabled or approved. Polling continues as the fallback,
so the symptom is increased dispatch latency rather than lost work.

## See also

- [Tracker overview](index.md)
- [Configuration reference](../reference/configuration.md)
- [Tracker tool reference](../reference/jira-tools.md)
- [Discord developer documentation](https://docs.discord.com/developers/intro)
