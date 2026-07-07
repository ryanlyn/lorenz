import { request as httpRequest } from "node:http";

import { Command } from "commander";
import { parseNonNegativeInteger, parseRequiredValue } from "@lorenz/cli-kit";
import { loadWorkflow, workflowFilePath } from "@lorenz/workflow";

import {
  daemonLockPath,
  readDaemonLock,
  type DaemonEndpoint,
  type DaemonLockRecord,
} from "./daemonLock.js";
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
    const live = await fetchDaemonStatus({ kind: "http", baseUrl: trimTrailingSlash(url) });
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
  const { target, controlToken } = await resolveDaemonControl(options);
  return postDaemonControl(target, "/api/v1/refresh", options.json, controlToken);
}

export async function runDaemonStopCommand(
  options: DaemonControlCommandOptions,
): Promise<DaemonControlResult> {
  const { target, controlToken } = await resolveDaemonControl(options);
  return postDaemonControl(target, "/api/v1/stop", options.json, controlToken);
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
  target: DaemonTarget;
  controlToken: string | null;
}> {
  if (options.url) {
    const target: DaemonTarget = { kind: "http", baseUrl: normalizeHttpBaseUrl(options.url) };
    return controlTokenForTarget(target, await readOptionalDaemonControlRecord(options), options);
  }
  const record = await readDaemonRecordForOptions(options);
  if (options.port !== null && options.port > 0) {
    const workflow = await loadDaemonWorkflow(options);
    const target: DaemonTarget = {
      kind: "http",
      baseUrl: trimTrailingSlash(workflowHttpBaseUrl(workflow, options.port)),
    };
    return controlTokenForTarget(target, record, options);
  }
  // Discovery: use whatever control endpoint the daemon published in its lock (socket or http).
  const discovered = record ? targetFromEndpoint(record.endpoint) : null;
  if (discovered) return controlTokenForTarget(discovered, record, options);
  if (record) {
    throw new Error("Daemon is running without a usable control endpoint. Pass --url or --port.");
  }
  const workflow = await loadDaemonWorkflow(options);
  const port = workflow.settings.server.port;
  if (typeof port === "number" && port > 0) {
    const target: DaemonTarget = {
      kind: "http",
      baseUrl: trimTrailingSlash(workflowHttpBaseUrl(workflow, port)),
    };
    return controlTokenForTarget(target, record, options);
  }
  throw new Error("No daemon control endpoint found. Pass --url or --port.");
}

