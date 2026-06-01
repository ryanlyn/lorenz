import path from "node:path";

import { test } from "vitest";

import { assert } from "../../../test/assert.js";

import { DEFAULT_BOARD_DIR, resolveBoardDir } from "@symphony/local-tracker";

test("resolveBoardDir defaults to .symphony/local under cwd", () => {
  const cwd = "/work/project";
  assert.equal(resolveBoardDir(undefined, { cwd, env: {} }), path.join(cwd, DEFAULT_BOARD_DIR));
});

test("resolveBoardDir expands a leading ~ to HOME (parity with the former client logic)", () => {
  const home = "/home/operator";
  // The read path (client) and write path (MCP tools) must resolve "~/board" identically.
  // Before the shared resolver, the client expanded "~" then resolved against cwd; an
  // absolute HOME means cwd is irrelevant, so both sides land on HOME/board.
  const expected = path.join(home, "board");
  assert.equal(resolveBoardDir("~/board", { cwd: "/elsewhere", env: { HOME: home } }), expected);
  // A bare "~" expands to HOME itself.
  assert.equal(resolveBoardDir("~", { cwd: "/elsewhere", env: { HOME: home } }), home);
});

test("resolveBoardDir substitutes $VAR and ${VAR} (parity with the former client logic)", () => {
  const base = "/srv/boards";
  const expected = path.join(base, "board");
  // Bare dollar-VAR form.
  assert.equal(
    resolveBoardDir("$BOARD_ROOT/board", { cwd: "/elsewhere", env: { BOARD_ROOT: base } }),
    expected,
  );
  // Dollar-brace form resolves to the same absolute path.
  assert.equal(
    resolveBoardDir("${BOARD_ROOT}/board", { cwd: "/elsewhere", env: { BOARD_ROOT: base } }),
    expected,
  );
});

test("resolveBoardDir resolves a relative path against cwd", () => {
  const cwd = "/work/project";
  assert.equal(resolveBoardDir("boards/team", { cwd, env: {} }), path.join(cwd, "boards/team"));
});

test("resolveBoardDir leaves an absolute path untouched", () => {
  assert.equal(resolveBoardDir("/abs/board", { cwd: "/elsewhere", env: {} }), "/abs/board");
});
