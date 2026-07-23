import {
  httpUrlHost,
  isRecord,
  normalizeHttpBindHost,
  type Settings,
  type TrackerKind,
} from "@lorenz/domain";
import type { McpServer } from "@agentclientprotocol/sdk";

import { startMcpServer, type IsRunLive, type ObservabilityServerHandle } from "./server.js";
import {
  issueMcpToken,
  issueRunMcpToken,
  mcpAuthScopeForSettings,
  revokeMcpToken,
  revokeRunClaim,
  type RunClaim,
} from "./auth.js";

export function trackerMcpServerName(kind: TrackerKind | undefined): string {
  return `lorenz_${(kind ?? "tracker").replace(/[^A-Za-z0-9_]/g, "_")}`;
}

export interface AgentMcpEndpointLease {
  url: string;
  token: string;
  /**
   * Generation of the shared local MCP server this lease (and its Token B claim)
   * was minted against, captured BEFORE the per-run tunnel was opened. The
   * composition root carries it onto the live `RunSlot` so the injected
   * `isRunLive(runKey, workerHost, generation)` re-check denies a token whose
   * generation no longer matches the live slot - the generation backstop for the
   * liveness re-check's own async window. `1` on the local/null path (no shared
   * server is recycled in place there).
   */
  generation: number;
  acpServer(): McpServer;
  release(): Promise<void>;
}

/** One leased remote port that forwards back to the local MCP server. */
interface RemoteMcpTunnel {
  remotePort: number;
}

/**
 * Provisions tunnels from a remote worker host back to the local MCP server. The
 * composition side passes its pool (e.g. the SSH worker-host pool); this package never
 * reaches into transport infrastructure itself. The whole-endpoint path uses the
 * stateless {@link acquireRemoteMcpTunnel}/{@link releaseRemoteMcpTunnel} pair; the
 * per-run path takes a per-run HOLD on the SHARED per-host tunnel via {@link
 * openForRun}/{@link closeForRun} (one `ssh -R` per worker host, refcounted across
 * co-resident runs). Co-resident runs are kept apart by their per-run Token B claim,
 * NOT by a distinct tunnel/remote port.
 */
export interface RemoteMcpTunnelTransport {
  acquireRemoteMcpTunnel(
    workerHost: string,
    localHost: string,
    localPort: number,
  ): Promise<RemoteMcpTunnel>;
  releaseRemoteMcpTunnel(tunnel: RemoteMcpTunnel): void;
  openForRun(
    workerHost: string,
    runKey: string,
    localHost: string,
    localPort: number,
  ): Promise<RemoteMcpTunnel>;
  closeForRun(workerHost: string, runKey: string): void;
}

interface McpEndpoint {
  url: string;
  authScope: string;
  /**
   * Generation of the shared local MCP server this endpoint was minted against,
   * captured BEFORE the per-run tunnel was opened so the per-run claim (Token B)
   * is stamped with the generation that was live at acquire time. Bumped on host
   * recycle; a later request carrying a stale generation fails the liveness fence.
   */
  generation: number;
  releaseTunnel?: (() => void) | undefined;
  localServer?: LocalMcpServerLease | undefined;
}

interface LocalMcpServerEntry {
  handle: ObservabilityServerHandle;
  identity: string;
  enforcePerRunClaim: boolean;
  refCount: number;
  /**
   * Monotonic generation for this host:port slot. Bumped each time a brand-new
   * entry replaces a fully torn-down one (host recycle), so a token minted
   * against the prior entry resolves to a stale generation and is rejected.
   */
  generation: number;
}

interface LocalMcpServerLease {
  key: string | null;
  handle: ObservabilityServerHandle;
  /**
   * The generation captured when this lease was taken. {@link
   * releaseLocalMcpServer} no-ops when this is older than the live entry's
   * generation: the entry was recycled and a fresh owner holds the live ref,
   * so this late release must not decrement the new entry's refcount.
   */
  generation: number;
}

interface IssuedMcpToken {
  authScope: string;
  token: string;
}

interface McpListener {
  host: string;
  port: number | undefined;
  sharesDashboard: boolean;
}

