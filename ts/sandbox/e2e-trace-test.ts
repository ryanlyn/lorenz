/**
 * End-to-end trace pipeline test.
 *
 * Runs a real agent (codex or claude) via the Symphony orchestrator against
 * a real Linear issue, captures:
 *   1. Raw JSONL trace (all events, unfiltered) from the log file
 *   2. Filtered JSONL trace (from the TraceEmitter output)
 *
 * Then starts the dashboard server, uses Playwright to navigate to the trace
 * view, takes a screenshot, and asserts the traces were processed correctly.
 *
 * Requires:
 *   LINEAR_API_KEY          - Linear API key
 *   LINEAR_PROJECT_SLUG     - Linear project slug
 *
 * Usage:
 *   SYMPHONY_E2E_AGENT_KIND=codex npx tsx sandbox/e2e-trace-test.ts
 *   SYMPHONY_E2E_AGENT_KIND=claude npx tsx sandbox/e2e-trace-test.ts
 */

import fs from "node:fs/promises";
import path from "node:path";

import { LinearClient, parseConfig, loadWorkflow } from "@symphony/cli";
import { SymphonyRuntime } from "@symphony/runtime";
import { TraceEmitter } from "@symphony/traceviz-emitter";
import { parseTraceLines } from "@symphony/traceviz-server";
import { startObservabilityServer } from "@symphony/server";
import { configureLogFile } from "@symphony/log-file";
import {
  registerBuiltinBackends,
  runtimeAdapters,
  runtimeDefaultSettingsOptions,
  createTrackerClient,
} from "../apps/cli/src/daemon.js";
import { runAgentAttempt } from "../apps/cli/src/daemon.js";

const TASK_DESCRIPTION = `Create a pyproject.toml file with httpx as a dependency, then echo the current datetime to stdout. When done, mark the linear issue as Done`;

const TRACE_DIR = "/tmp/symphony-e2e-traces";
const WORKSPACE_ROOT = "/tmp/symphony-e2e-workspaces";
const LOG_DIR = "/tmp/symphony-e2e-logs";
const SCREENSHOT_DIR = "/tmp/symphony-e2e-screenshots";

async function cleanDirs() {
  for (const dir of [TRACE_DIR, WORKSPACE_ROOT, LOG_DIR, SCREENSHOT_DIR]) {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
  }
}

function renderWorkflowContent(agentKind: string): string {
  return `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: $LINEAR_PROJECT_SLUG
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
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
  kind: ${agentKind}
  max_concurrent_agents: 1
  max_turns: 10

agents:
  codex:
    bridge_command: codex-acp
    turn_timeout_ms: 180000
    stall_timeout_ms: 60000
  claude:
    bridge_command: claude-agent-acp
    turn_timeout_ms: 360000
    stall_timeout_ms: 300000
    provider_config:
      permission_mode: dontAsk

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
`;
}

async function createLinearIssue(): Promise<{ issueId: string; issueIdentifier: string }> {
  const apiKey = process.env.LINEAR_API_KEY;
  const projectSlug = process.env.LINEAR_PROJECT_SLUG;
  if (!apiKey) throw new Error("LINEAR_API_KEY is required");
  if (!projectSlug) throw new Error("LINEAR_PROJECT_SLUG is required");

  const settings = parseConfig(
    {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_API_KEY",
        project_slug: "$LINEAR_PROJECT_SLUG",
        active_states: ["Todo", "In Progress"],
        terminal_states: ["Done", "Canceled", "Cancelled", "Duplicate", "Closed"],
      },
    },
    process.env,
    runtimeDefaultSettingsOptions(),
  );

  const client = new LinearClient(settings);
  const project = await client.projectBySlug();
  const team = project.teams[0];
  if (!team) throw new Error("Linear project has no teams");

  const todoState =
    team.states.find((s) => s.name === "Todo") ?? team.states.find((s) => s.type === "unstarted");
  if (!todoState) throw new Error("No Todo/unstarted state found");

  const marker = `e2e-trace-${Date.now()}`;
  const issue = await client.createIssue({
    teamId: team.id,
    projectId: project.id,
    stateId: todoState.id,
    title: `[${marker}] Create pyproject.toml with httpx`,
    description: [
      TASK_DESCRIPTION,
      "",
      `Marker: ${marker}`,
      "Temporary issue created by Symphony E2E trace test. Will be archived on completion.",
    ].join("\n"),
  });

  console.log(`[e2e] Created Linear issue: ${issue.identifier} (${issue.id})`);
  return { issueId: issue.id, issueIdentifier: issue.identifier };
}

