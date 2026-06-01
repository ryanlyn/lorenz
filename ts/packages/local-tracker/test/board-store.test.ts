import { promises as nodeFs } from "node:fs";
import { mkdtemp, readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { test, vi } from "vitest";

import { assert } from "../../../test/assert.js";

import { BoardStore } from "@symphony/local-tracker";

async function tempBoard(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "board-"));
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Escape a literal string (e.g. an absolute path with regex metacharacters) for use in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("a custom/unknown status falls back to a valid stateType (normalizeIssue requires one)", async () => {
  const dir = await tempBoard();
  await writeFile(
    path.join(dir, "BOARD-7.md"),
    "---\nstatus: Reviewing\n---\n# Custom status\n",
    "utf8",
  );
  const store = new BoardStore(dir);
  const issue = (await store.getByIds(["BOARD-7"]))[0]!;
  assert.equal(issue.state, "Reviewing");
  assert.equal(issue.stateType, "backlog");
});

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

test("updateStatus rejects a blank status and leaves the file intact", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);
  await store.create({ title: "Keep me", body: "Details here", status: "Todo" });
  const before = await readFile(path.join(dir, "BOARD-1.md"), "utf8");

  // A whitespace-only status would corrupt the file (parse() drops a status-less issue),
  // so it must be rejected before any write touches disk.
  await assert.rejects(() => store.updateStatus("BOARD-1", "   "), /status/);

  // The file is byte-for-byte unchanged and the issue still lists with its prior status.
  assert.equal(await readFile(path.join(dir, "BOARD-1.md"), "utf8"), before);
  const issue = (await store.getByIds(["BOARD-1"]))[0]!;
  assert.equal(issue.state, "Todo");
  assert.deepEqual(
    (await store.list()).map((i) => i.identifier),
    ["BOARD-1"],
  );
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

test("readContent returns status/title/description and each comment as its own entry", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);
  await store.create({ title: "Read me", body: "Some details", status: "Todo" });

  // No comments yet -> empty array, with the status/title/description read back faithfully.
  const before = await store.readContent("BOARD-1");
  assert.equal(before.id, "BOARD-1");
  assert.equal(before.status, "Todo");
  assert.equal(before.title, "Read me");
  assert.equal(before.description, "Some details");
  assert.deepEqual(before.comments, []);

  await store.updateStatus("BOARD-1", "In Progress");
  await store.appendComment("BOARD-1", "opened PR #42", () => new Date("2026-05-29T10:00:00Z"));
  await store.appendComment("BOARD-1", "checks green", () => new Date("2026-05-29T11:00:00Z"));

  const after = await store.readContent("BOARD-1");
  assert.equal(after.status, "In Progress");
  assert.equal(after.title, "Read me");
  assert.equal(after.description, "Some details");
  assert.deepEqual(after.comments, [
    "- 2026-05-29T10:00:00.000Z agent: opened PR #42",
    "- 2026-05-29T11:00:00.000Z agent: checks green",
  ]);
});

test("readContent rejects a missing or invalid id", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);
  // Invalid id shape is rejected before touching the filesystem.
  await assert.rejects(() => store.readContent("not-a-board-id"), /invalid.*id|BOARD/i);
  // A valid-shaped id with no backing file throws on read (ENOENT), matching getByIds strictness.
  await assert.rejects(() => store.readContent("BOARD-404"));
});

test("a custom idPrefix mints <prefix><n>, ignores other-prefix and stray files, and round-trips", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir, { idPrefix: "XXX-" });

  const a = await store.create({ title: "First", status: "Todo" });
  assert.equal(a.id, "XXX-1");
  assert.equal(a.identifier, "XXX-1");
  assert.match(await readFile(path.join(dir, "XXX-1.md"), "utf8"), /status: Todo/);

  // A file with the DEFAULT prefix is NOT an issue on an XXX- board, and a stray .md is ignored.
  await writeFile(path.join(dir, "BOARD-9.md"), "---\nstatus: Todo\n---\n# Foreign\n", "utf8");
  await writeFile(path.join(dir, "README.md"), "# not an issue\n", "utf8");
  assert.deepEqual(
    (await store.list()).map((i) => i.identifier),
    ["XXX-1"],
  );

  // nextId continues the XXX- sequence and never collides with the ignored BOARD-9.
  const b = await store.create({ title: "Second", status: "Todo" });
  assert.equal(b.id, "XXX-2");

  // read / update / comment all work against the custom-prefix id.
  await store.updateStatus("XXX-1", "Done");
  await store.appendComment("XXX-1", "did the thing", () => new Date("2026-06-01T00:00:00Z"));
  const read = await store.readContent("XXX-1");
  assert.equal(read.status, "Done");
  assert.deepEqual(read.comments, ["- 2026-06-01T00:00:00.000Z agent: did the thing"]);

  // An id with the wrong prefix is rejected by the prefix-aware path-safety guard.
  await assert.rejects(() => store.readContent("BOARD-1"), /invalid.*id|XXX-/i);
});

