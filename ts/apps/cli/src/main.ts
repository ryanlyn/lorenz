import path from "node:path";

import React from "react";
import { Command } from "commander";
import { render } from "ink";
import {
  commanderErrorMessage,
  configureCommandForMain,
  configureCommandForParse,
  hasHelpFlag,
  isCommanderHelp,
  parseNonNegativeInteger,
  parseRequiredValue,
  type ParseResult,
} from "@symphony/cli-kit";
import { validateDispatchConfig } from "@symphony/config";
import { startObservabilityServer } from "@symphony/server";
import { configureLogFile } from "@symphony/log-file";
import { SymphonyRuntime } from "@symphony/runtime";
import { RuntimeApp } from "@symphony/tui";
import { loadWorkflow } from "@symphony/workflow";
import { TraceEmitter } from "@symphony/traceviz-emitter";
import type { Settings, WorkflowDefinition } from "@symphony/domain";

import {
  createRunsCommand,
  runRunsCommand,
  runsOptionsFromCommanderOptions,
  type RunsCommanderOptions,
} from "./runs.js";
import {
  createTrackerClient,
  runAgentAttempt,
  runtimeAdapters,
  runtimeDefaultSettingsOptions,
} from "./daemon.js";

export interface CliOptions {
  workflowPath: string | null;
  once: boolean;
  dryRun: boolean;
  tui: boolean;
  dashboard: boolean;
  port: number | null;
  logsRoot: string | null;
}

interface CliCommanderOptions {
  once?: boolean;
  dryRun?: boolean;
  tui?: boolean;
  dashboard?: boolean;
  port?: number;
  logsRoot?: string;
}

export type CliParseResult = ParseResult<CliOptions>;

export function parseCliArgs(args: string[]): CliParseResult {
  const command = configureCommandForParse(createDaemonCommand());
  if (hasHelpFlag(args)) return { status: "help", message: command.helpInformation().trimEnd() };

  try {
    command.parse(args, { from: "user" });
  } catch (error) {
    return { status: "error", message: commanderErrorMessage(error) };
  }

  return { status: "ok", options: cliOptionsFromCommander(command.opts(), command.args[0]) };
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  let status = 0;
  const command = configureCommandForMain(createRootCommand());

  command.action(async (workflowPath: string | undefined, parsed: CliCommanderOptions) => {
    status = await runDaemon(cliOptionsFromCommander(parsed, workflowPath));
  });

  const runsCommand = createRunsCommand("runs");
  runsCommand.action(async () => {
    const rootOptions = command.opts<CliCommanderOptions>();
    const runsOptions = runsCommand.opts<RunsCommanderOptions>();
    process.stdout.write(
      await runRunsCommand(runsOptionsFromCommanderOptions({ ...rootOptions, ...runsOptions })),
    );
  });
  command.addCommand(runsCommand);

  try {
    await command.parseAsync(args, { from: "user" });
    return status;
  } catch (error) {
    if (isCommanderHelp(error)) return 0;
    process.stderr.write(`${commanderErrorMessage(error)}\n`);
    return 1;
  }
}

