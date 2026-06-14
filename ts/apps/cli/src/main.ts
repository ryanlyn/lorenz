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
import { checkSlotsPerMachineGate } from "@symphony/dispatch-coordinator";
import { startObservabilityServer } from "@symphony/server";
import { configureLogFile } from "@symphony/log-file";
import { SymphonyRuntime } from "@symphony/runtime";
import { RuntimeApp } from "@symphony/tui";
import { loadWorkflow } from "@symphony/workflow";
import { defaultAgentExecutorRegistry } from "@symphony/agent-sdk";
import { defaultToolRegistry } from "@symphony/tool-sdk";
import { defaultTrackerRegistry } from "@symphony/tracker-sdk";
import { TraceEmitter } from "@symphony/traceviz-emitter";
import { defaultIssueStorePath, IssueStore } from "@symphony/server";
import { errorMessage, type Settings, type WorkflowDefinition } from "@symphony/domain";

import {
  createRunsCommand,
  runRunsCommand,
  runsOptionsFromCommanderOptions,
  type RunsCommanderOptions,
} from "./runs.js";
import {
  createDoctorCommand,
  doctorOptionsFromCommanderOptions,
  renderDoctorReport,
  runDoctorCommand,
  type DoctorCommanderOptions,
} from "./doctor.js";
import {
  buildDispatchCoordinator,
  createTrackerClient,
  runAgentAttempt,
  registerBuiltinBackends,
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
  registerBuiltinBackends();
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

  const doctorCommand = createDoctorCommand("doctor");
  doctorCommand.action(async (workflowPath: string | undefined, parsed: DoctorCommanderOptions) => {
    const rootOptions = command.opts<CliCommanderOptions>();
    const doctorOptions = doctorOptionsFromCommanderOptions(parsed, workflowPath, rootOptions);
    const report = await runDoctorCommand(doctorOptions);
    process.stdout.write(renderDoctorReport(report));
    status = report.status === "error" ? 1 : 0;
  });
  command.addCommand(doctorCommand);

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
  registerBuiltinBackends();
  try {
    let boundServerPort: number | null = null;
    const loadRuntimeWorkflow = async () => {
      const workflow = await loadWorkflow(options.workflowPath ?? undefined, process.env, {
        ...runtimeDefaultSettingsOptions(),
        trackers: defaultTrackerRegistry,
      });
      applyCliOverrides(workflow, options);
      if (boundServerPort !== null) workflow.settings.server.port = boundServerPort;
      validateDispatchConfig(
        workflow.settings,
        defaultTrackerRegistry,
        defaultAgentExecutorRegistry,
        defaultToolRegistry,
      );
      return workflow;
    };
    const workflow = await loadRuntimeWorkflow();
    await configureLogFile(workflow.settings.logging.logFile);

    // baseDir anchors `./relative` driver module specifiers to the workflow
    // file's directory - the most predictable anchor for operators.
    const coordinator = await buildDispatchCoordinator(workflow.settings, process.env, {
      baseDir: path.dirname(workflow.path),
    });
    // Post-construction gate: slotsPerMachine>1 is only safe once the coordinator
    // advertises per-run MCP endpoints AND the operator has explicitly opted into
    // co-residence (a poisoned worker fails every co-resident run on recycle). The
    // capability is known only here, after the coordinator exists, so this is the
    // right home for the check (validateDispatchConfig stays capability-free).
    assertSlotsPerMachineGate(workflow.settings, coordinator);
    const traceDir = workflow.settings.server.traceDir!;
    const traceEmitter = new TraceEmitter(traceDir);
    const issueStore = new IssueStore(defaultIssueStorePath());
    const runtime = new SymphonyRuntime({
      workflow,
      clientFactory: createTrackerClient,
      reloadWorkflow: loadRuntimeWorkflow,
      runner: runAgentAttempt,
      coordinator,
      validateDispatch: (settings) =>
        validateDispatchConfig(
          settings,
          defaultTrackerRegistry,
          defaultAgentExecutorRegistry,
          defaultToolRegistry,
        ),
      onAgentUpdate: (issue, update) => {
        traceEmitter.emit(issue.id, issue.identifier, update);
      },
      onIssueDispatched: (issue) => {
        issueStore.upsert({
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          title: issue.title,
          url: issue.url ?? null,
        });
      },
      ...runtimeAdapters,
    });
    await coordinator?.hydrate();
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
    try {
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
          issueStore,
          tools: defaultToolRegistry,
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

      await runtime.start({ once: options.once, dryRun: options.dryRun });
      return 0;
    } finally {
      // Leave the signal handlers attached through teardown so a second Ctrl+C
      // can't slip past them and kill the process mid-shutdown.
      try {
        instance?.unmount();
        // start() returns once stop() flips the runtime to stopped; drain paid
        // cloud workers before tearing down the server so they are destroyed on exit.
        await runtime.drainWorkerPool();
        await server?.stop();
        issueStore.close();
      } finally {
        process.off("SIGINT", requestStop);
        process.off("SIGTERM", requestStop);
      }
    }
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }
}

function createDaemonCommand(name = "symphony-ts"): Command {
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
  return defaultTrackerRegistry.providerFor(settings)?.projectUrl?.(settings);
}

/**
 * Post-construction blast-radius gate for `worker.worker_pool.slots_per_machine > 1`
 * (the canonical field behind the legacy `max_in_flight` key). Co-residence packs
 * multiple run slots onto one machine, so it requires BOTH:
 *
 *  1. a coordinator that advertises `capabilities.perRunEndpoint === true` (each
 *     RunSlot owns its own MCP endpoint - token + local-server + tunnel - so two
 *     co-resident runs never share or tear out each other's endpoint), and
 *  2. an explicit `worker.worker_pool.co_residence` operator opt-in, because a single
 *     poisoned worker fails every co-resident run on recycle: widening that blast
 *     radius is a deliberate tradeoff, not just a capability.
 *
 * `slotsPerMachine === 1` (the default) always passes - the gate never triggers, so
 * the single-tenant startup path stays byte-identical. This lives in the daemon
 * rather than {@link validateDispatchConfig} because the per-run-endpoint capability
 * only exists once the coordinator has been constructed; the per-poll config
 * validation must stay capability-free.
 */
export function assertSlotsPerMachineGate(
  settings: Settings,
  coordinator: { readonly capabilities: { readonly perRunEndpoint: boolean } } | undefined,
): void {
  // Delegate to the shared PURE predicate so this STARTUP gate and the runtime
  // RELOAD guard enforce byte-identical rules (no drift). `null` means safe; a
  // string is the operator-facing failure message, which the daemon throws.
  const message = checkSlotsPerMachineGate(settings.worker.workerPool, coordinator?.capabilities);
  if (message !== null) throw new Error(message);
}
