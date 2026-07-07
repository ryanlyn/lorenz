export const CLAIM_STORE_SCHEMA_VERSION = 1;
export const CLAIM_STORE_SCHEMA_VERSION_KEY = "schema_version";

const CLAIM_STORE_META_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS claim_store_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export const CLAIM_STORE_TABLES_SQL = `
  ${CLAIM_STORE_META_TABLE_SQL}
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
`;

export const CLAIM_STORE_SCHEMA_VERSION_SELECT_SQL =
  "SELECT value FROM claim_store_meta WHERE key = ?";

export const CLAIM_STORE_SCHEMA_VERSION_INSERT_SQL = `
  INSERT INTO claim_store_meta (key, value)
  VALUES (?, ?)
  ON CONFLICT(key) DO NOTHING
`;

export function unsupportedClaimStoreSchemaVersionError(actual: string): Error {
  return new Error(
    `unsupported_claim_store_schema_version: expected=${CLAIM_STORE_SCHEMA_VERSION} actual=${actual}`,
  );
}
