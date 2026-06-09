import { startReverseTunnel, waitForRemoteTcpPort } from "@symphony/ssh";

export interface RemoteMcpTunnelLease {
  leaseId: string;
  workerHost: string;
  remotePort: number;
}

interface RemoteMcpTunnelEntry {
  workerHost: string;
  localHost: string;
  localPort: number;
  remotePort: number;
  process: ReturnType<typeof startReverseTunnel>;
  leaseIds: Set<string>;
  readyPromise: Promise<void>;
  processEnded: boolean;
  recyclePortOnProcessEnd: boolean;
}

export class WorkerHostPool {
  private nextRemoteMcpPort = 46_000;
  private nextRemoteMcpLeaseId = 1;
  private readonly availableRemoteMcpPorts: number[] = [];
  private readonly remoteMcpTunnelsByEndpoint = new Map<string, RemoteMcpTunnelEntry>();
  private readonly remoteMcpTunnelEntriesByLeaseId = new Map<string, RemoteMcpTunnelEntry>();

  async acquireRemoteMcpTunnel(
    workerHost: string,
    localHost: string,
    localPort: number,
  ): Promise<RemoteMcpTunnelLease> {
    const endpointKey = this.remoteMcpTunnelEndpointKey(workerHost, localHost, localPort);
    const current = this.remoteMcpTunnelsByEndpoint.get(endpointKey);
    if (current && !current.processEnded) {
      await this.waitForRemoteMcpTunnelReady(current);
      return this.createRemoteMcpTunnelLease(current);
    }
    if (current) this.closeRemoteMcpTunnel(current, true);

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
      leaseIds: new Set(),
      readyPromise: Promise.resolve(),
      remotePort,
      processEnded: false,
      recyclePortOnProcessEnd: false,
    };
    this.remoteMcpTunnelsByEndpoint.set(endpointKey, entry);
    process.on("close", () => this.handleRemoteMcpTunnelProcessEnd(entry, endpointKey));
    process.on("exit", () => this.handleRemoteMcpTunnelProcessEnd(entry, endpointKey));
    process.on("error", () => this.handleRemoteMcpTunnelProcessEnd(entry, endpointKey));
    entry.readyPromise = this.confirmRemoteMcpTunnelReady(entry);
    await this.waitForRemoteMcpTunnelReady(entry);
    return this.createRemoteMcpTunnelLease(entry);
  }

  releaseRemoteMcpTunnel(lease: RemoteMcpTunnelLease): void {
    const entry = this.remoteMcpTunnelEntriesByLeaseId.get(lease.leaseId);
    if (!entry) return;
    if (entry.workerHost !== lease.workerHost || entry.remotePort !== lease.remotePort) {
      return;
    }
    this.remoteMcpTunnelEntriesByLeaseId.delete(lease.leaseId);
    entry.leaseIds.delete(lease.leaseId);
    if (entry.leaseIds.size > 0) return;
    this.closeRemoteMcpTunnel(entry, true);
  }

  private closeRemoteMcpTunnel(entry: RemoteMcpTunnelEntry, recyclePort: boolean): void {
    const endpointKey = this.remoteMcpTunnelEndpointKey(
      entry.workerHost,
      entry.localHost,
      entry.localPort,
    );
    if (this.remoteMcpTunnelsByEndpoint.get(endpointKey) === entry) {
      this.remoteMcpTunnelsByEndpoint.delete(endpointKey);
    }
    for (const leaseId of entry.leaseIds) {
      this.remoteMcpTunnelEntriesByLeaseId.delete(leaseId);
    }
    entry.leaseIds.clear();
    if (recyclePort) {
      if (entry.processEnded) {
        this.recycleRemoteMcpPort(entry.remotePort);
      } else {
        entry.recyclePortOnProcessEnd = true;
      }
    }
    if (!entry.processEnded) {
      entry.process.kill();
    }
  }

  private handleRemoteMcpTunnelProcessEnd(entry: RemoteMcpTunnelEntry, endpointKey: string): void {
    if (entry.processEnded) return;
    entry.processEnded = true;
    if (this.remoteMcpTunnelsByEndpoint.get(endpointKey) === entry) {
      this.closeRemoteMcpTunnel(entry, true);
      return;
    }
    if (entry.recyclePortOnProcessEnd) this.recycleRemoteMcpPort(entry.remotePort);
  }

  private async waitForRemoteMcpTunnelReady(entry: RemoteMcpTunnelEntry): Promise<void> {
    try {
      await entry.readyPromise;
    } catch (error) {
      throw this.remoteMcpTunnelSetupError(entry, error);
    }
    if (entry.processEnded) {
      throw this.remoteMcpTunnelSetupError(entry, new Error("reverse_tunnel_process_ended"));
    }
  }

  private async confirmRemoteMcpTunnelReady(entry: RemoteMcpTunnelEntry): Promise<void> {
    const processEndWatcher = this.watchRemoteMcpTunnelSetupProcessEnd(entry);
    try {
      await Promise.race([
        waitForRemoteTcpPort(entry.workerHost, entry.remotePort),
        processEndWatcher.promise,
      ]);
    } catch (error) {
      this.closeRemoteMcpTunnel(entry, true);
      throw error;
    } finally {
      processEndWatcher.dispose();
    }
  }

  private watchRemoteMcpTunnelSetupProcessEnd(entry: RemoteMcpTunnelEntry): {
    promise: Promise<never>;
    dispose: () => void;
  } {
    let dispose = (): void => {};
    const promise = new Promise<never>((_, reject) => {
      const rejectOnce = (reason: string): void => {
        dispose();
        reject(new Error(reason));
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        rejectOnce(`reverse_tunnel_closed: ${code ?? "null"} ${signal ?? "null"}`);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        rejectOnce(`reverse_tunnel_exited: ${code ?? "null"} ${signal ?? "null"}`);
      };
      const onError = (error: Error): void => {
        rejectOnce(`reverse_tunnel_error: ${error.message}`);
      };
      dispose = (): void => {
        entry.process.off("close", onClose);
        entry.process.off("exit", onExit);
        entry.process.off("error", onError);
      };
      entry.process.once("close", onClose);
      entry.process.once("exit", onExit);
      entry.process.once("error", onError);
    });
    return { promise, dispose };
  }

  private remoteMcpTunnelSetupError(entry: RemoteMcpTunnelEntry, cause: unknown): Error {
    return new Error(`remote_mcp_tunnel_setup_failed: ${entry.workerHost} ${entry.remotePort}`, {
      cause,
    });
  }

  private recycleRemoteMcpPort(remotePort: number): void {
    if (this.availableRemoteMcpPorts.includes(remotePort)) return;
    this.availableRemoteMcpPorts.push(remotePort);
    this.availableRemoteMcpPorts.sort((left, right) => left - right);
  }

  private createRemoteMcpTunnelLease(entry: RemoteMcpTunnelEntry): RemoteMcpTunnelLease {
    const leaseId = String(this.nextRemoteMcpLeaseId);
    this.nextRemoteMcpLeaseId += 1;
    entry.leaseIds.add(leaseId);
    this.remoteMcpTunnelEntriesByLeaseId.set(leaseId, entry);
    return {
      leaseId,
      workerHost: entry.workerHost,
      remotePort: entry.remotePort,
    };
  }

  private remoteMcpTunnelEndpointKey(
    workerHost: string,
    localHost: string,
    localPort: number,
  ): string {
    return `${workerHost}\0${localHost}\0${localPort}`;
  }
}

export const workerHostPool = new WorkerHostPool();
