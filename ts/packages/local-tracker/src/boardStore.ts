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

export class BoardStore {
  constructor(private readonly dir: string) {}

  async list(): Promise<Issue[]> {
    const ids = await this.issueIds();
    const out: Issue[] = [];
    for (const id of ids) out.push(await this.read(id));
    return out;
  }

  async getByIds(ids: string[]): Promise<Issue[]> {
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
    const parsed = await this.parse(id);
    parsed.status = status;
    await this.write(id, parsed);
    return this.read(id);
  }

  async appendComment(id: string, body: string, now: () => Date = () => new Date()): Promise<void> {
    const parsed = await this.parse(id);
    const line = `- ${now().toISOString()} agent: ${body}`;
    parsed.comments = parsed.comments ? `${parsed.comments}\n${line}` : line;
    await this.write(id, parsed);
  }

  async create(input: { title: string; body?: string; status?: string }): Promise<Issue> {
    const id = await this.nextId();
    await this.write(id, {
      status: input.status ?? "Todo",
      labels: [],
      title: input.title,
      description: input.body ?? "",
      comments: "",
    });
    return this.read(id);
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.md`);
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

  private async write(id: string, p: ParsedFile): Promise<void> {
    const fm: Record<string, unknown> = { status: p.status };
    if (p.labels.length > 0) fm.labels = p.labels;
    const sections = [`---\n${stringifyYaml(fm).trimEnd()}\n---`, `# ${p.title}`];
    if (p.description.trim() !== "") sections.push(p.description.trim());
    if (p.comments.trim() !== "")
      sections.push(`${COMMENTS_MARKER}\n## Comments\n${p.comments.trim()}`);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.filePath(id), `${sections.join("\n\n")}\n`, "utf8");
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
