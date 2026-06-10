import { describe, expect, test } from "vitest";

import { findAgentSettingsPolicyViolations } from "../scripts/check-agent-settings-policy";

describe("agent settings policy", () => {
  test("flags broad home-directory reads in committed agent settings", () => {
    const violations = findAgentSettingsPolicyViolations([
      {
        path: ".claude/settings.local.json",
        content: JSON.stringify({
          permissions: {
            allow: ["Read(//Users/ryan/**)"],
          },
        }),
      },
    ]);

    expect(violations).toContainEqual(
      expect.objectContaining({
        kind: "broad-home-read",
        path: ".claude/settings.local.json",
      }),
    );
  });

  test("flags wildcard shell permissions in committed agent settings", () => {
    const violations = findAgentSettingsPolicyViolations([
      {
        path: ".claude/settings.local.json",
        content: JSON.stringify({
          permissions: {
            allow: ["Bash(ln:*)"],
          },
        }),
      },
    ]);

    expect(violations).toContainEqual(
      expect.objectContaining({
        kind: "wildcard-shell",
        path: ".claude/settings.local.json",
      }),
    );
  });

  test("ignores committed skill files", () => {
    const violations = findAgentSettingsPolicyViolations([
      {
        path: ".codex/skills/symphony-land/SKILL.md",
        content: "Use `Bash(ln:*)` only as an example.",
      },
      {
        path: ".claude/skills",
        content: "Tracked skill marker.",
      },
    ]);

    expect(violations).toEqual([]);
  });
});
