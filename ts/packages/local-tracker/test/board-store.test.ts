import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { test } from "vitest";

import { assert } from "../../../test/assert.js";

import { BoardStore } from "@symphony/local-tracker";

async function tempBoard(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "board-"));
  await mkdir(dir, { recursive: true });
  return dir;
}

test("create allocates incrementing BOARD ids and round-trips", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);

  const a = await store.create({ title: "First", body: "Body A", status: "Todo" });
  const b = await store.create({ title: "Second" });
  assert.deepEqual([a.identifier, b.identifier], ["BOARD-1", "BOARD-2"]);
  assert.equal(a.id, "BOARD-1");
  assert.equal(a.title, "First");
  assert.equal(a.description, "Body A");
  assert.equal(a.state, "Todo");
  assert.equal(a.stateType, "unstarted");
  assert.equal(b.state, "Todo");

  const file = await readFile(path.join(dir, "BOARD-1.md"), "utf8");
  assert.match(file, /status: Todo/);
  assert.match(file, /# First/);
});

test("updateStatus rewrites only the status and preserves body", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);
  await store.create({ title: "Fix it", body: "Details here", status: "Todo" });

  const updated = await store.updateStatus("BOARD-1", "In Progress");
  assert.equal(updated.state, "In Progress");
  assert.equal(updated.stateType, "started");
  assert.equal(updated.description, "Details here");
});

test("appendComment adds a Comments section without touching description", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);
  await store.create({ title: "T", body: "Desc", status: "Todo" });

  await store.appendComment("BOARD-1", "opened PR #42", () => new Date("2026-05-29T10:00:00Z"));
  await store.appendComment("BOARD-1", "checks green", () => new Date("2026-05-29T11:00:00Z"));

  const issue = (await store.getByIds(["BOARD-1"]))[0]!;
  assert.equal(issue.description, "Desc");
  const file = await readFile(path.join(dir, "BOARD-1.md"), "utf8");
  assert.match(file, /## Comments/);
  assert.match(file, /- 2026-05-29T10:00:00.000Z agent: opened PR #42/);
  assert.match(file, /- 2026-05-29T11:00:00.000Z agent: checks green/);
});

test("byStatus filters case-insensitively; getByIds preserves order and skips missing", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);
  await store.create({ title: "One", status: "Todo" });
  await store.create({ title: "Two", status: "Done" });
  await store.create({ title: "Three", status: "in progress" });

  const active = await store.byStatus(["todo", "In Progress"]);
  assert.deepEqual(active.map((i) => i.identifier).sort(), ["BOARD-1", "BOARD-3"]);

  const byId = await store.getByIds(["BOARD-2", "BOARD-404", "BOARD-1"]);
  assert.deepEqual(
    byId.map((i) => i.identifier),
    ["BOARD-2", "BOARD-1"],
  );
});

test("labels parse from frontmatter and lower-case; title falls back to id", async () => {
  const dir = await tempBoard();
  await writeFile(
    path.join(dir, "BOARD-7.md"),
    "---\nstatus: Todo\nlabels:\n  - Backend\n  - Symphony:API\n---\n\nNo heading body\n",
    "utf8",
  );
  const store = new BoardStore(dir);
  const issue = (await store.getByIds(["BOARD-7"]))[0]!;
  assert.deepEqual(issue.labels, ["backend", "symphony:api"]);
  assert.equal(issue.title, "BOARD-7");
  assert.equal(issue.description, "No heading body");
});

test("missing status throws a clear error", async () => {
  const dir = await tempBoard();
  await writeFile(path.join(dir, "BOARD-9.md"), "---\nlabels: []\n---\n# T\n", "utf8");
  const store = new BoardStore(dir);
  await assert.rejects(() => store.getByIds(["BOARD-9"]), /BOARD-9.*status/);
});

test("description containing a literal '## Comments' heading survives round-trips", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);
  const body = "Intro\n## Comments\nplease comment";
  await store.create({ title: "T", body, status: "Todo" });

  let issue = (await store.getByIds(["BOARD-1"]))[0]!;
  assert.equal(issue.description, body);

  await store.appendComment("BOARD-1", "real agent note", () => new Date("2026-05-29T10:00:00Z"));
  await store.updateStatus("BOARD-1", "In Progress");

  issue = (await store.getByIds(["BOARD-1"]))[0]!;
  assert.equal(issue.description, body);
  assert.equal(issue.state, "In Progress");

  const file = await readFile(path.join(dir, "BOARD-1.md"), "utf8");
  assert.match(file, /- 2026-05-29T10:00:00.000Z agent: real agent note/);
});

test("CRLF board files parse with clean status and description", async () => {
  const dir = await tempBoard();
  const raw = ["---", "status: In Progress", "---", "", "# Title", "", "Body line"].join("\r\n");
  await writeFile(path.join(dir, "BOARD-3.md"), `${raw}\r\n`, "utf8");
  const store = new BoardStore(dir);
  const issue = (await store.getByIds(["BOARD-3"]))[0]!;
  assert.equal(issue.state, "In Progress");
  assert.equal(issue.stateType, "started");
  assert.equal(issue.description, "Body line");
});
