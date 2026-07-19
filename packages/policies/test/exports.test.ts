import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import {
  actionForStopReason as rootActionForStopReason,
  mergeMonotonicUsage as rootMergeMonotonicUsage,
  retryBackoffMs as rootRetryBackoffMs,
  selectLeastLoadedHost as rootSelectLeastLoadedHost,
} from "@lorenz/policies";
import { retryBackoffMs } from "@lorenz/policies/retry";
import { actionForStopReason } from "@lorenz/policies/stopReason";
import { mergeMonotonicUsage } from "@lorenz/policies/usage";
import { selectLeastLoadedHost } from "@lorenz/policies/workerHost";

test("documented policy exports are available from root and subpaths", () => {
  assert.equal(rootRetryBackoffMs, retryBackoffMs);
  assert.equal(rootActionForStopReason, actionForStopReason);
  assert.equal(rootMergeMonotonicUsage, mergeMonotonicUsage);
  assert.equal(rootSelectLeastLoadedHost, selectLeastLoadedHost);
});
