import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, test } from "vitest";

import { assert } from "../../../test/assert.js";

import {
  FsTrackerClient,
  parseBoardFile,
  serializeBoardFile,
  slugifyState,
} from "@symphony/fs-tracker";

let boardDir: string;

beforeEach(async () => {
  boardDir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-tracker-"));
});

afterEach(async () => {
  await fs.rm(boardDir, { recursive: true, force: true });
});

async function writeIssue(state: string, identifier: string, content: string): Promise<void> {
  const dir = path.join(boardDir, state);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${identifier}.md`), content, "utf8");
}

test("fetchCandidateIssues filters by configured active states", async () => {
  await writeIssue(
    "todo",
    "ENG-1",
    "---\nid: a\nidentifier: ENG-1\ntitle: First\n---\nDescribe the work.\n",
  );
  await writeIssue("in-progress", "ENG-2", "---\nid: b\nidentifier: ENG-2\ntitle: Second\n---\n");
  await writeIssue("done", "ENG-3", "---\nid: c\nidentifier: ENG-3\ntitle: Third\n---\n");

  const client = new FsTrackerClient(boardDir, { activeStates: ["Todo", "In Progress"] });
  const candidates = await client.fetchCandidateIssues();

  assert.deepEqual(candidates.map((issue) => issue.identifier).sort(), ["ENG-1", "ENG-2"]);
});

test("maps directory slug to a display state and body to description", async () => {
  await writeIssue(
    "in-progress",
    "ENG-9",
    "---\nid: x\nidentifier: ENG-9\ntitle: Build it\n---\nBody becomes description.\n",
  );

  const client = new FsTrackerClient(boardDir);
  const [issue] = await client.fetchCandidateIssues();

  assert.equal(issue!.state, "In Progress");
  assert.equal(issue!.description, "Body becomes description.");
});

test("normalizes labels, priority, and string blockers", async () => {
  await writeIssue(
    "todo",
    "ENG-1",
    "---\nid: a\nidentifier: ENG-1\ntitle: First\nlabels: [Backend, ensemble:2]\npriority: 2\nblockers: [ENG-0]\n---\n",
  );

  const client = new FsTrackerClient(boardDir);
  const [issue] = await client.fetchCandidateIssues();

  assert.deepEqual(issue!.labels, ["backend", "ensemble:2"]);
  assert.equal(issue!.priority, 2);
  assert.equal(issue!.blockers[0]?.identifier, "ENG-0");
});

test("fetchIssuesByIds preserves requested order and dedupes", async () => {
  await writeIssue("todo", "ENG-1", "---\nid: a\nidentifier: ENG-1\ntitle: First\n---\n");
  await writeIssue("done", "ENG-2", "---\nid: b\nidentifier: ENG-2\ntitle: Second\n---\n");

  const client = new FsTrackerClient(boardDir);
  const result = await client.fetchIssuesByIds(["b", "missing", "a", "b"]);

  assert.deepEqual(
    result.map((issue) => issue.id),
    ["b", "a"],
  );
});

test("fetchIssuesByStates matches separators and case insensitively", async () => {
  await writeIssue("in-progress", "ENG-2", "---\nid: b\nidentifier: ENG-2\ntitle: Second\n---\n");

  const client = new FsTrackerClient(boardDir);
  const result = await client.fetchIssuesByStates(["In Progress"]);

  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "b");
});

test("falls back to identifier when id or title is omitted", async () => {
  await writeIssue("todo", "ENG-7", "---\nidentifier: ENG-7\n---\nOnly a body.\n");

  const client = new FsTrackerClient(boardDir);
  const [issue] = await client.fetchCandidateIssues();

  assert.equal(issue!.id, "ENG-7");
  assert.equal(issue!.identifier, "ENG-7");
  assert.equal(issue!.title, "ENG-7");
});

test("returns no issues when the board directory is absent", async () => {
  const client = new FsTrackerClient(path.join(boardDir, "missing"));
  assert.deepEqual(await client.fetchCandidateIssues(), []);
});

test("skips malformed files without failing the load", async () => {
  await writeIssue("todo", "ENG-1", "---\nid: a\nidentifier: ENG-1\ntitle: Good\n---\n");
  await writeIssue("todo", "ENG-BAD", "---\n: : not valid yaml : :\n---\n");

  const client = new FsTrackerClient(boardDir);
  const candidates = await client.fetchCandidateIssues();

  assert.deepEqual(
    candidates.map((issue) => issue.identifier),
    ["ENG-1"],
  );
});

test("serializeBoardFile round-trips through parseBoardFile", () => {
  const text = serializeBoardFile({ id: "a", identifier: "ENG-1", title: "Round trip" }, "Body.");
  const { data, body } = parseBoardFile(text);

  assert.equal(data.identifier, "ENG-1");
  assert.equal(body.trim(), "Body.");
});

test("slugifyState converts display names to directory slugs", () => {
  assert.equal(slugifyState("In Progress"), "in-progress");
  assert.equal(slugifyState("Todo"), "todo");
});
