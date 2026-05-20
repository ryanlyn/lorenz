import { issueMcpToken, revokeMcpToken } from "./auth.js";
import { startClaudeMcpServer, type ObservabilityServerHandle } from "./server.js";
import { workerHostPool, type RemoteMcpTunnelLease } from "@symphony/worker-host-pool";
import type { Settings } from "@symphony/domain";
import type { McpServer } from "@agentclientprotocol/sdk";

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
        name: "symphony_linear",
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

export function mcpConfigContents(serverUrl: string, token: string): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        symphony_linear: {
          type: "http",
          url: serverUrl,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    },
    null,
    2,
  )}\n`;
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
}

async function ensureLocalMcpServer(settings: Settings): Promise<LocalMcpServerLease | null> {
  const configuredPort = settings.server.port;
  if (typeof configuredPort === "number" && configuredPort > 0) {
    const key = `${settings.server.host}:${configuredPort}`;
    const existing = localMcpServers.get(key);
    if (existing) {
      existing.refCount += 1;
      return { key, handle: existing.handle };
    }
    if (await configuredMcpServerReachable(settings)) return null;
    const handle = await startClaudeMcpServer(settings, {
      host: settings.server.host,
      port: configuredPort,
    });
    localMcpServers.set(key, { handle, refCount: 1 });
    return { key, handle };
  }

  const handle = await startClaudeMcpServer(settings, { host: settings.server.host, port: 0 });
  return { key: null, handle };
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
  return `http://${httpHost(settings.server.host)}:${settings.server.port}${mcpPath}`;
}

function httpHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
