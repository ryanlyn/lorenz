import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, test } from "vitest";

import { assert } from "../../../test/assert.js";

import {
  boardList,
  boardMove,
  boardNew,
  createTrackerClient,
  FsTrackerClient,
  parseConfig,
} from "@symphony/cli";

let boardDir: string;

beforeEach(async () => {
  boardDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-cli-"));
});

afterEach(async () => {
  await fs.rm(boardDir, { recursive: true, force: true });
});

test("tracker factory selects the fs adapter and reads the board directory", async () => {
  await fs.mkdir(path.join(boardDir, "todo"), { recursive: true });
  await fs.writeFile(
    path.join(boardDir, "todo", "ENG-1.md"),
    "---\nid: a\nidentifier: ENG-1\ntitle: First\n---\n",
    "utf8",
  );

  const settings = parseConfig({ tracker: { kind: "fs", board_dir: boardDir } }, {});
  const client = createTrackerClient(settings, {});

  assert.ok(client instanceof FsTrackerClient);
  assert.deepEqual(
    (await client.fetchCandidateIssues()).map((issue) => issue.identifier),
    ["ENG-1"],
  );
});

test("board new generates an identifier and writes a file the adapter can read", async () => {
  const first = await boardNew(boardDir, {
    title: "Add login",
    state: "todo",
    labels: ["backend"],
    priority: 2,
    description: "Login description.",
    id: null,
    identifier: null,
    prefix: "ENG",
  });
  assert.equal(first.identifier, "ENG-1");

  const second = await boardNew(boardDir, {
    title: "Add logout",
    state: "todo",
    labels: [],
    priority: null,
    description: null,
    id: null,
    identifier: null,
    prefix: "ENG",
  });
  assert.equal(second.identifier, "ENG-2");

  const client = new FsTrackerClient(boardDir);
  const issues = await client.fetchCandidateIssues();
  const login = issues.find((issue) => issue.identifier === "ENG-1");
  assert.equal(login?.title, "Add login");
  assert.deepEqual(login?.labels, ["backend"]);
  assert.equal(login?.priority, 2);
  assert.equal(login?.description, "Login description.");
});

test("board move relocates an issue between state directories", async () => {
  await boardNew(boardDir, {
    title: "Work",
    state: "todo",
    labels: [],
    priority: null,
    description: null,
    id: null,
    identifier: "ENG-1",
    prefix: "ENG",
  });

  const moved = await boardMove(boardDir, "eng-1", "In Progress");
  assert.equal(moved.from, "todo");
  assert.equal(moved.to, "in-progress");

  assert.equal(await pathExists(path.join(boardDir, "todo", "ENG-1.md")), false);
  assert.equal(await pathExists(path.join(boardDir, "in-progress", "ENG-1.md")), true);

  const client = new FsTrackerClient(boardDir);
  const [issue] = await client.fetchIssuesByStates(["In Progress"]);
  assert.equal(issue!.identifier, "ENG-1");
});

test("board move rejects an unknown identifier", async () => {
  await assert.rejects(() => boardMove(boardDir, "nope", "done"), /board issue not found/);
});

test("board list renders issues grouped by state", async () => {
  await boardNew(boardDir, {
    title: "First",
    state: "todo",
    labels: ["backend"],
    priority: null,
    description: null,
    id: null,
    identifier: "ENG-1",
    prefix: "ENG",
  });

  const output = await boardList(boardDir, null);
  assert.match(output, /todo/);
  assert.match(output, /ENG-1 {2}First {2}\[backend\]/);

  const empty = await boardList(boardDir, "done");
  assert.match(empty, /No issues in done/);
});

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
