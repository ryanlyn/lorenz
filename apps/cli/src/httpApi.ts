import { parseRequiredValue } from "@lorenz/cli-kit";
import { httpUrlHost, isRecord, type WorkflowDefinition } from "@lorenz/domain";

export function workflowHttpBaseUrl(
  workflow: Pick<WorkflowDefinition, "settings">,
  port: number,
): string {
  return `http://${httpUrlHost(workflow.settings.server.host)}:${port}`;
}

export function parseHttpUrlOption(value: string): string {
  const parsed = parseRequiredValue("--url", "url")(value);
  return normalizeHttpBaseUrl(parsed);
}

export function normalizeHttpBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("--url must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("--url must use http or https");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("--url must not include a query string or fragment");
  }
  return trimTrailingSlash(parsed.toString());
}

export function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function apiErrorMessage(body: Record<string, unknown>, fallback: string): string {
  const error = body.error;
  if (typeof error === "string" && error) return error;
  if (isRecord(error) && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return fallback;
}
