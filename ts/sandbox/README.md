# Lorenz Demo Run

Run Lorenz end-to-end with pre-baked issues and a real Codex agent.

## Try it with no external tracker (`kind: local`)

The fastest way to try Lorenz is the local file-based board: no Linear API key, no
workspace, just a directory of `BOARD-<n>.md` files.

```bash
cd /home/coder/work/lorenz/ts
npx tsx sandbox/seed-local.ts
```

This writes a few sample issues (a couple in `Todo`, one in `In Progress`) into
`.lorenz/local/` via `@lorenz/local-tracker`'s `BoardStore`, so the ids and on-disk
format match what the running tracker expects.

- Seed a different directory: `npx tsx sandbox/seed-local.ts /tmp/demo-board`
- Seed fewer issues: `npx tsx sandbox/seed-local.ts .lorenz/local 2`

Point a workflow at the board with `tracker.kind: local` and `tracker.path: .lorenz/local`
(matching the directory you seeded), then run Lorenz as below.

There is no Slack equivalent of this seeder: Slack issues are real messages in a live
workspace, so they cannot be seeded offline. To exercise `kind: slack`, post a message in a
configured channel and add the "in progress" reaction yourself.

## Prerequisites (Linear demo)

- `LINEAR_API_KEY` and `LINEAR_PROJECT_SLUG` env vars set
- `codex` CLI available
- Project built: `pnpm build`

## Steps

### 1. Seed Linear issues

```bash
cd /home/coder/work/lorenz/ts
npx tsx demo/seed-issues.ts
```

This creates 3 simple coding tasks (hello_world.py, fibonacci.py, README.md) in your Linear project in "Todo" state.

Pass a number to create fewer: `npx tsx demo/seed-issues.ts 1`

### 2. Run Lorenz

```bash
pnpm start demo/DEMO_WORKFLOW.md --port 4040
```

This starts the orchestrator which will:

- Poll Linear for issues in "Todo" / "In Progress"
- Dispatch Codex to work on each issue in an isolated workspace under `/tmp/lorenz-demo-workspaces/`
- Serve the dashboard at http://localhost:4040

### 3. Inspect the dashboard

Open http://localhost:4040 in your browser to see:

- Running sessions (which issues are being worked on)
- Retry queue
- Token usage
- Live event stream

### 4. Inspect workspaces

Agent workspaces are at `/tmp/lorenz-demo-workspaces/<issue-id>/`. Check the files the agent created:

```bash
ls /tmp/lorenz-demo-workspaces/*/
```

### 5. Cleanup

Issues move to terminal states automatically when agents finish. To manually clean up:

```bash
rm -rf /tmp/lorenz-demo-workspaces
```

## Customization

- Edit `demo/DEMO_WORKFLOW.md` to change agent settings, concurrency, or prompt
- Edit `demo/seed-issues.ts` to add different task types
- Use `--no-tui` flag to see JSON snapshots instead of the terminal dashboard
