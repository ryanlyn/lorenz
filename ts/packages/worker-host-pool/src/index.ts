import { startReverseTunnel } from "@symphony/ssh";

export interface RemoteMcpTunnelLease {
  workerHost: string;
  remotePort: number;
}

interface RemoteMcpTunnelEntry extends RemoteMcpTunnelLease {
  localHost: string;
  localPort: number;
  process: ReturnType<typeof startReverseTunnel>;
  refCount: number;
  exited: boolean;
}

export class WorkerHostPool {
  private nextRemoteMcpPort = 46_000;
  private readonly availableRemoteMcpPorts: number[] = [];
  private readonly remoteMcpTunnels = new Map<string, RemoteMcpTunnelEntry>();

  acquireRemoteMcpTunnel(
    workerHost: string,
    localHost: string,
    localPort: number,
  ): RemoteMcpTunnelLease {
    const current = this.remoteMcpTunnels.get(workerHost);
    if (
      current &&
      !current.exited &&
      current.localHost === localHost &&
      current.localPort === localPort
    ) {
      current.refCount += 1;
      return { workerHost, remotePort: current.remotePort };
    }
    if (current) this.closeRemoteMcpTunnel(workerHost, current, true);

    const recycledPort = this.availableRemoteMcpPorts.shift();
    const remotePort = recycledPort ?? this.nextRemoteMcpPort;
    let process: ReturnType<typeof startReverseTunnel>;
    try {
      process = startReverseTunnel(workerHost, remotePort, localHost, localPort);
    } catch (error) {
      if (recycledPort !== undefined) this.recycleRemoteMcpPort(recycledPort);
      throw error;
    }
    if (recycledPort === undefined) this.nextRemoteMcpPort += 1;
    const entry: RemoteMcpTunnelEntry = {
      workerHost,
      localHost,
      localPort,
      process,
      refCount: 1,
      remotePort,
      exited: false,
    };
    this.remoteMcpTunnels.set(workerHost, entry);
    process.on("close", () => {
      entry.exited = true;
      if (this.remoteMcpTunnels.get(workerHost) === entry) {
        this.closeRemoteMcpTunnel(workerHost, entry, true);
      }
    });
    process.on("error", () => {
      entry.exited = true;
      if (this.remoteMcpTunnels.get(workerHost) === entry) {
        this.closeRemoteMcpTunnel(workerHost, entry, true);
      }
    });
    return { workerHost, remotePort };
  }

  releaseRemoteMcpTunnel(workerHost: string): void {
    const entry = this.remoteMcpTunnels.get(workerHost);
    if (!entry) return;
    if (entry.refCount > 1) {
      entry.refCount -= 1;
      return;
    }
    this.closeRemoteMcpTunnel(workerHost, entry, true);
  }

  private closeRemoteMcpTunnel(
    workerHost: string,
    entry: RemoteMcpTunnelEntry,
    recyclePort: boolean,
  ): void {
    this.remoteMcpTunnels.delete(workerHost);
    if (recyclePort) this.recycleRemoteMcpPort(entry.remotePort);
    if (!entry.exited) {
      entry.exited = true;
      entry.process.kill();
    }
  }

  private recycleRemoteMcpPort(remotePort: number): void {
    if (this.availableRemoteMcpPorts.includes(remotePort)) return;
    this.availableRemoteMcpPorts.push(remotePort);
    this.availableRemoteMcpPorts.sort((left, right) => left - right);
  }
}

export const workerHostPool = new WorkerHostPool();
