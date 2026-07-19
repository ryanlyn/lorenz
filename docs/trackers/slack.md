# Slack tracker

Use Slack channels as the source of work. An `@`-mention of your bot becomes an issue, the
mention's thread carries the status, and Lorenz reads the watched channels over the Slack Web API.
With Socket Mode enabled, event payloads feed a local channel mirror so most polls read memory, and
eligible human thread replies are submitted immediately as the active agent's next queued turn.
Without Socket Mode the tracker is pull-only and every poll is a real scan. This page is for
operators: it covers the Slack app setup, the required config, the status model, the
workpad/session-modal surfaces, and the `slack_*` agent tools. The provider lives in
`extensions/slack-tracker`.

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
  bot-owned visibility mirror, not the source of truth. Only the BOT's own reactions ever read
  as state; a human's reaction never moves an issue - humans transition with `!` commands.
- Humans create issues by mentioning the bot. Agents do not. There is no `slack_create_issue`.

## Setting up the Slack app

Create a Slack app for your workspace, install it to the channels Lorenz watches, and grant it the
OAuth bot scopes below. These are the OAuth bot scopes Lorenz needs, implied by the Web API methods
the transport calls; they are not declared in the extension source.

| Scope               | Why Lorenz needs it                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `channels:history`  | Read message history in public channels (`conversations.history`, `conversations.replies`).     |
| `groups:history`    | Read history in private channels.                                                               |
| `im:history`        | Read direct-message history.                                                                    |
| `mpim:history`      | Read multiparty direct-message history.                                                         |
| `app_mentions:read` | Receive `app_mention` events when Socket Mode push wakeups are enabled.                         |
| `reactions:read`    | Read reactions to derive fallback status and detect the bot's marker.                           |
| `reactions:write`   | Add and remove the bot's own marker and status reactions (`reactions.add`, `reactions.remove`). |
| `chat:write`        | Post the bot's `status:` and comment replies (`chat.postMessage`).                              |
| `users:read`        | Resolve a `U...` id to a profile for `slack_user_info` (`users.info`).                          |

