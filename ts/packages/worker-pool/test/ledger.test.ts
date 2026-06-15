import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { test, beforeEach, afterEach } from "vitest";
import type { ClockPort, TimerHandle } from "@lorenz/domain";
import { assert } from "@lorenz/test-utils";

import { createLedger } from "../src/ledger.js";
import type { LedgerRow } from "../src/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-pool-ledger-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// A clock whose `now()` is fully controlled by the test so day-key boundaries
// and timestamps are deterministic. `setTimeout`/`clearTimeout` are unused by
// the ledger (pure fs), but the ClockPort shape requires them.
function fixedClock(initial: Date): { clock: ClockPort; set(next: Date): void } {
  let current = initial;
  const clock: ClockPort = {
    now: () => current,
    monotonicMs: () => current.getTime(),
    setTimeout: (): TimerHandle => ({ unref: undefined }),
    clearTimeout: () => undefined,
  };
  return {
    clock,
    set(next: Date) {
      current = next;
    },
  };
}

function ledgerPathFor(dir: string): string {
  return path.join(dir, "worker-pool", "ledger.json");
}

function provisionalRow(workerId: string, atMs: number): LedgerRow {
  return {
    workerId,
    driverRef: null,
    workerHost: null,
    labels: ["lorenz-worker-pool"],
    status: "provisional",
    createdAtMs: atMs,
    updatedAtMs: atMs,
  };
}

test("provisional row flushed BEFORE provision", async () => {
  const { clock } = fixedClock(new Date("2026-05-29T10:00:00.000Z"));
  const ledger = createLedger({
    ledgerPath: ledgerPathFor(tmpDir),
    clock,
    usesLedger: true,
  });

  // A provisional row is written before the driver is even called, so a crash
  // mid-provision leaves a recoverable record on disk.
  await ledger.upsert(provisionalRow("worker-1", 1_000));

  const onDisk = await ledger.load();
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0]?.workerId, "worker-1");
  assert.equal(onDisk[0]?.status, "provisional");
  assert.equal(onDisk[0]?.driverRef, null);
  assert.equal(onDisk[0]?.workerHost, null);
});

test("row UPSERTED with driverRef/workerHost after provision returns", async () => {
  const { clock } = fixedClock(new Date("2026-05-29T10:00:00.000Z"));
  const ledger = createLedger({
    ledgerPath: ledgerPathFor(tmpDir),
    clock,
    usesLedger: true,
  });

  await ledger.upsert(provisionalRow("worker-1", 1_000));
  // After the driver returns, the SAME workerId row is upserted (not appended)
  // with the real driverRef/workerHost and an `active` status.
  await ledger.upsert({
    workerId: "worker-1",
    driverRef: "i-0abc123",
    workerHost: "user@10.0.0.5:22",
    labels: ["lorenz-worker-pool"],
    status: "active",
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
  });

  const onDisk = await ledger.load();
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0]?.workerId, "worker-1");
  assert.equal(onDisk[0]?.status, "active");
  assert.equal(onDisk[0]?.driverRef, "i-0abc123");
  assert.equal(onDisk[0]?.workerHost, "user@10.0.0.5:22");
});

test("load replays rows on hydrate", async () => {
  const { clock } = fixedClock(new Date("2026-05-29T10:00:00.000Z"));
  const ledgerPath = ledgerPathFor(tmpDir);

  // First "process": write two rows then forget the in-memory ledger.
  const first = createLedger({ ledgerPath, clock, usesLedger: true });
  await first.upsert(provisionalRow("worker-1", 1_000));
  await first.upsert({
    workerId: "worker-2",
    driverRef: "i-2",
    workerHost: "user@host-2:22",
    labels: ["lorenz-worker-pool"],
    status: "active",
    createdAtMs: 1_500,
    updatedAtMs: 1_500,
  });

  // Second "process" (restart): a fresh ledger over the same path replays both.
  const second = createLedger({ ledgerPath, clock, usesLedger: true });
  const replayed = await second.load();
  assert.equal(replayed.length, 2);
  assert.deepEqual(replayed.map((row) => row.workerId).sort(), ["worker-1", "worker-2"]);
});

