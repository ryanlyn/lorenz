import {
  startReverseTunnel,
  waitForRemoteTcpPortClosed,
  type ReverseTunnelHandle,
} from "@lorenz/ssh";

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
  tunnel: ReverseTunnelHandle;
  leaseIds: Set<string>;
  closed: boolean;
  closePromise: Promise<void> | null;
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
  private nextRemoteMcpLeaseId = 1;
  private readonly nextRemoteMcpPortByWorkerHost = new Map<string, number>();
  private readonly availableRemoteMcpPortsByWorkerHost = new Map<string, number[]>();
  private readonly remoteMcpTunnelsByEndpoint = new Map<string, RemoteMcpTunnelEntry>();
  private readonly remoteMcpTunnelSetupsByEndpoint = new Map<
    string,
    Promise<RemoteMcpTunnelEntry>
  >();
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
    while (true) {
      const entry = await this.ensureRemoteMcpTunnelEntry(
        workerHost,
        localHost,
        localPort,
        endpointKey,
      );
      if (!this.isCurrentRemoteMcpTunnel(entry, endpointKey)) continue;
      return this.createRemoteMcpTunnelLease(entry);
    }
  }

  async releaseRemoteMcpTunnel(lease: RemoteMcpTunnelLease): Promise<void> {
    const entry = this.remoteMcpTunnelEntriesByLeaseId.get(lease.leaseId);
    if (!entry) return;
    if (entry.workerHost !== lease.workerHost || entry.remotePort !== lease.remotePort) {
      return;
    }
    await this.dropRemoteMcpTunnelLease(entry, lease.leaseId);
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

    while (true) {
      // Re-opening the SAME run (e.g. resume) reuses its existing hold when the
      // shared host entry is still live - no second refcount/lease for one run.
      const existingHold = this.perRunTunnelHolds.get(holdKey);
      if (existingHold) {
        const heldEntry = this.remoteMcpTunnelEntriesByLeaseId.get(existingHold.leaseId);
        if (
          heldEntry &&
          !heldEntry.closed &&
          heldEntry.localHost === localHost &&
          heldEntry.localPort === localPort
        ) {
          await this.checkRemoteMcpTunnel(heldEntry);
          if (this.isCurrentRemoteMcpTunnel(heldEntry, existingHold.endpointKey)) {
            return {
              leaseId: existingHold.leaseId,
              workerHost: heldEntry.workerHost,
              remotePort: heldEntry.remotePort,
            };
          }
        }
        // The run's prior hold is stale (entry torn down or the local endpoint
        // moved): drop it and take a fresh hold on the current shared entry.
        await this.releasePerRunHold(holdKey);
      }

      const entry = await this.ensureRemoteMcpTunnelEntry(
        workerHost,
        localHost,
        localPort,
        endpointKey,
      );
      // A concurrent open for the same run may have installed its hold while
      // this call awaited tunnel setup. Re-evaluate that hold instead of taking
      // a second refcount that closeForRun could never address.
      if (this.perRunTunnelHolds.has(holdKey)) continue;
      if (!this.isCurrentRemoteMcpTunnel(entry, endpointKey)) continue;

      const lease = this.createRemoteMcpTunnelLease(entry);
      this.perRunTunnelHolds.set(holdKey, {
        leaseId: lease.leaseId,
        endpointKey,
        generation: entry.generation,
      });
      return lease;
    }
  }

  async closeForRun(workerHost: string, runKey: string): Promise<void> {
    await this.releasePerRunHold(perRunKey(workerHost, runKey));
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
  private async releasePerRunHold(holdKey: string): Promise<void> {
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
    await this.dropRemoteMcpTunnelLease(entry, hold.leaseId);
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
    if (current && !current.closed) {
      try {
        await this.checkRemoteMcpTunnel(current);
        return current;
      } catch {
        await this.closeRemoteMcpTunnel(current);
      }
    }
    if (current) await this.closeRemoteMcpTunnel(current);

    const existingSetup = this.remoteMcpTunnelSetupsByEndpoint.get(endpointKey);
    if (existingSetup) return existingSetup;

    const setup = this.createRemoteMcpTunnelEntry(workerHost, localHost, localPort, endpointKey);
    this.remoteMcpTunnelSetupsByEndpoint.set(endpointKey, setup);
    try {
      return await setup;
    } finally {
      if (this.remoteMcpTunnelSetupsByEndpoint.get(endpointKey) === setup) {
        this.remoteMcpTunnelSetupsByEndpoint.delete(endpointKey);
      }
    }
  }

  private async createRemoteMcpTunnelEntry(
    workerHost: string,
    localHost: string,
    localPort: number,
    endpointKey: string,
  ): Promise<RemoteMcpTunnelEntry> {
    const remotePort = this.reserveRemoteMcpPort(workerHost);
    let tunnel: ReverseTunnelHandle;
    try {
      tunnel = await startReverseTunnel(workerHost, remotePort, localHost, localPort);
    } catch (error) {
      try {
        await waitForRemoteTcpPortClosed(workerHost, remotePort);
        this.recycleRemoteMcpPort(workerHost, remotePort);
      } catch {
        // The port may contain a pre-existing or partially-created forward.
        // Only recycle it after positively proving that the listener is gone.
      }
      throw error;
    }
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
      tunnel,
      leaseIds: new Set(),
      remotePort,
      closed: false,
      closePromise: null,
      generation,
    };
    this.remoteMcpTunnelsByEndpoint.set(endpointKey, entry);
    void tunnel.ended.then(() => this.handleRemoteMcpTunnelEnd(entry));
    try {
      await this.checkRemoteMcpTunnel(entry);
      return entry;
    } catch (error) {
      await this.closeRemoteMcpTunnel(entry);
      throw error;
    }
  }

  private async dropRemoteMcpTunnelLease(
    entry: RemoteMcpTunnelEntry,
    leaseId: string,
  ): Promise<void> {
    if (!entry.leaseIds.has(leaseId)) return;
    this.remoteMcpTunnelEntriesByLeaseId.delete(leaseId);
    entry.leaseIds.delete(leaseId);
    if (entry.leaseIds.size > 0) return;
    await this.closeRemoteMcpTunnel(entry);
  }

  private async closeRemoteMcpTunnel(entry: RemoteMcpTunnelEntry): Promise<void> {
    if (entry.closePromise) return entry.closePromise;
    const endpointKey = this.remoteMcpTunnelEndpointKey(
      entry.workerHost,
      entry.localHost,
      entry.localPort,
    );
    for (const leaseId of entry.leaseIds) {
      this.remoteMcpTunnelEntriesByLeaseId.delete(leaseId);
    }
    entry.leaseIds.clear();
    entry.closed = true;
    const closePromise = entry.tunnel.close().then(() => {
      if (this.remoteMcpTunnelsByEndpoint.get(endpointKey) === entry) {
        this.remoteMcpTunnelsByEndpoint.delete(endpointKey);
      }
      this.recycleRemoteMcpPort(entry.workerHost, entry.remotePort);
    });
    entry.closePromise = closePromise;
    try {
      await closePromise;
    } catch (error) {
      if (entry.closePromise === closePromise) entry.closePromise = null;
      throw error;
    }
  }

  private handleRemoteMcpTunnelEnd(entry: RemoteMcpTunnelEntry): void {
    if (entry.closed) return;
    void this.closeRemoteMcpTunnel(entry).catch(() => {});
  }

  private async checkRemoteMcpTunnel(entry: RemoteMcpTunnelEntry): Promise<void> {
    try {
      await entry.tunnel.check();
    } catch (error) {
      throw this.remoteMcpTunnelSetupError(entry, error);
    }
    if (entry.closed) {
      throw this.remoteMcpTunnelSetupError(entry, new Error("reverse_tunnel_ended"));
    }
  }

  private remoteMcpTunnelSetupError(entry: RemoteMcpTunnelEntry, cause: unknown): Error {
    return new Error(`remote_mcp_tunnel_setup_failed: ${entry.workerHost} ${entry.remotePort}`, {
      cause,
    });
  }

  private reserveRemoteMcpPort(workerHost: string): number {
    const availablePorts = this.availableRemoteMcpPortsByWorkerHost.get(workerHost);
    const recycledPort = availablePorts?.shift();
    if (recycledPort !== undefined) return recycledPort;

    const remotePort = this.nextRemoteMcpPortByWorkerHost.get(workerHost) ?? 46_000;
    this.nextRemoteMcpPortByWorkerHost.set(workerHost, remotePort + 1);
    return remotePort;
  }

  private recycleRemoteMcpPort(workerHost: string, remotePort: number): void {
    const availablePorts = this.availableRemoteMcpPortsByWorkerHost.get(workerHost) ?? [];
    if (availablePorts.includes(remotePort)) return;
    availablePorts.push(remotePort);
    availablePorts.sort((left, right) => left - right);
    this.availableRemoteMcpPortsByWorkerHost.set(workerHost, availablePorts);
  }

  private isCurrentRemoteMcpTunnel(entry: RemoteMcpTunnelEntry, endpointKey: string): boolean {
    return !entry.closed && this.remoteMcpTunnelsByEndpoint.get(endpointKey) === entry;
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
