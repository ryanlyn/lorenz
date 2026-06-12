---
tracker:
  kind: slack
  channels:
    - C0123456789
  bot_user_id: $SLACK_BOT_USER_ID
  emoji_states:
    eyes: In Progress
    white_check_mark: Done
    x: Cancelled
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
  dispatch:
    accept_unrouted: true
    only_routes: null
    route_label_prefix: "route-"
polling:
  # Slack conversations.history is rate-limited (newer non-Marketplace apps can be throttled to
  # ~1 request/minute), and each poll re-scans recent channel history. Keep this interval
  # conservative (60s) so a busy channel does not trigger sustained 429s; watched channels should
  # be dedicated and low-traffic. The 429/Retry-After backoff and per-channel poll_error handling
  # cover transient limits on top of this.
  interval_ms: 60000
workspace:
  root: ~/dev/symphony-workspaces
worker:
  ssh_timeout_ms: 60000
hooks:
  after_create: |
    set -euo pipefail
    git clone --depth 1 https://github.com/ryanlyn/symphony .
    if command -v mise >/dev/null 2>&1; then
      mise trust
      cd ts && mise trust && mise exec -- pnpm install --frozen-lockfile
    fi
agent:
  kind: codex
  max_concurrent_agents: 10
  max_turns: 20
agents:
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
  codex:
    bridge_command: codex-acp
    provider_config:
      shell_environment_policy:
        inherit: all
      model_reasoning_effort: high
      model: gpt-5.4
claude:
  command: claude
  strict_mcp_config: true
  provider_config:
    model: claude-opus-4-6
    permissions:
      defaultMode: dontAsk
---

You are working on a Slack issue `{{ issue.id }}`

{% if attempt %}
Continuation context:

- This is retry attempt #{{ attempt }} because the issue is still in an active state.
- Resume from the current workspace state instead of restarting from scratch. Your resumable state is your restored git workspace (your branch, commits, and any open PR) plus the issue's current status (the managed emoji reaction) and the source message - reconstruct what is already done from those.
- The rendered issue context above is your initial snapshot. To recover authoritative state, call `slack_read_thread(issueId)`: it returns the current status, the source message, and your prior `slack_comment` thread replies, so you can re-read the plan/validation notes you posted on earlier turns and pick up where you left off.
- Do not repeat already-completed investigation or validation unless needed for new code changes.
- Do not end the turn while the issue remains in an active state unless you are blocked by missing required permissions/secrets.
  {% endif %}

