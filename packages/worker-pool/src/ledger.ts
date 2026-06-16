import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { ClockPort } from "@lorenz/domain";

import { createMutex } from "./mutex.js";
import type { LedgerRow } from "./types.js";

/**
 * Write-ahead ledger for cloud drivers. A provisional row is flushed BEFORE
 * the driver is asked to create a machine, then upserted with the real
 * `driverRef`/`workerHost` once the driver returns. A crash between create
 * and ledger-correlate is therefore recoverable: a hydrate reconciles
 * `driver.list()` (authoritative) against these rows by labels or workerId.
 *
 * Every mutating method is a no-op for non-cloud drivers (`usesLedger:false`),
 * so the fake / static-ssh drivers perform ZERO fs I/O. The ledger is pure fs
 * over an injected path with no coupling to the pool.
 */
export interface Ledger {
  /** Replace the entire ledger contents atomically (tmp file + rename). */
  flush(rows: ReadonlyArray<LedgerRow>): Promise<void>;
  /** Read all rows. Missing or corrupt file returns [] (defer to driver.list()). */
  load(): Promise<LedgerRow[]>;
  /** Insert or replace a row keyed by `workerId`, then flush atomically. */
  upsert(row: LedgerRow): Promise<void>;
  /** Remove a row by `workerId`, then flush atomically. */
  delete(workerId: string): Promise<void>;
  /** Read the persisted daily spend, rolling the day key when the UTC day changed. */
  loadDailySpend(): Promise<DailySpend>;
  /** Add wall-clock worker-seconds to today's accumulator and persist atomically. */
  recordDailyWorkerSeconds(workerSeconds: number): Promise<void>;
  /**
   * Durably SET today's accumulator to an ABSOLUTE total (not additive) and persist
   * atomically. Used on a clean drain to flush the pool's authoritative in-memory
   * daily total, so a crash that dropped an in-flight fire-and-forget additive
   * record cannot lose the delta. Serialized behind any earlier additive writes.
   */
  flushDailyWorkerSeconds(workerSecondsToday: number): Promise<void>;
}

/**
 * Persisted daily worker-second spend. `dayKey` is the UTC calendar day the
 * accumulator belongs to; a clock crossing midnight UTC zeroes `workerSecondsToday`
 * so the daily cap rolls over (and survives a restart within the same day).
 */
interface DailySpend {
  workerSecondsToday: number;
  dayKey: string;
}

interface LedgerFile {
  rows: LedgerRow[];
}

export interface LedgerOptions {
  ledgerPath: string;
  clock: ClockPort;
  usesLedger: boolean;
}

