# Symphony Demo Run

Run Symphony end-to-end with pre-baked Linear issues and a real Codex agent.

## Prerequisites

- `LINEAR_API_KEY` and `LINEAR_PROJECT_SLUG` env vars set
- `codex` CLI available
- Project built: `pnpm build`

## Steps

### 1. Seed Linear issues

```bash
cd /home/coder/work/symphony/ts
npx tsx demo/seed-issues.ts
```

This creates 3 simple coding tasks (hello_world.py, fibonacci.py, README.md) in your Linear project in "Todo" state.

Pass a number to create fewer: `npx tsx demo/seed-issues.ts 1`

### 2. Run Symphony

```bash
pnpm start demo/DEMO_WORKFLOW.md --port 4040
```

This starts the orchestrator which will:
- Poll Linear for issues in "Todo" / "In Progress"
- Dispatch Codex to work on each issue in an isolated workspace under `/tmp/symphony-demo-workspaces/`
- Serve the dashboard at http://localhost:4040

### 3. Inspect the dashboard

Open http://localhost:4040 in your browser to see:
- Running sessions (which issues are being worked on)
- Retry queue
- Token usage
- Live event stream

### 4. Inspect workspaces

Agent workspaces are at `/tmp/symphony-demo-workspaces/<issue-id>/`. Check the files the agent created:

```bash
ls /tmp/symphony-demo-workspaces/*/
```

### 5. Cleanup

Issues move to terminal states automatically when agents finish. To manually clean up:

```bash
rm -rf /tmp/symphony-demo-workspaces
```

## Customization

- Edit `demo/DEMO_WORKFLOW.md` to change agent settings, concurrency, or prompt
- Edit `demo/seed-issues.ts` to add different task types
- Use `--no-tui` flag to see JSON snapshots instead of the terminal dashboard
