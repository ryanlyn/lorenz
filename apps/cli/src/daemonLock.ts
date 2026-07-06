import { constants, realpathSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { isOneOf, isRecord } from "@lorenz/domain";
import { createOpaqueBearerToken } from "@lorenz/mcp";
import { createMutex, type Mutex } from "@lorenz/worker-pool";

import type {
  LeadershipAcquireResult,
  LeadershipEndpoint,
  LeadershipIdentity,
  LeadershipLease,
  LeadershipLeaseRecord,
  LeadershipStore,
} from "./leadershipStore.js";

/** @beta */
export const DAEMON_LOCK_VERSION = 1;
const MUTATION_LOCK_RETRY_MS = 10;
const MUTATION_LOCK_MAX_RETRY_MS = 250;
const MUTATION_LOCK_STALE_MS = 30_000;
const MUTATION_LOCK_TIMEOUT_MS = 120_000;
const DAEMON_ENDPOINT_KINDS = ["http", "socket", "none"] as const;

/** @beta */
export type DaemonEndpoint = LeadershipEndpoint;

export type DaemonIdentity = LeadershipIdentity;

export interface DaemonLockRecord extends DaemonIdentity, LeadershipLeaseRecord {
  version: typeof DAEMON_LOCK_VERSION;
  lockPath: string;
  endpoint: DaemonEndpoint;
  controlToken: string | null;
  heartbeatAt: string;
}

export interface CreateDaemonIdentityOptions {
  workflowPath: string;
  workspaceRoot: string;
  now?: Date | undefined;
  ownerId?: string | undefined;
  pid?: number | undefined;
  hostname?: string | undefined;
}

export interface AcquireDaemonLockOptions {
  lockPath: string;
  identity: DaemonIdentity;
  endpoint: DaemonEndpoint;
  controlToken?: string | undefined;
  now?: Date | undefined;
  /**
   * Take over the lease when the recorded owner is a same-host process whose pid is verifiably
   * dead (ESRCH). Heartbeat staleness alone never authorizes takeover; a stale-but-unverifiable
   * owner still yields a conflict with `stale: true`.
   */
  replaceDeadOwner?: boolean | undefined;
  staleAfterMs?: number | undefined;
}

export type AcquireDaemonLockResult =
  | { status: "acquired"; lock: DaemonLock }
  | { status: "conflict"; record: DaemonLockRecord | null; stale: boolean };

export type AcquireLocalFileDaemonLeadershipResult = LeadershipAcquireResult<
  DaemonLock,
  DaemonLockRecord
>;

export function createDaemonIdentity(options: CreateDaemonIdentityOptions): DaemonIdentity {
  const now = options.now ?? new Date();
  return {
    ownerId: options.ownerId ?? randomUUID(),
    pid: options.pid ?? process.pid,
    hostname: options.hostname ?? os.hostname(),
    startedAt: now.toISOString(),
    workflowPath: canonicalPath(options.workflowPath),
    workspaceRoot: canonicalPath(options.workspaceRoot),
  };
}

export function daemonLockPath(workflowPath: string): string {
  const suffix = daemonWorkflowKey(workflowPath);
  return path.join(
    path.dirname(canonicalPath(workflowPath)),
    ".lorenz",
    "daemon",
    `${suffix}.lock.json`,
  );
}

export function daemonWorkflowKey(workflowPath: string): string {
  return createHash("sha256").update(canonicalPath(workflowPath)).digest("hex");
}

/**
 * Unix control socket path. Kept well under the OS sun_path limit (~104 bytes) by living in a short
 * per-user runtime dir rather than next to the (possibly deeply nested) workflow file. The lease
 * records this absolute path, so the client discovers it from the lock instead of re-deriving it.
 */
export function daemonControlSocketPath(workflowPath: string): string {
  const suffix = daemonWorkflowKey(workflowPath).slice(0, 16);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  // Prefer the OS per-user runtime dir (XDG_RUNTIME_DIR is 0700 and owned by the user, so a
  // co-tenant cannot squat the path). Fall back to tmpdir, which the server hardens by verifying
  // the runtime dir's ownership and mode before binding (tmpdir is world-writable on Linux).
  const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(base, `lorenz-${uid}`, `${suffix}.sock`);
}

export function daemonWorkspacePath(workspaceRoot: string, ...segments: string[]): string {
  return path.join(canonicalPath(workspaceRoot), ".lorenz", ...segments);
}

function createDaemonControlToken(): string {
  return createOpaqueBearerToken();
}

export async function acquireDaemonLock(
  options: AcquireDaemonLockOptions,
): Promise<AcquireDaemonLockResult> {
  const result = await new LocalFileDaemonLeadershipStore().acquire(options);
  return result.status === "acquired" ? { status: "acquired", lock: result.lease } : result;
}

export async function readDaemonLock(lockPath: string): Promise<DaemonLockRecord | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    return parseDaemonLockRecord(raw, lockPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

export function daemonLockIsStale(
  record: DaemonLockRecord,
  now = new Date(),
  staleAfterMs = 60_000,
): boolean {
  const heartbeatMs = Date.parse(record.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return true;
  return now.getTime() - heartbeatMs > staleAfterMs;
}

/** @beta */
export class DaemonLock implements LeadershipLease<DaemonLockRecord> {
  private readonly operationMutex: Mutex = createMutex();

  constructor(
    readonly lockPath: string,
    private record: DaemonLockRecord,
  ) {}

  snapshot(): DaemonLockRecord {
    return { ...this.record, endpoint: { ...this.record.endpoint } };
  }

  async heartbeat(now = new Date()): Promise<DaemonLockRecord> {
    return this.operationMutex.runExclusive(async () => {
      return withDaemonLockMutation(this.lockPath, async () => {
        const current = await readDaemonLock(this.lockPath);
        if (!current || current.ownerId !== this.record.ownerId) {
          throw new Error("daemon_lock_lost");
        }
        this.record = { ...current, heartbeatAt: now.toISOString() };
        await writeDaemonLockRecord(this.lockPath, this.record);
        return this.snapshot();
      });
    });
  }

  async updateEndpoint(endpoint: DaemonEndpoint, now = new Date()): Promise<DaemonLockRecord> {
    return this.operationMutex.runExclusive(async () => {
      return withDaemonLockMutation(this.lockPath, async () => {
        const current = await readDaemonLock(this.lockPath);
        if (!current || current.ownerId !== this.record.ownerId) {
          throw new Error("daemon_lock_lost");
        }
        this.record = { ...current, endpoint: { ...endpoint }, heartbeatAt: now.toISOString() };
        await writeDaemonLockRecord(this.lockPath, this.record);
        return this.snapshot();
      });
    });
  }

  async release(): Promise<boolean> {
    return this.operationMutex.runExclusive(async () => {
      return withDaemonLockMutation(this.lockPath, async () => {
        const current = await readDaemonLock(this.lockPath);
        if (!current || current.ownerId !== this.record.ownerId) return false;
        await fs.rm(this.lockPath, { force: true });
        return true;
      });
    });
  }
}

/** @beta */
export class LocalFileDaemonLeadershipStore implements LeadershipStore<
  AcquireDaemonLockOptions,
  string,
  DaemonLockRecord,
  DaemonLock
> {
  readonly kind = "local-file";

  async acquire(
    options: AcquireDaemonLockOptions,
  ): Promise<AcquireLocalFileDaemonLeadershipResult> {
    const now = options.now ?? new Date();
    const record = daemonLockRecord(
      options.lockPath,
      options.identity,
      options.endpoint,
      options.controlToken ?? createDaemonControlToken(),
      now,
    );
    await fs.mkdir(path.dirname(options.lockPath), { recursive: true, mode: 0o700 });
    return withDaemonLockMutation(options.lockPath, async () => {
      const created = await writeExclusiveJsonFile(options.lockPath, record);
      if (created) {
        return { status: "acquired", lease: new DaemonLock(options.lockPath, record) };
      }
      const existing = await readDaemonLock(options.lockPath);
      const staleAfterMs = options.staleAfterMs ?? 60_000;
      const conflict = (record: DaemonLockRecord | null) => ({
        status: "conflict" as const,
        record,
        stale: record ? this.isStale(record, now, staleAfterMs) : true,
      });
      // A same-host owner whose pid is gone is dead no matter how fresh its heartbeat is, so
      // takeover does not wait out the staleness window (a crashed daemon can restart
      // immediately). Heartbeat staleness still drives the `stale` hint on conflicts where the
      // pid cannot be verified dead (other host, pid alive or reused, EPERM).
      if (options.replaceDeadOwner && existing && ownerIsVerifiablyDead(existing)) {
        // rm-then-create (not an atomic rename) is deliberate: the owner is provably dead, so a
        // failed create leaves no lock at all (an availability blip the next acquire repairs),
        // whereas a rename-based swap would reintroduce the by-path TOCTOU this mutation lock
        // exists to prevent.
        await fs.rm(options.lockPath, { force: true });
        const replaced = await writeExclusiveJsonFile(options.lockPath, record);
        if (replaced) {
          return { status: "acquired", lease: new DaemonLock(options.lockPath, record) };
        }
        // Report the record that won the recreate race, not the dead owner just removed.
        return conflict(await readDaemonLock(options.lockPath));
      }
      return conflict(existing);
    });
  }

  async read(lockPath: string): Promise<DaemonLockRecord | null> {
    return readDaemonLock(lockPath);
  }

  isStale(record: DaemonLockRecord, now = new Date(), staleAfterMs = 60_000): boolean {
    return daemonLockIsStale(record, now, staleAfterMs);
  }
}

// kill(pid, 0) is authoritative only within one pid namespace: sharing the lock directory across
// pid namespaces with identical hostnames (an unsupported deployment; the lease is same-host by
// design) could report a live foreign owner as dead and steal its lock.
function ownerIsVerifiablyDead(record: DaemonLockRecord): boolean {
  if (record.hostname !== os.hostname()) return false;
  if (!Number.isInteger(record.pid) || record.pid <= 0) return false;
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    return isNodeError(error) && error.code === "ESRCH";
  }
}

function daemonLockRecord(
  lockPath: string,
  identity: DaemonIdentity,
  endpoint: DaemonEndpoint,
  controlToken: string,
  now: Date,
): DaemonLockRecord {
  return {
    version: DAEMON_LOCK_VERSION,
    ...identity,
    lockPath,
    endpoint,
    controlToken,
    heartbeatAt: now.toISOString(),
  };
}

async function writeDaemonLockRecord(lockPath: string, record: DaemonLockRecord): Promise<void> {
  const tempPath = `${lockPath}.${record.ownerId}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tempPath, lockPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

async function writeExclusiveJsonFile(filePath: string, value: unknown): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await fs.open(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") return false;
    throw error;
  }

  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.close();
    return true;
  } catch (error) {
    try {
      await handle.close();
    } catch {
      // Ignore secondary close errors so the original write or close failure remains visible.
    }
    await fs.rm(filePath, { force: true });
    throw error;
  }
}

function parseDaemonLockRecord(raw: string, lockPath: string): DaemonLockRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const record = parsed as Partial<DaemonLockRecord>;
  if (
    record.version !== DAEMON_LOCK_VERSION ||
    typeof record.ownerId !== "string" ||
    typeof record.pid !== "number" ||
    typeof record.hostname !== "string" ||
    typeof record.startedAt !== "string" ||
    typeof record.workflowPath !== "string" ||
    typeof record.workspaceRoot !== "string" ||
    typeof record.heartbeatAt !== "string" ||
    !isRecord(record.endpoint) ||
    typeof record.endpoint.kind !== "string" ||
    !isOneOf(record.endpoint.kind, DAEMON_ENDPOINT_KINDS) ||
    typeof record.endpoint.address !== "string"
  ) {
    return null;
  }
  return {
    version: DAEMON_LOCK_VERSION,
    ownerId: record.ownerId,
    pid: record.pid,
    hostname: record.hostname,
    startedAt: record.startedAt,
    workflowPath: record.workflowPath,
    workspaceRoot: record.workspaceRoot,
    lockPath,
    endpoint: { kind: record.endpoint.kind, address: record.endpoint.address },
    controlToken: typeof record.controlToken === "string" ? record.controlToken : null,
    heartbeatAt: record.heartbeatAt,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function canonicalPath(input: string): string {
  const resolved = path.resolve(input);
  try {
    return realpathSync.native(resolved);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return resolved;
    throw error;
  }
}

async function withDaemonLockMutation<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const mutationPath = `${lockPath}.mutation`;
  const token = randomUUID();
  const startedAt = Date.now();
  let retryDelayMs = MUTATION_LOCK_RETRY_MS;
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  while (!(await tryAcquireMutationLock(mutationPath, token))) {
    if (await removeStaleMutationLock(mutationPath)) {
      retryDelayMs = MUTATION_LOCK_RETRY_MS;
      continue;
    }
    if (Date.now() - startedAt > MUTATION_LOCK_TIMEOUT_MS) {
      throw new Error("daemon_lock_mutation_timeout");
    }
    await sleep(retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, MUTATION_LOCK_MAX_RETRY_MS);
  }
  try {
    return await operation();
  } finally {
    await releaseMutationLock(mutationPath, token);
  }
}

async function tryAcquireMutationLock(mutationPath: string, token: string): Promise<boolean> {
  return writeExclusiveJsonFile(mutationPath, mutationLockValue(token));
}

async function releaseMutationLock(mutationPath: string, token: string): Promise<boolean> {
  // Only ever remove an entry that still carries our token: check first, then unlink. Stale
  // takeover (a foreign token) is serialized by the recovery lock in removeStaleMutationLock so
  // two contenders cannot both reach this unlink for the same stale entry.
  const record = await readMutationLock(mutationPath);
  if (record?.token !== token) return false;
  await fs.rm(mutationPath, { force: true });
  return true;
}

async function removeStaleMutationLock(mutationPath: string, now = new Date()): Promise<boolean> {
  const record = await readMutationLock(mutationPath);
  if (!record) return removeMalformedMutationLockIfStale(mutationPath, now);
  if (!mutationLockRecordIsStale(record, now)) return false;
  // Serialize stale takeover through the recovery lock - the same guard the malformed path
  // uses - so two contenders cannot both observe one stale entry and race their unlink against
  // a fresh acquirer's O_EXCL create (which would let two processes hold the mutation lock and
  // split-brain daemon leadership). Re-read under the lock before removing: the entry may have
  // been cleared (ENOENT) or legitimately reacquired (no longer stale) while we waited.
  //
  // Residual: a holder that keeps the mutation lock past MUTATION_LOCK_STALE_MS (a hung or
  // suspended process) can still race its own unlink against this recovery. That window is
  // irreducible for an O_EXCL lockfile and would need an OS advisory lock (flock/fcntl) to
  // close; mutation operations are short file writes, so exceeding the stale window is itself
  // the crash/hang signal this recovery exists to handle.
  return withMutationRecoveryLock(mutationPath, async () => {
    const current = await readMutationLock(mutationPath);
    if (!current) return true;
    if (!mutationLockRecordIsStale(current, now)) return false;
    return releaseMutationLock(mutationPath, current.token);
  });
}

async function removeMalformedMutationLockIfStale(
  mutationPath: string,
  now = new Date(),
): Promise<boolean> {
  return withMutationRecoveryLock(mutationPath, async () => {
    try {
      const stat = await fs.stat(mutationPath);
      if (now.getTime() - stat.mtimeMs <= MUTATION_LOCK_STALE_MS) return false;
      if (await readMutationLock(mutationPath)) return false;
      await fs.rm(mutationPath, { force: true });
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return true;
      throw error;
    }
  });
}

async function withMutationRecoveryLock<T>(
  mutationPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const recoveryPath = `${mutationPath}.recovery`;
  const token = randomUUID();
  const startedAt = Date.now();
  let retryDelayMs = MUTATION_LOCK_RETRY_MS;
  while (!(await writeExclusiveJsonFile(recoveryPath, mutationLockValue(token)))) {
    if (await removeStaleMutationRecoveryLock(recoveryPath)) {
      retryDelayMs = MUTATION_LOCK_RETRY_MS;
      continue;
    }
    if (Date.now() - startedAt > MUTATION_LOCK_TIMEOUT_MS) {
      throw new Error("daemon_lock_mutation_recovery_timeout");
    }
    await sleep(retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, MUTATION_LOCK_MAX_RETRY_MS);
  }
  try {
    return await operation();
  } finally {
    await releaseMutationLock(recoveryPath, token);
  }
}

async function removeStaleMutationRecoveryLock(
  recoveryPath: string,
  now = new Date(),
): Promise<boolean> {
  const record = await readMutationLock(recoveryPath);
  if (record) {
    if (!mutationLockRecordIsStale(record, now)) return false;
    return releaseMutationLock(recoveryPath, record.token);
  }
  try {
    const stat = await fs.stat(recoveryPath);
    if (now.getTime() - stat.mtimeMs <= MUTATION_LOCK_STALE_MS) return false;
    await fs.rm(recoveryPath, { force: true });
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    throw error;
  }
}

function mutationLockValue(token: string): { token: string; pid: number; createdAt: string } {
  return {
    token,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
}

function mutationLockRecordIsStale(record: { createdAt: string }, now = new Date()): boolean {
  const createdAtMs = Date.parse(record.createdAt);
  if (!Number.isFinite(createdAtMs)) return true;
  return now.getTime() - createdAtMs > MUTATION_LOCK_STALE_MS;
}

async function readMutationLock(
  mutationPath: string,
): Promise<{ token: string; createdAt: string } | null> {
  try {
    const raw = await fs.readFile(mutationPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const record = parsed as Partial<{ token: string; createdAt: string }>;
    if (typeof record.token !== "string" || typeof record.createdAt !== "string") return null;
    return { token: record.token, createdAt: record.createdAt };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
