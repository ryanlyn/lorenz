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
  /**
   * Monotonic generation for this host:port tunnel slot. Bumped each time a
   * brand-new entry replaces a fully torn-down one (a host:port recycle - e.g.
   * the shared local MCP server moved to a new local port on reload). A
   * `closeForRun`/late release recorded against the PRIOR generation must not
   * decrement the new entry's refcount (CAS late-close reject), so it carries
   * the generation it was opened against.
   */
  generation: number;
}

/**
 * Bookkeeping for ONE run's hold on a SHARED per-host tunnel. `openForRun`
 * coalesces every co-resident run on a host onto a SINGLE reverse tunnel (one
 * `ssh -R` per worker host), refcounted by these per-run leases; runs are
 * distinguished by their per-run claim (Token B), NOT by the tunnel/remote port.
 * `closeForRun(workerHost, runKey)` carries no lease id, so the pool records the
 * leaseId + the generation the run opened against here and resolves it on close.
 */
interface PerRunTunnelHold {
  leaseId: string;
  endpointKey: string;
  generation: number;
}

export class WorkerHostPool {
  private nextRemoteMcpPort = 46_000;
  private nextRemoteMcpLeaseId = 1;
  private readonly availableRemoteMcpPorts: number[] = [];
  private readonly remoteMcpTunnelsByEndpoint = new Map<string, RemoteMcpTunnelEntry>();
  private readonly remoteMcpTunnelEntriesByLeaseId = new Map<string, RemoteMcpTunnelEntry>();
  /**
   * Monotonic generation per host:port tunnel slot, surviving entry teardown so
   * a recreated entry gets a STRICTLY higher generation than the one it
   * replaces. A `closeForRun` recorded against a prior generation is rejected.
   */
  private readonly remoteMcpTunnelGenerations = new Map<string, number>();
  /**
   * Per-run holds on the SHARED per-host tunnels, keyed by `${workerHost}#${runKey}`.
   * Each entry records which leaseId (and which generation) a run holds so
   * `closeForRun` drops exactly that run's refcount - opening the tunnel on the
   * first co-resident run and closing it at the last deref.
   */
  private readonly perRunTunnelHolds = new Map<string, PerRunTunnelHold>();

  async acquireRemoteMcpTunnel(
    workerHost: string,
    localHost: string,
    localPort: number,
  ): Promise<RemoteMcpTunnelLease> {
    const endpointKey = this.remoteMcpTunnelEndpointKey(workerHost, localHost, localPort);
    const entry = await this.ensureRemoteMcpTunnelEntry(workerHost, localHost, localPort, endpointKey);
    return this.createRemoteMcpTunnelLease(entry);
  }

  releaseRemoteMcpTunnel(lease: RemoteMcpTunnelLease): void {
    const entry = this.remoteMcpTunnelEntriesByLeaseId.get(lease.leaseId);
    if (!entry) return;
    if (entry.workerHost !== lease.workerHost || entry.remotePort !== lease.remotePort) {
      return;
    }
    this.dropRemoteMcpTunnelLease(entry, lease.leaseId);
  }

  /**
   * Acquire a hold on the per-HOST reverse tunnel for one run. Co-resident runs
   * on the SAME host share ONE `ssh -R` tunnel (opened on the first run, closed
   * at the last `closeForRun`); they are kept apart by their per-run Token B
   * claim, not by a distinct remote port. The generation captured here is what a
   * later `closeForRun` is CAS-checked against, so a host:port recycle that bumps
   * the slot's generation strands a stale late-close instead of decrementing the
   * fresh entry.
   */
  async openForRun(
    workerHost: string,
    runKey: string,
    localHost: string,
    localPort: number,
  ): Promise<RemoteMcpTunnelLease> {
    const holdKey = perRunKey(workerHost, runKey);
    const endpointKey = this.remoteMcpTunnelEndpointKey(workerHost, localHost, localPort);

    // Re-opening the SAME run (e.g. resume) reuses its existing hold when the
    // shared host entry is still live - no second refcount/lease for one run.
    const existingHold = this.perRunTunnelHolds.get(holdKey);
    if (existingHold) {
      const heldEntry = this.remoteMcpTunnelEntriesByLeaseId.get(existingHold.leaseId);
      if (
        heldEntry &&
        !heldEntry.processEnded &&
        heldEntry.localHost === localHost &&
        heldEntry.localPort === localPort
      ) {
        await this.waitForRemoteMcpTunnelReady(heldEntry);
        return {
          leaseId: existingHold.leaseId,
          workerHost: heldEntry.workerHost,
          remotePort: heldEntry.remotePort,
        };
      }
      // The run's prior hold is stale (entry torn down or the local endpoint
      // moved): drop it and take a fresh hold on the current shared entry.
      this.releasePerRunHold(holdKey);
    }

    const entry = await this.ensureRemoteMcpTunnelEntry(workerHost, localHost, localPort, endpointKey);
    const lease = this.createRemoteMcpTunnelLease(entry);
    this.perRunTunnelHolds.set(holdKey, {
      leaseId: lease.leaseId,
      endpointKey,
      generation: entry.generation,
    });
    return lease;
  }

