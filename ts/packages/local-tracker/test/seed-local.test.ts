import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { test } from "vitest";


import { assert } from "../../../test/assert.js";
import { SEED_ISSUES, seedLocalBoard } from "../../../sandbox/seed-local.js";

import { BoardStore } from "@symphony/local-tracker";


async function tempBoard(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "seed-local-"));
}

test("seedLocalBoard writes one BOARD file per sample issue via BoardStore", async () => {
  const dir = await tempBoard();

  const created = await seedLocalBoard(dir);
  assert.equal(created.length, SEED_ISSUES.length);

  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  assert.equal(files.length, SEED_ISSUES.length);

  // Ids are the BOARD-<n> ids minted by BoardStore, surfaced back through the runtime.
  const store = new BoardStore(dir);
  const issues = await store.list();
  assert.deepEqual(
    issues.map((i) => i.id),
    created.map((c) => c.id),
  );
  assert.equal(issues[0]!.id, "BOARD-1");
});

test("seedLocalBoard spans Todo and In Progress states", async () => {
  const dir = await tempBoard();
  const created = await seedLocalBoard(dir);

  const states = new Set(created.map((c) => c.state));
  assert.equal(states.has("Todo"), true);
  assert.equal(states.has("In Progress"), true);
});

test("seedLocalBoard honors the count argument", async () => {
  const dir = await tempBoard();
  const created = await seedLocalBoard(dir, 2);

  assert.equal(created.length, 2);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 2);
});

test("seeded files round-trip the sample title and body", async () => {
  const dir = await tempBoard();
  await seedLocalBoard(dir, 1);

  const file = await readFile(path.join(dir, "BOARD-1.md"), "utf8");
  assert.match(file, /status: Todo/);
  assert.match(file, /# \[Demo\] Create hello_world\.py/);
  assert.match(file, /Hello, World!/);
});
