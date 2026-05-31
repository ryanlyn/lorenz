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
  interval_ms: 5000
workspace:
  root: ~/dev/symphony-workspaces
worker:
  ssh_timeout_ms: 60000
hooks:
  after_create: |
    git clone --depth 1 https://github.com/ryanlyn/symphony .
    if command -v mise >/dev/null 2>&1; then
      cd elixir && mise trust && mise exec -- mix deps.get
    fi
  before_remove: |
    cd elixir && mise exec -- mix workspace.before_remove
agent:
  kind: codex
  max_concurrent_agents: 10
  max_turns: 20
codex:
  command: >
    codex --config shell_environment_policy.inherit=all --config model_reasoning_effort=high --model gpt-5.4 app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    writableRoots:
      - /Users/ryan/dev/symphony-workspaces
    networkAccess: true
claude:
  command: claude
  model: claude-opus-4-6[1m]
  permission_mode: dontAsk
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
  strict_mcp_config: true
---

You are working on a Slack issue `{{ issue.id }}`

{% if attempt %}
Continuation context:

- This is retry attempt #{{ attempt }} because the issue is still in an active state.
- Resume from the current workspace state instead of restarting from scratch. Your resumable state is your restored git workspace (your branch, commits, and any open PR) plus the issue's current status (the managed emoji reaction) and the source message - reconstruct what is already done from those.
- You CANNOT read back your earlier `slack_comment` thread replies: there is no Slack read tool and replies are not included in this prompt. Treat thread replies as write-only, human-visible progress notes; never depend on re-reading them to recover plan or validation state.
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
- A task is created when someone **@-mentions the bot** (`$SLACK_BOT_USER_ID`) in one of the watched `tracker.channels`. That message is the issue.
- The mentioned message's text **is the issue description/title**; threaded replies on that message are the discussion/context.
- The issue id is the Slack message reference in `<channel>:<ts>` form (for example `C0123456789:1717000000.000100`). This is the `{{ issue.id }}` you operate on and the `issueId` you pass to `slack_update_status` / `slack_comment`. The display label `{{ issue.identifier }}` (for example `SLK-1717000000-000100`) is for reference only and is **not** a valid `issueId`; never pass it to a tool.
- **Status is shown as an emoji reaction** on the source message. You never edit frontmatter or a file; you change a reaction.

## Routing with hashtags

Slack issues carry only labels derived from hashtags in the message text: a `#tag` becomes the label `tag`. Dispatch treats a label as a **route** only when it starts with `tracker.dispatch.route_label_prefix`. This workflow sets that prefix to `route-`, so:

- Tag a message `#route-<name>` to route it. `#route-backend` yields the label `route-backend`, which dispatch resolves to the route `backend`. Set `only_routes` accordingly (for example `only_routes: ["backend"]`) so a given instance only picks up its routes.
- Plain hashtags such as `#backend` stay **non-route** labels (they do not start with `route-`). With the default `accept_unrouted: true`, those messages are still picked up; an instance with `only_routes` set and `accept_unrouted: false` would skip them.

## Status as emoji reactions

The `emoji_states` mapping controls how status appears as a reaction on the source message:

- `:eyes:` -> `In Progress`
- `:white_check_mark:` -> `Done`
- `:x:` -> `Cancelled`

You set status with `slack_update_status`, which **swaps the reaction**: it removes any other status emoji it manages and adds the one for the target status. A message with no managed reaction is effectively new/`Todo`.

## Available tools

You have exactly two Slack write tools:

- `slack_update_status` - set the issue's status by swapping its status emoji reaction. Args: `issueId` (`<channel>:<ts>`), `status` (one of `In Progress`, `Done`, `Cancelled`). Example: set `In Progress` when you pick it up, `Done` when complete.
- `slack_comment` - post a threaded reply on the source message. Args: `issueId` (`<channel>:<ts>`), `body`. Use it to post human-visible progress notes. These replies are write-only: you cannot read them back on a later turn, so do not rely on them as resumable state (use your workspace and the issue status instead).