test("atomic write via tmp+rename", async () => {
  const { clock } = fixedClock(new Date("2026-05-29T10:00:00.000Z"));
  const ledgerPath = ledgerPathFor(tmpDir);
  const ledger = createLedger({ ledgerPath, clock, usesLedger: true });

  await ledger.flush([provisionalRow("worker-1", 1_000)]);

  // The destination file exists and parses; no stray tmp file is left behind.
  assert.ok(existsSync(ledgerPath));
  const dir = path.dirname(ledgerPath);
  const entries = await fs.readdir(dir);
  const tmpLeftovers = entries.filter((entry) => entry.includes(".tmp"));
  assert.deepEqual(tmpLeftovers, []);

  // The on-disk bytes are valid JSON (proves the rename swapped a complete file,
  // not a partially written one).
  const text = readFileSync(ledgerPath, "utf8");
  const parsed = JSON.parse(text) as { rows: LedgerRow[] };
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0]?.workerId, "worker-1");
});

test("corrupted ledger returns [] defers to driver.list()", async () => {
  const { clock } = fixedClock(new Date("2026-05-29T10:00:00.000Z"));
  const ledgerPath = ledgerPathFor(tmpDir);
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  // A half-written / garbage file must not throw on load: the pool defers to
  // driver.list() as the authoritative inventory.
  await fs.writeFile(ledgerPath, "{ not valid json", "utf8");

  const ledger = createLedger({ ledgerPath, clock, usesLedger: true });
  const rows = await ledger.load();
  assert.deepEqual(rows, []);
});

test("delete removes a single row by workerId", async () => {
  const { clock } = fixedClock(new Date("2026-05-29T10:00:00.000Z"));
  const ledger = createLedger({
    ledgerPath: ledgerPathFor(tmpDir),
    clock,
    usesLedger: true,
  });

  await ledger.upsert(provisionalRow("worker-1", 1_000));
  await ledger.upsert(provisionalRow("worker-2", 1_000));
  await ledger.delete("worker-1");

  const rows = await ledger.load();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.workerId, "worker-2");
});

test("ledger untouched when usesLedger false", async () => {
  const { clock } = fixedClock(new Date("2026-05-29T10:00:00.000Z"));
  const ledgerPath = ledgerPathFor(tmpDir);
  const ledger = createLedger({ ledgerPath, clock, usesLedger: false });

  // Every mutating call is a no-op for a non-cloud driver: zero fs writes.
  await ledger.upsert(provisionalRow("worker-1", 1_000));
  await ledger.flush([provisionalRow("worker-2", 1_000)]);
  await ledger.delete("worker-1");

  assert.equal(existsSync(ledgerPath), false);
  assert.equal(existsSync(path.dirname(ledgerPath)), false);

  // load() also performs no I/O and returns an empty inventory.
  const rows = await ledger.load();
  assert.deepEqual(rows, []);
});

test("daily-spend sidecar persists workerSecondsToday across restart", async () => {
  const dayOne = new Date("2026-05-29T10:00:00.000Z");
  const { clock } = fixedClock(dayOne);
  const ledgerPath = ledgerPathFor(tmpDir);

  // First process accumulates daily worker-seconds and persists them.
  const first = createLedger({ ledgerPath, clock, usesLedger: true });
  await first.recordDailyWorkerSeconds(120);
  await first.recordDailyWorkerSeconds(30);

  // The sidecar lives next to the ledger file.
  const spendPath = path.join(path.dirname(ledgerPath), "spend.json");
  assert.ok(existsSync(spendPath));

  // Second process (restart) on the SAME UTC day reads the carried total so the
  // daily cap is not reset by a restart.
  const { clock: clock2 } = fixedClock(new Date("2026-05-29T18:00:00.000Z"));
  const second = createLedger({ ledgerPath, clock: clock2, usesLedger: true });
  const spend = await second.loadDailySpend();
  assert.equal(spend.workerSecondsToday, 150);
  assert.equal(spend.dayKey, "2026-05-29");
});

