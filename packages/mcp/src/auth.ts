import { createHash, randomBytes } from "node:crypto";

import type { Settings } from "@lorenz/domain";

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
    toolOptions: settings.toolOptions ? canonicalToolOptions(settings.toolOptions) : null,
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

/** Pack-name-sorted copy of the per-pack tool options with each pack's record canonical. */
function canonicalToolOptions(
  toolOptions: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(toolOptions)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([pack, options]) => [pack, canonicalRecord(options)]),
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

/**
 * The server-side claim record a per-run MCP token (Token B) resolves to.
 *
 * The token bytes stay opaque (`randomBytes(32)`); all scope lives here, in a
 * daemon-minted Map that is the sole authority. This is an unguessable-bearer
 * property, NOT platform attestation: the worker only ever presents its token
 * and the daemon resolves the claim. `runKey` is therefore resolved
 * server-side from the token and a self-reported `runKey` header is never
 * trusted.
 */
export interface RunClaim {
  /** The run this token authorizes. Resolved server-side; never self-reported. */
  runKey: string;
  /** The worker host the run is pinned to. Empty string means a local/acp run. */
  workerHost: string;
  /** The issue the run is working. */
  issueId: string;
  /**
   * Monotonic generation of the shared endpoint this claim was minted against.
   * Bumped on host recycle; a request whose claim generation no longer matches
   * the live endpoint is a late/torn-down token and must be rejected.
   */
  generation: number;
  /**
   * Coarse safety cap on the claim's lifetime (epoch millis). The claim is
   * primarily run-lifetime-bound via the injected `isRunLive` re-check; this is
   * only a backstop so a leaked token cannot live forever.
   */
  expiresAt: number;
  /**
   * The coarse settings fingerprint (Token A side, `mcpAuthScopeForSettings`).
   * Kept as a cheap pre-filter; it does NOT carry per-run identity.
   */
  settingsScope: string;
  /**
   * Per-operation allowlist: the tool names this run may call. `undefined`
   * means no restriction beyond the rest of the claim (every mounted tool).
   */
  allowedTools?: readonly string[];
}

/** Opaque per-run token (Token B) -> daemon-minted claim. The sole authority. */
const runClaims = new Map<string, RunClaim>();

/**
 * Mint an opaque per-run token (Token B) bound to {@link claim}. The token
 * bytes carry no scope; the returned claim is resolved server-side on every
 * request via {@link resolveRunClaim}.
 */
export function issueRunMcpToken(claim: RunClaim): string {
  const token = randomBytes(32).toString("base64url");
  runClaims.set(token, claim);
  return token;
}

/**
 * Resolve the claim for an opaque per-run token. This is the ONLY source of a
 * request's `runKey`; callers must never trust a self-reported header. Returns
 * `undefined` for unknown/revoked tokens (fail closed at the call site).
 */
export function resolveRunClaim(token: string | null | undefined): RunClaim | undefined {
  if (typeof token !== "string") return undefined;
  return runClaims.get(token);
}

/** Revoke a per-run token, dropping its claim. Safe no-op on unknown input. */
export function revokeRunClaim(token: string | null | undefined): void {
  if (token) runClaims.delete(token);
}

/** Inputs to {@link checkRunClaim}: what the request is asking to do. */
export interface RunClaimRequest {
  /** The tool being invoked (`tools/call` name), if this is a tool request. */
  toolName?: string | null;
  /**
   * Read-only liveness oracle injected from the composition root. Returns false
   * once the run is settled/recycled/superseded. The generation argument lets
   * liveness be paired with the generation fence so a momentary liveness lie
   * still fails on a stale generation.
   */
  isRunLive: (runKey: string, workerHost: string, generation: number) => boolean;
  /** Wall clock, injected for testability. Defaults to {@link Date.now}. */
  now?: () => number;
}

/** Outcome of {@link checkRunClaim}. `ok` is true only when every check passes. */
export type RunClaimDecision =
  | { ok: true; claim: RunClaim }
  | { ok: false; reason: "expired" | "tool-not-allowed" | "not-live" };

/**
 * Authoritative per-request owner re-check for a resolved {@link RunClaim},
 * ordered expiry-first, allowlist-before-secret, fail-closed:
 *
 *   1. `expiresAt > now`            - coarse lifetime cap.
 *   2. tool in `allowedTools`       - per-operation allowlist (before liveness).
 *   3. `isRunLive(runKey, host, generation)` - the run is still live AND the
 *      generation matches the live endpoint.
 *
 * Never falls back to the settings-wide scope; any miss denies.
 */
export function checkRunClaim(claim: RunClaim, request: RunClaimRequest): RunClaimDecision {
  const now = request.now ?? Date.now;
  if (claim.expiresAt <= now()) {
    return { ok: false, reason: "expired" };
  }
  if (
    request.toolName != null &&
    claim.allowedTools !== undefined &&
    !claim.allowedTools.includes(request.toolName)
  ) {
    return { ok: false, reason: "tool-not-allowed" };
  }
  if (!request.isRunLive(claim.runKey, claim.workerHost, claim.generation)) {
    return { ok: false, reason: "not-live" };
  }
  return { ok: true, claim };
}
