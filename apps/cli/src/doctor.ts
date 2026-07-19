import { constants } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { Command } from "commander";
import {
  collectConfigDeprecations,
  formatConfigDeprecation,
  validateDispatchConfig,
} from "@lorenz/config";
import { errorMessage, type Settings } from "@lorenz/domain";
import { loadWorkflow, workflowFilePath } from "@lorenz/workflow";
import { defaultAgentExecutorRegistry } from "@lorenz/agent-sdk";
import { resolveBridgeCommand } from "@lorenz/acp";
import { defaultToolRegistry } from "@lorenz/tool-sdk";
import { defaultTrackerRegistry } from "@lorenz/tracker-sdk";

import {
  agentCliRequirement,
  bridgeCommandRequirements,
  findExecutable,
  requiredBridgeCommandUses,
  type AgentCliRequirement,
  type BridgeCommandUse,
} from "./bridgeCommand.js";
import {
  commanderErrorMessage,
  configureCommandForParse,
  hasHelpFlag,
  parseRequiredValue,
  type ParseResult,
} from "./commander.js";
import { registerBuiltinBackends, runtimeDefaultSettingsOptions } from "./daemon.js";
import { accumulateOption, resolveAppFlags } from "./flags-manifest.js";

type DoctorCheckStatus = "ok" | "warning" | "error";

interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  details?: Record<string, string | number | boolean | null> | undefined;
}

export interface DoctorReport {
  status: DoctorCheckStatus;
  workflowPath: string;
  checks: DoctorCheck[];
}

export interface DoctorCommandOptions {
  workflowPath: string | null;
  dashboard: boolean;
  logsRoot: string | null;
  // Optional so existing/programmatic callers of the exported runDoctorCommand stay
  // source-compatible; the resolver treats absent arrays as "no CLI overrides".
  flagTokens?: string[];
  featureTokens?: string[];
}

export interface DoctorCommanderOptions {
  dashboard?: boolean;
  logsRoot?: string;
  flag?: string[];
  feature?: string[];
}

export interface DoctorInheritedOptions {
  dashboard?: boolean | undefined;
  logsRoot?: string | undefined;
  flag?: string[] | undefined;
  feature?: string[] | undefined;
}

