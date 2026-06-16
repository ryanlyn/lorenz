import { startReverseTunnel, waitForRemoteTcpPort } from "@lorenz/ssh";

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
  // Per-run tunnels are keyed by `${workerHost}#${runKey}`, NOT host-coalesced,
  // so each run owns a distinct entry (and distinct remote port). One run's
  // localPort change can never replace another run's entry.
  private readonly perRunMcpTunnels = new Map<string, RemoteMcpTunnelEntry>();

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

  async openForRun(
    workerHost: string,
    runKey: string,
    localHost: string,
    localPort: number,
  ): Promise<RemoteMcpTunnelLease> {
    const key = perRunKey(workerHost, runKey);
    const current = this.perRunMcpTunnels.get(key);
    if (
      current &&
      !current.processEnded &&
      current.localHost === localHost &&
      current.localPort === localPort
    ) {
      await this.waitForRemoteMcpTunnelReady(current);
      return this.createRemoteMcpTunnelLease(current);
    }
    if (current) this.closePerRunMcpTunnel(key, current, true);

    const remotePort = this.allocateRemoteMcpPort();
    const recycledPort = remotePort < this.nextRemoteMcpPort ? remotePort : undefined;
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
    this.perRunMcpTunnels.set(key, entry);
    process.on("close", () => this.handlePerRunMcpTunnelProcessEnd(key, entry));
    process.on("exit", () => this.handlePerRunMcpTunnelProcessEnd(key, entry));
    process.on("error", () => this.handlePerRunMcpTunnelProcessEnd(key, entry));
    entry.readyPromise = this.confirmPerRunMcpTunnelReady(key, entry);
    await this.waitForRemoteMcpTunnelReady(entry);
    return this.createRemoteMcpTunnelLease(entry);
  }

  closeForRun(workerHost: string, runKey: string): void {
    const key = perRunKey(workerHost, runKey);
    const entry = this.perRunMcpTunnels.get(key);
    if (!entry) return;
    // Each openForRun call on this run minted one lease; drop one per close
    // and keep the tunnel while other holders of the same run remain.
    const [leaseId] = entry.leaseIds;
    if (leaseId !== undefined) {
      entry.leaseIds.delete(leaseId);
      this.remoteMcpTunnelEntriesByLeaseId.delete(leaseId);
    }
    if (entry.leaseIds.size > 0) return;
    this.closePerRunMcpTunnel(key, entry, true);
  }

  // Allocate a remote port, reusing a recycled candidate only when no live
  // entry (host-keyed OR per-run) still holds it. This guards the
  // recycled-port-vs-stale-entry interaction under N concurrent live ports.
  private allocateRemoteMcpPort(): number {
    while (this.availableRemoteMcpPorts.length > 0) {
      const candidate = this.availableRemoteMcpPorts.shift()!;
      if (!this.isRemoteMcpPortLive(candidate)) return candidate;
    }
    return this.nextRemoteMcpPort;
  }

  private isRemoteMcpPortLive(remotePort: number): boolean {
    for (const entry of this.remoteMcpTunnelsByEndpoint.values()) {
      if (entry.remotePort === remotePort) return true;
    }
    for (const entry of this.perRunMcpTunnels.values()) {
      if (entry.remotePort === remotePort) return true;
    }
    return false;
  }

  private async confirmPerRunMcpTunnelReady(
    key: string,
    entry: RemoteMcpTunnelEntry,
  ): Promise<void> {
    const processEndWatcher = this.watchRemoteMcpTunnelSetupProcessEnd(entry);
    try {
      await Promise.race([
        waitForRemoteTcpPort(entry.workerHost, entry.remotePort),
        processEndWatcher.promise,
      ]);
    } catch (error) {
      this.closePerRunMcpTunnel(key, entry, true);
      throw error;
    } finally {
      processEndWatcher.dispose();
    }
  }

  private handlePerRunMcpTunnelProcessEnd(key: string, entry: RemoteMcpTunnelEntry): void {
    if (entry.processEnded) return;
    entry.processEnded = true;
    if (this.perRunMcpTunnels.get(key) === entry) {
      this.closePerRunMcpTunnel(key, entry, true);
      return;
    }
    if (entry.recyclePortOnProcessEnd) this.recycleRemoteMcpPort(entry.remotePort);
  }

  private closePerRunMcpTunnel(
    key: string,
    entry: RemoteMcpTunnelEntry,
    recyclePort: boolean,
  ): void {
    if (this.perRunMcpTunnels.get(key) === entry) {
      this.perRunMcpTunnels.delete(key);
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

function perRunKey(workerHost: string, runKey: string): string {
  return `${workerHost}#${runKey}`;
}

export const workerHostPool = new WorkerHostPool();