test("daily-spend resets on UTC day-key change", async () => {
  const ledgerPath = ledgerPathFor(tmpDir);
  const dayOne = fixedClock(new Date("2026-05-29T23:30:00.000Z"));
  const first = createLedger({ ledgerPath, clock: dayOne.clock, usesLedger: true });
  await first.recordDailyWorkerSeconds(200);

  let spend = await first.loadDailySpend();
  assert.equal(spend.workerSecondsToday, 200);
  assert.equal(spend.dayKey, "2026-05-29");

  // Advance the SAME clock past UTC midnight: the next read rolls the day key
  // and zeroes the accumulator (yesterday's spend no longer counts).
  dayOne.set(new Date("2026-05-30T00:10:00.000Z"));
  spend = await first.loadDailySpend();
  assert.equal(spend.dayKey, "2026-05-30");
  assert.equal(spend.workerSecondsToday, 0);

  // A record after the rollover accumulates against the new day only.
  await first.recordDailyWorkerSeconds(45);
  spend = await first.loadDailySpend();
  assert.equal(spend.workerSecondsToday, 45);
  assert.equal(spend.dayKey, "2026-05-30");
});

test("daily-spend survives concurrent records (no lost update)", async () => {
  const { clock } = fixedClock(new Date("2026-05-29T10:00:00.000Z"));
  const ledgerPath = ledgerPathFor(tmpDir);
  const ledger = createLedger({ ledgerPath, clock, usesLedger: true });

  // The pool settles many leases concurrently (cross-worker settles race the single
  // global spend.json). A non-atomic read-modify-write loses updates: every
  // concurrent record must accumulate, not clobber, the total.
  const N = 50;
  await Promise.all(Array.from({ length: N }, () => ledger.recordDailyWorkerSeconds(1)));

  const spend = await ledger.loadDailySpend();
  assert.equal(spend.workerSecondsToday, N);
  assert.equal(spend.dayKey, "2026-05-29");
});

test("daily-spend sidecar untouched when usesLedger false", async () => {
  const { clock } = fixedClock(new Date("2026-05-29T10:00:00.000Z"));
  const ledgerPath = ledgerPathFor(tmpDir);
  const ledger = createLedger({ ledgerPath, clock, usesLedger: false });

  await ledger.recordDailyWorkerSeconds(120);
  const spendPath = path.join(path.dirname(ledgerPath), "spend.json");
  assert.equal(existsSync(spendPath), false);

  // loadDailySpend still returns a coherent zeroed view keyed on today's UTC day.
  const spend = await ledger.loadDailySpend();
  assert.equal(spend.workerSecondsToday, 0);
  assert.equal(spend.dayKey, "2026-05-29");
});

test("flushDailyWorkerSeconds durably SETS the absolute daily total", async () => {
  const { clock } = fixedClock(new Date("2026-05-29T10:00:00.000Z"));
  const ledgerPath = ledgerPathFor(tmpDir);
  const ledger = createLedger({ ledgerPath, clock, usesLedger: true });

  // The pool's hot path is fire-and-forget additive records; on a clean drain it
  // flushes the authoritative in-memory total as an ABSOLUTE set so a crash that
  // dropped an in-flight additive write cannot lose the delta. The flush SETS
  // (does not add) the total, and is serialized after any earlier additive write.
  await ledger.recordDailyWorkerSeconds(40);
  await ledger.flushDailyWorkerSeconds(123);

  // A restart on the same UTC day reads the flushed absolute total, not 40+123.
  const second = createLedger({ ledgerPath, clock, usesLedger: true });
  const spend = await second.loadDailySpend();
  assert.equal(spend.workerSecondsToday, 123);
  assert.equal(spend.dayKey, "2026-05-29");
});

test("flushDailyWorkerSeconds is inert when usesLedger false", async () => {
  const { clock } = fixedClock(new Date("2026-05-29T10:00:00.000Z"));
  const ledgerPath = ledgerPathFor(tmpDir);
  const ledger = createLedger({ ledgerPath, clock, usesLedger: false });

  await ledger.flushDailyWorkerSeconds(99);
  const spendPath = path.join(path.dirname(ledgerPath), "spend.json");
  assert.equal(existsSync(spendPath), false);
});
