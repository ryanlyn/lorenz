# Slack tracker

Use Slack channels as the source of work. An `@`-mention of your bot becomes an issue, the
mention's thread carries the status, and Lorenz polls the watched channels over the Slack Web API.
This page is for operators: it covers the Slack app setup, the required config, the status model,
and the `slack_*` agent tools. The provider lives in `extensions/slack-tracker`.

## The model in one screen

- An `@bot` mention is an issue. A channel root message that mentions the bot is the issue itself.
  A thread reply that mentions the bot turns that thread into an issue, anchored at the thread root,
  with the reply as the request.
- The issue id is `<channel>:<ts>` of the thread root, for example
  `C0123456789:1717000000.000100`. That string is the `{{ issue.id }}` you pass to every tool as
  `issueId`.
- The display label is `identifier`, formatted `SLK-<channel>-<ts with dots as dashes>`, for example
  `SLK-C0123456789-1717000000-000100`. It is for reference only and is not a valid `issueId`.
- Status lives in the thread. The latest ts-ordered status event wins: the bot's own
  `status: <Name>` replies and human `@bot !<command>` mentions are events. Reactions are a
  bot-owned visibility mirror, not the source of truth.
- Humans create issues by mentioning the bot. Agents do not. There is no `slack_create_issue`.

## Setting up the Slack app

Create a Slack app for your workspace, install it to the channels Lorenz watches, and grant it the
OAuth bot scopes below. These are the OAuth bot scopes Lorenz needs, implied by the Web API methods
the transport calls; they are not declared in the extension source.

| Scope | Why Lorenz needs it |
| --- | --- |
| `channels:history` | Read message history in public channels (`conversations.history`, `conversations.replies`). |
| `groups:history` | Read history in private channels. |
| `reactions:read` | Read reactions to derive fallback status and detect the bot's marker. |
| `reactions:write` | Add and remove the bot's own marker and status reactions (`reactions.add`, `reactions.remove`). |
| `chat:write` | Post the bot's `status:` and comment replies (`chat.postMessage`). |
| `users:read` | Resolve a `U...` id to a profile for `slack_user_info` (`users.info`). |

There is no `app_mentions:read` scope and no Events API subscription. Discovery is pure polling of
`conversations.history`, so Lorenz never receives mention events and does not need that scope. A
per-channel incremental watermark is a deferred enhancement; each poll re-scans recent history from
the newest message.

The bot needs two distinct identifiers from the app:

- The bot token, an `xoxb-` value, supplied as `SLACK_BOT_TOKEN`.
- The bot user id, a `U...` value, supplied as `SLACK_BOT_USER_ID`. This is the user the bot posts
  as, not the app id.

## Required config

The minimal Slack tracker config names the channels and the bot user id. The token comes from the
environment.

The canonical form is the nested bundle: `tracker.kind` selects the bundle and `trackers.slack.provider` names the implementation. Options live under `trackers.slack`.

```yaml
tracker:
  kind: slack
trackers:
  slack:
    provider: slack
    channels:
      - C0123456789
    bot_user_id: $SLACK_BOT_USER_ID
```

| Key | Env fallback | Default | Meaning |
| --- | --- | --- | --- |
| `kind` / `provider` | | | `tracker.kind: slack` selects the bundle; `trackers.slack.provider: slack` names the implementation. |
| `channels` | | | Required. List of `C...` channel ids. Entries resolve `$VAR` references; an unresolved ref collapses to empty and is dropped. |
| `bot_user_id` | `SLACK_BOT_USER_ID` | | Required. The bot's `U...` id. An empty string does not satisfy it. |
| `api_key` | `SLACK_BOT_TOKEN` | | The `xoxb-` bot token. |
| `endpoint` | | `https://slack.com/api` | Slack Web API base. |
| `emoji_states` | | `eyes: In Progress`, `white_check_mark: Done`, `x: Cancelled` | Emoji name to state name, merged over the built-in `DEFAULT_EMOJI_STATES`. |
| `marker_emoji` | | `robot_face` | The reaction the bot adds to mark a tracked thread root. |
| `reply_lookback_days` | | `2` | How far back to discover new reply-mention threads. |

See [reference/configuration.md](../reference/configuration.md) for the full `tracker.*` key reference and the active/terminal state defaults.