/** UTC calendar-day key (YYYY-MM-DD) used to roll the daily spend accumulator. */
function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function createLedger(options: LedgerOptions): Ledger {
  const { ledgerPath, clock, usesLedger } = options;
  const spendPath = path.join(path.dirname(ledgerPath), "spend.json");

  // One in-process mutex serializes every read-modify-write against the ledger and
  // the spend sidecar. Without it, concurrent settles (the pool calls
  // `recordDailyWorkerSeconds` fire-and-forget per worker) interleave their
  // read-then-write and lose updates, under-counting the daily budget.
  const fileMutex = createMutex();

  // Disabled ledger: every method is inert. Reads still return a coherent zeroed
  // view (an empty inventory and a today-keyed zero spend) so callers need no
  // special-casing, and writes never touch the filesystem.
  if (!usesLedger) {
    return {
      async flush() {},
      async load() {
        return Promise.resolve([]);
      },
      async upsert() {},
      async delete() {},
      async loadDailySpend() {
        return Promise.resolve({ workerSecondsToday: 0, dayKey: utcDayKey(clock.now()) });
      },
      async recordDailyWorkerSeconds() {},
      async flushDailyWorkerSeconds() {},
    };
  }

  async function writeAtomic(filePath: string, text: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // Unique tmp sibling so concurrent writers never collide on the tmp name,
    // then a single atomic rename swaps in a complete file. A reader therefore
    // never observes a half-written ledger.
    const tmpPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(tmpPath, text, "utf8");
    try {
      await fs.rename(tmpPath, filePath);
    } catch (error) {
      await fs.rm(tmpPath, { force: true });
      throw error;
    }
  }

  async function load(): Promise<LedgerRow[]> {
    let text: string;
    try {
      text = await fs.readFile(ledgerPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    // Corruption tolerance: a truncated or garbage file must not throw. The pool
    // defers to driver.list() as the authoritative inventory in that case.
    try {
      const parsed = JSON.parse(text) as Partial<LedgerFile>;
      if (!parsed || !Array.isArray(parsed.rows)) return [];
      return parsed.rows;
    } catch {
      return [];
    }
  }

  async function flush(rows: ReadonlyArray<LedgerRow>): Promise<void> {
    const file: LedgerFile = { rows: [...rows] };
    await writeAtomic(ledgerPath, `${JSON.stringify(file, null, 2)}\n`);
  }

  async function upsert(row: LedgerRow): Promise<void> {
    await fileMutex.runExclusive(async () => {
      const rows = await load();
      const index = rows.findIndex((existing) => existing.workerId === row.workerId);
      if (index === -1) rows.push(row);
      else rows[index] = row;
      await flush(rows);
    });
  }

  async function remove(workerId: string): Promise<void> {
    await fileMutex.runExclusive(async () => {
      const rows = await load();
      const next = rows.filter((row) => row.workerId !== workerId);
      if (next.length === rows.length) return;
      await flush(next);
    });
  }

  async function readSpendFile(): Promise<DailySpend | null> {
    let text: string;
    try {
      text = await fs.readFile(spendPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as Partial<DailySpend>;
      if (
        !parsed ||
        typeof parsed.workerSecondsToday !== "number" ||
        typeof parsed.dayKey !== "string"
      ) {
        return null;
      }
      return { workerSecondsToday: parsed.workerSecondsToday, dayKey: parsed.dayKey };
    } catch {
      return null;
    }
  }

  // Reads the sidecar and rolls it to the current UTC day. A stored day that is
  // not today (or a missing/corrupt sidecar) yields a zeroed accumulator keyed
  // on today, so a restart within the same day carries the total while a day
  // boundary resets it.
  async function loadDailySpend(): Promise<DailySpend> {
    const today = utcDayKey(clock.now());
    const stored = await readSpendFile();
    if (!stored || stored.dayKey !== today) {
      return { workerSecondsToday: 0, dayKey: today };
    }
    return stored;
  }

  async function recordDailyWorkerSeconds(workerSeconds: number): Promise<void> {
    // Serialize the read-modify-write so concurrent settles accumulate rather than
    // clobber the single global spend.json (a lost-update would under-count the
    // daily budget, which the pool seeds from this sidecar after a restart).
    await fileMutex.runExclusive(async () => {
      const current = await loadDailySpend();
      const next: DailySpend = {
        dayKey: current.dayKey,
        workerSecondsToday: current.workerSecondsToday + workerSeconds,
      };
      await writeAtomic(spendPath, `${JSON.stringify(next, null, 2)}\n`);
    });
  }

  async function flushDailyWorkerSeconds(workerSecondsToday: number): Promise<void> {
    // SET (not add) the authoritative absolute total under the same fileMutex, so a
    // clean-drain flush is serialized AFTER any earlier fire-and-forget additive
    // write and durably records the final daily total. Keyed on today's UTC day so
    // a flush straddling a day boundary writes the new day's accumulator.
    await fileMutex.runExclusive(async () => {
      const today = utcDayKey(clock.now());
      const next: DailySpend = { dayKey: today, workerSecondsToday };
      await writeAtomic(spendPath, `${JSON.stringify(next, null, 2)}\n`);
    });
  }

  return {
    flush,
    load,
    upsert,
    delete: remove,
    loadDailySpend,
    recordDailyWorkerSeconds,
    flushDailyWorkerSeconds,
  };
}
