import { test } from "vitest";

import { assert } from "../../../test/assert.js";

import { defaultStateType } from "@symphony/issue";

test("defaultStateType maps common workflow state names to categories", () => {
  assert.equal(defaultStateType("Todo"), "unstarted");
  assert.equal(defaultStateType("In Progress"), "started");
  assert.equal(defaultStateType("Done"), "completed");
  assert.equal(defaultStateType("Cancelled"), "canceled");
  assert.equal(defaultStateType("Canceled"), "canceled");
  assert.equal(defaultStateType("Backlog"), "backlog");
  assert.equal(defaultStateType("Triage"), "triage");
  assert.equal(defaultStateType("Something Else"), null);
});
