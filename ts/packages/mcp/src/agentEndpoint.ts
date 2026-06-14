import {
  httpUrlHost,
  isRecord,
  normalizeHttpBindHost,
  type Settings,
  type TrackerKind,
} from "@symphony/domain";
import type { McpServer } from "@agentclientprotocol/sdk";

import { startMcpServer, type ObservabilityServerHandle } from "./server.js";
import { issueMcpToken, mcpAuthScopeForSettings, revokeMcpToken } from "./auth.js";

export function trackerMcpServerName(kind: TrackerKind | undefined): string {
  return `symphony_${(kind ?? "tracker").replace(/[^A-Za-z0-9_]/g, "_")}`;
}

export interface AgentMcpEndpointLease {
  url: string;
  token: string;
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
 * per-run path keys a tunnel by `(workerHost, runKey)` via {@link openForRun}/{@link
 * closeForRun} so co-resident runs on one machine each get an isolated tunnel.
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
  releaseTunnel?: (() => void) | undefined;
  localServer?: LocalMcpServerLease | undefined;
}

interface LocalMcpServerEntry {
  handle: ObservabilityServerHandle;
  identity: string;
  refCount: number;
}

interface LocalMcpServerLease {
  key: string | null;
  handle: ObservabilityServerHandle;
}

interface IssuedMcpToken {
  authScope: string;
  token: string;
}

const mcpPath = "/mcp";
const configuredMcpProbeId = "symphony-configured-mcp-probe";
const localMcpServers = new Map<string, LocalMcpServerEntry>();
const localMcpServerLocks = new Map<string, Promise<void>>();