const mcpPath = "/mcp";
const configuredMcpProbeId = "lorenz-configured-mcp-probe";
const localMcpServers = new Map<string, LocalMcpServerEntry>();
const localMcpServerLocks = new Map<string, Promise<void>>();
/**
 * Monotonic generation per host:port slot, surviving entry teardown so a
 * recreated entry gets a STRICTLY higher generation than the one it replaces.
 * The fence (re-checked per request via the injected `isRunLive`) rejects any
 * Token B minted against a prior, now-recycled generation of the same slot.
 */
const localMcpServerGenerations = new Map<string, number>();

/**
 * Coarse lifetime cap on a per-run claim (Token B). The claim is primarily
 * run-lifetime-bound via the injected `isRunLive` re-check; this backstop only
 * bounds a leaked token that somehow outlives both its run and its generation.
 */
const runClaimMaxLifetimeMs = 24 * 60 * 60 * 1000;

export async function acquireAgentMcpEndpoint(
  settings: Settings,
  workerHost?: string | null,
  tunnels?: RemoteMcpTunnelTransport,
): Promise<AgentMcpEndpointLease> {
  let endpoint: McpEndpoint | null = null;
  let token: string | null = null;
  let released = false;
  try {
    const listener = workerHost ? remoteMcpListener(settings) : sharedMcpListener(settings);
    const configuredToken = issueConfiguredMcpToken(settings, listener);
    token = configuredToken?.token ?? null;
    endpoint = workerHost
      ? await acquireRemoteMcpEndpoint(workerHost, settings, configuredToken, listener, tunnels)
      : await localMcpEndpoint(settings, configuredToken, listener);
    token ??= issueMcpToken(endpoint.authScope);
    return {
      url: endpoint.url,
      token,
      generation: endpoint.generation,
      acpServer: () => ({
        type: "http",
        name: trackerMcpServerName(settings.tracker.kind),
        url: endpoint?.url ?? "",
        headers: [{ name: "Authorization", value: `Bearer ${token}` }],
      }),
      release: async () => {
        if (released) return;
        released = true;
        revokeMcpToken(token);
        try {
          endpoint?.releaseTunnel?.();
        } finally {
          if (endpoint?.localServer) await releaseLocalMcpServer(endpoint.localServer);
        }
      },
    };
  } catch (error) {
    revokeMcpToken(token);
    try {
      endpoint?.releaseTunnel?.();
    } catch {
      // The acquisition error below is the actionable failure; tunnel cleanup is best-effort.
    }
    if (endpoint?.localServer) await releaseLocalMcpServer(endpoint.localServer);
    throw error;
  }
}

export async function acquireAgentMcpEndpointForRun(
  settings: Settings,
  workerHost: string,
  runKey: string,
  tunnels: RemoteMcpTunnelTransport,
  isRunLive?: IsRunLive,
): Promise<AgentMcpEndpointLease> {
  // Token B is bound to a per-run claim whose `workerHost` is the run's REAL ssh
  // host (the gateway re-checks `isRunLive(runKey, workerHost, generation)` against
  // it). An empty `workerHost` denotes a LOCAL/acp run, routed through the per-run
  // manager's null/local path - it must NEVER reach this minting path. Fail loud:
  // a local run here would otherwise mint a claim stamped `workerHost: ""` that
  // `isRunLive` could match against any other local slot, and the per-run claim
  // model only applies to real remote hosts.
  if (workerHost.length === 0) {
    throw new Error("per_run_mcp_endpoint_requires_remote_worker_host");
  }
  let endpoint: McpEndpoint | null = null;
  let token: string | null = null;
  let released = false;
  try {
    const listener = remoteMcpListener(settings);
    const configuredToken = issueConfiguredMcpToken(settings, listener);
    try {
      endpoint = await acquirePerRunMcpEndpoint(
        workerHost,
        runKey,
        settings,
        configuredToken,
        listener,
        tunnels,
        isRunLive,
      );
    } finally {
      // The per-run lease is scoped solely by Token B (minted below), never by
      // the settings-wide token. Revoke the temporary Token A on both success
      // and acquisition failure.
      revokeMcpToken(configuredToken?.token);
    }
    // Mint Token B: an opaque per-run token bound to a server-side claim. The
    // claim's generation was captured BEFORE the `openForRun` await (see
    // `acquirePerRunMcpEndpoint`), so a host recycle that bumps the slot's
    // generation strands this token at the per-request liveness fence.
    token = issueRunMcpToken(runClaimForLease(endpoint, settings, workerHost, runKey));
    return {
      url: endpoint.url,
      token,
      generation: endpoint.generation,
      acpServer: () => ({
        type: "http",
        name: trackerMcpServerName(settings.tracker.kind),
        url: endpoint?.url ?? "",
        headers: [{ name: "Authorization", value: `Bearer ${token}` }],
      }),
      release: async () => {
        if (released) return;
        released = true;
        revokeRunClaim(token);
        tunnels.closeForRun(workerHost, runKey);
        if (endpoint?.localServer) await releaseLocalMcpServer(endpoint.localServer);
      },
    };
  } catch (error) {
    revokeRunClaim(token);
    tunnels.closeForRun(workerHost, runKey);
    if (endpoint?.localServer) await releaseLocalMcpServer(endpoint.localServer);
    throw error;
  }
}

