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
import { startObservabilityServer, type ObservabilityServerHandle } from "@symphony/server";
import { configureLogFile } from "@symphony/log-file";
import { SymphonyRuntime } from "@symphony/runtime";
import { RuntimeApp } from "@symphony/tui";
import { loadWorkflow } from "@symphony/workflow";
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
  port: number | null;
  logsRoot: string | null;
}

interface CliCommanderOptions {
  once?: boolean;
  dryRun?: boolean;
  tui?: boolean;
  port?: number;
  logsRoot?: string;
}

export type CliParseResult = ParseResult<CliOptions>;
export const usageText = createDaemonCommand().helpInformation().trimEnd();

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

export const run = main;

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

    const runtime = new SymphonyRuntime({
      workflow,
      clientFactory: createTrackerClient,
      reloadWorkflow: loadRuntimeWorkflow,
      runner: runAgentAttempt,
      ...runtimeAdapters,
    });
    let server: ObservabilityServerHandle | null = null;
    const stop = () => runtime.stop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    const shouldStartServer =
      typeof workflow.settings.server.port === "number" ||
      workflow.settings.agent.kind === "claude";
    if (shouldStartServer) {
      server = await startObservabilityServer(runtime, {
        host: workflow.settings.server.host,
        port: workflow.settings.server.port ?? 0,
      });
      workflow.settings.server.port = server.port;
      boundServerPort = server.port;
      process.stderr.write(`Observability API listening on ${server.url("/")}\n`);
    }

    const instance =
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