  closeForRun(workerHost: string, runKey: string): void {
    this.releasePerRunHold(perRunKey(workerHost, runKey));
  }

  /**
   * Drop one run's hold on its shared per-host tunnel. CAS late-close reject: if
   * the live entry for the hold's endpoint has a STRICTLY higher generation than
   * the hold recorded, the slot was recycled and a fresh owner holds the live
   * ref - this stale release must NOT decrement the new entry's refcount. The
   * hold's own leaseId either still maps to the original (same-generation) entry
   * or was already cleared on that entry's teardown, so dropping it is otherwise
   * idempotent.
   */
  private releasePerRunHold(holdKey: string): void {
    const hold = this.perRunTunnelHolds.get(holdKey);
    if (!hold) return;
    this.perRunTunnelHolds.delete(holdKey);
    const liveGeneration = this.remoteMcpTunnelGenerations.get(hold.endpointKey);
    if (liveGeneration !== undefined && hold.generation < liveGeneration) {
      // Stale late-close against a recycled slot: never touch the live entry.
      return;
    }
    const entry = this.remoteMcpTunnelEntriesByLeaseId.get(hold.leaseId);
    if (!entry) return;
    this.dropRemoteMcpTunnelLease(entry, hold.leaseId);
  }

  // Reuse-or-open a host-keyed reverse tunnel entry. A live entry for this
  // host:port is shared (refcounted by leases); a torn-down one is replaced by a
  // fresh entry whose generation is STRICTLY higher than the slot's last value.
  private async ensureRemoteMcpTunnelEntry(
    workerHost: string,
    localHost: string,
    localPort: number,
    endpointKey: string,
  ): Promise<RemoteMcpTunnelEntry> {
    const current = this.remoteMcpTunnelsByEndpoint.get(endpointKey);
    if (current && !current.processEnded) {
      await this.waitForRemoteMcpTunnelReady(current);
      return current;
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
    // Bump the slot's generation when a brand-new entry replaces a torn-down
    // one. The first entry for a host:port gets generation 1; each recycle is
    // strictly higher, so a per-run hold recorded against the prior generation
    // is fenced out of the new entry's refcount.
    const generation = (this.remoteMcpTunnelGenerations.get(endpointKey) ?? 0) + 1;
    this.remoteMcpTunnelGenerations.set(endpointKey, generation);
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
      generation,
    };
    this.remoteMcpTunnelsByEndpoint.set(endpointKey, entry);
    process.on("close", () => this.handleRemoteMcpTunnelProcessEnd(entry, endpointKey));
    process.on("exit", () => this.handleRemoteMcpTunnelProcessEnd(entry, endpointKey));
    process.on("error", () => this.handleRemoteMcpTunnelProcessEnd(entry, endpointKey));
    entry.readyPromise = this.confirmRemoteMcpTunnelReady(entry);
    await this.waitForRemoteMcpTunnelReady(entry);
    return entry;
  }

  private dropRemoteMcpTunnelLease(entry: RemoteMcpTunnelEntry, leaseId: string): void {
    if (!entry.leaseIds.has(leaseId)) return;
    this.remoteMcpTunnelEntriesByLeaseId.delete(leaseId);
    entry.leaseIds.delete(leaseId);
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

function perRunKey(workerHost: string, runKey: string): string {
  return `${workerHost}#${runKey}`;
}

export const workerHostPool = new WorkerHostPool();
