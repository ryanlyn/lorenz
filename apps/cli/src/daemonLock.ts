import { constants, realpathSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { isOneOf, isRecord } from "@lorenz/domain";
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
const DAEMON_ENDPOINT_KINDS = ["http", "socket"] as const;

/** @beta */
export type DaemonEndpoint = LeadershipEndpoint;

export type DaemonIdentity = LeadershipIdentity;

export interface DaemonLockRecord extends DaemonIdentity, LeadershipLeaseRecord {
  version: typeof DAEMON_LOCK_VERSION;
  lockPath: string;
  endpoint: DaemonEndpoint;
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
  now?: Date | undefined;
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

export function daemonLockPath(workspaceRoot: string, workflowPath: string): string {
  const normalizedWorkflow = canonicalPath(workflowPath);
  const suffix = createHash("sha256").update(normalizedWorkflow).digest("hex");
  return path.join(canonicalPath(workspaceRoot), ".lorenz", "daemon", `${suffix}.lock.json`);
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
    const record = daemonLockRecord(options.lockPath, options.identity, options.endpoint, now);
    await fs.mkdir(path.dirname(options.lockPath), { recursive: true, mode: 0o700 });
    return withDaemonLockMutation(options.lockPath, async () => {
      const created = await writeExclusiveJsonFile(options.lockPath, record);
      if (created) {
        return { status: "acquired", lease: new DaemonLock(options.lockPath, record) };
      }
      const existing = await readDaemonLock(options.lockPath);
      return {
        status: "conflict",
        record: existing,
        stale: existing ? this.isStale(existing, now, options.staleAfterMs ?? 60_000) : true,
      };
    });
  }

  async read(lockPath: string): Promise<DaemonLockRecord | null> {
    return readDaemonLock(lockPath);
  }

  isStale(record: DaemonLockRecord, now = new Date(), staleAfterMs = 60_000): boolean {
    return daemonLockIsStale(record, now, staleAfterMs);
  }
}

function daemonLockRecord(
  lockPath: string,
  identity: DaemonIdentity,
  endpoint: DaemonEndpoint,
  now: Date,
): DaemonLockRecord {
  return {
    version: DAEMON_LOCK_VERSION,
    ...identity,
    lockPath,
    endpoint,
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
  return writeExclusiveJsonFile(mutationPath, {
    token,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
}

async function releaseMutationLock(mutationPath: string, token: string): Promise<boolean> {
  const record = await readMutationLock(mutationPath);
  if (record?.token !== token) return false;
  await fs.rm(mutationPath, { force: true });
  return true;
}

async function removeStaleMutationLock(mutationPath: string, now = new Date()): Promise<boolean> {
  const record = await readMutationLock(mutationPath);
  if (!record) return removeMalformedMutationLockIfStale(mutationPath, now);
  if (!mutationLockRecordIsStale(record, now)) return false;
  return releaseMutationLock(mutationPath, record.token);
}

async function removeMalformedMutationLockIfStale(
  mutationPath: string,
  now = new Date(),
): Promise<boolean> {
  try {
    const stat = await fs.stat(mutationPath);
    if (now.getTime() - stat.mtimeMs <= MUTATION_LOCK_STALE_MS) return false;
    if (await readMutationLock(mutationPath)) return false;
    throw new Error("daemon_lock_mutation_guard_malformed");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    throw error;
  }
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
