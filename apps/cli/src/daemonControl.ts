import { Command } from "commander";
import { parseNonNegativeInteger, parseRequiredValue } from "@lorenz/cli-kit";
import { loadWorkflow } from "@lorenz/workflow";
import { errorMessage } from "@lorenz/domain";

import { daemonLockPath, readDaemonLock, type DaemonLockRecord } from "./daemonLock.js";
import { daemonStatusPayload } from "./daemonStatus.js";

export interface DaemonControlCommandOptions {
  workflowPath: string | null;
  url: string | null;
  port: number | null;
  json: boolean;
}

interface DaemonControlCommanderOptions {
  url?: string | undefined;
  port?: number | undefined;
  json?: boolean | undefined;
}

interface DaemonControlResult {
  statusCode: number;
  output: string;
}

export function createDaemonStatusCommand(name = "status"): Command {
  return createDaemonControlCommand(name, "Show the active daemon owner and endpoint.");
}

export function createDaemonRefreshCommand(name = "refresh"): Command {
  return createDaemonControlCommand(name, "Ask the active daemon to poll now.");
}

export function createDaemonStopCommand(name = "stop"): Command {
  return createDaemonControlCommand(name, "Ask the active daemon to stop gracefully.");
}

export function daemonControlOptionsFromCommanderOptions(
  parsed: DaemonControlCommanderOptions,
  workflowPath?: string,
): DaemonControlCommandOptions {
  return {
    workflowPath: workflowPath ?? null,
    url: parsed.url ?? null,
    port: parsed.port ?? null,
    json: parsed.json ?? false,
  };
}

export async function runDaemonStatusCommand(
  options: DaemonControlCommandOptions,
): Promise<DaemonControlResult> {
  const { record } = await resolveDaemonRecord(options);
  if (!record) {
    return {
      statusCode: 1,
      output: renderDaemonControlOutput({ error: "daemon_not_running" }, options.json),
    };
  }
  const live = await fetchDaemonPayload(record, options);
  return {
    statusCode: live.statusCode === 0 ? 0 : 1,
    output: renderDaemonControlOutput(live.body, options.json),
  };
}

export async function runDaemonRefreshCommand(
  options: DaemonControlCommandOptions,
): Promise<DaemonControlResult> {
  const url = await resolveDaemonBaseUrl(options);
  return postDaemonControl(`${url}/api/v1/refresh`, options.json);
}

export async function runDaemonStopCommand(
  options: DaemonControlCommandOptions,
): Promise<DaemonControlResult> {
  const url = await resolveDaemonBaseUrl(options);
  return postDaemonControl(`${url}/api/v1/stop`, options.json);
}

async function resolveDaemonBaseUrl(options: DaemonControlCommandOptions): Promise<string> {
  if (options.url) return trimTrailingSlash(options.url);
  const { workflow, record } = await resolveDaemonRecord(options);
  if (record?.endpoint.kind === "http" && usableHttpEndpoint(record.endpoint.address)) {
    return trimTrailingSlash(record.endpoint.address);
  }
  if (options.port !== null && options.port > 0)
    return `http://${workflow.settings.server.host}:${options.port}`;
  const port = workflow.settings.server.port;
  if (typeof port === "number" && port > 0)
    return `http://${workflow.settings.server.host}:${port}`;
  throw new Error("No daemon control endpoint found. Pass --url or --port.");
}

async function resolveDaemonRecord(options: DaemonControlCommandOptions): Promise<{
  workflow: Awaited<ReturnType<typeof loadWorkflow>>;
  record: DaemonLockRecord | null;
}> {
  const workflow = await loadWorkflow(options.workflowPath ?? undefined);
  const lockPath = daemonLockPath(workflow.settings.workspace.root, workflow.path);
  return { workflow, record: await readDaemonLock(lockPath) };
}

async function fetchDaemonPayload(
  record: DaemonLockRecord,
  options: DaemonControlCommandOptions,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const fallback = daemonStatusPayload(record) as unknown as Record<string, unknown>;
  if (record.endpoint.kind !== "http" || !usableHttpEndpoint(record.endpoint.address)) {
    return { statusCode: 0, body: fallback };
  }
  try {
    const response = await fetch(`${trimTrailingSlash(record.endpoint.address)}/api/v1/daemon`);
    if (!response.ok) return { statusCode: response.status, body: fallback };
    return { statusCode: 0, body: (await response.json()) as Record<string, unknown> };
  } catch {
    return { statusCode: options.json ? 1 : 0, body: fallback };
  }
}

async function postDaemonControl(url: string, json: boolean): Promise<DaemonControlResult> {
  const response = await fetch(url, { method: "POST" });
  const body = (await response.json()) as Record<string, unknown>;
  if (response.ok) return { statusCode: 0, output: renderDaemonControlOutput(body, json) };
  return { statusCode: 1, output: renderDaemonControlOutput(body, json) };
}

function createDaemonControlCommand(name: string, description: string): Command {
  return new Command(name)
    .description(description)
    .allowExcessArguments(false)
    .argument("[workflowPath]", "Workflow markdown file.")
    .option("--url <url>", "Daemon control API base URL.", parseUrl)
    .option("--port <port>", "Daemon control localhost port.", parseNonNegativeInteger("--port"))
    .option("--json", "Print raw JSON response.");
}

function parseUrl(value: string): string {
  const parsed = parseRequiredValue("--url", "url")(value);
  try {
    return trimTrailingSlash(new URL(parsed).toString());
  } catch {
    throw new Error("--url must be a valid URL");
  }
}

function usableHttpEndpoint(address: string): boolean {
  try {
    const url = new URL(address);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function renderDaemonControlOutput(body: Record<string, unknown>, json: boolean): string {
  if (json) return `${JSON.stringify(body, null, 2)}\n`;
  if (body.error) return `${errorMessage(body.error)}\n`;
  return `${JSON.stringify(body, null, 2)}\n`;
}
