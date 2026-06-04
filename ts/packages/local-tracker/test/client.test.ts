import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseConfig } from "@symphony/config";
import { test } from "vitest";

import { assert } from "../../../test/assert.js";

import { BoardStore, LocalTrackerClient } from "@symphony/local-tracker";



test("LocalTrackerClient reads candidates by active states from the board dir", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "board-client-"));
  await mkdir(dir, { recursive: true });
  const store = new BoardStore(dir);
  await store.create({ title: "Active", status: "Todo" });
  await store.create({ title: "Done", status: "Done" });

  const settings = parseConfig(
    { tracker: { kind: "local", path: dir, active_states: ["Todo"], terminal_states: ["Done"] } },
    {},
  );
  const client = new LocalTrackerClient(settings);

  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(
    candidates.map((i) => i.identifier),
    ["BOARD-1"],
  );
  assert.deepEqual(
    (await client.fetchIssuesByStates(["Done"])).map((i) => i.identifier),
    ["BOARD-2"],
  );
  assert.deepEqual(
    (await client.fetchIssuesByIds(["BOARD-2"])).map((i) => i.title),
    ["Done"],
  );
});

test("LocalTrackerClient fetchCandidateIssues skips a malformed board file and warns", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "board-skip-"));
  await mkdir(dir, { recursive: true });
  const store = new BoardStore(dir);
  await store.create({ title: "Active", status: "Todo" });
  // A malformed file (frontmatter with no status) sitting alongside the valid issue.
  await writeFile(path.join(dir, "BOARD-99.md"), "---\nlabels: []\n---\n# Broken\n", "utf8");

  const settings = parseConfig(
    { tracker: { kind: "local", path: dir, active_states: ["Todo"], terminal_states: ["Done"] } },
    {},
  );
  const warnings: string[] = [];
  const client = new LocalTrackerClient(settings, process.cwd(), process.env, {
    warn: (msg) => warnings.push(msg),
  });

  const candidates = await client.fetchCandidateIssues();
  // The valid issue is still returned; the malformed file did not abort the fetch.
  assert.deepEqual(
    candidates.map((i) => i.identifier),
    ["BOARD-1"],
  );
  // The skip is observable: a warning naming the bad file was emitted.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /BOARD-99/);
});

test("LocalTrackerClient expands a leading ~ to HOME", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "board-home-"));
  const boardDir = path.join(home, "board");
  await mkdir(boardDir, { recursive: true });
  const seeded = new BoardStore(boardDir);
  await seeded.create({ title: "FromTilde", status: "Todo" });

  const settings = parseConfig(
    {
      tracker: {
        kind: "local",
        path: "~/board",
        active_states: ["Todo"],
        terminal_states: ["Done"],
      },
    },
    {},
  );
  // cwd is irrelevant once ~ resolves to HOME; point it elsewhere to prove that.
  const client = new LocalTrackerClient(settings, tmpdir(), { HOME: home });

  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(
    candidates.map((i) => i.title),
    ["FromTilde"],
  );
});

test("LocalTrackerClient substitutes an environment variable in the path", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "board-var-"));
  const boardDir = path.join(base, "board");
  await mkdir(boardDir, { recursive: true });
  const seeded = new BoardStore(boardDir);
  await seeded.create({ title: "FromVar", status: "Todo" });

  const settings = parseConfig(
    {
      tracker: {
        kind: "local",
        path: "$BOARD_ROOT/board",
        active_states: ["Todo"],
        terminal_states: ["Done"],
      },
    },
    {},
  );
  const client = new LocalTrackerClient(settings, tmpdir(), { BOARD_ROOT: base });

  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(
    candidates.map((i) => i.title),
    ["FromVar"],
  );
});
