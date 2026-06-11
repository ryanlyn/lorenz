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
    tools: settings.tools ?? null,
    tracker: {
      kind: tracker.kind ?? null,
      endpoint: tracker.endpoint ?? null,
      apiKey: tracker.apiKey ?? null,
      assignee: tracker.assignee ?? null,
      options: canonicalRecord(tracker.options),
      activeStates: tracker.activeStates,
      terminalStates: tracker.terminalStates,
      dispatch: tracker.dispatch,
    },
  });
  return `mcp:${createHash("sha256").update(identity).digest("base64url")}`;
}

/** Key-sorted copy of a provider options record so equivalent configs hash identically. */
function canonicalRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
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