/**
 * Build the server-side per-run claim (Token B) for a freshly-acquired per-run
 * endpoint. `runKey` is the issue-scoped `${issueId}#${slotIndex}` the
 * coordinator mints, so `issueId` is recovered as the part before the first
 * `#`. The generation is the endpoint's captured-before-`openForRun` value, and
 * `allowedTools` is left unset (the rest of the claim - liveness + generation +
 * expiry - gates the run; per-tool scoping is layered in later).
 */
function runClaimForLease(
  endpoint: McpEndpoint,
  settings: Settings,
  workerHost: string,
  runKey: string,
): RunClaim {
  const issueId = runKey.split("#", 1)[0] ?? runKey;
  return {
    runKey,
    workerHost,
    issueId,
    generation: endpoint.generation,
    expiresAt: Date.now() + runClaimMaxLifetimeMs,
    settingsScope: endpoint.authScope,
  };
}

async function localMcpEndpoint(
  settings: Settings,
  configuredToken: IssuedMcpToken | null,
  listener: McpListener,
): Promise<McpEndpoint> {
  const localServer = await ensureLocalMcpServer(settings, configuredToken, listener);
  return {
    url: localServer ? localServer.handle.url(mcpPath) : configuredLocalMcpUrl(listener),
    authScope:
      configuredToken?.authScope ??
      localServer?.handle.authScope ??
      mcpAuthScopeForSettings(settings, listener.host, listener.port),
    generation: localServer?.generation ?? 1,
    localServer: localServer ?? undefined,
  };
}

async function acquireRemoteMcpEndpoint(
  workerHost: string,
  settings: Settings,
  configuredToken: IssuedMcpToken | null,
  listener: McpListener,
  tunnels: RemoteMcpTunnelTransport | undefined,
): Promise<McpEndpoint> {
  if (!tunnels) throw new Error("remote_acp_mcp_requires_tunnel_transport");
  const localServer = await ensureLocalMcpServer(settings, configuredToken, listener);
  try {
    const localHost = "127.0.0.1";
    const localPort = localServer?.handle.port ?? listener.port;
    if (typeof localPort !== "number" || localPort <= 0) {
      throw new Error("remote_acp_mcp_requires_server_port");
    }
    const tunnel = await tunnels.acquireRemoteMcpTunnel(workerHost, localHost, localPort);
    return {
      url: `http://127.0.0.1:${tunnel.remotePort}${mcpPath}`,
      authScope:
        configuredToken?.authScope ??
        localServer?.handle.authScope ??
        mcpAuthScopeForSettings(settings, listener.host, localPort),
      generation: localServer?.generation ?? 1,
      releaseTunnel: () => tunnels.releaseRemoteMcpTunnel(tunnel),
      localServer: localServer ?? undefined,
    };
  } catch (error) {
    if (localServer) await releaseLocalMcpServer(localServer);
    throw error;
  }
}

