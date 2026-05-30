import { access, mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseConfig } from "@symphony/config";
import { test } from "vitest";

import { assert } from "../../../test/assert.js";

import { executeTool, toolSpecs } from "@symphony/mcp";

async function localSettings() {
  const dir = await mkdtemp(path.join(tmpdir(), "board-tools-"));
  await mkdir(dir, { recursive: true });
  return { dir, settings: parseConfig({ tracker: { kind: "local", path: dir } }, {}) };
}

test("local toolSpecs lists the three board tools", async () => {
  const { settings } = await localSettings();
  assert.deepEqual(
    toolSpecs(settings).map((t) => t.name),
    ["local_update_status", "local_comment", "local_create_issue"],
  );
});

test("local tools create, update status, and comment on the board", async () => {
  const { dir, settings } = await localSettings();

  const created = await executeTool(
    "local_create_issue",
    { title: "Fix it", status: "Todo" },
    settings,
  );
  assert.equal(created.success, true);

  const moved = await executeTool(
    "local_update_status",
    { issueId: "BOARD-1", status: "In Progress" },
    settings,
  );
  assert.equal(moved.success, true);

  const commented = await executeTool(
    "local_comment",
    { issueId: "BOARD-1", body: "opened PR" },
    settings,
  );
  assert.equal(commented.success, true);

  const file = await readFile(path.join(dir, "BOARD-1.md"), "utf8");
  assert.match(file, /status: In Progress/);
  assert.match(file, /agent: opened PR/);
});

test("local tools reject unknown names", async () => {
  const { settings } = await localSettings();
  const result = await executeTool("local_bogus", {}, settings);
  assert.equal(result.success, false);
});

test("local_create_issue writes under HOME for a ~ path, not a literal ~ under cwd", async () => {
  // Regression: the write path (MCP tools) must expand "~" the same way the read path
  // (LocalTrackerClient, which the daemon polls) does. Before the shared resolver the
  // tool wrote a literal "<cwd>/~/board" segment, so agent writes never reached the
  // polled HOME/board and the run loop re-dispatched forever.
  const home = await mkdtemp(path.join(tmpdir(), "board-mcp-home-"));
  const settings = parseConfig({ tracker: { kind: "local", path: "~/board" } }, {});

  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const created = await executeTool("local_create_issue", { title: "FromTilde" }, settings);
    assert.equal(created.success, true);

    // The issue file lands under the expanded HOME/board directory.
    await access(path.join(home, "board", "BOARD-1.md"));

    // And NOT under a literal "~" segment relative to cwd.
    let literalExists = true;
    try {
      await access(path.join(process.cwd(), "~", "board", "BOARD-1.md"));
    } catch {
      literalExists = false;
    }
    assert.equal(literalExists, false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
