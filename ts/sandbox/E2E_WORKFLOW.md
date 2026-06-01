---
tracker:
  kind: memory
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Cancelled
  dispatch:
    accept_unrouted: true

polling:
  interval_ms: 2000

workspace:
  root: /tmp/symphony-e2e-workspaces

hooks:
  after_create: |
    git init .
    git commit --allow-empty -m "initial"

agent:
  kind: ${SYMPHONY_E2E_AGENT_KIND:-codex}
  max_concurrent_agents: 1
  max_turns: 10

codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_timeout_ms: 180000
  stall_timeout_ms: 60000

claude:
  command: claude-agent-acp
  model: claude-sonnet-4-6
  permission_mode: dontAsk
  turn_timeout_ms: 360000
  stall_timeout_ms: 300000

server:
  port: 0
  traceDir: /tmp/symphony-e2e-traces
---

You are working on issue {{ issue.identifier }}: {{ issue.title }}

Issue description:
{{ issue.description }}

Instructions:
1. Complete the task described above.
2. Create the requested files in the current working directory.
3. Do not create extra files beyond what is asked.
4. When done, report what you created.