There is **no `linear_graphql`** tool and no Linear MCP server. Do not attempt to call Linear. Do not stop because "Linear is not configured" - this workflow never uses Linear. There is also no `slack_create_issue`: issues are created by humans @-mentioning the bot, not by the agent.

## Default posture

- Start by reading the current emoji reaction to determine status, then follow the matching flow.
- Post human-visible progress as threaded replies with `slack_comment`. These are write-only audit notes; for your own continuation rely on the restored workspace and the issue's current status, not on re-reading replies.
- Spend extra effort up front on planning and verification design before implementation.
- Reproduce first: confirm the current behavior/issue signal before changing code.
- Move status only when the matching quality bar is met (use `slack_update_status` to swap the reaction).
- Operate autonomously end-to-end unless blocked by missing requirements, secrets, or permissions.

## Related skills

- `symphony-commit`: produce clean, logical commits during implementation.
- `simplify`: review changed code for reuse, quality, and efficiency before committing.
- `symphony-push`: keep remote branch current and open/update the pull request.
- `symphony-pull`: keep branch updated with latest `origin/main` before handoff.
- `symphony-land`: when the work is approved, follow the `land` loop to merge the PR.

## Status map

- No managed reaction / `Todo` -> queued; immediately add the `:eyes:` reaction via `slack_update_status(issueId, "In Progress")` before active work.
- `In Progress` (`:eyes:`) -> implementation actively underway.
- `Done` (`:white_check_mark:`) -> terminal; no further action required.
- `Cancelled` (`:x:`) -> terminal; do not reopen.

## Step 0: Determine current status and route

1. Read the source message and its current managed reaction to determine status.
2. Route to the matching flow:
   - `Todo` (no managed reaction) -> call `slack_update_status(issueId, "In Progress")`, then start the execution flow.
   - `In Progress` -> continue the execution flow using your restored workspace (branch/commits and any open PR) and the issue's current state as the source of truth for what is done; you cannot read back prior thread replies.
   - `Done` / `Cancelled` -> do nothing and shut down.
3. If a PR already exists for the current branch and it is `CLOSED` or `MERGED`, treat prior branch work as non-reusable. Create a fresh branch from `origin/main` and restart the execution flow.

## Step 1: Start / continue execution

1. Post a `slack_comment` threaded reply with a hierarchical plan and acceptance criteria in checklist form, plus follow-up replies on each milestone, as a human-visible progress log. This thread is NOT your resumable memory (you cannot read it back); your durable state is the git workspace, so keep the plan reflected in your commits/PR and the issue status.
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

1. When implementation is complete, validated, and the PR is open and green, set the issue to `Done` with `slack_update_status(issueId, "Done")` (swaps the reaction to `:white_check_mark:`).
2. If the work is abandoned for a legitimate reason, set `Cancelled` (`:x:`) and post why in a threaded reply.

## Completion bar before Done

- Plan/acceptance/validation checklist is complete and reflected in the thread.
- Validation/tests are green for the latest commit.
- PR is pushed, linked in a threaded reply, and checks are green.

## Guardrails

- Never call Linear or `linear_graphql`; this tracker is Slack-only.
- Only act on messages that @-mention the configured bot in a watched channel.
- Status changes happen exclusively through `slack_update_status` (it swaps the managed reaction); never manually add/remove reactions for status by hand.
- If the branch PR is already closed/merged, create a new branch from `origin/main` and restart from reproduction/planning.
- Do not reopen terminal (`Done`/`Cancelled`) issues.
- Use threaded replies (`slack_comment`) as a human-visible progress log only; they are write-only and not readable on later turns, so never treat them as resumable agent state.
- If blocked by missing required tools/auth, post one threaded reply via `slack_comment` describing the blocker, its impact, and the next unblock action.

## Progress-note template

Use this structure for the first `slack_comment` progress reply and keep follow-ups consistent. These replies are human-visible notes, not resumable state:

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