test("an unsafe idPrefix is rejected by the BoardStore constructor", async () => {
  const dir = await tempBoard();
  assert.throws(() => new BoardStore(dir, { idPrefix: "../evil" }), /id_prefix/);
  assert.throws(() => new BoardStore(dir, { idPrefix: "a/b" }), /id_prefix/);
  assert.throws(() => new BoardStore(dir, { idPrefix: "" }), /id_prefix/);
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

test("list skips malformed files, reports them via onSkip, and returns the valid ones", async () => {
  const dir = await tempBoard();
  // A valid issue, a frontmatter-without-status issue, and an unparseable-YAML issue.
  await writeFile(
    path.join(dir, "BOARD-1.md"),
    "---\nstatus: Todo\n---\n# Valid\n\nBody\n",
    "utf8",
  );
  await writeFile(path.join(dir, "BOARD-2.md"), "---\nlabels: []\n---\n# No status\n", "utf8");
  await writeFile(
    path.join(dir, "BOARD-3.md"),
    "---\nstatus: [unterminated\n---\n# Bad YAML\n",
    "utf8",
  );

  const skipped: { id: string; error: string }[] = [];
  const store = new BoardStore(dir, { onSkip: (s) => skipped.push(s) });

  const issues = await store.list();
  // Only the valid file is returned; the two malformed files are skipped, not thrown.
  assert.deepEqual(
    issues.map((i) => i.identifier),
    ["BOARD-1"],
  );

  // Both malformed files are surfaced (observable), not silently hidden.
  assert.deepEqual(skipped.map((s) => s.id).sort(), ["BOARD-2", "BOARD-3"]);
  const missingStatus = skipped.find((s) => s.id === "BOARD-2")!;
  assert.match(missingStatus.error, /status/);

  // byStatus rides on the same resilient listing.
  const active = await store.byStatus(["Todo"]);
  assert.deepEqual(
    active.map((i) => i.identifier),
    ["BOARD-1"],
  );
});

test("getByIds stays strict: an explicitly-requested malformed id still throws", async () => {
  const dir = await tempBoard();
  await writeFile(path.join(dir, "BOARD-1.md"), "---\nstatus: Todo\n---\n# Valid\n", "utf8");
  await writeFile(path.join(dir, "BOARD-2.md"), "---\nlabels: []\n---\n# No status\n", "utf8");

  const skipped: { id: string; error: string }[] = [];
  const store = new BoardStore(dir, { onSkip: (s) => skipped.push(s) });

  // Explicitly asking for the bad id surfaces the error rather than skipping it.
  await assert.rejects(() => store.getByIds(["BOARD-2"]), /BOARD-2.*status/);
  // A strict fetch never routes through onSkip.
  assert.equal(skipped.length, 0);

  // A valid explicit fetch still works.
  const ok = (await store.getByIds(["BOARD-1"]))[0]!;
  assert.equal(ok.identifier, "BOARD-1");
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

test("rejects path-traversal and malformed issue ids without touching the filesystem", async () => {
  // Nest the board under a private parent (not the shared os.tmpdir()) so the "parent dir is
  // unchanged" assertion below only observes this test's files. Comparing the shared tmpdir
  // listing would flake whenever a concurrent test creates a temp dir there mid-run.
  const parent = await mkdtemp(path.join(tmpdir(), "board-traversal-"));
  const dir = path.join(parent, "board");
  await mkdir(dir, { recursive: true });
  const store = new BoardStore(dir);
  await store.create({ title: "Valid", body: "Body", status: "Todo" });

  const before = (await readdir(dir)).sort();
  // Capture a marker file outside the board dir so we can prove nothing escaped.
  const sentinel = path.join(parent, "outside-marker.txt");
  await writeFile(sentinel, "untouched", "utf8");
  const sentinelBefore = await readFile(sentinel, "utf8");
  const parentBefore = (await readdir(parent)).sort();

  const badIds = ["../../etc/passwd", "BOARD-1/../x", "foo", "", "BOARD-1/../../outside-marker"];
  for (const id of badIds) {
    await assert.rejects(() => store.updateStatus(id, "Done"), /invalid.*id|BOARD/i);
    await assert.rejects(() => store.appendComment(id, "x"), /invalid.*id|BOARD/i);
    await assert.rejects(() => store.getByIds([id]), /invalid.*id|BOARD/i);
  }

  // No file created or removed outside the board dir, and the board itself is unchanged.
  assert.deepEqual((await readdir(dir)).sort(), before);
  assert.equal(await readFile(sentinel, "utf8"), sentinelBefore);
  // The parent dir gained or lost nothing (the rejected ids never reached the filesystem).
  assert.deepEqual((await readdir(parent)).sort(), parentBefore);

  // A valid id still works end to end.
  const ok = await store.updateStatus("BOARD-1", "In Progress");
  assert.equal(ok.state, "In Progress");
  await store.appendComment("BOARD-1", "still works", () => new Date("2026-05-29T12:00:00Z"));
  const fetched = (await store.getByIds(["BOARD-1"]))[0]!;
  assert.equal(fetched.identifier, "BOARD-1");
});

test("write leaves no temporary file behind (atomic rename)", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);
  await store.create({ title: "Atomic", body: "Body", status: "Todo" });
  await store.updateStatus("BOARD-1", "In Progress");
  await store.appendComment("BOARD-1", "note", () => new Date("2026-05-29T10:00:00Z"));

  const entries = (await readdir(dir)).sort();
  // The only artifact is the final issue file; no *.tmp / *.<pid> scratch files remain.
  assert.deepEqual(entries, ["BOARD-1.md"]);
  const issue = (await store.getByIds(["BOARD-1"]))[0]!;
  assert.equal(issue.state, "In Progress");
});

test("create never overwrites a pre-existing higher id and stays collision-safe", async () => {
  const dir = await tempBoard();
  // Seed a hand-authored BOARD-3 directly on disk.
  await writeFile(
    path.join(dir, "BOARD-3.md"),
    "---\nstatus: Todo\n---\n\n# Seeded\n\nDo not clobber\n",
    "utf8",
  );
  const store = new BoardStore(dir);

  const created = await store.create({ title: "Next", status: "Todo" });
  assert.equal(created.identifier, "BOARD-4");

  // The seeded file is untouched.
  const seeded = await readFile(path.join(dir, "BOARD-3.md"), "utf8");
  assert.match(seeded, /# Seeded/);
  assert.match(seeded, /Do not clobber/);
});

test("ignores stray non-BOARD markdown files for ids, listing, and allocation", async () => {
  const dir = await tempBoard();
  // A real board issue alongside two stray markdown files that are NOT board issues. Without
  // filtering, nextId() would feed "README"/"notes" into boardNumber()'s MAX_SAFE_INTEGER
  // fallback and allocate BOARD-9007199254740992; here create() must simply yield BOARD-2.
  await writeFile(path.join(dir, "README.md"), "# Readme\n\nNot a board issue\n", "utf8");
  await writeFile(path.join(dir, "notes.md"), "# Notes\n\nAlso not a board issue\n", "utf8");
  await writeFile(path.join(dir, "BOARD-1.md"), "---\nstatus: Todo\n---\n# One\n\nBody\n", "utf8");
  const readmeBefore = await readFile(path.join(dir, "README.md"), "utf8");
  const notesBefore = await readFile(path.join(dir, "notes.md"), "utf8");

  const store = new BoardStore(dir);

  // Allocation skips the stray stems entirely and increments off the real board id.
  const created = await store.create({ title: "Next", status: "Todo" });
  assert.equal(created.identifier, "BOARD-2");

  // list() returns only canonical board issues, never the stray files.
  assert.deepEqual((await store.list()).map((i) => i.identifier).sort(), ["BOARD-1", "BOARD-2"]);

  // Explicit lookups of a real board id still work.
  const fetched = (await store.getByIds(["BOARD-1"]))[0]!;
  assert.equal(fetched.identifier, "BOARD-1");

  // The stray markdown files are left byte-for-byte untouched on disk.
  assert.equal(await readFile(path.join(dir, "README.md"), "utf8"), readmeBefore);
  assert.equal(await readFile(path.join(dir, "notes.md"), "utf8"), notesBefore);
});

test("concurrent create calls allocate unique ids without losing writes", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);

  // Fire many creates at once: the no-overwrite link + retry path must keep ids unique.
  const results = await Promise.all(
    Array.from({ length: 12 }, (_unused, i) =>
      store.create({ title: `Task ${i}`, status: "Todo" }),
    ),
  );
  const ids = results.map((r) => r.identifier).sort();
  const unique = new Set(ids);
  assert.equal(unique.size, results.length, `expected unique ids, got ${ids.join(",")}`);

  // Every create produced exactly one file on disk; nothing was overwritten.
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  assert.equal(files.length, results.length);
  for (const id of ids) {
    const fileStat = await stat(path.join(dir, `${id}.md`));
    assert.equal(fileStat.isFile(), true);
  }
});

test("create publishes crash-atomically: no temp scratch left, file fully-formed", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);

  const created = await store.create({ title: "Crash safe", body: "Body text", status: "Todo" });
  assert.equal(created.identifier, "BOARD-1");

  // No ".tmp" scratch file survives a successful create (the finally always unlinks it).
  const entries = (await readdir(dir)).sort();
  assert.deepEqual(entries, ["BOARD-1.md"]);
  assert.equal(
    entries.some((f) => f.endsWith(".tmp")),
    false,
  );

  // The published file is fully-formed: it parses with the correct title and status.
  const issue = (await store.getByIds(["BOARD-1"]))[0]!;
  assert.equal(issue.title, "Crash safe");
  assert.equal(issue.state, "Todo");
  assert.equal(issue.description, "Body text");
});

