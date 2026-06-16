#!/usr/bin/env npx tsx
/**
 * Seeds a few sample issues into a LOCAL board so a user can try `tracker.kind: local`
 * immediately, without a Linear API key or workspace.
 *
 * Usage:
 *   npx tsx sandbox/seed-local.ts [dir] [count] [idPrefix]
 *
 * Arguments (all optional):
 *   dir       target board directory (default: .lorenz/local)
 *   count     how many of the sample issues to create (default: all of them)
 *   idPrefix  issue-id prefix to mint with (default: BOARD-); match your workflow's tracker.id_prefix
 *
 * Examples:
 *   npx tsx sandbox/seed-local.ts                       # seeds ./.lorenz/local
 *   npx tsx sandbox/seed-local.ts /tmp/demo-board       # seeds an explicit dir
 *   npx tsx sandbox/seed-local.ts .lorenz/local 2     # seeds only the first 2 issues
 *   npx tsx sandbox/seed-local.ts /tmp/demo-board 3 XXX- # seeds XXX-1..XXX-3
 *
 * Issues are written as `BOARD-<n>.md` files via @lorenz/local-tracker's BoardStore so
 * the ids and on-disk format stay correct and match what the running tracker expects.
 *
 * NOTE: there is intentionally no Slack equivalent of this seeder. Slack issues are real
 * messages in a live workspace, so they cannot be seeded offline - post a message and add
 * the configured "in progress" reaction in your Slack channel instead.
 */
import { BoardStore } from "@lorenz/local-tracker";

interface SeedIssue {
  title: string;
  body: string;
  status: string;
}

/**
 * Illustrative board issues spanning a couple of states so a first run shows both an
 * unstarted ("Todo") and an in-flight ("In Progress") item on the board.
 */
export const SEED_ISSUES: readonly SeedIssue[] = [
  {
    title: "[Demo] Create hello_world.py",
    status: "Todo",
    body: [
      "Create a Python script `hello_world.py` in the repo root that prints `Hello, World!` to stdout.",
      "",
      "Acceptance criteria:",
      "- File exists at `hello_world.py`",
      "- Running `python hello_world.py` outputs exactly `Hello, World!`",
      "- No other files are created or modified",
    ].join("\n"),
  },
  {
    title: "[Demo] Create a Fibonacci function",
    status: "Todo",
    body: [
      "Create a Python file `fibonacci.py` in the repo root with a function `fib(n)` that returns the nth Fibonacci number (0-indexed).",
      "",
      "Acceptance criteria:",
      "- `fib(0)` returns `0`",
      "- `fib(1)` returns `1`",
      "- `fib(10)` returns `55`",
      "- Include a `if __name__ == '__main__'` block that prints `fib(10)`",
    ].join("\n"),
  },
  {
    title: "[Demo] Document the demo workspace",
    status: "In Progress",
    body: [
      "Create a `README.md` file in the repo root with:",
      "",
      "- A title: `# Demo Workspace`",
      "- A one-line description: `This workspace is used for Lorenz demo runs.`",
      "- A section `## Scripts` listing `hello_world.py` and `fibonacci.py`",
    ].join("\n"),
  },
];

/**
 * Write the first `count` sample issues into `dir` via BoardStore.create and return the
 * created issues. BoardStore mints incrementing BOARD-<n> ids, so an existing board is
 * appended to rather than overwritten.
 */
export async function seedLocalBoard(
  dir: string,
  count: number = SEED_ISSUES.length,
  idPrefix?: string,
): Promise<{ id: string; title: string; state: string }[]> {
  const store = new BoardStore(dir, idPrefix !== undefined ? { idPrefix } : {});
  const created: { id: string; title: string; state: string }[] = [];
  for (const issue of SEED_ISSUES.slice(0, count)) {
    const result = await store.create({
      title: issue.title,
      body: issue.body,
      status: issue.status,
    });
    created.push({ id: result.id, title: result.title, state: result.state });
  }
  return created;
}

async function main(): Promise<void> {
  const dir = process.argv[2] ?? ".lorenz/local";
  const count = process.argv[3] ? parseInt(process.argv[3], 10) : SEED_ISSUES.length;
  const idPrefix = process.argv[4];

  const created = await seedLocalBoard(dir, count, idPrefix);
  for (const issue of created) {
    console.log(`Created: ${issue.id} [${issue.state}] - ${issue.title}`);
  }

  console.log(`\nDone! Wrote ${created.length} board issue(s) to ${dir}.`);
  console.log("Point tracker.path at this directory and run Lorenz with kind: local.");
}

// Only run when invoked directly (e.g. `npx tsx sandbox/seed-local.ts`), not when imported
// by a test that exercises seedLocalBoard / SEED_ISSUES.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
