import { AsyncLocalStorage } from "node:async_hooks";

import { connect, type Database } from "@tursodatabase/database";

import type { AsyncClaimStoreBackend, ClaimStoreCheckpoint } from "./claimStore.js";
import { prepareClaimStoreFile, restrictClaimStoreFiles } from "./filePermissions.js";
import {
  CLAIM_STORE_SCHEMA_VERSION,
  CLAIM_STORE_SCHEMA_VERSION_INSERT_SQL,
  CLAIM_STORE_SCHEMA_VERSION_KEY,
  CLAIM_STORE_SCHEMA_VERSION_SELECT_SQL,
  CLAIM_STORE_TABLES_SQL,
  unsupportedClaimStoreSchemaVersionError,
} from "./claimStoreSchema.js";

export { CLAIM_STORE_SCHEMA_VERSION } from "./claimStoreSchema.js";

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

  private readonly transactionScope = new AsyncLocalStorage<boolean>();
  private transactionTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly db: Database,
    private readonly dbPath: string,
    private readonly maxEventRows: number,
  ) {}

  static async open(
    dbPath: string,
    options: TursoClaimStoreBackendOptions = {},
  ): Promise<TursoClaimStoreBackend> {
    prepareClaimStoreFile(dbPath);
    const dbOptions: { timeout: number; experimental?: ["multiprocess_wal"] } = {
      timeout: options.busyTimeoutMs ?? 5000,
    };
    if (options.multiprocessWal) dbOptions.experimental = ["multiprocess_wal"];
    const db = await connect(dbPath, dbOptions);
    const backend = new TursoClaimStoreBackend(
      db,
      dbPath,
      Math.max(1, Math.floor(options.maxEventRows ?? 1000)),
    );
    try {
      await backend.initialize();
      return backend;
    } catch (error) {
      try {
        await db.close();
      } catch {
        // Preserve the initialization error.
      }
      throw error;
    }
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
    if (this.transactionScope.getStore()) return run();
    const releaseTransactionTurn = await this.waitForTransactionTurn();
    try {
      await this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = await this.transactionScope.run(true, run);
        await this.db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          await this.db.exec("ROLLBACK");
        } catch {
          // Keep the original failure visible; a rollback error must not mask it.
        }
        throw error;
      }
    } finally {
      releaseTransactionTurn();
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  private async initialize(): Promise<void> {
    await this.db.exec(CLAIM_STORE_TABLES_SQL);
    await this.verifySchemaVersion();
    restrictClaimStoreFiles(this.dbPath);
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

  private async verifySchemaVersion(): Promise<void> {
    await this.db.run(
      CLAIM_STORE_SCHEMA_VERSION_INSERT_SQL,
      CLAIM_STORE_SCHEMA_VERSION_KEY,
      String(CLAIM_STORE_SCHEMA_VERSION),
    );
    const row = (await this.db.get(
      CLAIM_STORE_SCHEMA_VERSION_SELECT_SQL,
      CLAIM_STORE_SCHEMA_VERSION_KEY,
    )) as { value: string } | undefined;
    if (!row) throw new Error("claim_store_schema_version_missing");
    const version = Number(row.value);
    if (version !== CLAIM_STORE_SCHEMA_VERSION)
      throw unsupportedClaimStoreSchemaVersionError(row.value);
  }

  private async waitForTransactionTurn(): Promise<() => void> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }
}