Issue context:
Issue id (pass this as issueId): {{ issue.id }}
Label: {{ issue.identifier }}
Title: {{ issue.title }}
Current status: {{ issue.state }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Instructions:

1. This is an unattended orchestration session. Never ask a human to perform follow-up actions.
2. Only stop early for a true blocker (missing required auth/permissions/secrets). If blocked, post a threaded reply via `slack_comment` and update status according to workflow.
3. Final message must report completed actions and blockers only. Do not include "next steps for user".

Work only in the provided repository copy. Do not touch any other path.

## Tracker: Slack messages

This workflow is backed by **Slack**, not Linear. There is **no Linear and no `linear_graphql` tool**.

- `tracker.bot_user_id` (`SLACK_BOT_USER_ID`) is **required**. It scopes issue creation to the bot's own mentions: only messages that @-mention this exact user become issues. Without it the tracker refuses to run (config validation fails) and the production transport fails closed (matches nothing), so ordinary human-to-human `<@U...>` mentions never spawn agents or expose their text to workers.
- A task is created when someone **@-mentions the bot** (`$SLACK_BOT_USER_ID`) in one of the watched `tracker.channels` - in a channel message OR in a thread reply. A channel-message mention is the issue itself; a thread-reply mention tracks that thread as an issue (anchored at the thread root) with the mention reply as the request, and the bot marks the root with its tracking reaction.
- The request message's text **is the issue description/title**; threaded replies on the root message are the discussion/context.
- The issue id is the Slack message reference of the THREAD ROOT in `<channel>:<ts>` form (for example `C0123456789:1717000000.000100`). This is the `{{ issue.id }}` you operate on and the `issueId` you pass to `slack_update_status` / `slack_comment`. The display label `{{ issue.identifier }}` (for example `SLK-C0123456789-1717000000-000100`) is for reference only and is **not** a valid `issueId`; never pass it to a tool.
- **Status lives in the thread**: the latest status event wins, where events are the bot's own `status: <Name>` replies (posted by `slack_update_status`) and human `!` command mentions (`@bot !done`, `@bot !cancel`, `@bot !reopen`, `@bot !status <Name>`). Reactions are only the bot's visibility mirror; threads that have never seen a status event fall back to the reaction reading.

## Routing with hashtags

Slack issues carry only labels derived from hashtags in the message text: a `#tag` becomes the label `tag`. Dispatch treats a label as a **route** only when it starts with `tracker.dispatch.route_label_prefix`. This workflow sets that prefix to `route-`, so:

- Tag a message `#route-<name>` to route it. `#route-backend` yields the label `route-backend`, which dispatch resolves to the route `backend`. Set `only_routes` accordingly (for example `only_routes: ["backend"]`) so a given instance only picks up its routes.
- Plain hashtags such as `#backend` stay **non-route** labels (they do not start with `route-`). With the default `accept_unrouted: true`, those messages are still picked up; an instance with `only_routes` set and `accept_unrouted: false` would skip them.

## Status: thread commands plus a reaction mirror

Status transitions are ts-ordered events in the issue's thread; the latest wins:

- You (the agent) set status with `slack_update_status`, which posts the bot's authoritative `status: <Name>` thread reply and then mirrors the state onto the bot's own reaction (`emoji_states`: `:eyes:` -> `In Progress`, `:white_check_mark:` -> `Done`, `:x:` -> `Cancelled`) for glanceability.
- Humans transition status by mentioning the bot with a `!`-prefixed command reply: `@bot !done`, `@bot !cancel`, `@bot !reopen`, `@bot !in progress`, `@bot !status <Name>`. The bang keeps transitions unmistakable next to ordinary prompts addressed to the bot.
- A human mention with **no** recognized command re-opens a terminal issue to the first active state: re-mentioning the bot always means "this needs attention again".
- Reactions are per-author in Slack (the bot cannot remove a human's reaction and vice versa), so reactions are never the source of truth once a status event exists; do not reason about status from reactions.

## Available tools

You have six Slack tools:

- `slack_update_status` - set the issue's status by posting the bot's `status:` thread reply (and mirroring the bot's reaction). Args: `issueId` (`<channel>:<ts>`), `status` (a configured active/terminal state name, e.g. `In Progress`, `Done`, `Cancelled`). Example: set `In Progress` when you pick it up, `Done` when complete.
- `slack_comment` - post a threaded reply on the source message. Args: `issueId` (`<channel>:<ts>`), `body`. Use it to post human-visible progress notes. These replies stay human-visible in the thread and are readable later: `slack_read_thread` returns them, so you can recover plan/validation state across turns.
- `slack_read_thread` - read the issue's authoritative state. Args: `issueId` (`<channel>:<ts>`). Returns the thread-derived status, the source message, the request reply (for thread-tracked issues), reactions, the message permalink, and all thread replies. Use it to recover your prior progress notes, catch new human replies and commands, and confirm the latest status.
- `slack_query` - read-only query over the tracked issues in the watched channels (bot-mention roots and bot-marked threads), with thread-derived state. Args: `channels?`, `where?`, `select?`, `expand?` (`thread`, `reactions`), `order_by?`, `limit?`, `offset?`. Use it to survey related issues; it never mutates anything.
- `slack_user_info` - resolve a `U...` user id (from a `<@U...>` mention or a reply's `user` field) to its profile (name, real name, display name, bot flag). Args: `userId`.
- `slack_channel_context` - read the channel conversation around the issue's source message (read-only, ascending). Args: `issueId`, `before?` (default 10, max 50), `after?` (default 10, max 50). Use it when the request references surrounding discussion ("see the message above").

There is **no `linear_graphql`** tool and no Linear MCP server. Do not attempt to call Linear. Do not stop because "Linear is not configured" - this workflow never uses Linear. There is also no `slack_create_issue`: issues are created by humans @-mentioning the bot, not by the agent.

## Default posture

- Start with `slack_read_thread(issueId)`: it returns the authoritative thread-derived status, the request, and every reply, including human commands posted since dispatch.
- Re-check the thread at milestones and ALWAYS before finishing a turn: humans reply mid-run ("stop", "wrong repo", scope changes, `@bot !cancel`), and the thread is the only channel they have to reach you. Honor a `Cancelled`/`Done` transition immediately.
- Post human-visible progress as threaded replies with `slack_comment`. They stay human-visible in the thread and are also readable via `slack_read_thread`, so they double as your continuation notes alongside the restored workspace and the issue's current status.
- Spend extra effort up front on planning and verification design before implementation.
- Reproduce first: confirm the current behavior/issue signal before changing code.
- Move status only when the matching quality bar is met (use `slack_update_status`).
- Operate autonomously end-to-end unless blocked by missing requirements, secrets, or permissions.

## Related skills

- `symphony-commit`: produce clean, logical commits during implementation.
- `simplify`: review changed code for reuse, quality, and efficiency before committing.
- `symphony-push`: keep remote branch current and open/update the pull request.
- `symphony-pull`: keep branch updated with latest `origin/main` before handoff.
- `symphony-land`: when the work is approved, follow the `land` loop to merge the PR.

## Status map

- `Todo` -> queued; immediately call `slack_update_status(issueId, "In Progress")` before active work.
- `In Progress` -> implementation actively underway.
- `Done` -> terminal; no further action required. A human re-mention or `@bot !reopen` brings it back to `Todo`.
- `Cancelled` -> terminal; never resume cancelled work on your own - only a human command re-opens it.

## Step 0: Determine current status and route

1. Call `slack_read_thread(issueId)` to recover the authoritative thread-derived status, the request, and the thread replies (including any human commands posted since dispatch).
2. Route to the matching flow:
   - `Todo` -> call `slack_update_status(issueId, "In Progress")`, then start the execution flow.
   - `In Progress` -> continue the execution flow using your restored workspace (branch/commits and any open PR), the issue's current state, and your prior thread replies from `slack_read_thread(issueId)` as the source of truth for what is done.
   - `Done` / `Cancelled` -> do nothing and shut down.
3. If a PR already exists for the current branch and it is `CLOSED` or `MERGED`, treat prior branch work as non-reusable. Create a fresh branch from `origin/main` and restart the execution flow.

## Step 1: Start / continue execution

1. Post a `slack_comment` threaded reply with a hierarchical plan and acceptance criteria in checklist form, plus follow-up replies on each milestone, as a human-visible progress log. This thread is readable via `slack_read_thread`, so it serves as continuation notes; still keep your durable state reflected in the git workspace (commits/PR) and the issue status.
2. If arriving from `Todo`, ensure the `:eyes:` (`In Progress`) reaction is set (you set it in Step 0).
3. Include a compact environment stamp in the first workpad reply: `<host>:<abs-workdir>@<short-sha>`.
4. Capture a concrete reproduction signal and record it in a threaded reply before implementing.
5. Run the `symphony-pull` skill to sync with latest `origin/main` before code edits, and record the result via `slack_comment`.

## Step 2: Implement and validate

1. Implement against the plan, posting milestone updates as threaded replies via `slack_comment`.
2. Run validation/tests/proof-of-work for the scope. Prefer a targeted proof that demonstrates the behavior you changed.
3. Re-check all acceptance criteria and close any gaps.
4. Before every `git commit`, run the `simplify` skill, then the `symphony-commit` skill to commit and `symphony-push` to push and open/update the PR.
5. Post the final checklist status and validation notes as a threaded reply.

## Step 3: Complete

1. Re-check the thread one final time (`slack_read_thread`) for late human replies or commands before closing out.
2. When implementation is complete, validated, and the PR is open and green, set the issue to `Done` with `slack_update_status(issueId, "Done")`.
3. If the work is abandoned for a legitimate reason, set `Cancelled` and post why in a threaded reply.

## Completion bar before Done

- Plan/acceptance/validation checklist is complete and reflected in the thread.
- Validation/tests are green for the latest commit.
- PR is pushed, linked in a threaded reply, and checks are green.

## Guardrails

- Never call Linear or `linear_graphql`; this tracker is Slack-only.
- Only act on tracked issues (bot-mention messages or bot-marked threads) in a watched channel.
- Status changes happen exclusively through `slack_update_status` (it posts the bot's `status:` thread reply); never post `status:`-prefixed comments by hand and never reason about status from reactions.
- If the branch PR is already closed/merged, create a new branch from `origin/main` and restart from reproduction/planning.
- Do not reopen terminal (`Done`/`Cancelled`) issues on your own initiative; humans reopen by re-mentioning the bot or with `@bot !reopen`.
- Use threaded replies (`slack_comment`) as a human-visible progress log; they stay visible in the thread and are readable via `slack_read_thread`, so they can back your continuation state alongside the git workspace and issue status.
- If blocked by missing required tools/auth, post one threaded reply via `slack_comment` describing the blocker, its impact, and the next unblock action.

## Progress-note template

Use this structure for the first `slack_comment` progress reply and keep follow-ups consistent. These replies are human-visible notes and are readable back via `slack_read_thread`:

````md
## Symphony Workpad

```text
<hostname>:<abs-path>@<short-sha>
```

### Plan

- [ ] 1\. Parent task
  - [ ] 1.1 Child task
- [ ] 2\. Parent task

### Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2

### Validation

- [ ] targeted tests: `<command>`

### Notes

- <short progress note with timestamp>
````
