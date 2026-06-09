import { test } from "vitest";

import { assert } from "../../../test/assert.js";
import { toToml } from "../src/toml.js";

test("toToml quotes literal keys and section names that are not bare TOML keys", () => {
  const toml = toToml({
    "bad key": "space",
    "bracket[key]": "bracket",
    "model.provider": "literal",
    'quoted"key': "quote",
    nested: {
      "child.key": "nested literal",
      plain: true,
    },
    "section.with.dot": {
      "inner key": 42,
    },
    'section"quote': {
      "inner[bracket]": false,
    },
  });

  assert.match(toml, /"bad key" = "space"/);
  assert.match(toml, /"bracket\[key\]" = "bracket"/);
  assert.match(toml, /"model.provider" = "literal"/);
  assert.match(toml, /"quoted\\"key" = "quote"/);
  assert.match(toml, /\[nested\]/);
  assert.match(toml, /"child.key" = "nested literal"/);
  assert.match(toml, /plain = true/);
  assert.match(toml, /\["section.with.dot"\]/);
  assert.match(toml, /"inner key" = 42/);
  assert.match(toml, /\["section\\"quote"\]/);
  assert.match(toml, /"inner\[bracket\]" = false/);
  assert.deepEqual(parseGeneratedToml(toml), {
    "bad key": "space",
    "bracket[key]": "bracket",
    "model.provider": "literal",
    'quoted"key': "quote",
    nested: {
      "child.key": "nested literal",
      plain: true,
    },
    "section.with.dot": {
      "inner key": 42,
    },
    'section"quote': {
      "inner[bracket]": false,
    },
  });
});

test("toToml rejects keys that cannot be safely represented", () => {
  assert.throws(() => toToml({ "bad\nkey": "value" }), /TOML key cannot contain newline/);
});

function parseGeneratedToml(toml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let current = result;
  for (const rawLine of toml.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      current = result;
      for (const segment of parseDottedKey(line.slice(1, -1))) {
        const value = current[segment];
        if (isRecord(value)) {
          current = value;
          continue;
        }
        const nested: Record<string, unknown> = {};
        current[segment] = nested;
        current = nested;
      }
      continue;
    }
    const [rawKey, rawValue] = splitAssignment(line);
    setDottedValue(current, parseDottedKey(rawKey), parseTomlValue(rawValue));
  }
  return result;
}

function setDottedValue(target: Record<string, unknown>, keys: string[], value: unknown): void {
  let current = target;
  for (const [index, key] of keys.entries()) {
    if (index === keys.length - 1) {
      current[key] = value;
      return;
    }
    const existing = current[key];
    if (isRecord(existing)) {
      current = existing;
      continue;
    }
    const nested: Record<string, unknown> = {};
    current[key] = nested;
    current = nested;
  }
}

function splitAssignment(line: string): [string, string] {
  const index = line.indexOf(" = ");
  if (index === -1) throw new Error(`Invalid assignment: ${line}`);
  return [line.slice(0, index), line.slice(index + 3)];
}

function parseDottedKey(input: string): string[] {
  const keys: string[] = [];
  let index = 0;
  while (index < input.length) {
    if (input[index] === '"') {
      const end = findQuotedKeyEnd(input, index);
      if (end === -1) throw new Error(`Invalid quoted key: ${input}`);
      keys.push(JSON.parse(input.slice(index, end + 1)) as string);
      index = end + 1;
    } else {
      const end = input.indexOf(".", index);
      keys.push(input.slice(index, end === -1 ? input.length : end));
      index = end === -1 ? input.length : end;
    }
    if (input[index] === ".") index += 1;
  }
  return keys;
}

function findQuotedKeyEnd(input: string, start: number): number {
  for (let index = start + 1; index < input.length; index += 1) {
    if (input[index] === "\\" && index + 1 < input.length) {
      index += 1;
      continue;
    }
    if (input[index] === '"') return index;
  }
  return -1;
}

function parseTomlValue(rawValue: string): unknown {
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  const numberValue = Number(rawValue);
  if (!Number.isNaN(numberValue)) return numberValue;
  return JSON.parse(rawValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
