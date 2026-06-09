import { workerHostPool, type RemoteMcpTunnelLease } from "@symphony/worker-host-pool";
import {
  httpUrlHost,
  isRecord,
  normalizeHttpBindHost,
  type Settings,
  type TrackerKind,
} from "@symphony/domain";
import type { McpServer } from "@agentclientprotocol/sdk";

import { startClaudeMcpServer, type ObservabilityServerHandle } from "./server.js";
import { issueMcpToken, mcpAuthScopeForSettings, revokeMcpToken } from "./auth.js";

export function trackerMcpServerName(kind: TrackerKind | undefined): string {
  return `symphony_${kind ?? "linear"}`;
}

export interface AgentMcpEndpointLease {
  url: string;
  token: string;
  acpServer(): McpServer;
  release(): Promise<void>;
}

interface McpEndpoint {
  url: string;
  authScope: string;
  tunnel?: RemoteMcpTunnelLease | undefined;
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

const mcpPath = "/claude-mcp";
const configuredMcpProbeId = "symphony-configured-mcp-probe";
const localMcpServers = new Map<string, LocalMcpServerEntry>();
const localMcpServerLocks = new Map<string, Promise<void>>();

export async function acquireAgentMcpEndpoint(
  settings: Settings,
  workerHost?: string | null,
): Promise<AgentMcpEndpointLease> {
  let endpoint: McpEndpoint | null = null;
  let token: string | null = null;
  let released = false;
  try {
    const configuredToken = issueConfiguredMcpToken(settings);
    token = configuredToken?.token ?? null;
    endpoint = workerHost
      ? await acquireRemoteMcpEndpoint(workerHost, settings, configuredToken)
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
        if (endpoint?.tunnel) workerHostPool.releaseRemoteMcpTunnel(endpoint.tunnel);
        if (endpoint?.localServer) await releaseLocalMcpServer(endpoint.localServer);
      },
    };
  } catch (error) {
    revokeMcpToken(token);
    if (endpoint?.tunnel) workerHostPool.releaseRemoteMcpTunnel(endpoint.tunnel);
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
): Promise<McpEndpoint> {
  const localServer = await ensureLocalMcpServer(settings, configuredToken);
  try {
    const localHost = "127.0.0.1";
    const localPort = localServer?.handle.port ?? settings.server.port;
    if (typeof localPort !== "number" || localPort <= 0) {
      throw new Error("remote_acp_mcp_requires_server_port");
    }
    const tunnel = await workerHostPool.acquireRemoteMcpTunnel(workerHost, localHost, localPort);
    return {
      url: `http://127.0.0.1:${tunnel.remotePort}${mcpPath}`,
      authScope:
        configuredToken?.authScope ??
        localServer?.handle.authScope ??
        mcpAuthScopeForSettings(settings, normalizeHttpBindHost(settings.server.host), localPort),
      tunnel,
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
      const handle = await startClaudeMcpServer(settings, {
        host: serverHost,
        port: configuredPort,
        authScope: identity,
      });
      localMcpServers.set(key, { handle, identity, refCount: 1 });
      return { key, handle };
    });
  }

  const handle = await startClaudeMcpServer(settings, { host: serverHost, port: 0 });
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
