---
tracker:
  kind: linear
trackers:
  linear:
    provider: linear
    project_slug: $LINEAR_PROJECT_SLUG
    active_states:
      - Todo
      - In Progress
    terminal_states:
      - Done
      - Closed
      - Cancelled
      - Canceled
    dispatch:
      accept_unrouted: true

polling:
  interval_ms: 5000

workspace:
  root: /tmp/lorenz-demo-workspaces

hooks:
  after_create: |
    git init .
    git commit --allow-empty -m "initial"

agent:
  kind: codex
  max_concurrent_agents: 2
  max_turns: 10

agents:
  turn_timeout_ms: 120000
  stall_timeout_ms: 60000
  codex:
    bridge_command: codex-acp

server:
  port: 4040
---

You are working on issue {{ issue.identifier }}: {{ issue.title }}

Issue description:
{{ issue.description }}

Instructions:
1. Complete the task described above.
2. Create the requested files in the current working directory.
3. Do not create extra files beyond what is asked.
4. When done, report what you created.