interface DoctorRunContext {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export type DoctorParseResult = ParseResult<DoctorCommandOptions>;

export function createDoctorCommand(name = "lorenz doctor"): Command {
  return new Command(name)
    .description("Validate a Lorenz workflow and local runtime prerequisites.")
    .allowExcessArguments(false)
    .argument("[workflowPath]", "Workflow markdown file.")
    .option("--no-dashboard", "Skip dashboard static asset checks.")
    .option(
      "--logs-root <path>",
      "Root directory for Lorenz logs.",
      parseRequiredValue("--logs-root", "path"),
    )
    .option(
      "--flag <key=value>",
      "Override an internal feature flag (repeatable).",
      accumulateOption,
    )
    .option(
      "--feature <name|name=bool>",
      "Enable or disable an internal feature preset (repeatable).",
      accumulateOption,
    );
}

export function parseDoctorArgs(args: string[]): DoctorParseResult {
  const command = configureCommandForParse(createDoctorCommand());
  if (hasHelpFlag(args)) return { status: "help", message: command.helpInformation().trimEnd() };

  try {
    command.parse(args, { from: "user" });
  } catch (error) {
    return { status: "error", message: commanderErrorMessage(error) };
  }

  return {
    status: "ok",
    options: doctorOptionsFromCommanderOptions(
      command.opts<DoctorCommanderOptions>(),
      command.args[0],
    ),
  };
}

export function doctorOptionsFromCommanderOptions(
  parsed: DoctorCommanderOptions,
  workflowPath?: string,
  inherited: DoctorInheritedOptions = {},
): DoctorCommandOptions {
  return {
    workflowPath: workflowPath ?? null,
    dashboard: parsed.dashboard === false || inherited.dashboard === false ? false : true,
    logsRoot: parsed.logsRoot ?? inherited.logsRoot ?? null,
    // Flag/feature tokens compose across the root and subcommand (unlike the scalar options above):
    // inherited root tokens come first, then local ones, so both apply and a local token wins per
    // key via the resolver's last-wins-within-a-layer rule.
    flagTokens: [...(inherited.flag ?? []), ...(parsed.flag ?? [])],
    featureTokens: [...(inherited.feature ?? []), ...(parsed.feature ?? [])],
  };
}

export async function runDoctorMain(args: string[]): Promise<string> {
  const parsed = parseDoctorArgs(args);
  if (parsed.status === "help") return `${parsed.message}\n`;
  if (parsed.status === "error") throw new Error(parsed.message);
  const report = await runDoctorCommand(parsed.options);
  return renderDoctorReport(report);
}

export async function runDoctorCommand(
  options: DoctorCommandOptions,
  context: DoctorRunContext = {},
): Promise<DoctorReport> {
  registerBuiltinBackends();
  const env = context.env ?? process.env;
  const cwd = context.cwd ?? process.cwd();
  const resolvedWorkflowPath = resolveWorkflowPath(options.workflowPath, env, cwd);
  const checks: DoctorCheck[] = [];

  const workflowFile = await checkWorkflowFile(resolvedWorkflowPath);
  checks.push(workflowFile);
  if (workflowFile.status === "error") return doctorReport(resolvedWorkflowPath, checks);

  let workflow;
  try {
    // Doctor is a STATIC validator: it does not dynamic-import out-of-tree
    // extensions (the daemon does that at startup). An out-of-tree `tracker.kind`
    // module specifier surfaces through `dispatch_config` as an unsupported kind,
    // listing the registered kinds - the same fail-loud surface as any unknown
    // kind - without running arbitrary extension code in the doctor process.
    workflow = await loadWorkflow(resolvedWorkflowPath, env, {
      ...runtimeDefaultSettingsOptions(),
      cwd,
      trackers: defaultTrackerRegistry,
      executors: defaultAgentExecutorRegistry,
    });
    checks.push({
      id: "workflow_load",
      status: "ok",
      message: "Workflow loaded and parsed.",
      details: { path: workflow.path },
    });
  } catch (error) {
    checks.push({
      id: "workflow_load",
      status: "error",
      message: `Workflow failed to load: ${errorMessage(error)}`,
      details: { path: resolvedWorkflowPath },
    });
    return doctorReport(resolvedWorkflowPath, checks);
  }

  applyDoctorOverrides(workflow.settings, options);
  checks.push(...checkConfigDeprecations(workflow.config));
  checks.push(checkFlags(workflow.config, options, env));
  checks.push(checkDispatchConfig(workflow.settings));
  checks.push(await checkDashboardAssets(workflow.settings, options.dashboard));
  checks.push(await checkLogPath(workflow.settings.logging.logFile));
  checks.push(...(await checkAgentBridgeCommands(workflow.settings, env)));
  return doctorReport(workflow.path, checks);
}

export function renderDoctorReport(report: DoctorReport): string {
  return `${[
    "Lorenz doctor",
    `status=${report.status}`,
    `workflow=${report.workflowPath}`,
    "",
    ...report.checks.map((check) => `[${check.status}] ${check.id}: ${check.message}`),
  ].join("\n")}\n`;
}

function resolveWorkflowPath(
  workflowPath: string | null,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  const resolved = workflowPath ?? workflowFilePath(env, cwd);
  return path.isAbsolute(resolved) ? resolved : path.resolve(cwd, resolved);
}

async function checkWorkflowFile(workflowPath: string): Promise<DoctorCheck> {
  try {
    const stat = await fs.stat(workflowPath);
    if (!stat.isFile()) {
      return {
        id: "workflow_file",
        status: "error",
        message: `Workflow path is not a file: ${workflowPath}`,
        details: { path: workflowPath },
      };
    }
    await fs.access(workflowPath, constants.R_OK);
    return {
      id: "workflow_file",
      status: "ok",
      message: `Workflow file is readable: ${workflowPath}`,
      details: { path: workflowPath, size: stat.size },
    };
  } catch (error) {
    return {
      id: "workflow_file",
      status: "error",
      message: `Workflow file is not readable: ${workflowPath} ${errorMessage(error)}`,
      details: { path: workflowPath },
    };
  }
}

function checkConfigDeprecations(rawConfig: Record<string, unknown>): DoctorCheck[] {
  const deprecations = collectConfigDeprecations(rawConfig);
  if (deprecations.length === 0) {
    return [
      {
        id: "config_deprecations",
        status: "ok",
        message: "No deprecated configuration keys are in use.",
      },
    ];
  }
  return deprecations.map((dep) => ({
    id: `config_deprecation_${safeCheckId(dep.configPath)}`,
    status: "warning",
    message: formatConfigDeprecation(dep),
    details: { key: dep.configPath, replacement: dep.replacement },
  }));
}

function checkFlags(
  config: Record<string, unknown>,
  options: DoctorCommandOptions,
  env: NodeJS.ProcessEnv,
): DoctorCheck {
  try {
    const flags = resolveAppFlags(
      { flagTokens: options.flagTokens, featureTokens: options.featureTokens },
      config,
      env,
      { warn: () => {} },
    );
    const details: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(flags.values)) {
      details[key] =
        `${JSON.stringify(value)} (${flags.source(key as Parameters<typeof flags.source>[0])})`;
    }
    return {
      id: "flags",
      status: "ok",
      message: "Internal feature flags resolve with the active layers.",
      details,
    };
  } catch (error) {
    return {
      id: "flags",
      status: "error",
      message: `Internal feature flags failed to resolve: ${errorMessage(error)}`,
    };
  }
}

