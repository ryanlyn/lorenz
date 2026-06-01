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
 * Default issue-id prefix. {@link BoardStore} mints ids shaped `<prefix><n>` (see
 * {@link BoardStore.nextId}); the prefix is configurable per board (tracker.id_prefix) and
 * defaults to this. Anything not matching `^<prefix>\d+$` - including ids containing path
 * separators, "..", or NUL - is rejected before it can reach the filesystem, closing off path
 * traversal via agent-supplied ids.
 */
export const DEFAULT_ID_PREFIX = "BOARD-";

/**
 * Valid id prefixes: an alphanumeric, then alphanumerics / `_` / `-`. Disallowing `.`, `/`, `\`,
 * whitespace and NUL keeps every minted filename inside the board dir (no traversal) and keeps
 * `<prefix><n>` an unambiguous, safe filename stem. The trailing `-` in "BOARD-" is allowed.
 */
const ID_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Escape a string for safe literal interpolation into a RegExp (the configured prefix). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Throw if `prefix` is not a safe id prefix (letters/digits, then letters/digits/`_`/`-`). */
function assertValidIdPrefix(prefix: string): void {
  if (!ID_PREFIX_PATTERN.test(prefix)) {
    throw new Error(
      `invalid board id_prefix: ${JSON.stringify(prefix)} ` +
        `(must start alphanumeric, then only letters, digits, "_" or "-")`,
    );
  }
}

/**
 * Module-level (process-wide) lock chain keyed by an absolute filesystem path. Because
 * {@link BoardStore} is rebuilt per MCP call (see storeFor), the mutex MUST live at module
 * scope so every instance pointing at the same board file/dir shares the same chain.
 *
 * Each key maps to a promise that resolves when the currently-queued critical sections for
 * that key have finished. {@link withLock} appends its work to the chain so read-modify-write
 * cycles on the same file (or id allocation in the same dir) serialize instead of interleaving
 * and losing an update. This is IN-PROCESS serialization only: it covers concurrent agents and
 * ensemble slots inside the single Symphony daemon, but assumes no external process is editing
 * the board files concurrently (that is out of scope - see ts/README.md).
 */
const pathLocks = new Map<string, Promise<unknown>>();

/**
 * Force a file's CONTENTS to durable storage. The temp/rename and temp/link publish dances are
 * only crash-atomic if the new file's data blocks reach disk BEFORE the directory entry that
 * exposes them: otherwise a power-loss can leave a published BOARD-<n>.md whose name is visible
 * but whose contents are still buffered (zero-length or truncated) - the exact "empty/partial
 * file" failure the atomic publish is meant to prevent. fsync the data first, then the dir entry.
 */
