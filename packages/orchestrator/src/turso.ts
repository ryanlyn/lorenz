import { mkdirSync } from "node:fs";
import path from "node:path";

import { connect, type Database } from "@tursodatabase/database";

import type { AsyncClaimStoreBackend, ClaimStoreCheckpoint } from "./claimStore.js";

export interface TursoClaimStoreBackendOptions {
  busyTimeoutMs?: number | undefined;
  maxEventRows?: number | undefined;
  multiprocessWal?: boolean | undefined;
}

export class TursoClaimStoreBackend implements AsyncClaimStoreBackend {
  readonly kind = "turso";
  readonly capabilities = {
    crashRecovery: true,
    sharedAcrossProcesses: true,
    retryDurability: true,
  };

  private transactionDepth = 0;

  private constructor(
    private readonly db: Database,
    private readonly maxEventRows: number,
  ) {}

  static async open(
    dbPath: string,
    options: TursoClaimStoreBackendOptions = {},
  ): Promise<TursoClaimStoreBackend> {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const dbOptions: { timeout: number; experimental?: ["multiprocess_wal"] } = {
      timeout: options.busyTimeoutMs ?? 5000,
    };
    if (options.multiprocessWal) dbOptions.experimental = ["multiprocess_wal"];
    const db = await connect(dbPath, dbOptions);
    const backend = new TursoClaimStoreBackend(
      db,
      Math.max(1, Math.floor(options.maxEventRows ?? 1000)),
    );
    await backend.initialize();
    return backend;
  }

  async load(): Promise<ClaimStoreCheckpoint | null> {
    const row = (await this.db.get(
      "SELECT checkpointJson FROM claim_store_snapshot WHERE id = 1",
    )) as { checkpointJson: string } | undefined;
    return row ? (JSON.parse(row.checkpointJson) as ClaimStoreCheckpoint) : null;
  }

  async save(checkpoint: ClaimStoreCheckpoint): Promise<void> {
    await this.withExclusiveTransaction(async () => this.writeCheckpoint(checkpoint));
  }

  async heartbeatOwner(ownerId: string, at: Date): Promise<void> {
    await this.withExclusiveTransaction(async () => {
      await this.db.run(
        `
          INSERT INTO claim_store_owners (ownerId, heartbeatAt)
          VALUES (?, ?)
          ON CONFLICT(ownerId) DO UPDATE SET
            heartbeatAt = excluded.heartbeatAt
        `,
        ownerId,
        at.toISOString(),
      );
    });
  }

  async ownerIsActive(ownerId: string, now: Date, staleMs: number): Promise<boolean> {
    const row = (await this.db.get(
      "SELECT heartbeatAt FROM claim_store_owners WHERE ownerId = ?",
      ownerId,
    )) as { heartbeatAt: string } | undefined;
    if (!row) return false;
    const heartbeatMs = Date.parse(row.heartbeatAt);
    if (!Number.isFinite(heartbeatMs)) return false;
    return now.getTime() - heartbeatMs <= staleMs;
  }

  async withExclusiveTransaction<T>(run: () => Promise<T>): Promise<T> {
    if (this.transactionDepth > 0) return run();
    await this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = await run();
      await this.db.exec("COMMIT");
      return result;
    } catch (error) {
      await this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  private async initialize(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS claim_store_snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ownerId TEXT NOT NULL,
        writtenAt TEXT NOT NULL,
        operation TEXT NOT NULL,
        checkpointJson TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claim_store_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ownerId TEXT NOT NULL,
        writtenAt TEXT NOT NULL,
        operation TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_claim_store_events_written_at
        ON claim_store_events (writtenAt);
      CREATE TABLE IF NOT EXISTS claim_store_owners (
        ownerId TEXT PRIMARY KEY,
        heartbeatAt TEXT NOT NULL
      );
    `);
  }

  private async writeCheckpoint(checkpoint: ClaimStoreCheckpoint): Promise<void> {
    const checkpointJson = JSON.stringify(checkpoint);
    await this.db.run(
      `
        INSERT INTO claim_store_snapshot (id, ownerId, writtenAt, operation, checkpointJson)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          ownerId = excluded.ownerId,
          writtenAt = excluded.writtenAt,
          operation = excluded.operation,
          checkpointJson = excluded.checkpointJson
      `,
      checkpoint.ownerId,
      checkpoint.writtenAt,
      checkpoint.operation,
      checkpointJson,
    );
    await this.db.run(
      `
        INSERT INTO claim_store_events (ownerId, writtenAt, operation)
        VALUES (?, ?, ?)
      `,
      checkpoint.ownerId,
      checkpoint.writtenAt,
      checkpoint.operation,
    );
    await this.db.run(
      `
        DELETE FROM claim_store_events
        WHERE id NOT IN (
          SELECT id FROM claim_store_events
          ORDER BY id DESC
          LIMIT ?
        )
      `,
      this.maxEventRows,
    );
  }
}
