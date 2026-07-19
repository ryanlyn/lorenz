# Discord tracker

Use Discord guild channels as a source of work. A message becomes an issue when it mentions the
configured bot user or its bot-managed role, or when an allowed user chooses the message command
**Apps > Track with Lorenz**. The message's native Discord thread carries status changes, rich
Workpads, progress notes, and human follow-up. Discord Gateway events wake Lorenz immediately,
while REST polling remains the authoritative source of truth and the recovery path for missed
events.

The provider lives in `extensions/discord-tracker` and is selected with `provider: discord`.

## Issue model

- A non-bot message in a configured channel becomes an issue when it mentions the configured bot
  user or a guild role Discord reports as managed by that bot, or the bot marks it through the
  **Track with Lorenz** message command.
- Lorenz resolves the managed bot role from the guild automatically. No separate role id is
  required.
- `users` can narrow issue creation and interactive status changes to specific Discord user ids.
- The bot's `marker_emoji` reaction records ownership for a message selected through the context
  menu. A human reaction with the same emoji never creates work.
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
   The `applications.commands` scope is included automatically when the `bot` scope is selected.
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
| `marker_emoji`       | `🤖`                          | Bot-owned reaction that marks a context-menu tracked message.      |
| `scan_lookback_days` | `0`                           | Fixed trailing candidate window. Zero is unbounded.                |

`assignee` is rejected because Discord messages have no assignee field.

## Status and discussion

Status lives in the native thread. The latest valid event wins:

- `discord_update_status` posts `status: <Name>` as the bot.
- A human can use `/status`, `/start`, `/done`, `/cancel`, or `/reopen` inside the issue thread.
- A human can select **Start**, **Done**, **Cancel**, or **Reopen** on a rich Workpad.
- A later allowed human mention continues the issue in `In Progress`, including from `Todo` or a
  terminal state.
- When no thread status exists, only reactions owned by the bot can provide state. Human reactions
  never change an issue.

Lorenz acknowledges every command or button interaction immediately with a deferred private
response, performs the authoritative status write, then replaces that response with a success or
error card. Commands outside a tracked issue thread fail privately without changing state. Guild
commands are registered when the Gateway watcher starts, so they are available without a global
command propagation delay. A newly tracked context-menu message enters the next dispatch check
directly after Discord confirms the marker and thread writes, so it does not wait for a historical
channel scan. The ordinary REST scan still repairs missed events and process restarts.

The bot mirrors explicit status transitions onto its own source-message reaction. Polling also
self-heals a stale mirror after a human command or bare re-mention. These heals run in a serialized
background queue, so rate limits on reaction writes never delay issue discovery or dispatch.
Mirror failures do not change the thread-derived authoritative state.

## Rich Workpads

`discord_workpad` posts a native Components V2 card in the issue thread. It renders the environment,
plan, acceptance criteria, validation commands, and progress as separate Markdown sections inside
an accented container. Its action row provides status buttons for the configured workflow. Outbound
mentions are disabled, and long sections are split across bounded Text Display components.

Use `discord_comment` for incremental progress after the initial Workpad. Plain comments remain
appropriate for chronological notes, while the Workpad provides a compact structured starting
point and the issue's primary interactive controls.

## Discord and Slack behavior

Both trackers keep thread state authoritative, use bot-owned reactions only as a visual mirror, and
offer equivalent agent tools for status, comments, reads, queries, user lookup, and channel context.
Discord adds native interaction surfaces while preserving the same recovery model.

| Behavior | Slack | Discord |
| --- | --- | --- |
| Create work | Bot mention in a root or reply | Bot or managed-role mention, plus **Track with Lorenz** on any allowed source message |
| Human status control | Text commands in the thread | Slash commands and Workpad buttons with private confirmations |
| Push path | Optional Socket Mode and a second app token | Gateway using the existing bot token |
| Workpad | Plain thread reply | Components V2 container with Markdown sections and action buttons |
| Conversation | Slack thread | Native Discord thread |
| Recovery | REST polling and authoritative thread read | REST polling and authoritative thread read |

The Discord path is more interactive without weakening correctness: the Gateway is only the
low-latency delivery path, every mutation writes the same authoritative `status: <Name>` thread
record used by tools and polling, and private interaction errors do not clutter the issue thread.

## Agent tools

The tracker automatically mounts the `discord` tool pack:

| Tool                      | Purpose                                                                  |
| ------------------------- | ------------------------------------------------------------------------ |
| `discord_update_status`   | Post the authoritative status event and update the reaction mirror.      |
| `discord_workpad`         | Post a structured Components V2 Workpad with native status buttons.      |
| `discord_comment`         | Post a progress note in the native issue thread.                         |
| `discord_read_thread`     | Read the source, resolved state, permalink, reactions, and thread.       |
| `discord_query`           | Query tracked messages with filtering, projection, ordering, and paging. |
| `discord_user_info`       | Resolve a Discord user id.                                               |
| `discord_channel_context` | Read a bounded context window around the source message.                 |

Every per-issue tool validates that the issue references a configured channel and a currently
tracked mention or bot-owned marker before reading or writing. `discord_query` intersects requested
channels with the configured channel allowlist.

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

- Confirm the message mentions the bot user or its bot-managed guild role, or use **Apps > Track
  with Lorenz** on the message.
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
- [Discord application commands](https://docs.discord.com/developers/interactions/application-commands)
- [Discord message components](https://docs.discord.com/developers/components/using-message-components)
