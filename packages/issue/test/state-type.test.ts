import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { defaultStateType } from "@lorenz/issue";

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
