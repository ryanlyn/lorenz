import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { sanitizeTerminalText, stripAnsiSequences, truncateTerminalText } from "@lorenz/humanize";

test("sanitizeTerminalText strips ANSI control and escape sequences", () => {
  const value = ["\x1b[38;5;196mred\x1b[0m", "\x1b[2Jcleared\x1b[2K", "\x1bMindexed"].join("");

  assert.equal(sanitizeTerminalText(value), "redclearedindexed");
});

test("stripAnsiSequences preserves surrounding whitespace", () => {
  assert.equal(stripAnsiSequences(" \x1b[31mred\x1b[0m "), " red ");
});

test("sanitizeTerminalText removes every ASCII control character", () => {
  const controls =
    Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join("") +
    String.fromCharCode(127);

  assert.equal(sanitizeTerminalText(`before${controls}after`), "beforeafter");
});

test("sanitizeTerminalText preserves trimming behavior", () => {
  assert.equal(sanitizeTerminalText(" \t value \n"), "value");
  assert.equal(sanitizeTerminalText(" ordinary [31m text "), "ordinary [31m text");
});

test("truncateTerminalText preserves short-limit behavior", () => {
  assert.equal(truncateTerminalText("abcdef", 0), "...");
  assert.equal(truncateTerminalText("abcdef", 1), "...");
  assert.equal(truncateTerminalText("abcdef", 2), "...");
  assert.equal(truncateTerminalText("abcdef", 3), "...");
  assert.equal(truncateTerminalText("abcdef", 4), "a...");
});

test("truncateTerminalText preserves exact-boundary output", () => {
  assert.equal(truncateTerminalText("abcd", 4), "abcd");
  assert.equal(truncateTerminalText("abc", 4), "abc");
});
