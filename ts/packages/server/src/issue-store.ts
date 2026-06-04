import Database from "better-sqlite3";

export interface IssueRecord {
  issueId: string;
  identifier: string;
  title: string | null;
  url: string | null;
}

export class IssueStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private updateStmt: Database.Statement;
  private getStmt: Database.Statement;
  private getAllStmt: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issueId TEXT NOT NULL,
        identifier TEXT NOT NULL,
        title TEXT,
        url TEXT
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_issues_issueId ON issues(issueId)
    `);
    this.insertStmt = this.db.prepare(
      "INSERT INTO issues (issueId, identifier, title, url) VALUES (?, ?, ?, ?)",
    );
    this.updateStmt = this.db.prepare(
      "UPDATE issues SET identifier = ?, title = ?, url = ? WHERE issueId = ?",
    );
    this.getStmt = this.db.prepare(
      "SELECT issueId, identifier, title, url FROM issues WHERE issueId = ?",
    );
    this.getAllStmt = this.db.prepare("SELECT issueId, identifier, title, url FROM issues");
  }

  upsert(record: IssueRecord): void {
    const existing = this.getStmt.get(record.issueId);
    if (existing) {
      this.updateStmt.run(record.identifier, record.title, record.url, record.issueId);
    } else {
      this.insertStmt.run(record.issueId, record.identifier, record.title, record.url);
    }
  }

  get(issueId: string): IssueRecord | undefined {
    return this.getStmt.get(issueId) as IssueRecord | undefined;
  }

  getAll(): IssueRecord[] {
    return this.getAllStmt.all() as IssueRecord[];
  }

  close(): void {
    this.db.close();
  }
}