export async function runDaemon(options: CliOptions): Promise<number> {
  try {
    let boundServerPort: number | null = null;
    const loadRuntimeWorkflow = async () => {
      const workflow = await loadWorkflow(
        options.workflowPath ?? undefined,
        process.env,
        runtimeDefaultSettingsOptions(),
      );
      applyCliOverrides(workflow, options);
      if (boundServerPort !== null) workflow.settings.server.port = boundServerPort;
      validateDispatchConfig(workflow.settings);
      return workflow;
    };
    const workflow = await loadRuntimeWorkflow();
    await configureLogFile(workflow.settings.logging.logFile);

    const traceEmitter = new TraceEmitter(workflow.settings.server.traceDir!);
    const runtime = new SymphonyRuntime({
      workflow,
      clientFactory: createTrackerClient,
      reloadWorkflow: loadRuntimeWorkflow,
      runner: runAgentAttempt,
      onAgentUpdate: (issue, update) => {
        traceEmitter.emit(issue.id, issue.identifier, update);
      },
      ...runtimeAdapters,
    });
    let instance: ReturnType<typeof render> | null = null;
    // Persistent (not once) handlers so the graceful teardown below actually
    // runs to completion. With process.once, the listener is removed after the
    // first SIGINT; a second SIGINT — which Node + Ink can surface while the
    // daemon is still winding down — then hits the default disposition and kills
    // the process with code 130 mid-shutdown, before Ink restores the terminal.
    // That abrupt kill is what leaves a garbled/red error state on Ctrl+C.
    let shuttingDown = false;
    const requestStop = () => {
      if (shuttingDown) {
        // Repeated Ctrl+C: force-quit, but unmount Ink first so the terminal is
        // left clean rather than mid-render.
        instance?.unmount();
        process.exit(130);
      }
      shuttingDown = true;
      runtime.stop();
    };
    process.on("SIGINT", requestStop);
    process.on("SIGTERM", requestStop);

    let server: Awaited<ReturnType<typeof startObservabilityServer>> | null = null;
    if (options.dashboard) {
      server = await startObservabilityServer(runtime, {
        host: workflow.settings.server.host,
        port: workflow.settings.server.port ?? 0,
        ...(workflow.settings.server.traceDir !== undefined && {
          traceDir: workflow.settings.server.traceDir,
        }),
        ...(workflow.settings.server.staticDir !== undefined && {
          staticDir: workflow.settings.server.staticDir,
        }),
      });
      workflow.settings.server.port = server.port;
      boundServerPort = server.port;
      process.stderr.write(`Observability API listening on ${server.url("/")}\n`);
    }

    instance =
      options.tui && process.stdout.isTTY
        ? render(
            React.createElement(RuntimeApp, {
              runtime,
              dashboardUrl: server?.url("/") ?? null,
              projectUrl: projectUrlForSettings(workflow.settings),
            }),
          )
        : null;

    if (!instance) {
      runtime.subscribe((snapshot) => {
        process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
      });
    }

    try {
      await runtime.start({ once: options.once, dryRun: options.dryRun });
    } finally {
      // Leave the signal handlers attached through teardown so a second Ctrl+C
      // can't slip past them and kill the process mid-shutdown.
      instance?.unmount();
      await server?.stop();
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export function createDaemonCommand(name = "symphony-ts"): Command {
  return new Command(name)
    .description("Run the Symphony TypeScript orchestrator.")
    .allowExcessArguments(false)
    .argument("[workflowPath]", "Workflow markdown file.")
    .option("--once", "Poll once and exit.")
    .option("--dry-run", "Evaluate candidates without dispatching agents.")
    .option("--no-tui", "Disable the terminal dashboard.")
    .option("--no-dashboard", "Disable the web dashboard server.")
    .option(
      "--logs-root <path>",
      "Root directory for Symphony logs.",
      parseRequiredValue("--logs-root", "path"),
    )
    .option("--port <port>", "Observability API port.", parseNonNegativeInteger("--port"));
}

function createRootCommand(): Command {
  return createDaemonCommand("symphony-ts");
}

function cliOptionsFromCommander(parsed: CliCommanderOptions, workflowPath?: string): CliOptions {
  return {
    workflowPath: workflowPath ?? null,
    once: parsed.once ?? false,
    dryRun: parsed.dryRun ?? false,
    tui: parsed.tui ?? true,
    dashboard: parsed.dashboard ?? true,
    port: parsed.port ?? null,
    logsRoot: parsed.logsRoot ?? null,
  };
}

function applyCliOverrides(workflow: WorkflowDefinition, options: CliOptions): void {
  if (options.port !== null) workflow.settings.server.port = options.port;
  if (options.logsRoot !== null) {
    workflow.settings.logging.logFile = path.join(
      path.resolve(options.logsRoot),
      "log",
      "symphony.log",
    );
  }
}

export function projectUrlForSettings(settings: Settings): string | undefined {
  const slug = settings.tracker.projectSlug?.trim();
  if (!slug) return undefined;
  return `https://linear.app/project/${encodeURIComponent(slug)}/issues`;
}
