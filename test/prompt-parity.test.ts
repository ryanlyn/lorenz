import fs from "node:fs/promises";

import { test } from "vitest";
import { buildPrompt } from "@lorenz/cli";
import type { Issue } from "@lorenz/cli";
import { assert } from "@lorenz/test-utils";

interface PromptParityFixture {
  name: string;
  template: string;
  issue: Issue;
  options: {
    attempt?: number | null;
    slotIndex?: number;
    ensembleSize?: number;
  };
  expected: string;
}

test("shared prompt fixtures render with Liquid as expected", async () => {
  const fixtures = JSON.parse(
    await fs.readFile(new URL("./fixtures/prompt-parity.json", import.meta.url), "utf8"),
  ) as PromptParityFixture[];

  for (const fixture of fixtures) {
    const prompt = await buildPrompt(fixture.template, fixture.issue, fixture.options);
    assert.equal(prompt, fixture.expected, fixture.name);
  }
});