Socket Mode is optional. Without an app token, discovery is pure polling of
`conversations.history`. With an app-level token, Lorenz opens a Socket Mode connection and the
socket becomes a data feed, not just a doorbell: every watched `app_mention`, `message`, and
reaction event payload is applied to an in-memory **channel mirror**, the poll the event nudges
reads that mirror instead of re-scanning Slack, and the real history scan runs only as
reconciliation - after every accepted connection, whenever an event cannot be applied cleanly,
and on the `reconcile_interval_ms` cadence as a standing repair pass. Reconciliation invalidates
cached thread authority so the following thread read repairs missed edits as well as additions
and deletions. The fold over thread events is idempotent, so a duplicated or re-scanned input
re-derives the same state; while the socket is unhealthy the mirror never serves and every poll
is a real scan, exactly the pull-only behavior. Lorenz rejects an additional Socket Mode
connection when Slack reports that it would split the feed, preserving exclusive ownership for
the connection that already backs the mirror. Envelopes buffered on the rejected connection are
left unacknowledged so Slack can retry them on the owner. `interactive` envelopes (the
workpad's Cancel/Details buttons) arrive over the same connection, so interactivity needs no
public HTTP endpoint - enable **Interactivity** in the Slack app config to use the buttons.
Eligible human thread replies also travel with the event as structured issue data and are
submitted immediately to the active ACP session. Thread reads recover any reply missed during a
reconnect.

To receive Socket Mode wakeups, enable Event Subscriptions in the Slack app and subscribe to the bot
events Lorenz watches: `app_mention`, `message.channels` for public channels, `message.groups` for
private channels, `message.im` for direct messages, `message.mpim` for multiparty direct messages,
plus `reaction_added` and `reaction_removed`. Socket Mode delivers those events over the WebSocket;
the bot token still performs every read and write.

The bot needs two distinct identifiers from the app, plus an optional Socket Mode token:

- The bot token, an `xoxb-` value, supplied as `SLACK_BOT_TOKEN`.
- The bot user id, a `U...` value, supplied as `SLACK_BOT_USER_ID`. This is the user the bot posts
  as, not the app id.
- Optional: an app-level token, an `xapp-` value with `connections:write`, supplied as
  `SLACK_APP_TOKEN`, enables Socket Mode push wakeups. The bot token still does all reads and
  writes.

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

| Key                   | Env fallback        | Default                                                       | Meaning                                                                                                                               |
| --------------------- | ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `kind` / `provider`   |                     |                                                               | `tracker.kind: slack` selects the bundle; `trackers.slack.provider: slack` names the implementation.                                  |
| `channels`            |                     |                                                               | Required. List of public (`C...`), private or multiparty (`G...`), or direct-message (`D...`) conversation ids. Entries resolve `$VAR` references; an unresolved ref collapses to empty and is dropped. |
| `bot_user_id`         | `SLACK_BOT_USER_ID` |                                                               | Required. The bot's `U...` id. An empty string does not satisfy it.                                                                   |
| `api_key`             | `SLACK_BOT_TOKEN`   |                                                               | The `xoxb-` bot token.                                                                                                                |
| `app_token`           | `SLACK_APP_TOKEN`   |                                                               | Optional `xapp-` app-level token for Socket Mode wakeups and immediate live steering.                                                  |
| `users`               |                     | Any authenticated human                                       | Optional author allowlist applied to issue creation and steering replies.                                                             |
| `endpoint`            |                     | `https://slack.com/api`                                       | Slack Web API base.                                                                                                                   |
| `emoji_states`        |                     | `eyes: In Progress`, `white_check_mark: Done`, `x: Cancelled` | Emoji name to state name, merged over the built-in `DEFAULT_EMOJI_STATES`.                                                            |
| `marker_emoji`        |                     | `robot_face`                                                  | The reaction the bot adds to mark a tracked thread root.                                                                              |
| `reply_lookback_days` |                     | `2`                                                           | How far back to discover new reply-mention threads.                                                                                   |
| `scan_lookback_days`  |                     | Unbounded                                                     | How far back the candidate `conversations.history` scan pages. The shipped sample sets `30`; set `0` or omit for a full-history scan. |
| `reconcile_interval_ms` |                   | `900000` (15 min)                                             | With Socket Mode: how often the event-fed channel mirror re-syncs from a real scan. Ignored without `app_token` (pull-only scans every poll). |

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

- **Bot `status:` replies.** `slack_update_status` writes these. Each carries Slack **message
  metadata** (`lorenz_status` with the canonical state and a unique `seq`), which the fold
  prefers over text parsing: only the posting app can attach metadata, so it cannot be forged,
  and the text is free to carry extra lines (for example a Cancel-button attribution). Replies
  Bot replies without metadata still fold through the `^status:\s*(.+)$` regex (case-insensitive).
  The `seq` also upgrades delivery to exactly-once: an ambiguous outcome (5xx/timeout after the
  request was sent) is reconciled against the thread by its marker instead of silently losing -
  or duplicating - a transition.
- **Human `!`-command mentions.** A reply that starts with the bot mention followed by a
  `!`-prefixed body.

Two escape hatches around the events:

- **Asides.** A reply whose first line starts with `!aside` (after an optional leading bot
  mention) opts out of the fold entirely: it is never a command, never a bare re-mention (so it
  cannot re-open a terminal issue), and is never delivered to the agent as steering context. Use
  it to talk near the issue without addressing it.
- **Edits and deletions.** Command classification is **first-seen** for the daemon session: an
  edit to an already-folded `!` command is ignored (a one-time thread notice says so) - post a
  new command instead. A deleted command keeps its folded role until the next reconciliation
  scan, where the substrate has forgotten it and the fold re-derives. Across a restart the
  rebuild scan can only fold current text (Slack's API cannot return pre-edit text) - the
  first-seen guarantee is in-session, stated plainly rather than pretended durable. Root edits
  track current text: editing the mention away untracks the issue.

If the thread has no status event, state falls back to the BOT's own reactions when the root is a
mention, otherwise `Todo`. Human reactions never count toward state.

### Human commands

A command reply must lead with the bot mention, then a `!` body. `@bot done` without the bang is a
bare mention, not a command. The keyword map:

| Command                                         | Result                      |
| ----------------------------------------------- | --------------------------- |
| `!done`, `!complete`, `!completed`, `!finished` | `Done`                      |
| `!cancel`, `!cancelled`, `!canceled`, `!stop`   | `Cancelled`                 |
| `!reopen`, `!rework`, `!retry`                  | First active state          |
| `!in progress`, `!start`, `!started`, `!wip`    | `In Progress`               |
| `!todo`, `!backlog`                             | `Todo`                      |
| `!status <Name>`                                | The explicit state `<Name>` |

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

Mirror updates are frugal and off the dispatch path. Only the bot's own managed emoji observed on
the message are removed, so a mirror that is merely missing its target costs a single
`reactions.add`. Poll-time heals run in a serialized background queue: reaction methods are Slack
Tier-3 rate-limited, and a cold heal pass over a large backlog (restart, newly watched channel)
must not stall candidate discovery and dispatch behind 429 backoffs.

Reactions are per-author: the bot cannot add or remove a human's reaction, so reactions cannot
carry a jointly-edited status. Consequently only BOT-AUTHORED reactions are ever read as state -
the fallback for threads with no status event reads the bot's own reactions (the mirror it wrote
in an earlier session), and a human's reaction is display-only. This keeps state changes auditable
(a `!` command is a ts-ordered thread event; an emoji is not) and means a random channel member
cannot silently complete or cancel an issue, bypassing the `users` author allowlist. When several
of the bot's mapped reactions are present, the most-advanced wins: cancelled outranks done, which
outranks in progress, which outranks backlog. Bot authorship is derived from each reaction's
`users` list, which Slack can truncate on heavily-reacted messages; the thread reply always wins
when one exists.

## Routing with hashtags

Slack issues carry only labels derived from hashtags. Dispatch treats a label as a route only when
it starts with `tracker.dispatch.route_label_prefix`, which the shipped workflow sets to `route-`.

- `#route-backend` becomes the label `route-backend`, which dispatch resolves to the route
  `backend`. Set `only_routes` accordingly, for example `only_routes: ["backend"]`, so an instance
  only picks up its routes.
- `#backend` is a plain, non-route label. With `accept_unrouted: true`, those mentions are still
  picked up. An instance with `only_routes` set and `accept_unrouted: false` skips them.

See [dispatch.md](../dispatch.md) for the full route resolution chain.

## Polling, push, and rate limits

The shipped `WORKFLOW.slack.md` sets `polling.interval_ms` to `60000`, a 60-second cadence. The
interval is deliberately conservative: `conversations.history` can be throttled to roughly one
request per minute for newer non-Marketplace apps, while Marketplace-approved apps and internal
customer-built apps keep the higher tier. Each full poll re-scans recent channel history.

```yaml
polling:
  interval_ms: 60000
```

Each poll re-scans `conversations.history` newest-first, paging at `limit=200` until there is no
`next_cursor` or `MAX_HISTORY_PAGES` (500) is reached. When `scan_lookback_days` is set to a
positive value, the scan sends a fixed trailing `oldest` watermark. The watermark is not an
advancing cursor: active issues inside the window keep re-surfacing, while new discovery of roots
older than the window is intentionally bounded. Because `conversations.history` filters on the
thread root's ts, that bound also applies to reply mentions: a fresh reply-mention in a thread whose
root predates the window is not discovered, regardless of `reply_lookback_days`. Claimed issues are
still refreshed by id, unbounded, during reconciliation. Hitting the page cap with a cursor
remaining logs a loud truncation warning.
Channels are scanned concurrently; one failed channel is skipped and logged, and only an
all-channels failure rejects the poll with `poll_error`.

With Socket Mode enabled, push feeds the channel mirror and the poll path stays identical - it
just reads memory. A watched Slack event is applied to the mirror and then queues the same full
poll path the interval uses, so reconciliation, retry timers, terminal cleanup, blocked-dispatch
snapshots, and candidate counts stay consistent. Real scans then happen only at bootstrap, after
reconnects, on dirty channels, and on the `reconcile_interval_ms` cadence - the interval poll
keeps running as the safety net, it is just cheap. This is also what keeps the tracker viable
under Slack's restricted non-Marketplace rate tier (~1 `conversations.history` request/minute):
the hot path stops depending on history reads entirely.

### Steering a running agent

A new human thread reply is submitted to the active ACP session immediately when Socket Mode
delivers it. ACP queues the prompt behind any turn already executing, so that reply itself is the
next turn. The runner consumes the queued result as the next turn slot and does not append the reply
to a separate continuation prompt.

Slack authenticates the reply author. The same `tracker.users` policy used for issue creation
authorizes steering: when the list is non-empty only listed users can direct the agent; when it is
empty any authenticated human in a watched channel is eligible. Bot-authored replies, unknown
authors, status commands, `!aside` replies, message edits, system messages, and channel roots do not
steer the agent.

`conversations.replies` recovers eligible messages after a reconnect or turn boundary. Recovery
returns oldest-first bounded pages, advances only through accepted events, and shortens oversized
live-delivery text without changing its Slack timestamp or author. Without Socket Mode, eligible
replies are recovered between turns rather than pushed during an executing turn.

Reads retry on 429 and 5xx. Each retry wait is logged so a rate-limited scan is visible in daemon
logs instead of looking hung. `chat.postMessage` retries only on 429, never blindly on an
ambiguous 5xx, since it is non-idempotent - but metadata-marked posts (`status:` replies, the
workpad) resolve ambiguity by scanning the thread for their unique marker: found means the send
landed (no duplicate), and a successful read with no marker proves a retry is safe. A failed
reconciliation read fails loudly without retrying the post. Reaction writes are idempotent:
Slack's `already_reacted` and `no_reaction` errors are treated as success. Backoff is
exponential with jitter, honors `Retry-After`, and is capped, with a 30-second request timeout.

## The workpad and the session modal

At the first `slack_workpad` call, the bot posts ONE Block Kit message in the issue thread and
edits it in place from then on - the live plan checklist and latest note, without the notification
spam of posting each revision as a new reply (edits do not notify; genuinely notifying milestones
still belong in `slack_comment` replies). The workpad is recognized by its `lorenz_workpad`
message metadata, which also round-trips the plan/note so partial updates and restarts never lose
a section. It is a display surface, never state. Status remains in the thread event fold and the
bot-owned reaction mirror, so workpad updates only touch plan and note content. A workpad that
cannot be edited because Slack definitively rejects its stored message identity is reposted.

With Socket Mode enabled, the workpad carries two buttons delivered as `interactive` envelopes.
Pull-only workpads omit the actions because no interaction stream is available:

- **Cancel** posts the authoritative `status: Cancelled` reply with an attribution line naming
  the clicker, then nudges a poll so the runtime's reconciliation aborts the running agent within
  seconds. It is a shortcut for typing `@bot !cancel`, not a new privilege: any human can use it,
  matching the `!`-command model (the author allowlist gates issue creation, not transitions).
- **Details** opens a per-user modal - the in-Slack session view: current status, the folded
  status history (who moved the issue where, when), the request, the live plan/note, and artifact
  links harvested from the bot's replies, with a Refresh button. It consumes Slack's short-lived
  trigger immediately with a loading modal, then updates that view after authoritative reads.
  Nothing is posted to the thread and no external link is involved.

When a human posts a bare (command-less) bot-mention reply on an issue that is already past its
initial active state, the bot answers with an **ephemeral** notice - visible only to that author -
saying the agent is already working, that replies become its next queued turn, and how to stop it.
Rate-limited per issue+author; a politeness surface, never a lock.

## Steering a running agent

With Socket Mode, an eligible human thread reply is submitted to the active ACP session
immediately. ACP queues it behind a turn already executing, so the reply itself becomes the next
turn; the runner consumes that queued result instead of sending a separate continuation prompt.
Thread reads recover replies newer than the latest submitted watermark after a reconnect or turn
boundary. Without Socket Mode, eligible replies are recovered between turns rather than pushed
during an executing turn.

Excluded: the bot's own replies, `!` commands (they act through the status fold), asides, message
edits, system/root messages, and deleted replies. The shipped workflow still mandates re-reading
the thread at milestones and before finishing so status and visible context are verified together.

Every outbound bot message is broadcast-sanitized: `<!channel>`, `<!here>`, `<!everyone>`, and
`<!subteam^...>` tokens are rewritten to inert plain text (`@channel` or `@group`)
unconditionally. User-group labels are discarded so their contents cannot reconstruct another
broadcast token. An agent cannot page a channel; there is no knob to get wrong.

## The `slack_*` tools

The `slack` tool pack mounts automatically for the Slack tracker (its `defaultToolPacks` returns
`["slack"]`), and it is the only pack the Slack tracker mounts. Its Slack-native tools expose the
thread model directly: `slack_update_status` and `slack_comment` write the bot's reply,
`slack_workpad` creates/edits the single in-place plan message, with per-issue serialization so
concurrent partial updates merge against the latest metadata. `slack_read_thread` returns the
authoritative thread-derived state plus the folded `statusEvents` audit trail, `slack_query` runs
the read-only `where` DSL, and `slack_user_info` / `slack_channel_context` resolve people and
surrounding conversation.

Every tool enforces the same trust boundary: a configured `bot_user_id`, a watched channel, and a
tracked message. `slack_query` rejects `jql` (use the `where` DSL) and always intersects requested
channels with the configured allow-list, so it cannot become an oracle for arbitrary messages. A
no-arg `slack_query` returns every tracked root in the configured channels, regardless of state;
narrow it with `where`, `order_by`, and paging.

### Why there is no `slack_create_issue`

Issues are created only by humans mentioning the bot. The `slack` pack ships no issue-creation tool
deliberately, so there is no agent path to create a Slack issue. Agents read and update existing
threads through `slack_read_thread`, `slack_query`, `slack_update_status`, and `slack_comment`.

## Workflow example

`WORKFLOW.slack.md` at the repo root is the complete shipped example: the front-matter config above,
the routing rules, the status map, and the agent prompt that drives `slack_read_thread` first and
re-checks the thread before finishing each turn. Use it as the starting point for your own Slack
workflow.

## See also

- [trackers/index.md](index.md) - the shared read surface and per-tracker tool packs.
- [dispatch.md](../dispatch.md) - the route resolution and eligibility chain.
- [reference/configuration.md](../reference/configuration.md) - the full `tracker.*` key reference.
- [security.md](../security.md) - the agent trust boundary and secret handling.
