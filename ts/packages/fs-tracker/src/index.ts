import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";

import YAML from "yaml";
import { normalizeIssue } from "@symphony/issue";
import type { Issue, RuntimeTrackerClient } from "@symphony/domain";

export interface FsTrackerOptions {
  /** State names considered eligible for dispatch (matched case/separator-insensitively). */
  activeStates?: string[] | undefined;
  /** Assignee identity used to populate {@link Issue.assignedToWorker}. */
  assignee?: string | undefined;
}

/**
 * Read-only tracker backed by Markdown files on the local filesystem. Issues live at
 * `<boardDir>/<state-slug>/<identifier>.md`, where the containing directory names the state and
 * the file is YAML frontmatter plus a markdown body (the issue description). Requires no external
 * service: authoring and state transitions happen by editing or moving files (see the `board` CLI).
 */
export class FsTrackerClient implements RuntimeTrackerClient {
  constructor(
    private readonly boardDir: string,
    private readonly options: FsTrackerOptions = {},
  ) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    const issues = await this.loadIssues();
    const active = (this.options.activeStates ?? []).map(normalizeStateKey);
    if (active.length === 0) return issues;
    const wanted = new Set(active);
    return issues.filter((issue) => wanted.has(normalizeStateKey(issue.state)));
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) return [];
    const issues = await this.loadIssues();
    const byId = new Map(issues.map((issue) => [issue.id, issue]));
    const result: Issue[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const issue = byId.get(id);
      if (issue) result.push(issue);
    }
    return result;
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const issues = await this.loadIssues();
    const wanted = new Set(states.map(normalizeStateKey));
    return issues.filter((issue) => wanted.has(normalizeStateKey(issue.state)));
  }

  private async loadIssues(): Promise<Issue[]> {
    const files = await readBoardFiles(this.boardDir);
    return files.map((file) => boardFileToIssue(file, this.options.assignee));
  }
}

export interface BoardFile {
  /** Absolute or board-relative path to the `.md` file. */
  filePath: string;
  /** Directory name that determines the issue state. */
  stateSlug: string;
  /** Filename without the `.md` extension; used as the identifier when frontmatter omits one. */
  identifier: string;
  data: Record<string, unknown>;
  body: string;
}

/**
 * Lists every issue file under `boardDir`, grouped by state directory. Returns an empty list when
 * the board directory does not exist. Files whose frontmatter cannot be parsed are skipped with a
 * warning so one malformed file cannot stall polling.
 */
export async function readBoardFiles(boardDir: string): Promise<BoardFile[]> {
  let stateDirs: Dirent[];
  try {
    stateDirs = await fs.readdir(boardDir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }

  const files: BoardFile[] = [];
  for (const stateDir of stateDirs) {
    if (!stateDir.isDirectory()) continue;
    const stateSlug = stateDir.name;
    const dir = path.join(boardDir, stateSlug);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const filePath = path.join(dir, entry.name);
      const identifier = entry.name.slice(0, -".md".length);
      try {
        const content = await fs.readFile(filePath, "utf8");
        const { data, body } = parseBoardFile(content);
        files.push({ filePath, stateSlug, identifier, data, body });
      } catch (error) {
        process.stderr.write(`fs-tracker: skipping ${filePath}: ${messageOf(error)}\n`);
      }
    }
  }
  return files;
}

/** Converts a parsed board file into the canonical {@link Issue} via {@link normalizeIssue}. */
export function boardFileToIssue(file: BoardFile, assignee?: string): Issue {
  const data = file.data;
  const frontmatterIdentifier = stringOrUndefined(data.identifier);
  const identifier = frontmatterIdentifier ?? file.identifier;
  const raw: Record<string, unknown> = {
    ...data,
    identifier,
    id: stringOrUndefined(data.id) ?? identifier,
    title: stringOrUndefined(data.title) ?? identifier,
    state: stateDisplayName(file.stateSlug),
    description: stringOrUndefined(data.description) ?? nonEmpty(file.body.trim()),
  };
  if (Array.isArray(data.blockers)) {
    raw.blockers = (data.blockers as unknown[]).map((blocker) =>
      typeof blocker === "string" ? { identifier: blocker } : blocker,
    );
  }
  return normalizeIssue(raw, assignee);
}

/** Splits `---`-fenced YAML frontmatter from the markdown body. */
export function parseBoardFile(content: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return { data: {}, body: content };
  const parsed = YAML.parse(match[1] ?? "") as unknown;
  const data = parsed ?? {};
  if (!isRecord(data)) throw new Error("frontmatter must be a YAML mapping");
  return { data, body: match[2] ?? "" };
}

/** Serializes frontmatter and a body back into board-file form. */
export function serializeBoardFile(data: Record<string, unknown>, body = ""): string {
  const front = YAML.stringify(data).trimEnd();
  const trimmedBody = body.trim();
  return `---\n${front}\n---\n${trimmedBody === "" ? "" : `\n${trimmedBody}\n`}`;
}

/** Converts a state name (e.g. `"In Progress"`) into its directory slug (e.g. `"in-progress"`). */
export function slugifyState(state: string): string {
  return state
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

function stateDisplayName(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function normalizeStateKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function nonEmpty(value: string): string | undefined {
  return value === "" ? undefined : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
