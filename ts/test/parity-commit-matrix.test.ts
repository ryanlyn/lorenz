import { assert } from "./assert.js";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

test("parity audit covers every Elixir commit and capability bucket", () => {
  const inventory = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "docs/parity/elixir-feature-inventory.json"), "utf8"),
  ) as Array<{ capabilityTags: string[] }>;
  const audit = fs.readFileSync(path.join(repoRoot, "docs/parity/COMMIT_AUDIT.md"), "utf8");
  const matrix = fs.readFileSync(path.join(repoRoot, "docs/parity/FEATURE_MATRIX.md"), "utf8");
  const gaps = fs.readFileSync(path.join(repoRoot, "docs/parity/GAPS.md"), "utf8");

  assert.equal(inventory.length, 103);
  assert.equal([...audit.matchAll(/^- \[x\] /gm)].length, 103);
  assert.notMatch(audit, /unreviewed/);

  for (const capability of requiredCapabilities()) {
    assert.match(
      matrix,
      new RegExp(`\\| ${capability} \\|`),
      `missing matrix row for ${capability}`,
    );
  }

  for (const capability of gapCapabilities()) {
    assert.match(gaps, new RegExp(`\\| ${capability} \\|`), `missing gap row for ${capability}`);
    assert.match(
      matrix,
      new RegExp(`\\| ${capability} \\|[^\\n]*\\| partial \\|`),
      `matrix row for ${capability} should be partial while gap is open`,
    );
  }
  assert.notMatch(matrix, /\| gap \|/);
});

function requiredCapabilities(): string[] {
  return [
    "workflow_config",
    "linear_tracker",
    "dispatch_orchestrator",
    "workspace_hooks",
    "ssh_workers",
    "codex_executor",
    "claude_executor",
    "prompting",
    "observability_terminal_tui",
    "observability_web_dashboard",
    "observability_api",
    "runs_cli",
    "live_canaries",
    "packaging_cli",
    "docs_workflows",
    "not_applicable_merge_commit",
  ];
}

function gapCapabilities(): string[] {
  return [];
}