async function fsyncFile(filePath: string): Promise<void> {
  const fh = await fs.open(filePath, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Force a DIRECTORY entry to durable storage so a freshly-published (renamed/linked) file is
 * guaranteed to survive a crash. Directory fsync is a best-effort durability barrier: some
 * platforms (notably Windows) cannot fsync a directory handle and reject with EINVAL/EISDIR/
 * EPERM/EBADF/ENOTSUP/EACCES. Those are swallowed - the data fsync above already protects the
 * contents, and the OS will flush the entry on its own schedule - but unexpected errors propagate.
 */
async function fsyncDir(dirPath: string): Promise<void> {
  let fh: Awaited<ReturnType<typeof fs.open>>;
  try {
    fh = await fs.open(dirPath, "r");
  } catch (err) {
    if (isUnsupportedDirSync((err as NodeJS.ErrnoException).code)) return;
    throw err;
  }
  try {
    await fh.sync();
  } catch (err) {
    if (!isUnsupportedDirSync((err as NodeJS.ErrnoException).code)) throw err;
  } finally {
    await fh.close();
  }
}

/** Platforms that cannot fsync a directory handle reject with one of these; treat as a no-op. */
function isUnsupportedDirSync(code: string | undefined): boolean {
  return (
    code === "EINVAL" ||
    code === "EISDIR" ||
    code === "EPERM" ||
    code === "EBADF" ||
    code === "ENOTSUP" ||
    code === "EACCES"
  );
}

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = pathLocks.get(key) ?? Promise.resolve();
  // Run fn after the prior holder settles. Always continue (.then with both handlers) so one
  // critical section's failure cannot poison the next caller's turn.
  const run = prior.then(fn, fn);
  // The tail is what later callers wait on; its settled value/error is intentionally discarded.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  pathLocks.set(key, tail);
  try {
    return await run;
  } finally {
    // Once this is the last queued work for the key, drop it so the Map cannot grow unbounded.
    if (pathLocks.get(key) === tail) pathLocks.delete(key);
  }
}

/**
 * The agent-facing read view of a single board issue. Returned by {@link BoardStore.readContent}
 * so a worker can read back an issue's current status, title, description, AND the comments it (or
 * the operator) has appended - symmetric with the write tools (updateStatus/appendComment/create).
 * `comments` is the list of individual "- ..." lines from the issue's "## Comments" section, with
 * an empty array when the issue has no comments yet.
 */
export interface BoardIssueContent {
  id: string;
  status: string;
  title: string;
  description: string;
  comments: string[];
}

/** A board file that {@link BoardStore.list} could not parse, surfaced rather than hidden. */
export interface SkippedBoardFile {
  /** The id derived from the filename (e.g. "BOARD-2"), even if its contents are invalid. */
  id: string;
  /** Human-readable reason the file was skipped (missing status, unparseable YAML, etc.). */
  error: string;
}

export interface BoardStoreOptions {
  /**
   * Invoked once per board file that fails to parse during a bulk {@link BoardStore.list}
   * (and the {@link BoardStore.byStatus} / candidate flows built on it). A single bad file is
   * skipped so it cannot starve the rest of the board, but it is reported here so the problem
   * is observable instead of silently swallowed. Explicit {@link BoardStore.getByIds} lookups
   * stay strict and throw rather than routing through this callback.
   */
  onSkip?: (skip: SkippedBoardFile) => void;
  /**
   * Issue-id prefix for this board (e.g. `"BOARD-"`, `"XXX-"`). Ids are `<prefix><n>`; only
   * `<prefix><n>.md` files are treated as issues, and new ids are minted with this prefix.
   * Defaults to {@link DEFAULT_ID_PREFIX}. Must be filesystem-safe (see {@link assertValidIdPrefix});
   * an invalid prefix throws from the constructor.
   */
  idPrefix?: string;
}

export class BoardStore {
  private readonly onSkip: ((skip: SkippedBoardFile) => void) | undefined;
  private readonly idPrefix: string;
  /** `^<prefix>\d+$` - the canonical id shape this board mints and accepts. */
  private readonly idPattern: RegExp;

  constructor(
    private readonly dir: string,
    options: BoardStoreOptions = {},
  ) {
    this.onSkip = options.onSkip;
    this.idPrefix = options.idPrefix ?? DEFAULT_ID_PREFIX;
    assertValidIdPrefix(this.idPrefix);
    this.idPattern = new RegExp(`^${escapeRegExp(this.idPrefix)}\\d+$`);
  }

  async list(): Promise<Issue[]> {
    const ids = await this.issueIds();
    const out: Issue[] = [];
    for (const id of ids) {
      try {
        out.push(await this.read(id));
      } catch (err) {
        // One malformed/unreadable file must not abort the whole listing (and, via the
        // runtime, the poll). Skip it but surface the reason through onSkip so it is visible.
        this.onSkip?.({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }

  async getByIds(ids: string[]): Promise<Issue[]> {
    for (const id of ids) this.assertValidId(id);
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
    this.assertValidId(id);
    const trimmed = status.trim();
    // Reject an empty/whitespace-only status BEFORE writing: a blank status produces a file
    // that parse() rejects as "missing required 'status'", which would silently drop the issue
    // from list(). Failing fast here leaves the file (and its prior status) intact.
    if (trimmed === "") throw new Error(`board issue ${id} status must not be empty`);
    // Serialize the read-modify-write per target file (module-level lock) so a concurrent
    // appendComment/updateStatus on the same issue cannot read-then-clobber and lose an update.
    return withLock(this.filePath(id), async () => {
      const parsed = await this.parse(id);
      parsed.status = trimmed;
      await this.write(id, parsed);
      return this.read(id);
    });
  }

  async appendComment(id: string, body: string, now: () => Date = () => new Date()): Promise<void> {
    this.assertValidId(id);
    // Same per-file lock as updateStatus: the parse -> append -> write cycle must be atomic with
    // respect to other mutations of this issue, otherwise concurrent comments overwrite each other.
    await withLock(this.filePath(id), async () => {
      const parsed = await this.parse(id);
      const line = `- ${now().toISOString()} agent: ${body}`;
      parsed.comments = parsed.comments ? `${parsed.comments}\n${line}` : line;
      await this.write(id, parsed);
    });
  }

  /**
   * Agent-facing read of a single issue's content: its current status, title, description, and the
   * comments appended to it. Symmetric with the write methods so a worker can read back what it (or
   * the operator) wrote. Validates the id and reads/parses the file via the same parse() the write
   * paths use, so a missing/invalid id throws exactly as getByIds/updateStatus do. The "## Comments"
   * block is split into individual "- ..." entries (empty array when the issue has no comments).
   */
  async readContent(id: string): Promise<BoardIssueContent> {
    this.assertValidId(id);
    const parsed = await this.parse(id);
    const comments = parsed.comments.trim() === "" ? [] : parsed.comments.split("\n");
    return {
      id,
      status: parsed.status,
      title: parsed.title,
      description: parsed.description,
      comments,
    };
  }

  async create(input: { title: string; body?: string; status?: string }): Promise<Issue> {
    const parsed: ParsedFile = {
      status: input.status ?? "Todo",
      labels: [],
      title: input.title,
      description: input.body ?? "",
      comments: "",
    };
    const contents = this.render(parsed);
    // Serialize id allocation per board DIRECTORY under the same module-level lock so concurrent
    // creates in one daemon do not all scan the same nextId in lockstep. The no-overwrite link
    // below is still the authoritative guard (it also defends against any external writer), so the
    // lock is an optimization that also keeps the bounded retry loop from churning.
    return withLock(path.resolve(this.dir), async () => {
      // ensureBoardDir MUST run inside the per-directory lock. On a first-run board the chain is
      // created by mkdir(recursive), and fs.mkdir returns only the topmost level THIS call observed
      // as newly-created. Two concurrent first-run creates can interleave inside Node's recursive
      // mkdir so each sees a different topmost-created level and fsyncs only its own slice of the
      // chain - with no happens-before barrier guaranteeing the slice covering the upper parents is
      // durable before the other caller publishes its file. Serializing ensureBoardDir under the
      // same lock as the publish makes exactly one create build AND fully fsync the new chain before
      // any racing create observes the dir as existing (mkdir returns undefined) and links its file.
      await this.ensureBoardDir();
      // Crash-atomic publish: write the full contents to a sibling TEMP file first, then PUBLISH
      // it to the final BOARD-<n>.md with a no-overwrite hard link. fs.link is atomic and fails
      // with EEXIST if the target already exists, so it is collision-safe (two racing creates can
      // never pick the same BOARD-<n>, and an external writer is still defended against) AND
      // crash-safe (a process death mid-write leaves only the ignored temp, never a truncated
      // <prefix><n>.md - issueIds() filters to ^<prefix>\d+$ so the dotted temp is invisible). On
      // EEXIST we recompute nextId and retry the link, reusing the same fully-written temp file.
      //
      // The temp name is NOT a "<prefix><n>.md" stem (it is dotted and ends in .tmp) so it is never
      // mistaken for an issue; the id is not part of the name because one temp serves every retry.
      const tmp = path.join(
        this.dir,
        `.symphony-create.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
      );
      try {
        await fs.writeFile(tmp, contents, "utf8");
        // Flush the temp's CONTENTS to disk before publishing its directory entry. Otherwise a
        // crash after fs.link could leave a named BOARD-<n>.md whose data is still buffered (i.e.
        // an empty/partial file) - the very failure the temp+link publish is meant to rule out.
        await fsyncFile(tmp);
        // Allocate an id with a no-overwrite link so two racing creates can never publish over the
        // same BOARD-<n>. On collision (EEXIST) we recompute the next id and retry within a bounded
        // loop rather than blindly overwriting an existing issue file.
        const attempts = 64;
        for (let attempt = 0; attempt < attempts; attempt++) {
          const id = await this.nextId();
          const target = this.filePath(id);
          try {
            await fs.link(tmp, target);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
            throw err;
          }
          // The new directory entry must itself be durable, or a crash could lose the just-linked
          // name even though its (already-fsynced) contents are safe. Flush the dir, then read back.
          await fsyncDir(this.dir);
          return await this.read(id);
        }
        throw new Error(`failed to allocate a board id after ${attempts} attempts`);
      } finally {
        // Always drop the temp (success or failure). A leftover is harmless - issueIds() ignores
        // it - but removing it keeps the board dir clean. force:true so a never-created temp is fine.
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
    });
  }

  /**
   * Create the board directory durably so a freshly-created board survives a crash. mkdir alone
   * is not enough: fsyncing this.dir after publishing a file persists the entries INSIDE it, but
   * NOT the directory entry in the PARENT that makes a newly-created board dir reachable. On a
   * first-run board (the .symphony/local path did not exist) a crash right after create() could
   * otherwise lose the entire new directory and the acknowledged issue even though the file and
   * the board dir were synced.
   *
   * fs.mkdir(dir, { recursive: true }) returns the path of the FIRST (topmost) directory it
   * actually created, or undefined when nothing was created (the dir already existed). When it
   * created something, every directory along the chain from that topmost-created dir down to (and
   * including) this.dir is brand new, and each gained a new child entry in its own parent. To make
   * the whole chain reachable we fsync each parent that gained a new entry: path.dirname(topmost)
   * (the pre-existing parent that gained the top new dir) plus every newly-created directory from
   * the topmost down to - but NOT including - this.dir (this.dir's own entry is fsynced by the
   * existing post-publish fsyncDir(this.dir), which persists the new FILE entry inside it). When
   * nothing was created (dir already existed) there is no parent entry to flush. fsyncDir is
   * best-effort (it swallows dir-fsync-unsupported errors), so platforms that cannot fsync a dir
   * handle are unaffected.
   */
  private async ensureBoardDir(): Promise<void> {
    const firstCreated = await fs.mkdir(this.dir, { recursive: true });
    if (!firstCreated) return;
    // Every directory that gained a NEW child entry along the freshly-created chain must be
    // fsynced so the chain is reachable. Those are exactly the parents of each newly-created
    // directory: path.dirname(top) (the pre-existing dir that gained `top`) through to
    // path.dirname(this.dir) (the last new dir above this.dir). We walk UP from this.dir's parent
    // and stop after flushing path.dirname(top). this.dir itself is intentionally skipped - its
    // own entry is persisted by the post-publish fsyncDir(this.dir) that flushes the new file.
    const top = path.resolve(firstCreated);
    const stop = path.dirname(top);
    let parent = path.dirname(path.resolve(this.dir));
    // Guard against an unexpected loop at a filesystem root (path.dirname("/") === "/").
    while (true) {
      await fsyncDir(parent);
      if (parent === stop) break;
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }

  private filePath(id: string): string {
    this.assertValidId(id);
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
    } catch (err) {
      // A MISSING board directory is a legitimately empty board: return [] so list()/byStatus()/
      // fetchCandidateIssues report no issues. But any OTHER failure (EACCES on a locked-down dir,
      // ENOTDIR when the path points at a file, etc.) means the board is misconfigured or broken,
      // and silently returning [] would make it look idle - hiding the operator action needed.
      // Re-throw with the dir in the message so the runtime poll-loop guard records a poll_error
      // (it catches throws from fetchCandidateIssues, logs, and keeps the daemon alive) instead of
      // swallowing the failure.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`failed to read board directory ${JSON.stringify(this.dir)}: ${reason}`, {
        cause: err,
      });
    }
    return (
      entries
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.slice(0, -3))
        // Keep ONLY canonical board ids (the same shape filePath/assertValidId enforce). Stray
        // markdown files (README.md, notes.md) and files with a different prefix are not board
        // issues, so ignoring them here keeps list()/getByIds()/byStatus() clean AND prevents
        // nextId() from feeding a non-matching stem into boardNumber() (whose MAX_SAFE_INTEGER
        // fallback would otherwise blow up id allocation).
        .filter((id) => this.idPattern.test(id))
        .sort((a, b) => this.boardNumber(a) - this.boardNumber(b))
    );
  }

  private async nextId(): Promise<string> {
    let max = 0;
    for (const id of await this.issueIds()) max = Math.max(max, this.boardNumber(id));
    return `${this.idPrefix}${max + 1}`;
  }

  private async read(id: string): Promise<Issue> {
    const parsed = await this.parse(id);
    const stat = await fs.stat(this.filePath(id));
    // normalizeIssue requires a stateType. Map known statuses and fall back to "backlog"
    // for custom/free-form board statuses so an unrecognized status never crashes the read.
    const stateType = defaultStateType(parsed.status) ?? "backlog";
    return normalizeIssue({
      id,
      identifier: id,
      title: parsed.title.trim() === "" ? id : parsed.title,
      description: parsed.description === "" ? null : parsed.description,
      state: parsed.status,
      state_type: stateType,
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
   * The contents are fsync'd before the rename and the directory after it, so the rename cannot
   * expose a name whose data has not yet reached disk (which would otherwise read back empty).
   */
  private async write(id: string, p: ParsedFile): Promise<void> {
    await this.ensureBoardDir();
    const target = this.filePath(id);
    const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.writeFile(tmp, this.render(p), "utf8");
      await fsyncFile(tmp);
      await fs.rename(tmp, target);
      await fsyncDir(this.dir);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /** Reject any id not matching this board's `^<prefix>\d+$` (defends agent-supplied ids). */
  private assertValidId(id: string): void {
    if (!this.idPattern.test(id)) {
      throw new Error(
        `invalid board issue id: ${JSON.stringify(id)} (expected ${this.idPrefix}<n>)`,
      );
    }
  }

  /**
   * Numeric suffix of a canonical id (e.g. "XXX-7" -> 7). Callers pass ids that already matched
   * idPattern, so the slice after the prefix is always digits; the fallback is belt-and-suspenders.
   */
  private boardNumber(id: string): number {
    const n = Number(id.slice(this.idPrefix.length));
    return Number.isInteger(n) ? n : Number.MAX_SAFE_INTEGER;
  }
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
