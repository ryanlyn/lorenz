import { workerHostPool, type RemoteMcpTunnelLease } from "@symphony/worker-host-pool";
import {
  httpUrlHost,
  normalizeHttpBindHost,
  type Settings,
  type TrackerKind,
} from "@symphony/domain";
import type { McpServer } from "@agentclientprotocol/sdk";

import { startClaudeMcpServer, type ObservabilityServerHandle } from "./server.js";
import { issueMcpToken, revokeMcpToken } from "./auth.js";

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
  tunnel?: RemoteMcpTunnelLease | undefined;
  localServer?: LocalMcpServerLease | undefined;
}

interface LocalMcpServerEntry {
  handle: ObservabilityServerHandle;
  refCount: number;
}

interface LocalMcpServerLease {
  key: string | null;
  handle: ObservabilityServerHandle;
}

const mcpPath = "/claude-mcp";
const localMcpServers = new Map<string, LocalMcpServerEntry>();
const localMcpServerLocks = new Map<string, Promise<void>>();

export async function acquireAgentMcpEndpoint(
  settings: Settings,
  workerHost?: string | null,
): Promise<AgentMcpEndpointLease> {
  let endpoint: McpEndpoint | null = null;
  const token = issueMcpToken();
  let released = false;
  try {
    endpoint = workerHost
      ? await acquireRemoteMcpEndpoint(workerHost, settings)
      : await localMcpEndpoint(settings);
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
        if (endpoint?.tunnel) workerHostPool.releaseRemoteMcpTunnel(endpoint.tunnel.workerHost);
        if (endpoint?.localServer) await releaseLocalMcpServer(endpoint.localServer);
      },
    };
  } catch (error) {
    revokeMcpToken(token);
    if (endpoint?.tunnel) workerHostPool.releaseRemoteMcpTunnel(endpoint.tunnel.workerHost);
    if (endpoint?.localServer) await releaseLocalMcpServer(endpoint.localServer);
    throw error;
  }
}

async function localMcpEndpoint(settings: Settings): Promise<McpEndpoint> {
  const localServer = await ensureLocalMcpServer(settings);
  return {
    url: localServer ? localServer.handle.url(mcpPath) : configuredLocalMcpUrl(settings),
    localServer: localServer ?? undefined,
  };
}

async function acquireRemoteMcpEndpoint(
  workerHost: string,
  settings: Settings,
): Promise<McpEndpoint> {
  const localServer = await ensureLocalMcpServer(settings);
  try {
    const localHost = "127.0.0.1";
    const localPort = localServer?.handle.port ?? settings.server.port;
    if (typeof localPort !== "number" || localPort <= 0) {
      throw new Error("remote_acp_mcp_requires_server_port");
    }
    const tunnel = workerHostPool.acquireRemoteMcpTunnel(workerHost, localHost, localPort);
    return {
      url: `http://127.0.0.1:${tunnel.remotePort}${mcpPath}`,
      tunnel,
      localServer: localServer ?? undefined,
    };
  } catch (error) {
    if (localServer) await releaseLocalMcpServer(localServer);
    throw error;
  }
}

async function ensureLocalMcpServer(settings: Settings): Promise<LocalMcpServerLease | null> {
  const configuredPort = settings.server.port;
  const serverHost = normalizeHttpBindHost(settings.server.host);
  if (typeof configuredPort === "number" && configuredPort > 0) {
    const key = `${serverHost}:${configuredPort}`;
    return withLocalMcpServerLock(key, async () => {
      const existing = localMcpServers.get(key);
      if (existing) {
        existing.refCount += 1;
        return { key, handle: existing.handle };
      }
      if (await configuredMcpServerReachable(settings)) return null;
      const handle = await startClaudeMcpServer(settings, {
        host: serverHost,
        port: configuredPort,
      });
      localMcpServers.set(key, { handle, refCount: 1 });
      return { key, handle };
    });
  }

  const handle = await startClaudeMcpServer(settings, { host: serverHost, port: 0 });
  return { key: null, handle };
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
  const entry = localMcpServers.get(lease.key);
  if (!entry) return;
  if (entry.refCount > 1) {
    entry.refCount -= 1;
    return;
  }
  localMcpServers.delete(lease.key);
  await entry.handle.stop();
}

async function configuredMcpServerReachable(settings: Settings): Promise<boolean> {
  const url = configuredLocalMcpUrl(settings);
  try {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(250) });
    return response.status === 405;
  } catch {
    return false;
  }
}

function configuredLocalMcpUrl(settings: Settings): string {
  return `http://${httpUrlHost(settings.server.host)}:${settings.server.port}${mcpPath}`;
}
