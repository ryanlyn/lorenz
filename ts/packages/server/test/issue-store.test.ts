import path from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { IssueStore } from "../src/issue-store.js";

function makeTempDir(): string {
  const dir = path.join(
    tmpdir(),
    `issue-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("IssueStore", () => {
  let dir: string;
  let store: IssueStore;

  beforeEach(() => {
    dir = makeTempDir();
    store = new IssueStore(path.join(dir, "issues.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("inserts and retrieves a record", () => {
    store.upsert({
      issueId: "id-1",
      issueIdentifier: "ENG-1",
      title: "Fix bug",
      url: "https://example.com",
    });

    const record = store.get("id-1");
    expect(record).toEqual({
      issueId: "id-1",
      issueIdentifier: "ENG-1",
      title: "Fix bug",
      url: "https://example.com",
    });
  });

  it("upserts existing record with new title and url", () => {
    store.upsert({ issueId: "id-1", issueIdentifier: "ENG-1", title: "Old title", url: null });
    store.upsert({
      issueId: "id-1",
      issueIdentifier: "ENG-1",
      title: "New title",
      url: "https://new.url",
    });

    const record = store.get("id-1");
    expect(record?.title).toBe("New title");
    expect(record?.url).toBe("https://new.url");
  });

  it("updates issueIdentifier on upsert", () => {
    store.upsert({ issueId: "id-1", issueIdentifier: "ENG-1", title: "Title", url: null });
    store.upsert({ issueId: "id-1", issueIdentifier: "ENG-2", title: "Title", url: null });

    const record = store.get("id-1");
    expect(record?.issueIdentifier).toBe("ENG-2");
  });

  it("returns undefined for non-existent id", () => {
    expect(store.get("no-such-id")).toBeUndefined();
  });

  it("handles null title and url", () => {
    store.upsert({ issueId: "id-1", issueIdentifier: "ENG-1", title: null, url: null });

    const record = store.get("id-1");
    expect(record?.title).toBeNull();
    expect(record?.url).toBeNull();
  });

  it("creates missing database parent directories", () => {
    const nestedPath = path.join(dir, "nested", "issues.db");
    const nestedStore = new IssueStore(nestedPath);
    try {
      nestedStore.upsert({ issueId: "id-1", issueIdentifier: "ENG-1", title: null, url: null });
      expect(existsSync(nestedPath)).toBe(true);
    } finally {
      nestedStore.close();
    }
  });

  it("survives close and reopen", () => {
    store.upsert({ issueId: "id-1", issueIdentifier: "ENG-1", title: "Persistent", url: null });
    store.close();

    const store2 = new IssueStore(path.join(dir, "issues.db"));
    const record = store2.get("id-1");
    expect(record?.title).toBe("Persistent");
    store2.close();
  });

  it("uses auto-incrementing id primary key, not issueId", () => {
    store.upsert({ issueId: "id-1", issueIdentifier: "ENG-1", title: "First", url: null });
    store.upsert({ issueId: "id-2", issueIdentifier: "ENG-2", title: "Second", url: null });

    const db = (store as any).db;
    const rows = db.prepare("SELECT id, issueId FROM issues ORDER BY id").all() as Array<{
      id: number;
      issueId: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe(1);
    expect(rows[1]!.id).toBe(2);
    expect(rows[0]!.issueId).toBe("id-1");
    expect(rows[1]!.issueId).toBe("id-2");
  });

  it("updates existing record on repeated upsert", () => {
    store.upsert({ issueId: "id-1", issueIdentifier: "ENG-1", title: "Old", url: null });
    store.upsert({ issueId: "id-1", issueIdentifier: "ENG-1", title: "New", url: "https://x.com" });

    const record = store.get("id-1");
    expect(record?.title).toBe("New");
    expect(record?.url).toBe("https://x.com");
  });
});
