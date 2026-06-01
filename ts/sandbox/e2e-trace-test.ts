/**
 * End-to-end trace pipeline test.
 *
 * Runs a real agent (codex or claude) via the Symphony orchestrator against
 * a dummy in-memory issue, captures:
 *   1. Raw JSONL trace (all events, unfiltered) from the log file
 *   2. Filtered JSONL trace (from the TraceEmitter output)
 *
 * Then starts the dashboard server, uses Playwright to navigate to the trace
 * view, takes a screenshot, and asserts the traces were processed correctly.
 *
 * Usage:
 *   SYMPHONY_E2E_AGENT_KIND=codex npx tsx sandbox/e2e-trace-test.ts
 *   SYMPHONY_E2E_AGENT_KIND=claude npx tsx sandbox/e2e-trace-test.ts
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadWorkflow } from "@symphony/workflow";
import { SymphonyRuntime } from "@symphony/runtime";
import { TraceEmitter } from "@symphony/traceviz-emitter";
import { parseTraceLines } from "@symphony/traceviz-server";
import { startObservabilityServer } from "@symphony/server";
import { MemoryTrackerClient } from "@symphony/memory-tracker";
import { normalizeIssue } from "@symphony/issue";
import {
  runtimeAdapters,
  runtimeDefaultSettingsOptions,
} from "../apps/cli/src/daemon.js";
import { runAgentAttempt } from "../apps/cli/src/daemon.js";
import { configureLogFile } from "@symphony/log-file";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ISSUE_ID = "e2e-trace-test-001";
const ISSUE_IDENTIFIER = "E2E-1";

const TASK_DESCRIPTION = `Create a pyproject.toml file with httpx as a dependency, then echo the current datetime to stdout.`;

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
  kind: ${agentKind}
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
`;
}

async function runOrchestrator(): Promise<{ rawLogPath: string; traceJsonlPath: string }> {
  const agentKind = process.env.SYMPHONY_E2E_AGENT_KIND ?? "codex";
  console.log(`[e2e] Agent kind: ${agentKind}`);

  const issue = normalizeIssue({
    id: ISSUE_ID,
    identifier: ISSUE_IDENTIFIER,
    title: "Create pyproject.toml with httpx",
    description: TASK_DESCRIPTION,
    state: "Todo",
    stateType: "unstarted",
    labels: [],
    blockers: [],
  });

  const rawLogPath = path.join(LOG_DIR, "log", "symphony.log");

  const env = {
    ...process.env,
    SYMPHONY_MEMORY_TRACKER_ISSUES_JSON: JSON.stringify([issue]),
  } as unknown as NodeJS.ProcessEnv;

  const workflowPath = path.join(LOG_DIR, "WORKFLOW.md");
  await fs.writeFile(workflowPath, renderWorkflowContent(agentKind));
  const workflow = await loadWorkflow(workflowPath, env, runtimeDefaultSettingsOptions());

  workflow.settings.server.traceDir = TRACE_DIR;
  workflow.settings.logging.logFile = rawLogPath;

  await configureLogFile(rawLogPath);

  const traceEmitter = new TraceEmitter(TRACE_DIR);

  const trackerClient = new MemoryTrackerClient([issue]);
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

  console.log(`[e2e] Orchestrator completed (issue marked terminal).`);

  const traceJsonlPath = path.join(TRACE_DIR, ISSUE_IDENTIFIER, "trace.jsonl");
  return { rawLogPath, traceJsonlPath };
}

async function verifyTraces(rawLogPath: string, traceJsonlPath: string) {
  console.log(`[e2e] Verifying traces...`);

  // Check raw log exists and has content
  let rawLogExists = false;
  try {
    const rawLog = await fs.readFile(rawLogPath, "utf-8");
    rawLogExists = rawLog.trim().length > 0;
    const rawLines = rawLog.split("\n").filter((l) => l.trim());
    console.log(`[e2e] Raw log: ${rawLines.length} lines at ${rawLogPath}`);
  } catch {
    console.log(`[e2e] Raw log not found at ${rawLogPath} (this is OK if log-file is not wired)`);
  }

  // Check filtered trace exists
  const traceContent = await fs.readFile(traceJsonlPath, "utf-8");
  const traceLines = traceContent.split("\n").filter((l) => l.trim());
  console.log(`[e2e] Filtered trace: ${traceLines.length} lines at ${traceJsonlPath}`);

  if (traceLines.length === 0) {
    throw new Error("Filtered trace is empty - no events were emitted!");
  }

  // Parse the trace into DisplayEvents
  const events = parseTraceLines(traceLines);
  console.log(`[e2e] Parsed ${events.length} DisplayEvents from trace`);

  const kinds = new Set(events.map((e) => e.kind));
  console.log(`[e2e] Event kinds: ${[...kinds].join(", ")}`);

  // Verify we got meaningful events
  if (!kinds.has("turn_started")) {
    throw new Error("Expected at least one turn_started event");
  }

  return { rawLogExists, traceLineCount: traceLines.length, eventCount: events.length, kinds: [...kinds] };
}

async function screenshotDashboard(traceJsonlPath: string): Promise<string> {
  console.log(`[e2e] Starting dashboard server...`);

  // Create a minimal runtime source for the server
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

  // Give the watcher time to pick up trace files
  await new Promise((r) => setTimeout(r, 2000));

  let screenshotPath: string;
  try {
    const { chromium } = await import("playwright");

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    // Navigate to the trace list
    const traceListUrl = `${server.url("/")}#/trace/`;
    console.log(`[e2e] Navigating to trace list: ${traceListUrl}`);
    await page.goto(traceListUrl);
    await page.waitForTimeout(2000);

    screenshotPath = path.join(SCREENSHOT_DIR, "trace-list.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[e2e] Screenshot (trace list): ${screenshotPath}`);

    // Navigate to the specific trace
    const traceViewUrl = `${server.url("/")}#/trace/${ISSUE_ID}`;
    console.log(`[e2e] Navigating to trace view: ${traceViewUrl}`);
    await page.goto(traceViewUrl);
    await page.waitForTimeout(2000);

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

  await cleanDirs();

  const { rawLogPath, traceJsonlPath } = await runOrchestrator();
  const verification = await verifyTraces(rawLogPath, traceJsonlPath);

  console.log("\n[e2e] Trace verification results:");
  console.log(JSON.stringify(verification, null, 2));

  const screenshotPath = await screenshotDashboard(traceJsonlPath);

  console.log("\n=== E2E Test PASSED ===");
  console.log(`Filtered trace: ${traceJsonlPath}`);
  console.log(`Raw log: ${rawLogPath}`);
  console.log(`Screenshot: ${screenshotPath}`);
  console.log(`Events: ${verification.eventCount} (${verification.kinds.join(", ")})`);
}

main().catch((err) => {
  console.error("\n=== E2E Test FAILED ===");
  console.error(err);
  process.exit(1);
});
