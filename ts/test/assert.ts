import { expect } from "vitest";

type ErrorExpectation = string | RegExp | Error | ((error: unknown) => boolean);

function applyErrorExpectation(error: unknown, expected?: ErrorExpectation): void {
  if (expected === undefined) return;
  if (typeof expected === "string" || expected instanceof RegExp) {
    expect(error instanceof Error ? error.message : String(error)).toMatch(expected);
    return;
  }
  if (expected instanceof Error) {
    expect(error).toEqual(expected);
    return;
  }
  expect(expected(error)).toBe(true);
}

export const assert = {
  equal(actual: unknown, expected: unknown, message?: string): void {
    expect(actual, message).toBe(expected);
  },
  notEqual(actual: unknown, expected: unknown): void {
    expect(actual).not.toBe(expected);
  },
  deepEqual(actual: unknown, expected: unknown): void {
    expect(actual).toEqual(expected);
  },
  ok(actual: unknown): void {
    expect(actual).toBeTruthy();
  },
  match(actual: unknown, expected: string | RegExp): void {
    expect(String(actual)).toMatch(expected);
  },
  notMatch(actual: unknown, expected: string | RegExp): void {
    expect(String(actual)).not.toMatch(expected);
  },
  throws(fn: () => unknown, expected?: ErrorExpectation): void {
    try {
      fn();
    } catch (error) {
      applyErrorExpectation(error, expected);
      return;
    }
    throw new Error("Expected function to throw");
  },
  async rejects(fn: () => unknown | Promise<unknown>, expected?: ErrorExpectation): Promise<void> {
    try {
      await fn();
    } catch (error) {
      applyErrorExpectation(error, expected);
      return;
    }
    throw new Error("Expected promise to reject");
  },
};