test("create fsyncs the temp contents before publish and the dir after publish", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);

  // Track every fsync target so we can prove the durability barriers fire in the right order:
  // the temp file's CONTENTS must be flushed BEFORE the directory entry that exposes it, and the
  // board directory must be flushed AFTER the link so the new name itself survives a crash.
  const synced: string[] = [];
  const realOpen = nodeFs.open.bind(nodeFs);
  const openSpy = vi
    .spyOn(nodeFs, "open")
    .mockImplementation(async (p: Parameters<typeof nodeFs.open>[0], ...rest) => {
      const fh = await (realOpen as typeof nodeFs.open)(p, ...rest);
      const realSync = fh.sync.bind(fh);
      fh.sync = async () => {
        synced.push(String(p));
        return realSync();
      };
      return fh;
    });
  try {
    await store.create({ title: "Durable", body: "Body", status: "Todo" });
  } finally {
    openSpy.mockRestore();
  }

  // A temp file (dotted .tmp scratch) was fsynced, and the board directory was fsynced, with the
  // temp fsync strictly before the directory fsync.
  const tempIdx = synced.findIndex((p) => p.endsWith(".tmp"));
  const dirIdx = synced.indexOf(path.resolve(dir));
  assert.ok(tempIdx !== -1, `expected a temp-file fsync, saw ${JSON.stringify(synced)}`);
  assert.ok(dirIdx !== -1, `expected a board-dir fsync, saw ${JSON.stringify(synced)}`);
  assert.ok(tempIdx < dirIdx, "temp contents must be fsynced before the directory entry");

  // The published file is fully-formed and the temp scratch is gone.
  const issue = (await store.getByIds(["BOARD-1"]))[0]!;
  assert.equal(issue.title, "Durable");
  assert.deepEqual((await readdir(dir)).sort(), ["BOARD-1.md"]);
});

