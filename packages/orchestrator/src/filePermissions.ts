import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function prepareClaimStoreFile(dbPath: string): void {
  const dirPath = path.dirname(dbPath);
  const createdDir = mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (createdDir) chmodSync(dirPath, PRIVATE_DIR_MODE);
  const fd = openSync(dbPath, "a", PRIVATE_FILE_MODE);
  closeSync(fd);
  restrictClaimStoreFiles(dbPath);
}

export function restrictClaimStoreFiles(dbPath: string): void {
  for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      chmodSync(filePath, PRIVATE_FILE_MODE);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
