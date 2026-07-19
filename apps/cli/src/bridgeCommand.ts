import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { settingsForIssueState } from "@lorenz/config";
import type { Settings } from "@lorenz/domain";
import { acpAgentOptions, isClaudeCompatibleBridgeCommand } from "@lorenz/acp";

export interface BridgeCommandUse {
  kind: string;
  bridgeCommand: string;
  state?: string | undefined;
}

export interface BridgeCommandRequirements {
  executable: string;
  wrapperExecutable?: string | undefined;
  bridgeTarget?: string | undefined;
}

export interface AgentCliRequirement {
  binary: string;
  executable: string;
  envOverride: string;
  overridden: boolean;
}

export function bridgeCommandRequirements(command: string): BridgeCommandRequirements | null {
  const words = shellWords(command);
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index += 1;
  if (words[index] === "exec") index += 1;
  const wrapperExecutable = isEnvCommand(words[index]) ? words[index] : undefined;
  if (wrapperExecutable !== undefined) {
    const wrappedIndex = envWrappedCommandIndex(words, index + 1);
    if (wrappedIndex === null) return null;
    index = wrappedIndex;
  }
  const executable = words[index];
  if (!executable) return null;
  return {
    executable,
    wrapperExecutable,
    bridgeTarget: nodeBridgeTarget(executable, words[index + 1]),
  };
}

export async function findExecutable(
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (executable.includes("/") || path.isAbsolute(executable)) {
    return (await canExecute(executable)) ? executable : null;
  }
  const pathValue = env.PATH ?? process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    if (await canExecute(candidate)) return candidate;
  }
  return null;
}

export function agentCliRequirement(
  bridgeCommand: string,
  env: NodeJS.ProcessEnv,
): AgentCliRequirement | null {
  if (isClaudeCompatibleBridgeCommand(bridgeCommand)) {
    return agentCliFromEnv("claude", "CLAUDE_CODE_EXECUTABLE", env);
  }
  if (isCodexBridgeCommand(bridgeCommand)) {
    return agentCliFromEnv("codex", "CODEX_PATH", env);
  }
  return null;
}

export function requiredBridgeCommandUses(settings: Settings): BridgeCommandUse[] {
  const uses = new Map<string, BridgeCommandUse>();
  addActiveBridgeCommandUse(uses, settings);

  for (const state of [...settings.statusOverrides.keys()].sort()) {
    addActiveBridgeCommandUse(uses, settingsForIssueState(settings, state), state);
  }

  return [...uses.values()].sort((left, right) =>
    `${left.kind}:${left.state ?? ""}:${left.bridgeCommand}`.localeCompare(
      `${right.kind}:${right.state ?? ""}:${right.bridgeCommand}`,
    ),
  );
}

function envWrappedCommandIndex(words: string[], start: number): number | null {
  let index = start;
  while (index < words.length) {
    const word = words[index]!;
    if (word === "--") return index + 1 < words.length ? index + 1 : null;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index += 1;
      continue;
    }
    if (word === "-" || word === "-0" || word === "-i" || word === "--ignore-environment") {
      index += 1;
      continue;
    }
    if (word === "-u" || word === "--unset" || word === "-C" || word === "--chdir") {
      if (index + 1 >= words.length) return null;
      index += 2;
      continue;
    }
    if (
      (word.startsWith("-u") && word.length > 2) ||
      word.startsWith("--unset=") ||
      word.startsWith("--chdir=")
    ) {
      index += 1;
      continue;
    }
    if (word === "-S" || word === "--split-string" || word.startsWith("--split-string=")) {
      return null;
    }
    if (word.startsWith("-")) return null;
    return index;
  }
  return null;
}

function isEnvCommand(command: string | undefined): command is string {
  if (command === undefined) return false;
  const basename = path.basename(command).toLowerCase();
  return basename === "env" || basename === "env.exe";
}

function nodeBridgeTarget(executable: string, firstArg: string | undefined): string | undefined {
  if (firstArg === undefined || !path.isAbsolute(firstArg)) return undefined;
  const basename = path.basename(executable).toLowerCase();
  return basename === "node" || basename === "node.exe" ? firstArg : undefined;
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  for (const char of command.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

function agentCliFromEnv(
  binary: string,
  envOverride: string,
  env: NodeJS.ProcessEnv,
): AgentCliRequirement {
  const override = nonEmptyEnv(env[envOverride]);
  return {
    binary,
    executable: override ?? binary,
    envOverride,
    overridden: override !== undefined,
  };
}

function isCodexBridgeCommand(bridgeCommand: string): boolean {
  return /(^|\s|\/)codex-acp(\s|$)/.test(bridgeCommand);
}

function nonEmptyEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function addActiveBridgeCommandUse(
  uses: Map<string, BridgeCommandUse>,
  settings: Settings,
  state?: string,
): void {
  const kind = settings.agent.kind;
  const config = settings.agents[kind];
  if (config?.executor !== "acp") return;
  const bridgeCommand = acpAgentOptions(config).bridgeCommand;
  const key = `${kind}\0${bridgeCommand}`;
  if (!uses.has(key)) uses.set(key, { kind, bridgeCommand, state });
}

async function canExecute(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    await fs.access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
