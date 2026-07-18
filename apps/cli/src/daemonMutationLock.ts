import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { isRecord } from "@lorenz/domain";

import { writeExclusiveJsonFile } from "./exclusiveJsonFile.js";

const MUTATION_LOCK_RETRY_MS = 10;
const MUTATION_LOCK_MAX_RETRY_MS = 250;
const MUTATION_LOCK_STALE_MS = 30_000;
const MUTATION_LOCK_TIMEOUT_MS = 120_000;

interface MutationLockRecord {
  token: string;
  createdAt: string;
}

export async function withDaemonLockMutation<T>(
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

function mutationLockValue(token: string): MutationLockRecord & { pid: number } {
  return {
    token,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
}

function mutationLockRecordIsStale(record: MutationLockRecord, now = new Date()): boolean {
  const createdAtMs = Date.parse(record.createdAt);
  if (!Number.isFinite(createdAtMs)) return true;
  return now.getTime() - createdAtMs > MUTATION_LOCK_STALE_MS;
}

async function readMutationLock(mutationPath: string): Promise<MutationLockRecord | null> {
  try {
    const raw = await fs.readFile(mutationPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const record = parsed as Partial<MutationLockRecord>;
    if (typeof record.token !== "string" || typeof record.createdAt !== "string") return null;
    return { token: record.token, createdAt: record.createdAt };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