function controlTokenForTarget(
  target: DaemonTarget,
  record: DaemonLockRecord | null,
  options: DaemonControlCommandOptions,
): { target: DaemonTarget; controlToken: string | null } {
  if (options.controlToken) return { target, controlToken: options.controlToken };
  const recordTarget = record ? targetFromEndpoint(record.endpoint) : null;
  // Only attach the lock's token when the resolved target is the one the daemon actually published.
  if (recordTarget && targetsMatch(target, recordTarget) && record) {
    return { target, controlToken: record.controlToken };
  }
  return { target, controlToken: null };
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

// A control endpoint is reached either over HTTP (TCP, the dashboard) or a unix domain socket (the
// always-on daemon control endpoint). Discovery resolves one of these from the daemon lock.
type DaemonTarget = { kind: "http"; baseUrl: string } | { kind: "socket"; socketPath: string };

interface DaemonResponse {
  status: number;
  body: Record<string, unknown>;
  requestFailed: boolean;
}

function targetFromEndpoint(endpoint: DaemonEndpoint): DaemonTarget | null {
  if (endpoint.kind === "http" && usableHttpEndpoint(endpoint.address)) {
    return { kind: "http", baseUrl: trimTrailingSlash(endpoint.address) };
  }
  if (endpoint.kind === "socket" && endpoint.address.length > 0) {
    return { kind: "socket", socketPath: endpoint.address };
  }
  return null;
}

function targetsMatch(left: DaemonTarget, right: DaemonTarget): boolean {
  if (left.kind === "http" && right.kind === "http") {
    return sameDaemonBaseUrl(left.baseUrl, right.baseUrl);
  }
  if (left.kind === "socket" && right.kind === "socket")
    return left.socketPath === right.socketPath;
  return false;
}

async function daemonRequest(
  target: DaemonTarget,
  path: string,
  method: "GET" | "POST",
  controlToken: string | null,
): Promise<DaemonResponse> {
  try {
    return target.kind === "http"
      ? await httpDaemonRequest(`${target.baseUrl}${path}`, method, controlToken)
      : await socketDaemonRequest(target.socketPath, path, method, controlToken);
  } catch (error) {
    return { status: 0, body: requestFailedBody(error), requestFailed: true };
  }
}

async function httpDaemonRequest(
  url: string,
  method: "GET" | "POST",
  controlToken: string | null,
): Promise<DaemonResponse> {
  const headers: Record<string, string> = {};
  if (controlToken) headers.authorization = `Bearer ${controlToken}`;
  const response = await fetch(url, { method, headers });
  const raw = await response.text();
  return {
    status: response.status,
    body: daemonResponseBody(raw, response.status),
    requestFailed: false,
  };
}

async function socketDaemonRequest(
  socketPath: string,
  path: string,
  method: "GET" | "POST",
  controlToken: string | null,
): Promise<DaemonResponse> {
  const response = await new Promise<DaemonResponse>((resolve, reject) => {
    const headers: Record<string, string> = { host: "lorenz.local" };
    if (controlToken) headers.authorization = `Bearer ${controlToken}`;
    const req = httpRequest({ socketPath, path, method, headers }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("error", reject);
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        resolve({ status, body: daemonResponseBody(raw, status), requestFailed: false });
      });
    });
    req.on("error", reject);
    req.end();
  });
  return response;
}

// Parse a control response body, synthesizing an error payload when a failed response has no JSON
// body (preserving the pre-socket behavior of reporting the HTTP status).
function daemonResponseBody(raw: string, status: number): Record<string, unknown> {
  const parsed = tryParseObject(raw);
  if (parsed) return parsed;
  if (status >= 200 && status < 300) return {};
  return {
    error: {
      code: "daemon_request_failed",
      message: `Daemon request failed with status ${status}`,
    },
  };
}

function tryParseObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function requestFailedBody(error: unknown): Record<string, unknown> {
  return {
    error: {
      code: "daemon_request_failed",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

async function fetchDaemonPayload(
  record: DaemonLockRecord,
  options: DaemonControlCommandOptions,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const fallback = daemonStatusPayload(record) as unknown as Record<string, unknown>;
  const target = targetFromEndpoint(record.endpoint);
  if (!target) return { statusCode: 0, body: fallback };
  const live = await fetchDaemonStatus(target);
  if (live.requestFailed) return { statusCode: options.json ? 1 : 0, body: fallback };
  if (live.statusCode !== 0) return { statusCode: live.statusCode, body: fallback };
  return { statusCode: 0, body: live.body };
}

async function fetchDaemonStatus(target: DaemonTarget): Promise<{
  statusCode: number;
  body: Record<string, unknown>;
  requestFailed: boolean;
}> {
  const res = await daemonRequest(target, "/api/v1/daemon", "GET", null);
  if (res.requestFailed) return { statusCode: 1, body: res.body, requestFailed: true };
  if (res.status !== 200) return { statusCode: res.status, body: res.body, requestFailed: false };
  return { statusCode: 0, body: res.body, requestFailed: false };
}

async function postDaemonControl(
  target: DaemonTarget,
  path: string,
  json: boolean,
  controlToken: string | null,
): Promise<DaemonControlResult> {
  const res = await daemonRequest(target, path, "POST", controlToken);
  const ok = !res.requestFailed && res.status >= 200 && res.status < 300;
  return { statusCode: ok ? 0 : 1, output: renderDaemonControlOutput(res.body, json) };
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
