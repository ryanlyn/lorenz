---
tracker:
  kind: slack
  channels:
    - C0123456789
  bot_user_id: $SLACK_BOT_USER_ID
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
  emoji_states:
    rocket: Shipped
---

Slack workflow fixture (test only). Requires SLACK_BOT_TOKEN and SLACK_BOT_USER_ID in the environment.