`tracker.assignee` is rejected for the Slack tracker. Slack messages carry no assignee, so an
assignee-partitioned deployment would double-dispatch every mention. Setting it fails dispatch
validation.

### Why `bot_user_id` is mandatory

`bot_user_id` is the security gate, not a convenience. It scopes issue creation to the bot's own
mentions: only messages that mention this exact user become issues. Three layers enforce it.

- `validateDispatch` throws if it is missing or blank, so the daemon refuses to start.
- The production transport fails closed when it is unset: the channel scan returns empty and warns
  once, so no mention is ever read.
- Every `slack_*` tool calls `requireBotUserId` and throws without it.

Without this gate, any human-to-human `<@U...>` mention in a watched channel would spawn an agent
and expose its text to a worker. The matcher has a back-compat mode where an unset id falls back to
matching any `<@U...>` mention, but the production transport never reaches that path because it fails
closed first. Watch dedicated channels and keep them low-traffic.

## How an issue is built

A tracked root is one of three things: a root message whose text matches the bot-mention regex, a
threaded root the bot has already reacted to with its marker emoji, or an untracked threaded root
whose first bot-mention reply Lorenz discovers within `reply_lookback_days`. On discovery of a
reply-mention thread, the bot adds its marker reaction to the root so later polls recognize it
without re-scanning.

The mention regex matches `<@BOTID>` or the piped form `<@BOTID|label>`. A reply-mention posted
while the daemon was down longer than the lookback window is never picked up.

The root message maps to a normalized issue:

- **Channel root mention**: the root text is the title and description.
- **Reply-mention thread**: the title and routing hashtags come from the request reply; labels come
  from both the root and the request; the description is `<request text>` followed by a blank line
  and `(thread root) <root text>`. `createdAt` derives from the root `ts` times 1000.

Labels come from hashtags in the message text. `deriveLabels` strips all `<...>` mrkdwn tokens
first, then matches `#tag` only at the start of the text or after whitespace, lowercased and
deduped. Channel refs, user mentions, and hashtags inside link captions do not leak into labels.

## Status lives in the thread

Status is a fold over ts-ordered events in the issue's thread. The latest event wins.

<p align="center"><img src="../assets/diagrams/slack-thread-status.svg" alt="slack thread status diagram" width="920" style="width:100%;max-width:920px;height:auto" /></p>
*Status is the latest ts-ordered event: a bot `status:` reply or a human `!`-command, with reactions as a fallback only when the thread has no event.*

Two event kinds count:

- **Bot `status:` replies.** A reply matching `^status:\s*(.+)$` (case-insensitive), posted by the
  bot. `slack_update_status` writes these, with the `status:` prefix from `BOT_STATUS_PREFIX`.
- **Human `!`-command mentions.** A reply that starts with the bot mention followed by a
  `!`-prefixed body.

If the thread has no status event, state falls back to the reactions when the root is a mention,
otherwise `Todo`.

### Human commands

A command reply must lead with the bot mention, then a `!` body. `@bot done` without the bang is a
bare mention, not a command. The keyword map:

| Command | Result |
| --- | --- |
| `!done`, `!complete`, `!completed`, `!finished` | `Done` |
| `!cancel`, `!cancelled`, `!canceled`, `!stop` | `Cancelled` |
| `!reopen`, `!rework`, `!retry` | First active state |
| `!in progress`, `!start`, `!started`, `!wip` | `In Progress` |
| `!todo`, `!backlog` | `Todo` |
| `!status <Name>` | The explicit state `<Name>` |

A bare bot-mention reply with no recognized command reopens a terminal issue to the first configured
active state. Reaction-only state is treated as having ts of negative infinity, so any later bare
mention reopens it. Re-mentioning the bot always means "this needs attention again".

### Reactions as a mirror

`slack_update_status` is transactional: it resolves the canonical state name (rejecting an unknown
one), runs the trust check, posts the `status: <Name>` reply, then mirrors the state onto the bot's
own reaction best-effort. The posted reply is the new authoritative state; there is no re-read.

During a poll, if a human transition left the bot's managed reaction stale or missing, a self-healing
mirror reconciles the bot's own reaction once per state change per issue. `reactions.remove` only
removes the caller's own reaction, so human reactions are never touched.