function checkDispatchConfig(settings: Settings): DoctorCheck {
  try {
    validateDispatchConfig(
      settings,
      defaultTrackerRegistry,
      defaultAgentExecutorRegistry,
      defaultToolRegistry,
    );
    return {
      id: "dispatch_config",
      status: "ok",
      message: "Dispatch config validates with built-in registries.",
      details: { tracker: settings.tracker.kind ?? null, agent: settings.agent.kind },
    };
  } catch (error) {
    return {
      id: "dispatch_config",
      status: "error",
      message: `Dispatch config failed validation: ${errorMessage(error)}`,
      details: { tracker: settings.tracker.kind ?? null, agent: settings.agent.kind },
    };
  }
}

async function checkDashboardAssets(
  settings: Settings,
  cliDashboard: boolean,
): Promise<DoctorCheck> {
  if (!cliDashboard) {
    return {
      id: "dashboard_assets",
      status: "ok",
      message: "Dashboard is disabled by CLI option; static asset check skipped.",
    };
  }

  const staticDir = path.resolve(settings.server.staticDir ?? defaultDashboardStaticDir());
  const indexPath = path.join(staticDir, "index.html");
  const assetsDir = path.join(staticDir, "assets");
  try {
    const [indexStat, assetsStat] = await Promise.all([fs.stat(indexPath), fs.stat(assetsDir)]);
    if (!indexStat.isFile()) throw new Error(`${indexPath} is not a file`);
    if (!assetsStat.isDirectory()) throw new Error(`${assetsDir} is not a directory`);
    return {
      id: "dashboard_assets",
      status: "ok",
      message: `Dashboard static assets are available: ${staticDir}`,
      details: { staticDir },
    };
  } catch (error) {
    return {
      id: "dashboard_assets",
      status: "warning",
      message: `Dashboard static assets are not available at ${staticDir}: ${errorMessage(error)}`,
      details: { staticDir },
    };
  }
}

