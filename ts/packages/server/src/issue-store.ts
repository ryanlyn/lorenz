import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

export interface IssueRecord {
  issueId: string;
  /** Human-readable ticket key (e.g. "ENG-123") — distinct from issueId which is the tracker's opaque UUID. */
  issueIdentifier: string;
  title: string | null;
  url: string | null;
  updatedAt: number;
}

export function defaultIssueStorePath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".symphony", "issues.db");
}

export class IssueStore {
  private readonly db: Database.Database;
  private readonly upsertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly recentStmt: Database.Statement;
  private readonly searchStmt: Database.Statement;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        id INTEGER PRIMARY KEY,
        issueId TEXT NOT NULL UNIQUE,
        issueIdentifier TEXT NOT NULL,
        title TEXT,
        url TEXT,
        updatedAt INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.upsertStmt = this.db.prepare(`
      INSERT INTO issues (issueId, issueIdentifier, title, url, updatedAt) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(issueId) DO UPDATE SET
        issueIdentifier = excluded.issueIdentifier,
        title = excluded.title,
        url = excluded.url,
        updatedAt = excluded.updatedAt
    `);
    this.getStmt = this.db.prepare(
      "SELECT issueId, issueIdentifier, title, url FROM issues WHERE issueId = ?",
    );
    this.recentStmt = this.db.prepare(
      "SELECT issueId, issueIdentifier, title, url, updatedAt FROM issues ORDER BY updatedAt DESC LIMIT ?",
    );
    this.searchStmt = this.db.prepare(
      "SELECT issueId, issueIdentifier, title, url, updatedAt FROM issues WHERE issueIdentifier LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' LIMIT ?",
    );
  }

  upsert(record: Omit<IssueRecord, "updatedAt">): void {
    this.upsertStmt.run(
      record.issueId,
      record.issueIdentifier,
      record.title,
      record.url,
      Date.now(),
    );
  }

  get(issueId: string): Omit<IssueRecord, "updatedAt"> | undefined {
    return this.getStmt.get(issueId) as Omit<IssueRecord, "updatedAt"> | undefined;
  }

  getRecent(limit: number): IssueRecord[] {
    return this.recentStmt.all(Math.min(limit, 100)) as IssueRecord[];
  }

  search(query: string, limit = 20): IssueRecord[] {
    const escaped = query.replace(/[%_\\]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;
    return this.searchStmt.all(pattern, pattern, Math.min(limit, 100)) as IssueRecord[];
  }

  close(): void {
    this.db.close();
  }
}