test("first create fsyncs the PARENT of a newly-created board dir (new-dir entry is durable)", async () => {
  // A first-run board whose parent does not exist yet: <tmp>/new-parent/board. mkdir creates the
  // whole chain. fsyncing the board dir alone persists entries INSIDE it but NOT the directory
  // entry in the parent that makes the new board dir reachable, so a crash right after create()
  // could lose the entire board. The parent of the newly-created board dir must be fsynced too.
  const tmp = await mkdtemp(path.join(tmpdir(), "board-first-run-"));
  const parent = path.join(tmp, "new-parent");
  const dir = path.join(parent, "board");
  const store = new BoardStore(dir);

  const synced: string[] = [];
  const realOpen = nodeFs.open.bind(nodeFs);
  const openSpy = vi
    .spyOn(nodeFs, "open")
    .mockImplementation(async (p: Parameters<typeof nodeFs.open>[0], ...rest) => {
      const fh = await (realOpen as typeof nodeFs.open)(p, ...rest);
      const realSync = fh.sync.bind(fh);
      fh.sync = async () => {
        synced.push(path.resolve(String(p)));
        return realSync();
      };
      return fh;
    });
  try {
    await store.create({ title: "First run", body: "Body", status: "Todo" });
  } finally {
    openSpy.mockRestore();
  }

  // The board dir itself was fsynced (post-publish, persists the new file entry)...
  assert.ok(
    synced.includes(path.resolve(dir)),
    `expected the board dir to be fsynced, saw ${JSON.stringify(synced)}`,
  );
  // ...AND its parent was fsynced so the newly-created board-dir entry survives a crash.
  assert.ok(
    synced.includes(path.resolve(parent)),
    `expected the new board dir's PARENT to be fsynced, saw ${JSON.stringify(synced)}`,
  );

  // The created issue is fully durable and round-trips.
  const issue = (await store.getByIds(["BOARD-1"]))[0]!;
  assert.equal(issue.title, "First run");
  assert.equal(issue.state, "Todo");
});

