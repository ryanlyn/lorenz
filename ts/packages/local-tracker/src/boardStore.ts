import { promises as fs } from "node:fs";
import path from "node:path";

import type { Issue } from "@symphony/domain";
import { defaultStateType, normalizeIssue } from "@symphony/issue";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

interface ParsedFile {
  status: string;
  labels: string[];
  title: string;
  description: string;
  comments: string;
}

/**
 * Collision-resistant sentinel that marks the start of the comments section. It sits
 * immediately before the human-readable "## Comments" heading so a description that
 * legitimately contains a "## Comments" heading is never misparsed.
 */
const COMMENTS_MARKER = "<!-- symphony:comments -->";

/**
 * The only id shape {@link BoardStore} ever mints (see {@link BoardStore.nextId}).
 * Anything else - including ids containing path separators, "..", or NUL - is rejected
 * before it can reach the filesystem, closing off path traversal via agent-supplied ids.
 */
const ID_PATTERN = /^BOARD-\d+$/;

export class BoardStore {
  constructor(private readonly dir: string) {}

  async list(): Promise<Issue[]> {
    const ids = await this.issueIds();
    const out: Issue[] = [];
    for (const id of ids) out.push(await this.read(id));
    return out;
  }

  async getByIds(ids: string[]): Promise<Issue[]> {
    for (const id of ids) assertValidId(id);
    const existing = new Set(await this.issueIds());
    const out: Issue[] = [];
    for (const id of ids) if (existing.has(id)) out.push(await this.read(id));
    return out;
  }

  async byStatus(states: string[]): Promise<Issue[]> {
    const wanted = new Set(states.map((s) => s.trim().toLowerCase()));
    return (await this.list()).filter((i) => wanted.has(i.state.trim().toLowerCase()));
  }

  async updateStatus(id: string, status: string): Promise<Issue> {
    assertValidId(id);
    const parsed = await this.parse(id);
    parsed.status = status;
    await this.write(id, parsed);
    return this.read(id);
  }

  async appendComment(id: string, body: string, now: () => Date = () => new Date()): Promise<void> {
    assertValidId(id);
    const parsed = await this.parse(id);
    const line = `- ${now().toISOString()} agent: ${body}`;
    parsed.comments = parsed.comments ? `${parsed.comments}\n${line}` : line;
    await this.write(id, parsed);
  }

  async create(input: { title: string; body?: string; status?: string }): Promise<Issue> {
    const parsed: ParsedFile = {
      status: input.status ?? "Todo",
      labels: [],
      title: input.title,
      description: input.body ?? "",
      comments: "",
    };
    await fs.mkdir(this.dir, { recursive: true });
    const contents = this.render(parsed);
    // Allocate an id with an exclusive create so two racing creates can never pick the
    // same BOARD-<n>. On collision (EEXIST) we recompute the next id and retry within a
    // bounded loop rather than blindly overwriting an existing issue file.
    const attempts = 64;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const id = await this.nextId();
      const target = this.filePath(id);
      try {
        await fs.writeFile(target, contents, { encoding: "utf8", flag: "wx" });
        return await this.read(id);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err;
      }
    }
    throw new Error(`failed to allocate a board id after ${attempts} attempts`);
  }

  private filePath(id: string): string {
    assertValidId(id);
    const resolved = path.resolve(this.dir, `${id}.md`);
    // Defense in depth: even with a valid-looking id, refuse any path that escapes the board dir.
    const base = path.resolve(this.dir);
    if (resolved !== path.join(base, `${id}.md`) || !resolved.startsWith(base + path.sep)) {
      throw new Error(`invalid board issue id: ${JSON.stringify(id)}`);
    }
    return resolved;
  }

  private async issueIds(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    return entries
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort((a, b) => boardNumber(a) - boardNumber(b));
  }

  private async nextId(): Promise<string> {
    let max = 0;
    for (const id of await this.issueIds()) max = Math.max(max, boardNumber(id));
    return `BOARD-${max + 1}`;
  }

  private async read(id: string): Promise<Issue> {
    const parsed = await this.parse(id);
    const stat = await fs.stat(this.filePath(id));
    const stateType = defaultStateType(parsed.status);
    return normalizeIssue({
      id,
      identifier: id,
      title: parsed.title.trim() === "" ? id : parsed.title,
      description: parsed.description === "" ? null : parsed.description,
      state: parsed.status,
      ...(stateType ? { state_type: stateType } : {}),
      labels: parsed.labels,
      created_at: stat.birthtime.toISOString(),
      updated_at: stat.mtime.toISOString(),
    });
  }

  private async parse(id: string): Promise<ParsedFile> {
    const raw = (await fs.readFile(this.filePath(id), "utf8")).replace(/\r\n/g, "\n");
    const { frontmatter, body } = splitFrontmatter(raw);
    const fm = (frontmatter ? parseYaml(frontmatter) : {}) as Record<string, unknown>;
    const status = typeof fm.status === "string" ? fm.status.trim() : "";
    if (status === "") throw new Error(`board issue ${id} is missing required 'status'`);
    const labels = Array.isArray(fm.labels)
      ? fm.labels.filter((l): l is string => typeof l === "string")
      : [];
    return { status, labels, ...splitBody(body) };
  }

  private render(p: ParsedFile): string {
    const fm: Record<string, unknown> = { status: p.status };
    if (p.labels.length > 0) fm.labels = p.labels;
    const sections = [`---\n${stringifyYaml(fm).trimEnd()}\n---`, `# ${p.title}`];
    if (p.description.trim() !== "") sections.push(p.description.trim());
    if (p.comments.trim() !== "")
      sections.push(`${COMMENTS_MARKER}\n## Comments\n${p.comments.trim()}`);
    return `${sections.join("\n\n")}\n`;
  }

  /**
   * Atomic replace: write to a uniquely-named sibling temp file in the SAME directory and
   * fs.rename it over the target. rename is atomic within a filesystem, so a crash mid-write
   * leaves either the prior file or the fully-written new file intact - never a truncated one.
   */
  private async write(id: string, p: ParsedFile): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.filePath(id);
    const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.writeFile(tmp, this.render(p), "utf8");
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
}

function assertValidId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`invalid board issue id: ${JSON.stringify(id)} (expected BOARD-<n>)`);
  }
}

function boardNumber(id: string): number {
  const m = /^BOARD-(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  if (!raw.startsWith("---")) return { frontmatter: null, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: null, body: raw };
  const frontmatter = raw.slice(raw.indexOf("\n") + 1, end);
  const afterClose = raw.indexOf("\n", end + 1);
  const body = afterClose === -1 ? "" : raw.slice(afterClose + 1);
  return { frontmatter, body };
}

function splitBody(body: string): { title: string; description: string; comments: string } {
  const markerIdx = body.indexOf(COMMENTS_MARKER);
  const main = markerIdx === -1 ? body : body.slice(0, markerIdx);
  const comments =
    markerIdx === -1
      ? ""
      : body
          .slice(markerIdx + COMMENTS_MARKER.length)
          .replace(/^\n?## Comments\n?/, "")
          .trim();
  const lines = main.split("\n");
  const headingIdx = lines.findIndex((l) => l.startsWith("# "));
  const title = headingIdx === -1 ? "" : lines[headingIdx]!.slice(2).trim();
  const descLines = headingIdx === -1 ? lines : lines.slice(headingIdx + 1);
  return { title, description: descLines.join("\n").trim(), comments };
}
