import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AgentSettingsPolicyFile = {
  path: string;
  content: string;
};

export type AgentSettingsPolicyViolation = {
  path: string;
  kind: "broad-home-read" | "wildcard-shell";
  detail: string;
};

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

const settingsPathPatterns = [
  /^\.claude\/settings(?:\.local)?\.json$/,
  /^\.codex\/[^/]*(?:config|settings)[^/]*\.(?:json|toml|ya?ml)$/i,
];

const broadHomeReadPattern =
  /\bRead\(\s*(?:(?:\/\/|\/)Users\/[^/)]+\/\*\*|\/home\/[^/)]+\/\*\*|~\/\*\*|\$HOME\/\*\*)/;
const wildcardShellPattern = /\bBash\([^)]*:\*\s*\)/;

export function findAgentSettingsPolicyViolations(
  files: AgentSettingsPolicyFile[],
): AgentSettingsPolicyViolation[] {
  const violations: AgentSettingsPolicyViolation[] = [];

  for (const file of files) {
    if (!isAgentSettingsPath(file.path)) continue;

    file.content.split(/\r?\n/).forEach((line, index) => {
      if (broadHomeReadPattern.test(line)) {
        violations.push({
          path: file.path,
          kind: "broad-home-read",
          detail: `line ${index + 1}: broad home-directory read permissions are not allowed`,
        });
      }

      if (wildcardShellPattern.test(line)) {
        violations.push({
          path: file.path,
          kind: "wildcard-shell",
          detail: `line ${index + 1}: wildcard shell permissions are not allowed`,
        });
      }
    });
  }

  return violations;
}

export function readTrackedAgentSettingsFiles(root = repoRoot): AgentSettingsPolicyFile[] {
  const trackedFiles = execFileSync("git", ["ls-files", "-z", "--", ".claude", ".codex"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .filter(isAgentSettingsPath);

  return trackedFiles.map((trackedPath) => ({
    path: trackedPath,
    content: fs.readFileSync(path.join(root, trackedPath), "utf8"),
  }));
}

function isAgentSettingsPath(filePath: string): boolean {
  const normalizedPath = filePath.split(path.sep).join("/");

  if (
    normalizedPath === ".lorenz/skills" ||
    normalizedPath.startsWith(".lorenz/skills/")
  ) {
    return false;
  }

  return settingsPathPatterns.some((pattern) => pattern.test(normalizedPath));
}

function runCli(): void {
  const violations = findAgentSettingsPolicyViolations(readTrackedAgentSettingsFiles());

  if (violations.length === 0) return;

  for (const violation of violations) {
    console.error(`${violation.path}: ${violation.detail}`);
  }

  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runCli();
}