async function checkLogPath(logFile: string): Promise<DoctorCheck> {
  const resolvedLogFile = path.resolve(logFile);
  const parent = path.dirname(resolvedLogFile);
  const parentStat = await statOrNull(parent);
  const nearest = parentStat
    ? { path: parent, isDirectory: parentStat.isDirectory() }
    : await nearestExistingPath(parent);
  if (nearest && !nearest.isDirectory) {
    return {
      id: "log_path",
      status: "warning",
      message: `Log path ancestor exists but is not a directory: ${nearest.path}`,
      details: { logFile: resolvedLogFile, parent, checkedParent: nearest.path },
    };
  }

  if (!nearest) {
    return {
      id: "log_path",
      status: "warning",
      message: `No existing parent found for log path: ${resolvedLogFile}`,
      details: { logFile: resolvedLogFile, parent },
    };
  }

  try {
    await fs.access(nearest.path, constants.W_OK);
    const message =
      nearest.path === parent
        ? `Log parent is writable: ${parent}`
        : `Log parent will need to be created; nearest existing parent is writable: ${nearest.path}`;
    return {
      id: "log_path",
      status: "ok",
      message,
      details: { logFile: resolvedLogFile, parent, checkedParent: nearest.path },
    };
  } catch (error) {
    return {
      id: "log_path",
      status: "warning",
      message: `Log parent is not writable: ${nearest.path} ${errorMessage(error)}`,
      details: { logFile: resolvedLogFile, parent, checkedParent: nearest.path },
    };
  }
}

async function checkAgentBridgeCommands(
  settings: Settings,
  env: NodeJS.ProcessEnv,
): Promise<DoctorCheck[]> {
  const bridgeUses = requiredBridgeCommandUses(settings);
  if (bridgeUses.length === 0) {
    return [
      {
        id: "agent_bridge",
        status: "ok",
        message: "No local ACP bridge commands are required by the active dispatch config.",
      },
    ];
  }

  if (settings.worker.sshHosts.length > 0) {
    return [
      {
        id: "agent_bridge",
        status: "warning",
        message: "Remote workers are configured; bridge command presence was not checked over SSH.",
        details: { sshHosts: settings.worker.sshHosts.length },
      },
    ];
  }

  const bridgeChecks: DoctorCheck[] = await Promise.all(
    bridgeUses.map(async ({ kind, bridgeCommand, state }) => {
      const resolvedCommand = resolveBridgeCommand(bridgeCommand, null);
      const requirements = bridgeCommandRequirements(resolvedCommand);
      const subject = state === undefined ? kind : `${kind} in ${state}`;
      const details = { kind, command: bridgeCommand, state: state ?? null };
      if (!requirements) {
        return {
          id: bridgeCheckId(kind, state),
          status: "warning",
          message: `Agent bridge command could not be parsed for ${subject}: ${bridgeCommand}`,
          details,
        };
      }
      const found = await findExecutable(requirements.executable, env);
      const resolvedDetails = {
        ...details,
        executable: requirements.executable,
        wrapperExecutable: requirements.wrapperExecutable ?? null,
        resolvedCommand,
        bridgeTarget: requirements.bridgeTarget ?? null,
      };
      if (requirements.wrapperExecutable !== undefined) {
        const wrapperFound = await findExecutable(requirements.wrapperExecutable, env);
        if (!wrapperFound) {
          return {
            id: bridgeCheckId(kind, state),
            status: "warning",
            message: `Agent bridge wrapper command was not found for ${subject}: ${requirements.wrapperExecutable}`,
            details: resolvedDetails,
          };
        }
      }
      if (found) {
        if (
          requirements.bridgeTarget !== undefined &&
          !(await canReadFile(requirements.bridgeTarget))
        ) {
          return {
            id: bridgeCheckId(kind, state),
            status: "warning",
            message: `Agent bridge target was not readable for ${subject}: ${requirements.bridgeTarget}`,
            details: resolvedDetails,
          };
        }
        return {
          id: bridgeCheckId(kind, state),
          status: "ok",
          message: `Agent bridge command is available for ${subject}: ${requirements.executable}`,
          details: resolvedDetails,
        };
      }
      return {
        id: bridgeCheckId(kind, state),
        status: "warning",
        message: `Agent bridge command was not found for ${subject}: ${requirements.executable}`,
        details: resolvedDetails,
      };
    }),
  );
  return [...bridgeChecks, ...(await agentCliChecks(bridgeUses, env))];
}

