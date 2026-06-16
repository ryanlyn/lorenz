#!/usr/bin/env npx tsx
/**
 * Seeds pre-baked Linear issues for a Lorenz demo run.
 *
 * Usage:
 *   LINEAR_API_KEY=... LINEAR_PROJECT_SLUG=... npx tsx demo/seed-issues.ts
 *
 * Creates simple coding tasks that a Codex agent can complete quickly.
 */
import { LinearClient, parseConfig } from "@lorenz/cli";

const issues = [
  {
    title: "[Demo] Create hello_world.py",
    description: [
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
    description: [
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
    title: "[Demo] Create a README.md",
    description: [
      "Create a `README.md` file in the repo root with:",
      "",
      "- A title: `# Demo Workspace`",
      "- A one-line description: `This workspace is used for Lorenz demo runs.`",
      "- A section `## Scripts` listing `hello_world.py` and `fibonacci.py`",
    ].join("\n"),
  },
];

async function main() {
  const apiKey = process.env.LINEAR_API_KEY;
  const projectSlug = process.env.LINEAR_PROJECT_SLUG;
  if (!apiKey) throw new Error("LINEAR_API_KEY is required");
  if (!projectSlug) throw new Error("LINEAR_PROJECT_SLUG is required");

  const settings = parseConfig(
    {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_API_KEY",
        project_slug: `$LINEAR_PROJECT_SLUG`,
        active_states: ["Todo"],
        terminal_states: ["Done", "Canceled", "Cancelled", "Closed"],
      },
    },
    process.env,
  );

  const client = new LinearClient(settings);
  const viewer = await client.viewer();
  console.log(`Authenticated as: ${viewer.name ?? viewer.email ?? viewer.id}`);

  const project = await client.projectBySlug();
  console.log(`Project: ${projectSlug} (${project.id})`);

  const team = project.teams[0];
  if (!team) throw new Error("Project has no teams");
  console.log(`Team: ${team.key} (${team.id})`);

  const todoState =
    team.states.find((s) => s.name === "Todo") ??
    team.states.find((s) => s.type === "unstarted");
  if (!todoState) throw new Error("No Todo/unstarted state found");
  console.log(`Target state: ${todoState.name} (${todoState.id})\n`);

  const count = parseInt(process.argv[2] ?? String(issues.length), 10);
  const toCreate = issues.slice(0, count);

  for (const issue of toCreate) {
    const created = await client.createIssue({
      teamId: team.id,
      projectId: project.id,
      stateId: todoState.id,
      title: issue.title,
      description: issue.description,
      assigneeId: viewer.id,
    });
    console.log(`Created: ${created.identifier} — ${created.title}`);
    console.log(`  URL: ${created.url}`);
  }

  console.log(`\nDone! Created ${toCreate.length} issues in "${todoState.name}" state.`);
  console.log("Run Lorenz with: pnpm start demo/DEMO_WORKFLOW.md --port 4040");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