async function acquirePerRunMcpEndpoint(
  workerHost: string,
  runKey: string,
  settings: Settings,
  configuredToken: IssuedMcpToken | null,
  listener: McpListener,
  tunnels: RemoteMcpTunnelTransport,
  isRunLive?: IsRunLive,
): Promise<McpEndpoint> {
  // The refcounted local MCP server is acquired BEFORE the per-run tunnel is
  // opened. If anything after this point throws (notably `openForRun` failing
  // to spawn the reverse tunnel), this function rejects before returning an
  // McpEndpoint, so the caller never sees `localServer` and cannot release it.
  // Drop the ref here so repeated tunnel-spawn failures don't leak refcounted
  // local MCP servers / their listeners. The per-run server is mounted with the
  // injected `isRunLive` oracle so its Token B middleware enforces the owner
  // re-check + generation fence on every request. `requireOwnedServer: true`
  // refuses to attach to a foreign server Lorenz cannot enforce that fence over.
  // Remote-worker workflows whose dashboard owns `server.port` must configure a
  // distinct `server.mcp_port`.
  const localServer = await ensureLocalMcpServer(
    settings,
    configuredToken,
    listener,
    isRunLive,
    true,
  );
  // Capture the shared local server's generation BEFORE the `openForRun` await.
  // The event loop is single-writer only BETWEEN awaits, so stamping the claim
  // with the generation live at this point (not re-read after the await, when a
  // recycle may have bumped it) makes a stale token fail the per-request liveness
  // fence instead of silently inheriting a generation it was never minted against.
  const generation = localServer?.generation ?? 1;
  try {
    const localHost = "127.0.0.1";
    const localPort = localServer?.handle.port ?? listener.port;
    if (typeof localPort !== "number" || localPort <= 0) {
      throw new Error("remote_acp_mcp_requires_server_port");
    }
    const tunnel = await tunnels.openForRun(workerHost, runKey, localHost, localPort);
    return {
      url: `http://127.0.0.1:${tunnel.remotePort}${mcpPath}`,
      authScope:
        configuredToken?.authScope ??
        localServer?.handle.authScope ??
        mcpAuthScopeForSettings(settings, listener.host, localPort),
      generation,
      localServer: localServer ?? undefined,
    };
  } catch (error) {
    if (localServer) await releaseLocalMcpServer(localServer);
    throw error;
  }
}

async function ensureLocalMcpServer(
  settings: Settings,
  configuredToken: IssuedMcpToken | null,
  listener: McpListener,
  isRunLive?: IsRunLive,
  requireOwnedServer = false,
): Promise<LocalMcpServerLease | null> {
  const configuredPort = listener.port;
  const serverHost = listener.host;
  const enforcePerRunClaim = isRunLive !== undefined;
  if (typeof configuredPort === "number" && configuredPort > 0) {
    const key = `${serverHost}:${configuredPort}`;
    const identity = mcpAuthScopeForSettings(settings, serverHost, configuredPort);
    if (!configuredToken || configuredToken.authScope !== identity) {
      throw new Error("configured_mcp_token_scope_mismatch");
    }
    return withLocalMcpServerLock(key, async () => {
      const existing = localMcpServers.get(key);
      if (existing) {
        if (existing.identity !== identity || existing.enforcePerRunClaim !== enforcePerRunClaim) {
          throw new Error("configured_mcp_server_conflict");
        }
        existing.refCount += 1;
        return { key, handle: existing.handle, generation: existing.generation };
      }
      if (await configuredMcpServerReachable(settings, configuredToken.token, listener)) {
        // A foreign MCP server is already reachable on the configured port. The
        // ACP/local path attaches to it, but the per-run claim path must refuse:
        // Lorenz cannot enforce Token B's owner and generation checks there.
        if (requireOwnedServer) {
          throw new Error(
            listener.sharesDashboard
              ? "per_run_mcp_endpoint_requires_server_mcp_port"
              : "per_run_mcp_endpoint_requires_lorenz_owned_server",
          );
        }
        return null;
      }
      const handle = await startMcpServer(settings, {
        host: serverHost,
        port: configuredPort,
        authScope: identity,
        isRunLive,
      });
      // Bump the slot's generation when a brand-new entry replaces a torn-down
      // one. The first entry for a key gets generation 1; each recycle is
      // strictly higher, so any Token B stamped with the prior generation is
      // fenced out by the per-request liveness re-check.
      const generation = (localMcpServerGenerations.get(key) ?? 0) + 1;
      localMcpServerGenerations.set(key, generation);
      localMcpServers.set(key, {
        handle,
        identity,
        enforcePerRunClaim,
        refCount: 1,
        generation,
      });
      return { key, handle, generation };
    });
  }

  const handle = await startMcpServer(settings, { host: serverHost, port: 0, isRunLive });
  // Ephemeral (port 0) servers are not shared/refcounted, so each lease is its
  // own generation-1 slot stopped on release; nothing recycles it in place.
  return { key: null, handle, generation: 1 };
}

