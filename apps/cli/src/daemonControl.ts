import { Command } from "commander";
import { parseNonNegativeInteger, parseRequiredValue } from "@lorenz/cli-kit";
import { loadWorkflow, workflowFilePath } from "@lorenz/workflow";

import { daemonLockPath, readDaemonLock, type DaemonLockRecord } from "./daemonLock.js";
import { daemonStatusPayload } from "./daemonStatus.js";
import {
  apiErrorMessage,
  normalizeHttpBaseUrl,
  parseHttpUrlOption,
  trimTrailingSlash,
  workflowHttpBaseUrl,
} from "./httpApi.js";

export interface DaemonControlCommandOptions {
  workflowPath: string | null;
  url: string | null;
  port: number | null;
  controlToken: string | null;
  json: boolean;
}

interface DaemonControlCommanderOptions {
  url?: string | undefined;
  port?: number | undefined;
  controlToken?: string | undefined;
  json?: boolean | undefined;
}

interface DaemonControlResult {
  statusCode: number;
  output: string;
}

type LoadedWorkflow = Awaited<ReturnType<typeof loadWorkflow>>;

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
    controlToken: parsed.controlToken ?? null,
    json: parsed.json ?? false,
  };
}

export async function runDaemonStatusCommand(
  options: DaemonControlCommandOptions,
): Promise<DaemonControlResult> {
  if (options.url || options.port !== null) {
    const url = await resolveDaemonBaseUrl(options);
    const live = await fetchDaemonPayloadUrl(`${url}/api/v1/daemon`);
    return {
      statusCode: live.statusCode === 0 ? 0 : 1,
      output: renderDaemonControlOutput(live.body, options.json),
    };
  }
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
  const { url, controlToken } = await resolveDaemonControl(options);
  return postDaemonControl(`${url}/api/v1/refresh`, options.json, controlToken);
}

export async function runDaemonStopCommand(
  options: DaemonControlCommandOptions,
): Promise<DaemonControlResult> {
  const { url, controlToken } = await resolveDaemonControl(options);
  return postDaemonControl(`${url}/api/v1/stop`, options.json, controlToken);
}

async function resolveDaemonBaseUrl(options: DaemonControlCommandOptions): Promise<string> {
  if (options.url) return normalizeHttpBaseUrl(options.url);
  const record = await readDaemonRecordForOptions(options);
  if (options.port !== null && options.port > 0) {
    return workflowHttpBaseUrl(await loadDaemonWorkflow(options), options.port);
  }
  if (record?.endpoint.kind === "http" && usableHttpEndpoint(record.endpoint.address)) {
    return trimTrailingSlash(record.endpoint.address);
  }
  const workflow = await loadDaemonWorkflow(options);
  const port = workflow.settings.server.port;
  if (typeof port === "number" && port > 0) return workflowHttpBaseUrl(workflow, port);
  throw new Error("No daemon control endpoint found. Pass --url or --port.");
}

async function resolveDaemonControl(options: DaemonControlCommandOptions): Promise<{
  url: string;
  controlToken: string | null;
}> {
  if (options.url) {
    return controlTarget(
      normalizeHttpBaseUrl(options.url),
      await readOptionalDaemonControlRecord(options),
      options.controlToken,
    );
  }
  const record = await readDaemonRecordForOptions(options);
  if (options.port !== null && options.port > 0) {
    const workflow = await loadDaemonWorkflow(options);
    return controlTarget(workflowHttpBaseUrl(workflow, options.port), record, options.controlToken);
  }
  if (record?.endpoint.kind === "http" && usableHttpEndpoint(record.endpoint.address)) {
    return controlTarget(trimTrailingSlash(record.endpoint.address), record, options.controlToken);
  }
  if (record) {
    throw new Error("Daemon is running without an HTTP control endpoint. Pass --url or --port.");
  }
  const workflow = await loadDaemonWorkflow(options);
  const port = workflow.settings.server.port;
  if (typeof port === "number" && port > 0) {
    return controlTarget(workflowHttpBaseUrl(workflow, port), record, options.controlToken);
  }
  throw new Error("No daemon control endpoint found. Pass --url or --port.");
}

function controlTarget(
  url: string,
  record: DaemonLockRecord | null,
  explicitControlToken: string | null = null,
): { url: string; controlToken: string | null } {
  const normalizedUrl = trimTrailingSlash(url);
  if (explicitControlToken) return { url: normalizedUrl, controlToken: explicitControlToken };
  if (record?.endpoint.kind !== "http" || !usableHttpEndpoint(record.endpoint.address)) {
    return { url: normalizedUrl, controlToken: null };
  }
  if (sameDaemonBaseUrl(normalizedUrl, record.endpoint.address)) {
    return { url: normalizedUrl, controlToken: record.controlToken };
  }
  return { url: normalizedUrl, controlToken: null };
}

