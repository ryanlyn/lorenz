import { test } from "vitest";

import { assert } from "../../../test/assert.js";

import {
  actionForStopReason as rootActionForStopReason,
  mergeMonotonicUsage as rootMergeMonotonicUsage,
  reconciliationStopReason as rootReconciliationStopReason,
  resumeIdentityMatches as rootResumeIdentityMatches,
  retryBackoffMs as rootRetryBackoffMs,
  selectLeastLoadedHost as rootSelectLeastLoadedHost,
} from "@symphony/policies";
import { retryBackoffMs } from "@symphony/policies/retry";
import { actionForStopReason } from "@symphony/policies/stopReason";
import { mergeMonotonicUsage } from "@symphony/policies/usage";
import { resumeIdentityMatches } from "@symphony/policies/resume";
import { reconciliationStopReason } from "@symphony/policies/reconciliation";
import { selectLeastLoadedHost } from "@symphony/policies/workerHost";

test("documented policy exports are available from root and subpaths", () => {
  assert.equal(rootRetryBackoffMs, retryBackoffMs);
  assert.equal(rootActionForStopReason, actionForStopReason);
  assert.equal(rootMergeMonotonicUsage, mergeMonotonicUsage);
  assert.equal(rootResumeIdentityMatches, resumeIdentityMatches);
  assert.equal(rootReconciliationStopReason, reconciliationStopReason);
  assert.equal(rootSelectLeastLoadedHost, selectLeastLoadedHost);
});
