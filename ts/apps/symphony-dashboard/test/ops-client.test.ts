import { afterEach, expect, test, vi } from "vitest";

import { fetchOpsState } from "../src/features/ops/api/client";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("fetchOpsState returns null when the initial state request fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

  await expect(fetchOpsState()).resolves.toBeNull();
});

test("fetchOpsState returns null when the initial state response is invalid JSON", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error("invalid json");
      },
    }),
  );

  await expect(fetchOpsState()).resolves.toBeNull();
});

test("fetchOpsState keeps non-OK responses as null", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      json: vi.fn(),
    }),
  );

  await expect(fetchOpsState()).resolves.toBeNull();
});