function issueConfiguredMcpToken(settings: Settings, listener: McpListener): IssuedMcpToken | null {
  const configuredPort = listener.port;
  if (typeof configuredPort !== "number" || configuredPort <= 0) return null;
  const authScope = mcpAuthScopeForSettings(settings, listener.host, configuredPort);
  return { authScope, token: issueMcpToken(authScope) };
}

async function withLocalMcpServerLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = localMcpServerLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  localMcpServerLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (localMcpServerLocks.get(key) === current) localMcpServerLocks.delete(key);
  }
}

async function releaseLocalMcpServer(lease: LocalMcpServerLease): Promise<void> {
  if (lease.key === null) {
    await lease.handle.stop();
    return;
  }
  const key = lease.key;
  await withLocalMcpServerLock(key, async () => {
    const entry = localMcpServers.get(key);
    if (!entry) return;
    // Generation fence: this lease was taken against an OLDER entry that has
    // since been fully torn down and recreated (host recycle bumped the slot's
    // generation). A fresh owner holds the live entry's ref, so a late release
    // from the prior generation must NOT decrement the new entry's refcount and
    // tear down a server that is still in use.
    if (lease.generation < entry.generation) return;
    if (entry.refCount > 1) {
      entry.refCount -= 1;
      return;
    }
    localMcpServers.delete(key);
    await entry.handle.stop();
  });
}

async function configuredMcpServerReachable(
  settings: Settings,
  token: string,
  listener: McpListener,
): Promise<boolean> {
  const url = configuredLocalMcpUrl(listener);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: configuredMcpProbeId,
        method: "tools/list",
      }),
      signal: AbortSignal.timeout(250),
    });
    if (!response.ok) return false;
    const body = await response.json();
    if (!isRecord(body) || body.jsonrpc !== "2.0" || body.id !== configuredMcpProbeId) {
      return false;
    }
    const result = body.result;
    return isRecord(result) && Array.isArray(result.tools);
  } catch {
    return false;
  }
}

function configuredLocalMcpUrl(listener: McpListener): string {
  return `http://${httpUrlHost(listener.host)}:${listener.port}${mcpPath}`;
}

function sharedMcpListener(settings: Settings): McpListener {
  return {
    host: normalizeHttpBindHost(settings.server.host),
    port: settings.server.port,
    sharesDashboard: true,
  };
}

function remoteMcpListener(settings: Settings): McpListener {
  const port = settings.server.mcpPort ?? settings.server.port;
  const sharesDashboard =
    settings.server.mcpPort === undefined || settings.server.mcpPort === settings.server.port;
  // A dedicated agent MCP listener is only reached locally or through `ssh -R`.
  // Keep it on loopback even when the operator exposes the dashboard. An
  // explicitly equal MCP/dashboard port is still the shared endpoint, so retain
  // the dashboard host and surface the actionable dedicated-port error.
  return {
    host: sharesDashboard ? normalizeHttpBindHost(settings.server.host) : "127.0.0.1",
    port,
    sharesDashboard,
  };
}