test("concurrent first-run creates fsync the FULL new chain before publishing (ensureBoardDir is locked)", async () => {
  // A first-run board several levels deep whose entire chain is missing: <tmp>/p1/p2/board. The
  // chain is built by mkdir(recursive), which returns only the topmost level a given call observed
  // as newly-created. If ensureBoardDir ran OUTSIDE the per-dir lock, two racing first-run creates
  // could interleave inside the recursive mkdir so each fsyncs only its own slice of the chain with
  // no barrier guaranteeing the upper parents are durable before the other create links its file.
  // Running ensureBoardDir under the same lock as the publish makes exactly one create build AND
  // fully fsync the new chain; the other observes the dir as already existing and skips re-fsyncing.
  const tmp = await mkdtemp(path.join(tmpdir(), "board-first-run-race-"));
  const p1 = path.join(tmp, "p1");
  const p2 = path.join(p1, "p2");
  const dir = path.join(p2, "board");
  // Two SEPARATE stores so the only thing serializing them is the module-level per-dir lock.
  const a = new BoardStore(dir);
  const b = new BoardStore(dir);

  const synced: string[] = [];
  const realOpen = nodeFs.open.bind(nodeFs);
  const openSpy = vi
    .spyOn(nodeFs, "open")
    .mockImplementation(async (p: Parameters<typeof nodeFs.open>[0], ...rest) => {
      const fh = await (realOpen as typeof nodeFs.open)(p, ...rest);
      const realSync = fh.sync.bind(fh);
      fh.sync = async () => {
        synced.push(path.resolve(String(p)));
        return realSync();
      };
      return fh;
    });
  let results: Awaited<ReturnType<BoardStore["create"]>>[];
  try {
    results = await Promise.all([
      a.create({ title: "Race A", status: "Todo" }),
      b.create({ title: "Race B", status: "Todo" }),
    ]);
  } finally {
    openSpy.mockRestore();
  }

  // Both creates succeeded with unique ids (no lost write, no clobber).
  const ids = results.map((r) => r.identifier).sort();
  assert.deepEqual(ids, ["BOARD-1", "BOARD-2"]);

  // Every parent entry along the newly-created chain was fsynced, so the whole chain is reachable
  // after a crash: the pre-existing tmp dir gained `p1`, `p1` gained `p2`, `p2` gained `board`.
  for (const ancestorParent of [tmp, p1, p2]) {
    assert.ok(
      synced.includes(path.resolve(ancestorParent)),
      `expected ${ancestorParent} to be fsynced, saw ${JSON.stringify(synced)}`,
    );
  }
  // The board dir itself was fsynced post-publish (persists the new file entries inside it).
  assert.ok(
    synced.includes(path.resolve(dir)),
    `expected the board dir to be fsynced, saw ${JSON.stringify(synced)}`,
  );

  // Both issues are durable on disk and round-trip through a fresh store.
  const fetched = await new BoardStore(dir).getByIds(["BOARD-1", "BOARD-2"]);
  assert.deepEqual(fetched.map((i) => i.identifier).sort(), ["BOARD-1", "BOARD-2"]);
});

