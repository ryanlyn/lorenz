import Database from "better-sqlite3";

import type { ClaimStoreBackend, ClaimStoreCheckpoint } from "./claimStore.js";
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

export interface SqliteClaimStoreBackendOptions {
  busyTimeoutMs?: number | undefined;
  maxEventRows?: number | undefined;
}

export class SqliteClaimStoreBackend implements ClaimStoreBackend {
  readonly kind = "sqlite";
  readonly capabilities = {
    crashRecovery: true,
    sharedAcrossProcesses: true,
    retryDurability: true,
  };

  private readonly db: Database.Database;
  private readonly loadStmt: Database.Statement;
  private readonly upsertSnapshotStmt: Database.Statement;
  private readonly insertEventStmt: Database.Statement;
  private readonly pruneEventsStmt: Database.Statement;
  private readonly upsertOwnerStmt: Database.Statement;
  private readonly ownerHeartbeatStmt: Database.Statement;
  private readonly beginImmediateStmt: Database.Statement;
  private readonly commitStmt: Database.Statement;
  private readonly rollbackStmt: Database.Statement;
  private readonly maxEventRows: number;
  private transactionDepth = 0;

  constructor(dbPath: string, options: SqliteClaimStoreBackendOptions = {}) {
    this.maxEventRows = Math.max(1, Math.floor(options.maxEventRows ?? 1000));
    prepareClaimStoreFile(dbPath);
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
    this.db.pragma("foreign_keys = ON");
    try {
      this.db.exec(CLAIM_STORE_TABLES_SQL);
      this.verifySchemaVersion();
      restrictClaimStoreFiles(dbPath);
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // Preserve the initialization error.
      }
      throw error;
    }
    this.loadStmt = this.db.prepare("SELECT checkpointJson FROM claim_store_snapshot WHERE id = 1");
    this.upsertSnapshotStmt = this.db.prepare(`
      INSERT INTO claim_store_snapshot (id, ownerId, writtenAt, operation, checkpointJson)
      VALUES (1, @ownerId, @writtenAt, @operation, @checkpointJson)
      ON CONFLICT(id) DO UPDATE SET
        ownerId = excluded.ownerId,
        writtenAt = excluded.writtenAt,
        operation = excluded.operation,
        checkpointJson = excluded.checkpointJson
    `);
    this.insertEventStmt = this.db.prepare(`
      INSERT INTO claim_store_events (ownerId, writtenAt, operation)
      VALUES (@ownerId, @writtenAt, @operation)
    `);
    this.pruneEventsStmt = this.db.prepare(`
      DELETE FROM claim_store_events
      WHERE id NOT IN (
        SELECT id FROM claim_store_events
        ORDER BY id DESC
        LIMIT @maxEventRows
      )
    `);
    this.upsertOwnerStmt = this.db.prepare(`
      INSERT INTO claim_store_owners (ownerId, heartbeatAt)
      VALUES (@ownerId, @heartbeatAt)
      ON CONFLICT(ownerId) DO UPDATE SET
        heartbeatAt = excluded.heartbeatAt
    `);
    this.ownerHeartbeatStmt = this.db.prepare(
      "SELECT heartbeatAt FROM claim_store_owners WHERE ownerId = @ownerId",
    );
    this.beginImmediateStmt = this.db.prepare("BEGIN IMMEDIATE");
    this.commitStmt = this.db.prepare("COMMIT");
    this.rollbackStmt = this.db.prepare("ROLLBACK");
  }

  load(): ClaimStoreCheckpoint | null {
    const row = this.loadStmt.get() as { checkpointJson: string } | undefined;
    return row ? (JSON.parse(row.checkpointJson) as ClaimStoreCheckpoint) : null;
  }

  save(checkpoint: ClaimStoreCheckpoint): void {
    this.withExclusiveTransaction(() => this.writeCheckpoint(checkpoint));
  }

  heartbeatOwner(ownerId: string, at: Date): void {
    this.withExclusiveTransaction(() => {
      this.upsertOwnerStmt.run({ ownerId, heartbeatAt: at.toISOString() });
    });
  }

  ownerIsActive(ownerId: string, now: Date, staleMs: number): boolean {
    const row = this.ownerHeartbeatStmt.get({ ownerId }) as { heartbeatAt: string } | undefined;
    if (!row) return false;
    const heartbeatMs = Date.parse(row.heartbeatAt);
    if (!Number.isFinite(heartbeatMs)) return false;
    return now.getTime() - heartbeatMs <= staleMs;
  }

  withExclusiveTransaction<T>(run: () => T): T {
    if (this.transactionDepth > 0) return run();
    this.beginImmediateStmt.run();
    this.transactionDepth += 1;
    try {
      const result = run();
      this.commitStmt.run();
      return result;
    } catch (error) {
      try {
        this.rollbackStmt.run();
      } catch {
        // Keep the original failure visible; a rollback error must not mask it.
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  close(): void {
    this.db.close();
  }

  private writeCheckpoint(checkpoint: ClaimStoreCheckpoint): void {
    this.upsertSnapshotStmt.run({
      ownerId: checkpoint.ownerId,
      writtenAt: checkpoint.writtenAt,
      operation: checkpoint.operation,
      checkpointJson: JSON.stringify(checkpoint),
    });
    this.insertEventStmt.run({
      ownerId: checkpoint.ownerId,
      writtenAt: checkpoint.writtenAt,
      operation: checkpoint.operation,
    });
    this.pruneEventsStmt.run({ maxEventRows: this.maxEventRows });
  }

  private verifySchemaVersion(): void {
    this.db
      .prepare(CLAIM_STORE_SCHEMA_VERSION_INSERT_SQL)
      .run(CLAIM_STORE_SCHEMA_VERSION_KEY, String(CLAIM_STORE_SCHEMA_VERSION));
    const row = this.db
      .prepare(CLAIM_STORE_SCHEMA_VERSION_SELECT_SQL)
      .get(CLAIM_STORE_SCHEMA_VERSION_KEY) as { value: string } | undefined;
    if (!row) throw new Error("claim_store_schema_version_missing");
    const version = Number(row.value);
    if (version !== CLAIM_STORE_SCHEMA_VERSION)
      throw unsupportedClaimStoreSchemaVersionError(row.value);
  }
}