// Vendored ACP bridges shell out to an underlying agent CLI: `codex-acp` runs
// `$CODEX_PATH ?? codex` and `claude-agent-acp` runs `$CLAUDE_CODE_EXECUTABLE ??
// claude`. Doctor verifies that CLI is discoverable so a missing install is
// caught before a run rather than at session start. Custom bridges name no known
// CLI, so they are left to the bridge-command check above.
async function agentCliChecks(
  bridgeUses: BridgeCommandUse[],
  env: NodeJS.ProcessEnv,
): Promise<DoctorCheck[]> {
  const requirements = new Map<string, AgentCliRequirement>();
  for (const { bridgeCommand } of bridgeUses) {
    const requirement = agentCliRequirement(bridgeCommand, env);
    if (requirement) requirements.set(requirement.binary, requirement);
  }

  return Promise.all(
    [...requirements.values()]
      .sort((left, right) => left.binary.localeCompare(right.binary))
      .map(async (requirement) => {
        const found = await findExecutable(requirement.executable, env);
        const details = {
          binary: requirement.binary,
          executable: requirement.executable,
          envOverride: requirement.envOverride,
          source: requirement.overridden ? requirement.envOverride : "PATH",
          resolved: found,
        };
        if (found) {
          return {
            id: `agent_cli_${requirement.binary}`,
            status: "ok" as const,
            message: `Agent CLI is available: ${requirement.binary} (${found})`,
            details,
          };
        }
        const message = requirement.overridden
          ? `Agent CLI was not found at ${requirement.envOverride}=${requirement.executable}.`
          : `Agent CLI was not found on PATH: ${requirement.binary}. Install it or set ${requirement.envOverride}.`;
        return {
          id: `agent_cli_${requirement.binary}`,
          status: "warning" as const,
          message,
          details,
        };
      }),
  );
}

function bridgeCheckId(kind: string, state?: string): string {
  return `agent_bridge_${safeCheckId(state === undefined ? kind : `${kind}_${state}`)}`;
}

async function canReadFile(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, constants.R_OK);
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function nearestExistingPath(
  directory: string,
): Promise<{ path: string; isDirectory: boolean } | null> {
  let current = path.resolve(directory);
  while (true) {
    const stat = await statOrNull(current);
    if (stat) return { path: current, isDirectory: stat.isDirectory() };
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function statOrNull(filePath: string) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

function defaultDashboardStaticDir(): string {
  // Packaged releases ship the dashboard as a bundled `@lorenz/dashboard` package; resolve it via
  // Node module resolution so doctor checks the same assets the server serves in any layout. The
  // dev monorepo falls back to the dashboard app's built output.
  try {
    const require = createRequire(import.meta.url);
    return path.dirname(require.resolve("@lorenz/dashboard/dist/index.html"));
  } catch {
    return path.resolve(import.meta.dirname, "../../web/dist");
  }
}

function applyDoctorOverrides(settings: Settings, options: DoctorCommandOptions): void {
  if (options.logsRoot !== null) {
    settings.logging.logFile = path.join(path.resolve(options.logsRoot), "log", "lorenz.log");
  }
}

function doctorReport(workflowPath: string, checks: DoctorCheck[]): DoctorReport {
  return {
    status: overallStatus(checks),
    workflowPath,
    checks,
  };
}

function overallStatus(checks: DoctorCheck[]): DoctorCheckStatus {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
}

function safeCheckId(value: string): string {
  return value.replace(/[^A-Za-z0-9_]+/g, "_") || "agent";
}
