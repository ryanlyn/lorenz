import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { Command } from "commander";
import { parsePositiveInteger, parseRequiredValue } from "@symphony/cli-kit";
import {
  boardFileToIssue,
  readBoardFiles,
  serializeBoardFile,
  slugifyState,
  type BoardFile,
} from "@symphony/fs-tracker";
import { loadWorkflow } from "@symphony/workflow";

import { runtimeDefaultSettings, runtimeDefaultSettingsOptions } from "./daemon.js";

export interface BoardNewInput {
  title: string;
  state: string;
  labels: string[];
  priority: number | null;
  description: string | null;
  id: string | null;
  identifier: string | null;
  prefix: string;
}

/** Creates a new board issue file under `<boardDir>/<state-slug>/<identifier>.md`. */
export async function boardNew(
  boardDir: string,
  input: BoardNewInput,
): Promise<{ identifier: string; filePath: string }> {
  const stateSlug = slugifyState(input.state);
  const dir = path.join(boardDir, stateSlug);
  await fs.mkdir(dir, { recursive: true });

  const files = await readBoardFiles(boardDir);
  const identifier = input.identifier ?? nextIdentifier(input.prefix, files);
  const filePath = path.join(dir, `${identifier}.md`);
  if (await pathExists(filePath)) throw new Error(`board issue already exists: ${identifier}`);

  const data: Record<string, unknown> = {
    id: input.id ?? randomUUID(),
    identifier,
    title: input.title,
  };
  if (input.labels.length > 0) data.labels = input.labels;
  if (input.priority !== null) data.priority = input.priority;

  await fs.writeFile(filePath, serializeBoardFile(data, input.description ?? ""), "utf8");
  return { identifier, filePath };
}

/** Moves an existing board issue into a different state directory. */
export async function boardMove(
  boardDir: string,
  identifier: string,
  state: string,
): Promise<{ from: string; to: string }> {
  const files = await readBoardFiles(boardDir);
  const file = files.find((candidate) => matchesIdentifier(candidate, identifier));
  if (!file) throw new Error(`board issue not found: ${identifier}`);

  const targetSlug = slugifyState(state);
  if (file.stateSlug === targetSlug) return { from: file.stateSlug, to: targetSlug };

  const dir = path.join(boardDir, targetSlug);
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, path.basename(file.filePath));
  if (await pathExists(dest)) {
    throw new Error(`board issue already exists in ${targetSlug}: ${identifier}`);
  }
  await fs.rename(file.filePath, dest);
  return { from: file.stateSlug, to: targetSlug };
}