async function runOrchestrator(
  issueId: string,
  issueIdentifier: string,
): Promise<{ rawLogPath: string; traceJsonlPath: string }> {
  const agentKind = process.env.SYMPHONY_E2E_AGENT_KIND ?? "codex";
  console.log(`[e2e] Agent kind: ${agentKind}`);

  const rawLogPath = path.join(LOG_DIR, "log", "symphony.log");

  const workflowPath = path.join(LOG_DIR, "WORKFLOW.md");
  await fs.writeFile(workflowPath, renderWorkflowContent(agentKind));
  const workflow = await loadWorkflow(workflowPath, process.env, runtimeDefaultSettingsOptions());

  workflow.settings.server.traceDir = TRACE_DIR;
  workflow.settings.logging.logFile = rawLogPath;

  await configureLogFile(rawLogPath);

  const traceEmitter = new TraceEmitter(TRACE_DIR);

  const trackerClient = createTrackerClient(workflow.settings, process.env);
  const runtime = new SymphonyRuntime({
    workflow,
    clientFactory: () => trackerClient,
    reloadWorkflow: async () => workflow,
    runner: runAgentAttempt,
    onAgentUpdate: (iss, update) => {
      traceEmitter.emit(iss.id, iss.identifier, update);
    },
    ...runtimeAdapters,
  });

  console.log(`[e2e] Starting orchestrator (--once mode)...`);
  await runtime.start({ once: true, dryRun: false });

  await traceEmitter.drain();
  console.log(`[e2e] Orchestrator completed.`);

  const traceJsonlPath = path.join(TRACE_DIR, issueIdentifier, "trace.jsonl");
  return { rawLogPath, traceJsonlPath };
}

async function cleanupLinearIssue(issueId: string) {
  const settings = parseConfig(
    {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_API_KEY",
        project_slug: "$LINEAR_PROJECT_SLUG",
        active_states: ["Todo", "In Progress"],
        terminal_states: ["Done", "Canceled", "Cancelled", "Duplicate", "Closed"],
      },
    },
    process.env,
    runtimeDefaultSettingsOptions(),
  );

  const client = new LinearClient(settings);
  const project = await client.projectBySlug();
  const team = project.teams[0];
  const doneState =
    team?.states.find((s) => s.name === "Done") ??
    team?.states.find((s) => s.type === "completed");

  if (doneState) {
    await client.updateIssueState(issueId, doneState.id);
  }
  await client.archiveIssue(issueId);
  console.log(`[e2e] Archived Linear issue ${issueId}`);
}

