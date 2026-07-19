import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";

export async function writeExclusiveJsonFile(filePath: string, value: unknown): Promise<boolean> {
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
