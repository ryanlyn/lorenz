import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import pino, { type Logger } from "pino";

export interface LogFileOptions {
  maxBytes?: number | undefined;
  maxFiles?: number | undefined;
  now?: (() => Date) | undefined;
}

export function defaultLogFile(root = process.cwd()): string {
  return path.join(root, "log", "symphony.log");
}

let configuredLogger: { logFile: string; logger: Logger } | null = null;

export async function configureLogFile(
  logFile: string,
  options: LogFileOptions = {},
): Promise<void> {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 5;
  try {
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    await rotateIfNeeded(logFile, maxBytes, maxFiles);
    const logger = createLogger(logFile, options.now ?? (() => new Date()));
    configuredLogger = { logFile, logger };
    logger.info({ event: "symphony_ts_started" });
  } catch (error) {
    process.stderr.write(`warning: log_file_unavailable ${logFile}: ${errorMessage(error)}\n`);
  }
}

export async function appendLogEvent(
  logFile: string,
  event: Record<string, unknown>,
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    const logger =
      configuredLogger?.logFile === logFile
        ? configuredLogger.logger
        : createLogger(logFile, () => new Date());
    logger.info(event);
  } catch (error) {
    process.stderr.write(`warning: log_file_unavailable ${logFile}: ${errorMessage(error)}\n`);
  }
}

function createLogger(logFile: string, now: () => Date): Logger {
  return pino(
    {
      base: null,
      timestamp: false,
    },
    {
      write: (line: string) => {
        const event = JSON.parse(line) as Record<string, unknown>;
        delete event.level;
        event.at ??= now().toISOString();
        appendFileSync(logFile, `${JSON.stringify(event)}\n`);
      },
    },
  );
}

async function rotateIfNeeded(logFile: string, maxBytes: number, maxFiles: number): Promise<void> {
  if (maxBytes <= 0 || maxFiles <= 0) return;
  const stat = await statOrNull(logFile);
  if (!stat || stat.size < maxBytes) return;

  await fs.rm(`${logFile}.${maxFiles}`, { force: true });
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    await renameIfExists(`${logFile}.${index}`, `${logFile}.${index + 1}`);
  }
  await renameIfExists(logFile, `${logFile}.1`);
}

async function renameIfExists(source: string, target: string): Promise<void> {
  try {
    await fs.rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function statOrNull(filePath: string): Promise<{ size: number } | null> {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