/** Renders board issues grouped by state, optionally filtered to one state. */
export async function boardList(boardDir: string, stateFilter: string | null): Promise<string> {
  const wanted = stateFilter ? slugifyState(stateFilter) : null;
  const files = (await readBoardFiles(boardDir))
    .filter((file) => (wanted ? file.stateSlug === wanted : true))
    .sort(
      (a, b) => a.stateSlug.localeCompare(b.stateSlug) || a.identifier.localeCompare(b.identifier),
    );

  if (files.length === 0) {
    return wanted ? `No issues in ${wanted}.\n` : "No board issues found.\n";
  }

  const lines: string[] = [];
  let currentState: string | null = null;
  for (const file of files) {
    if (file.stateSlug !== currentState) {
      if (currentState !== null) lines.push("");
      lines.push(`${file.stateSlug}`);
      currentState = file.stateSlug;
    }
    const issue = boardFileToIssue(file);
    const labels = issue.labels.length > 0 ? `  [${issue.labels.join(", ")}]` : "";
    lines.push(`  ${issue.identifier}  ${issue.title}${labels}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Resolves the board directory: explicit flag, then `SYMPHONY_BOARD_DIR`, then the workflow's
 * configured `tracker.board_dir`, falling back to the default when no workflow file is present.
 */
export async function resolveBoardDir(
  explicit: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (explicit) return path.resolve(explicit);
  const fromEnv = env.SYMPHONY_BOARD_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  try {
    const workflow = await loadWorkflow(undefined, env, runtimeDefaultSettingsOptions());
    if (workflow.settings.tracker.boardDir) return workflow.settings.tracker.boardDir;
  } catch {
    // No workflow file: fall back to defaults below.
  }
  return runtimeDefaultSettings().tracker.boardDir ?? path.resolve(".symphony/board");
}

export function createBoardCommand(name = "symphony-ts board"): Command {
  const board = new Command(name)
    .description("Manage the local filesystem issue board.")
    .allowExcessArguments(false);

  board
    .command("new")
    .description("Create a new board issue.")
    .requiredOption("--title <title>", "Issue title.", parseRequiredValue("--title", "title"))
    .option("--state <state>", "Initial state (directory).", parseRequiredValue("--state"), "todo")
    .option("--label <label>", "Label (repeatable).", collectLabel, [])
    .option("--priority <n>", "Priority.", parsePositiveInteger("--priority"))
    .option("--description <text>", "Description body.", parseRequiredValue("--description"))
    .option("--id <id>", "Explicit issue id.", parseRequiredValue("--id"))
    .option("--identifier <id>", "Explicit identifier.", parseRequiredValue("--identifier"))
    .option("--prefix <prefix>", "Identifier prefix.", parseRequiredValue("--prefix"), "BOARD")
    .option("--board-dir <path>", "Board directory.", parseRequiredValue("--board-dir", "path"))
    .action(async (options: BoardNewCommanderOptions) => {
      const boardDir = await resolveBoardDir(options.boardDir ?? null);
      const created = await boardNew(boardDir, {
        title: options.title,
        state: options.state ?? "todo",
        labels: options.label ?? [],
        priority: options.priority ?? null,
        description: options.description ?? null,
        id: options.id ?? null,
        identifier: options.identifier ?? null,
        prefix: options.prefix ?? "BOARD",
      });
      process.stdout.write(`Created ${created.identifier} at ${created.filePath}\n`);
    });

  board
    .command("move")
    .description("Move a board issue to another state.")
    .argument("<identifier>", "Issue identifier.")
    .argument("<state>", "Target state (directory).")
    .option("--board-dir <path>", "Board directory.", parseRequiredValue("--board-dir", "path"))
    .action(async (identifier: string, state: string, options: BoardDirOption) => {
      const boardDir = await resolveBoardDir(options.boardDir ?? null);
      const moved = await boardMove(boardDir, identifier, state);
      process.stdout.write(`Moved ${identifier}: ${moved.from} -> ${moved.to}\n`);
    });

  board
    .command("list")
    .description("List board issues grouped by state.")
    .option("--state <state>", "Filter by state.", parseRequiredValue("--state"))
    .option("--board-dir <path>", "Board directory.", parseRequiredValue("--board-dir", "path"))
    .action(async (options: BoardListCommanderOptions) => {
      const boardDir = await resolveBoardDir(options.boardDir ?? null);
      process.stdout.write(await boardList(boardDir, options.state ?? null));
    });

  return board;
}

interface BoardDirOption {
  boardDir?: string;
}

interface BoardNewCommanderOptions extends BoardDirOption {
  title: string;
  state?: string;
  label?: string[];
  priority?: number;
  description?: string;
  id?: string;
  identifier?: string;
  prefix?: string;
}

interface BoardListCommanderOptions extends BoardDirOption {
  state?: string;
}

function collectLabel(value: string, previous: string[]): string[] {
  return [...previous, parseRequiredValue("--label", "label")(value)];
}

function nextIdentifier(prefix: string, files: BoardFile[]): string {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)$`, "i");
  let max = 0;
  for (const file of files) {
    const identifier =
      typeof file.data.identifier === "string" ? file.data.identifier : file.identifier;
    const match = pattern.exec(identifier);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${max + 1}`;
}

function matchesIdentifier(file: BoardFile, identifier: string): boolean {
  const target = identifier.trim().toLowerCase();
  const frontmatter =
    typeof file.data.identifier === "string" ? file.data.identifier.toLowerCase() : null;
  return file.identifier.toLowerCase() === target || frontmatter === target;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