test("create leaves NO partial BOARD file when the publish (link) fails", async () => {
  const dir = await tempBoard();
  const store = new BoardStore(dir);

  // Stub fs.link so the publish step throws a non-EEXIST error once. The fully-written temp must
  // never become a visible BOARD-<n>.md, and the finally must still clean the temp away.
  const linkSpy = vi
    .spyOn(nodeFs, "link")
    .mockRejectedValueOnce(Object.assign(new Error("simulated publish failure"), { code: "EIO" }));
  try {
    await assert.rejects(
      () => store.create({ title: "Doomed", body: "Body", status: "Todo" }),
      /simulated publish failure/,
    );
  } finally {
    linkSpy.mockRestore();
  }

  // No BOARD-<n>.md was published, and no temp scratch file leaked into the board dir.
  const entries = (await readdir(dir)).sort();
  assert.deepEqual(entries, []);

  // The board is still healthy: a subsequent create succeeds and claims the first id.
  const ok = await store.create({ title: "Recovered", status: "Todo" });
  assert.equal(ok.identifier, "BOARD-1");
  assert.deepEqual((await readdir(dir)).sort(), ["BOARD-1.md"]);
});

test("concurrent updateStatus and appendComment on one issue lose nothing (shared module lock)", async () => {
  const dir = await tempBoard();
  // Seed the issue with one store, then mutate it through TWO separate BoardStore instances
  // pointing at the same dir. The lock must be module-level/shared, not per-instance, for the
  // races below to serialize - a per-instance lock would let them interleave and lose updates.
  await new BoardStore(dir).create({ title: "Race", status: "Todo" });
  const a = new BoardStore(dir);
  const b = new BoardStore(dir);

  const comments = Array.from({ length: 8 }, (_unused, i) => `comment ${i}`);
  // Fire one status change plus many comments at once, split across both instances, against the
  // same BOARD-1 file. Without serialization these read-modify-write cycles clobber each other.
  await Promise.all([
    a.updateStatus("BOARD-1", "In Progress"),
    ...comments.map((c, i) => (i % 2 === 0 ? a : b).appendComment("BOARD-1", c)),
  ]);

  const file = await readFile(path.join(dir, "BOARD-1.md"), "utf8");
  // The status change survived...
  assert.match(file, /status: In Progress/);
  // ...and every comment is present - no lost update.
  for (const c of comments) assert.match(file, new RegExp(`agent: ${c}\\b`));

  // Round-trip through a fresh store to confirm the final file is still well-formed.
  const issue = (await new BoardStore(dir).getByIds(["BOARD-1"]))[0]!;
  assert.equal(issue.state, "In Progress");
});

test("list() treats a MISSING board directory as an empty board (ENOENT -> [])", async () => {
  // A nonexistent dir is a legitimately empty board: no issues yet, no error.
  const dir = path.join(await tempBoard(), "does-not-exist-yet");
  const store = new BoardStore(dir);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await store.byStatus(["Todo"]), []);
});

test("list()/byStatus() THROW with the path when the board dir is a file (ENOTDIR)", async () => {
  // Point the store at a REGULAR FILE rather than a directory. fs.readdir fails with ENOTDIR,
  // which must surface as a throw (with the path in the message) instead of looking like an
  // empty board - so the runtime poll-loop guard records a poll_error for the operator.
  const parent = await tempBoard();
  const filePath = path.join(parent, "board-file");
  await writeFile(filePath, "not a directory", "utf8");

  const store = new BoardStore(filePath);
  await assert.rejects(() => store.list(), new RegExp(escapeRegExp(filePath)));
  await assert.rejects(() => store.byStatus(["Todo"]), new RegExp(escapeRegExp(filePath)));
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