Reactions are per-author: the bot cannot add or remove a human's reaction. They cannot carry a
jointly-edited status, so once any status event exists, reactions stop being the source of truth.
They are a visibility mirror plus a back-compat fallback for threads with no event. When several
mapped reactions are present, the most-advanced wins: cancelled outranks done, which outranks in
progress, which outranks backlog.

## Routing with hashtags

Slack issues carry only labels derived from hashtags. Dispatch treats a label as a route only when
it starts with `tracker.dispatch.route_label_prefix`, which the shipped workflow sets to `route-`.

- `#route-backend` becomes the label `route-backend`, which dispatch resolves to the route
  `backend`. Set `only_routes` accordingly, for example `only_routes: ["backend"]`, so an instance
  only picks up its routes.
- `#backend` is a plain, non-route label. With `accept_unrouted: true`, those mentions are still
  picked up. An instance with `only_routes` set and `accept_unrouted: false` skips them.

See [dispatch.md](../dispatch.md) for the full route resolution chain.

## Polling and rate limits

The shipped `WORKFLOW.slack.md` sets `polling.interval_ms` to `60000`, a 60-second cadence. The
interval is deliberately conservative: `conversations.history` can be throttled to roughly one
request per minute for newer non-Marketplace apps, and each poll re-scans recent channel history.

```yaml
polling:
  interval_ms: 60000
```

Each poll re-scans recent `conversations.history` newest-first with no `sinceTs` watermark, paging
at `limit=200` until there is no `next_cursor` or `MAX_HISTORY_PAGES` (500) is reached. Hitting the
cap with a cursor remaining logs a loud truncation warning. Channels are scanned concurrently; one
failed channel is skipped and logged, and only an all-channels failure rejects the poll with
`poll_error`.

Reads retry on 429 and 5xx. `chat.postMessage` retries only on 429, never on an ambiguous 5xx, since
it is non-idempotent. Reaction writes are idempotent: Slack's `already_reacted` and `no_reaction`
errors are treated as success. Backoff is exponential, honors `Retry-After`, and is capped, with a
30-second request timeout.

## The `slack_*` tools

The `slack` tool pack mounts automatically for the Slack tracker (its `defaultToolPacks` returns
`["slack"]`). Alongside the seven provider-neutral `tracker_*` tools (see
[reference/tracker-tools.md](../reference/tracker-tools.md)), it adds Slack-native tools that expose
the thread model directly: `slack_update_status` and `slack_comment` write the bot's reply,
`slack_read_thread` returns the authoritative thread-derived state, `slack_query` runs the read-only
`where` DSL, and `slack_user_info` / `slack_channel_context` resolve people and surrounding
conversation.

Every tool enforces the same trust boundary: a configured `bot_user_id`, a watched channel, and a
tracked message. `slack_query` rejects `jql` (use the `where` DSL) and always intersects requested
channels with the configured allow-list, so it cannot become an oracle for arbitrary messages. A
no-arg `slack_query` returns every tracked root in the configured channels, regardless of state;
narrow it with `where`, `order_by`, and paging. The candidate-scoped, active-states-only default
belongs to the neutral `tracker_query` / `queryIssues` path instead.

### Why there is no `slack_create_issue`

Issues are created only by humans mentioning the bot. The Slack `TrackerToolOps` adapter omits
`createIssue` deliberately, so the neutral `tracker_create_issue` reports unavailable on Slack.
There is no agent path to create a Slack issue. The neutral pack still serves `readIssue`,
`queryIssues`, `updateStatus`, and `addComment` through the same client.

## Workflow example

`WORKFLOW.slack.md` at the repo root is the complete shipped example: the front-matter config above,
the routing rules, the status map, and the agent prompt that drives `slack_read_thread` first and
re-checks the thread before finishing each turn. Use it as the starting point for your own Slack
workflow.

## See also

- [trackers/index.md](index.md) - the shared read surface and the neutral `tracker_*` pack.
- [dispatch.md](../dispatch.md) - the route resolution and eligibility chain.
- [reference/tracker-tools.md](../reference/tracker-tools.md) - exact schemas for the neutral tools.
- [reference/configuration.md](../reference/configuration.md) - the full `tracker.*` key reference.
- [security.md](../security.md) - the agent trust boundary and secret handling.