export async function acquireAgentMcpEndpoint(
  settings: Settings,
  workerHost?: string | null,
  tunnels?: RemoteMcpTunnelTransport,
): Promise<AgentMcpEndpointLease> {
  let endpoint: McpEndpoint | null = null;
  let token: string | null = null;
  let released = false;
  try {
    const configuredToken = issueConfiguredMcpToken(settings);
    token = configuredToken?.token ?? null;
    endpoint = workerHost
      ? await acquireRemoteMcpEndpoint(workerHost, settings, configuredToken, tunnels)
      : await localMcpEndpoint(settings, configuredToken);
    token ??= issueMcpToken(endpoint.authScope);
    return {
      url: endpoint.url,
      token,
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
): Promise<AgentMcpEndpointLease> {
  let endpoint: McpEndpoint | null = null;
  let token: string | null = null;
  let released = false;
  try {
    const configuredToken = issueConfiguredMcpToken(settings);
    token = configuredToken?.token ?? null;
    endpoint = await acquirePerRunMcpEndpoint(
      workerHost,
      runKey,
      settings,
      configuredToken,
      tunnels,
    );
    token ??= issueMcpToken(endpoint.authScope);
    return {
      url: endpoint.url,
      token,
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
        tunnels.closeForRun(workerHost, runKey);
        if (endpoint?.localServer) await releaseLocalMcpServer(endpoint.localServer);
      },
    };
  } catch (error) {
    revokeMcpToken(token);
    tunnels.closeForRun(workerHost, runKey);
    if (endpoint?.localServer) await releaseLocalMcpServer(endpoint.localServer);
    throw error;
  }
}

async function localMcpEndpoint(
  settings: Settings,
  configuredToken: IssuedMcpToken | null,
): Promise<McpEndpoint> {
  const localServer = await ensureLocalMcpServer(settings, configuredToken);
  const serverHost = normalizeHttpBindHost(settings.server.host);
  const configuredPort = settings.server.port;
  return {
    url: localServer ? localServer.handle.url(mcpPath) : configuredLocalMcpUrl(settings),
    authScope:
      configuredToken?.authScope ??
      localServer?.handle.authScope ??
      mcpAuthScopeForSettings(settings, serverHost, configuredPort),
    localServer: localServer ?? undefined,
  };
}

async function acquireRemoteMcpEndpoint(
  workerHost: string,
  settings: Settings,
  configuredToken: IssuedMcpToken | null,
  tunnels: RemoteMcpTunnelTransport | undefined,
): Promise<McpEndpoint> {
  if (!tunnels) throw new Error("remote_acp_mcp_requires_tunnel_transport");
  const localServer = await ensureLocalMcpServer(settings, configuredToken);
  try {
    const localHost = "127.0.0.1";
    const localPort = localServer?.handle.port ?? settings.server.port;
    if (typeof localPort !== "number" || localPort <= 0) {
      throw new Error("remote_acp_mcp_requires_server_port");
    }
    const tunnel = await tunnels.acquireRemoteMcpTunnel(workerHost, localHost, localPort);
    return {
      url: `http://127.0.0.1:${tunnel.remotePort}${mcpPath}`,
      authScope:
        configuredToken?.authScope ??
        localServer?.handle.authScope ??
        mcpAuthScopeForSettings(settings, normalizeHttpBindHost(settings.server.host), localPort),
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
  tunnels: RemoteMcpTunnelTransport,
): Promise<McpEndpoint> {
  // The refcounted local MCP server is acquired BEFORE the per-run tunnel is
  // opened. If anything after this point throws (notably `openForRun` failing
  // to spawn the reverse tunnel), this function rejects before returning an
  // McpEndpoint, so the caller never sees `localServer` and cannot release it.
  // Drop the ref here so repeated tunnel-spawn failures don't leak refcounted
  // local MCP servers / their listeners.
  const localServer = await ensureLocalMcpServer(settings, configuredToken);
  try {
    const localHost = "127.0.0.1";
    const localPort = localServer?.handle.port ?? settings.server.port;
    if (typeof localPort !== "number" || localPort <= 0) {
      throw new Error("remote_acp_mcp_requires_server_port");
    }
    const tunnel = await tunnels.openForRun(workerHost, runKey, localHost, localPort);
    return {
      url: `http://127.0.0.1:${tunnel.remotePort}${mcpPath}`,
      authScope:
        configuredToken?.authScope ??
        localServer?.handle.authScope ??
        mcpAuthScopeForSettings(settings, normalizeHttpBindHost(settings.server.host), localPort),
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
): Promise<LocalMcpServerLease | null> {
  const configuredPort = settings.server.port;
  const serverHost = normalizeHttpBindHost(settings.server.host);
  if (typeof configuredPort === "number" && configuredPort > 0) {
    const key = `${serverHost}:${configuredPort}`;
    const identity = mcpAuthScopeForSettings(settings, serverHost, configuredPort);
    if (!configuredToken || configuredToken.authScope !== identity) {
      throw new Error("configured_mcp_token_scope_mismatch");
    }
    return withLocalMcpServerLock(key, async () => {
      const existing = localMcpServers.get(key);
      if (existing) {
        if (existing.identity !== identity) {
          throw new Error("configured_mcp_server_conflict");
        }
        existing.refCount += 1;
        return { key, handle: existing.handle };
      }
      if (await configuredMcpServerReachable(settings, configuredToken.token)) return null;
      const handle = await startMcpServer(settings, {
        host: serverHost,
        port: configuredPort,
        authScope: identity,
      });
      localMcpServers.set(key, { handle, identity, refCount: 1 });
      return { key, handle };
    });
  }

  const handle = await startMcpServer(settings, { host: serverHost, port: 0 });
  return { key: null, handle };
}

function issueConfiguredMcpToken(settings: Settings): IssuedMcpToken | null {
  const configuredPort = settings.server.port;
  if (typeof configuredPort !== "number" || configuredPort <= 0) return null;
  const serverHost = normalizeHttpBindHost(settings.server.host);
  const authScope = mcpAuthScopeForSettings(settings, serverHost, configuredPort);
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
    if (entry.refCount > 1) {
      entry.refCount -= 1;
      return;
    }
    localMcpServers.delete(key);
    await entry.handle.stop();
  });
}

async function configuredMcpServerReachable(settings: Settings, token: string): Promise<boolean> {
  const url = configuredLocalMcpUrl(settings);
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

function configuredLocalMcpUrl(settings: Settings): string {
  return `http://${httpUrlHost(settings.server.host)}:${settings.server.port}${mcpPath}`;
}