async function readOptionalDaemonControlRecord(
  options: DaemonControlCommandOptions,
): Promise<DaemonLockRecord | null> {
  try {
    return await readDaemonRecordForOptions(options);
  } catch {
    return null;
  }
}

function sameDaemonBaseUrl(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(trimTrailingSlash(left));
    const rightUrl = new URL(trimTrailingSlash(right));
    return (
      leftUrl.protocol === rightUrl.protocol &&
      leftUrl.username === rightUrl.username &&
      leftUrl.password === rightUrl.password &&
      leftUrl.hostname === rightUrl.hostname &&
      leftUrl.port === rightUrl.port &&
      trimTrailingSlash(leftUrl.pathname || "/") === trimTrailingSlash(rightUrl.pathname || "/") &&
      leftUrl.search === rightUrl.search &&
      leftUrl.hash === rightUrl.hash
    );
  } catch {
    return false;
  }
}

async function resolveDaemonRecord(options: DaemonControlCommandOptions): Promise<{
  workflow: LoadedWorkflow | null;
  record: DaemonLockRecord | null;
}> {
  const record = await readDaemonRecordForOptions(options);
  if (record) return { workflow: null, record };
  const workflow = await loadDaemonWorkflow(options);
  return { workflow, record: await readDaemonRecordForWorkflow(workflow) };
}

async function readDaemonRecordForWorkflow(
  workflow: LoadedWorkflow,
): Promise<DaemonLockRecord | null> {
  const lockPath = daemonLockPath(workflow.path);
  return readDaemonLock(lockPath);
}

async function readDaemonRecordForOptions(
  options: DaemonControlCommandOptions,
): Promise<DaemonLockRecord | null> {
  return readDaemonLock(daemonLockPath(daemonControlWorkflowPath(options)));
}

function daemonControlWorkflowPath(options: DaemonControlCommandOptions): string {
  return options.workflowPath ?? workflowFilePath();
}

async function loadDaemonWorkflow(options: DaemonControlCommandOptions): Promise<LoadedWorkflow> {
  return loadWorkflow(options.workflowPath ?? undefined);
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
    const live = await fetchDaemonPayloadUrl(
      `${trimTrailingSlash(record.endpoint.address)}/api/v1/daemon`,
    );
    if (live.requestFailed) return { statusCode: options.json ? 1 : 0, body: fallback };
    if (live.statusCode !== 0) return { statusCode: live.statusCode, body: fallback };
    return { statusCode: 0, body: live.body };
  } catch {
    return { statusCode: options.json ? 1 : 0, body: fallback };
  }
}

async function fetchDaemonPayloadUrl(url: string): Promise<{
  statusCode: number;
  body: Record<string, unknown>;
  requestFailed?: boolean;
}> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return {
        statusCode: response.status,
        body: await responseJsonOrError(response),
      };
    }
    return { statusCode: 0, body: (await response.json()) as Record<string, unknown> };
  } catch (error) {
    return {
      statusCode: 1,
      body: {
        error: {
          code: "daemon_request_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      requestFailed: true,
    };
  }
}

async function responseJsonOrError(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {
      error: {
        code: "daemon_request_failed",
        message: `Daemon request failed with status ${response.status}`,
      },
    };
  }
}

async function postDaemonControl(
  url: string,
  json: boolean,
  controlToken: string | null,
): Promise<DaemonControlResult> {
  const headers: Record<string, string> = {};
  if (controlToken) headers.authorization = `Bearer ${controlToken}`;
  const response = await fetch(url, { method: "POST", headers });
  const body = response.ok
    ? ((await response.json()) as Record<string, unknown>)
    : await responseJsonOrError(response);
  if (response.ok) return { statusCode: 0, output: renderDaemonControlOutput(body, json) };
  return { statusCode: 1, output: renderDaemonControlOutput(body, json) };
}

function createDaemonControlCommand(name: string, description: string): Command {
  return new Command(name)
    .description(description)
    .allowExcessArguments(false)
    .argument("[workflowPath]", "Workflow markdown file.")
    .option("--url <url>", "Daemon control API base URL.", parseHttpUrlOption)
    .option("--port <port>", "Daemon control localhost port.", parseNonNegativeInteger("--port"))
    .option(
      "--control-token <token>",
      "Bearer token for protected daemon control.",
      parseRequiredValue("--control-token", "token"),
    )
    .option("--json", "Print raw JSON response.");
}

function usableHttpEndpoint(address: string): boolean {
  try {
    const url = new URL(address);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function renderDaemonControlOutput(body: Record<string, unknown>, json: boolean): string {
  if (json) return `${JSON.stringify(body, null, 2)}\n`;
  if (body.error) {
    const fallback = typeof body.error === "string" ? body.error : "Daemon request failed";
    return `${apiErrorMessage(body, fallback)}\n`;
  }
  return `${JSON.stringify(body, null, 2)}\n`;
}
