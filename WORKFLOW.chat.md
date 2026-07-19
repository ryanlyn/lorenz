---
# Lorenz runs one dispatch tracker at a time. Change this selector to `slack` to use the Slack
# bundle below; Discord is the default for this workflow.
tracker:
  kind: discord
trackers:
  discord:
    provider: discord
    guild_id: $DISCORD_GUILD_ID
    channels:
      - $DISCORD_CHANNEL_ID
    bot_user_id: $DISCORD_BOT_USER_ID
    # Restrict issue creation to known requesters when a channel has a broad audience.
    # users:
    #   - $DISCORD_REQUESTER_ID
    emoji_states:
      "👀": In Progress
      "✅": Done
      "❌": Cancelled
    marker_emoji: "🤖"
    scan_lookback_days: 30
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
      # Any route matching a key under agents selects that agent without changing eligibility.
      # For example, #route-claude selects agents.claude below.
  slack:
    provider: slack
    channels:
      - $SLACK_CHANNEL_ID
      # Direct-message channels (D...) are watched the same way.
      # - $SLACK_DM_CHANNEL_ID
    bot_user_id: $SLACK_BOT_USER_ID
    # Optional Socket Mode token (xapp-..., scope connections:write) for low-latency wake-ups.
    app_token: $SLACK_APP_TOKEN
    # Restrict issue creation and active-agent steering to known requesters when a channel has a
    # broad audience.
    # users:
    #   - $SLACK_REQUESTER_ID
    emoji_states:
      eyes: In Progress
      white_check_mark: Done
      x: Cancelled
    scan_lookback_days: 30
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
      # Any route matching a key under agents selects that agent without changing eligibility.
      # For example, #route-claude selects agents.claude below.
polling:
  # Gateway or Socket Mode events provide prompt wake-ups. Polling remains the recovery path.
  interval_ms: 60000
workspace:
  root: ~/dev/lorenz-workspaces
agent:
  kind: codex
  max_concurrent_agents: 10
  max_turns: 20
  skills:
    - ./skills/lorenz-commit
    - ./skills/lorenz-push
    - ./skills/lorenz-pull
    - ./skills/lorenz-land
    - ./skills/lorenz-debug
agents:
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
  codex:
    bridge_command: 'env CODEX_PATH="$(command -v codex)" codex-acp'
    provider_config:
      shell_environment_policy:
        inherit: all
      model_reasoning_effort: xhigh
      service_tier: flex
      model: gpt-5.6-sol
  claude:
    executor: acp
    bridge_command: 'env CLAUDE_CODE_EXECUTABLE="$(command -v claude)" claude-agent-acp'
    provider_config:
      model: claude-fable-5
      effortLevel: xhigh
      permissions:
        defaultMode: bypassPermissions
    strict_mcp_config: true
---

You are working on a chat issue `{{ issue.id }}`.

{% if attempt %}
Continuation context:

- This is retry attempt #{{ attempt }} because the issue remains active.
- Resume from the restored workspace and the tracker thread instead of restarting.
- Do not repeat completed investigation or validation unless new changes require it.
- Do not end the turn while the issue remains active unless a required permission or secret is
  unavailable.
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

## Tracker selection

This workflow defines Discord and Slack tracker bundles, but Lorenz mounts tools only for the
tracker selected by `tracker.kind`.

- A Discord issue id is `<channel-id>:<message-id>`, with numeric Discord snowflakes on both sides.
  Use only `discord_*` tools for it.
- A Slack issue id is `<channel-id>:<timestamp>`, where the channel starts with `C`, `D`, or `G`.
  Use only `slack_*` tools for it.
- There is no Linear tracker and no `linear_graphql` tool in this workflow.

## Discord contract

- Start by calling `discord_read_thread(issueId)`. The native Discord thread is authoritative for
  status, progress, and human follow-up.
- Lorenz acknowledges a newly dispatched `Todo` issue as `In Progress` before agent setup. If the
  thread is still `Todo`, set `In Progress` with `discord_update_status` before active work.
- Post the initial structured workpad with `discord_workpad`. Use `discord_comment` for later
  evidence, decisions, and milestone updates.
- Re-read the thread at milestones and immediately before finishing so late commands and scope
  changes are honored.
- Set `Done` with `discord_update_status` only after implementation and validation are complete.
- Reactions are a visual mirror, not the source of truth.
- Humans create work by mentioning the bot in a configured source channel or by choosing
  **Apps > Track with Lorenz** on an existing message. They change status with slash commands or
  the native buttons on a Workpad. There is no `discord_create_issue`.

## Slack contract

- Start by calling `slack_read_thread(issueId)`. The Slack thread is authoritative for status,
  progress, and human follow-up.
- Set `In Progress` with `slack_update_status` before active work.
- Post the plan, acceptance criteria, reproduction evidence, and milestones with `slack_comment`.
- Re-read the thread at milestones and immediately before finishing so late commands and scope
  changes are honored.
- Set `Done` with `slack_update_status` only after implementation and validation are complete.
- Reactions are a visual mirror, not the source of truth.
- Humans create work by mentioning the bot in a configured channel or thread. There is no
  `slack_create_issue`.

## Execution contract

1. This is an unattended orchestration session. Never ask a human to perform follow-up actions.
2. The per-issue workspace starts empty. Do not clone a repository unless the request requires
   repository access. When code work is required, clone the named repository or create the needed
   worktree inside this workspace before using repository-specific skills. For requests that can be
   answered from tracker context alone, respond without creating a checkout.
3. Read the selected tracker thread and route from the current status:
   - `Todo`: move to `In Progress`, then begin execution.
   - `In Progress`: resume from the workspace and existing thread notes.
   - `Done` or `Cancelled`: do nothing and stop.
4. Post a human-visible workpad. Use `discord_workpad` for Discord and `slack_comment` for Slack.
   Include:
   - a compact environment stamp: `<host>:<abs-workdir>@<short-sha>`
   - a hierarchical plan
   - acceptance criteria
   - validation commands
   - timestamped progress notes
5. Reproduce the current behavior before editing and record the evidence in the tracker thread.
6. Run the `lorenz-pull` skill before code edits and record the resulting revision.
7. Implement and validate against the workpad. Keep the tracker thread current at meaningful
   milestones.
8. Before every commit, run the `simplify` skill, then use `lorenz-commit` and `lorenz-push`.
9. Re-read the tracker thread before completion. Honor a human cancellation or scope change
   immediately.
10. Treat a tracker message delivered as a queued turn as current issue input. Reconcile it with
    the issue state and scope before continuing.
11. Mark the issue `Done` only when the acceptance criteria are complete, validation is green, and
   the pull request is open and green.
12. If blocked by missing required tools, authentication, or permissions, post one concise blocker
    note in the selected tracker thread and leave the issue in the appropriate non-terminal state.

Keep all checkouts and task changes inside the provided per-issue workspace. Do not modify other
working directories.
