import { createHash, randomBytes } from "node:crypto";

import type { Settings } from "@symphony/domain";

const defaultMcpAuthScope = "mcp:default";
const activeTokens = new Map<string, string>();

export function createMcpAuthScope(): string {
  return `mcp:${randomBytes(16).toString("base64url")}`;
}

export function mcpAuthScopeForSettings(
  settings: Settings,
  host: string,
  port: number | undefined,
): string {
  const tracker = settings.tracker;
  const identity = JSON.stringify({
    host,
    port,
    tracker: {
      kind: tracker.kind ?? "linear",
      endpoint: tracker.endpoint,
      apiKey: tracker.apiKey ?? null,
      projectSlug: tracker.projectSlug ?? null,
      projectSlugs: tracker.projectSlugs ?? null,
      projectLabels: tracker.projectLabels ?? null,
      assignee: tracker.assignee ?? null,
      path: tracker.path ?? null,
      idPrefix: tracker.idPrefix ?? null,
      activeStates: tracker.activeStates,
      terminalStates: tracker.terminalStates,
      dispatch: tracker.dispatch,
    },
  });
  return `mcp:${createHash("sha256").update(identity).digest("base64url")}`;
}

export function issueMcpToken(scope = defaultMcpAuthScope): string {
  const token = randomBytes(32).toString("base64url");
  activeTokens.set(token, scope);
  return token;
}

export function revokeMcpToken(token: string | null | undefined): void {
  if (token) activeTokens.delete(token);
}

export function validMcpToken(
  token: string | null | undefined,
  scope = defaultMcpAuthScope,
): boolean {
  return typeof token === "string" && activeTokens.get(token) === scope;
}