async function verifyTraces(rawLogPath: string, traceJsonlPath: string) {
  console.log(`[e2e] Verifying traces...`);

  try {
    const rawLog = await fs.readFile(rawLogPath, "utf-8");
    const rawLines = rawLog.split("\n").filter((l) => l.trim());
    console.log(`[e2e] Raw log: ${rawLines.length} lines at ${rawLogPath}`);
  } catch {
    console.log(`[e2e] Raw log not found at ${rawLogPath} (this is OK if log-file is not wired)`);
  }

  const traceContent = await fs.readFile(traceJsonlPath, "utf-8");
  const traceLines = traceContent.split("\n").filter((l) => l.trim());
  console.log(`[e2e] Filtered trace: ${traceLines.length} lines at ${traceJsonlPath}`);

  if (traceLines.length === 0) {
    throw new Error("Filtered trace is empty - no events were emitted!");
  }

  const events = parseTraceLines(traceLines);
  console.log(`[e2e] Parsed ${events.length} DisplayEvents from trace`);

  const kinds = new Set(events.map((e) => e.kind));
  console.log(`[e2e] Event kinds: ${[...kinds].join(", ")}`);

  if (!kinds.has("turn_started")) {
    throw new Error("Expected at least one turn_started event");
  }

  return { traceLineCount: traceLines.length, eventCount: events.length, kinds: [...kinds] };
}

async function screenshotDashboard(traceJsonlPath: string, issueId: string): Promise<string> {
  console.log(`[e2e] Starting dashboard server...`);

  const runtimeSource = {
    workflow: undefined,
    snapshot: () => ({ sessions: [], completedIssues: [], retryQueue: [], usage: {} } as any),
    subscribe: () => () => {},
    requestRefresh: () => ({}),
  };

  const server = await startObservabilityServer(runtimeSource, {
    host: "127.0.0.1",
    port: 0,
    traceDir: TRACE_DIR,
  });

  console.log(`[e2e] Dashboard listening at ${server.url("/")}`);

  await new Promise((r) => setTimeout(r, 2000));

  let screenshotPath: string;
  try {
    const { chromium } = await import("playwright");

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    const traceListUrl = `${server.url("/")}#/trace/`;
    console.log(`[e2e] Navigating to trace list: ${traceListUrl}`);
    await page.goto(traceListUrl);
    await page.waitForTimeout(3000);

    screenshotPath = path.join(SCREENSHOT_DIR, "trace-list.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[e2e] Screenshot (trace list): ${screenshotPath}`);

    // Navigate to the specific trace detail view using the Linear issue UUID
    const traceViewUrl = `${server.url("/")}#/trace/${encodeURIComponent(issueId)}`;
    console.log(`[e2e] Navigating to trace view: ${traceViewUrl}`);
    await page.goto(traceViewUrl);
    await page.waitForTimeout(3000);

    // Expand the turn to show all events
    const expandBtn = page.getByRole("button", { name: "Expand all" });
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
      await page.waitForTimeout(1000);
    }

    const traceViewScreenshot = path.join(SCREENSHOT_DIR, "trace-view.png");
    await page.screenshot({ path: traceViewScreenshot, fullPage: true });
    console.log(`[e2e] Screenshot (trace view): ${traceViewScreenshot}`);

    await browser.close();
    screenshotPath = traceViewScreenshot;
  } finally {
    await server.stop();
  }

  return screenshotPath;
}

async function main() {
  console.log("=== Symphony E2E Trace Pipeline Test ===\n");

  registerBuiltinBackends();
  await cleanDirs();

  const { issueId, issueIdentifier } = await createLinearIssue();

  try {
    const { rawLogPath, traceJsonlPath } = await runOrchestrator(issueId, issueIdentifier);
    const verification = await verifyTraces(rawLogPath, traceJsonlPath);

    console.log("\n[e2e] Trace verification results:");
    console.log(JSON.stringify(verification, null, 2));

    const screenshotPath = await screenshotDashboard(traceJsonlPath, issueId);

    console.log("\n=== E2E Test PASSED ===");
    console.log(`Filtered trace: ${traceJsonlPath}`);
    console.log(`Raw log: ${rawLogPath}`);
    console.log(`Screenshot: ${screenshotPath}`);
    console.log(`Events: ${verification.eventCount} (${verification.kinds.join(", ")})`);
  } finally {
    await cleanupLinearIssue(issueId);
  }
}

main().catch((err) => {
  console.error("\n=== E2E Test FAILED ===");
  console.error(err);
  process.exit(1);
});
