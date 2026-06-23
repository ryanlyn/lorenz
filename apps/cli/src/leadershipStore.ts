/** @beta */
export interface LeadershipEndpoint {
  kind: "http" | "socket" | "none";
  address: string;
}

/** @beta */
export interface LeadershipIdentity {
  ownerId: string;
  pid: number;
  hostname: string;
  startedAt: string;
  workflowPath: string;
  workspaceRoot: string;
}

/** @beta */
export interface LeadershipLeaseRecord extends LeadershipIdentity {
  endpoint: LeadershipEndpoint;
  heartbeatAt: string;
}

/** @beta */
export interface LeadershipLease<TRecord extends LeadershipLeaseRecord = LeadershipLeaseRecord> {
  snapshot(): TRecord;
  heartbeat(now?: Date): Promise<TRecord>;
  release(): Promise<boolean>;
}

/** @beta */
export type LeadershipAcquireResult<
  TLease extends LeadershipLease<TRecord>,
  TRecord extends LeadershipLeaseRecord,
> =
  | { status: "acquired"; lease: TLease }
  | { status: "conflict"; record: TRecord | null; stale: boolean };

/** @beta */
export interface LeadershipStore<
  TAcquireOptions,
  TReadOptions,
  TRecord extends LeadershipLeaseRecord,
  TLease extends LeadershipLease<TRecord>,
> {
  readonly kind: string;
  acquire(options: TAcquireOptions): Promise<LeadershipAcquireResult<TLease, TRecord>>;
  read(options: TReadOptions): Promise<TRecord | null>;
  isStale(record: TRecord, now?: Date, staleAfterMs?: number): boolean;
}
