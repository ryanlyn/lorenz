import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

export async function writeExecutable(filePath: string, source: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, source);
  await fs.chmod(filePath, 0o755);
}

export const sampleIssue = {
  id: "issue-1",
  identifier: "MT-1",
  title: "Test issue",
  description: "Ship it",
  state: "Todo",
  stateType: "unstarted" as const,
  labels: ["Lorenz:Backend"],
  blockers: [],
};
