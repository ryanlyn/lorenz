// Markdown -> Atlassian Document Format (ADF) for Jira comment/description bodies.
// The Jira REST API only accepts ADF, but callers author markdown. Supports headings,
// bullet/ordered lists, GitHub task lists (- [ ] / - [x]) with nesting, fenced code
// blocks, pipe tables (header + |---| separator), and inline marks (**bold**,
// *italic*/_italic_, `code`, [text](url)).
export function markdownToAdf(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  const content: Record<string, unknown>[] = [];
  const localIds = { value: 0 };
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++;
      content.push(codeBlock(codeLines.join("\n"), lang));
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      content.push({
        type: "heading",
        attrs: { level: headingMatch[1]!.length },
        content: inlineNodes(headingMatch[2]!),
      });
      i++;
      continue;
    }

    if (listKindOf(line) !== null) {
      const [list, next] = buildList(lines, i, localIds);
      content.push(list);
      i = next;
      continue;
    }

    if (isTableRow(line) && isTableSeparator(lines[i + 1])) {
      const [table, next] = buildTable(lines, i);
      content.push(table);
      i = next;
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    content.push({ type: "paragraph", content: inlineNodes(line) });
    i++;
  }

  // ADF rejects an empty doc; ensure at least one block.
  if (content.length === 0) content.push({ type: "paragraph", content: [] });
  return { type: "doc", version: 1, content };
}

type ListKind = "bulletList" | "orderedList" | "taskList";

// Task lists are checked before bullets because "- [ ] x" also matches the bullet pattern.
function listKindOf(line: string): ListKind | null {
  if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(line)) return "taskList";
  if (/^\s*[-*]\s+/.test(line)) return "bulletList";
  if (/^\s*\d+[.)]\s+/.test(line)) return "orderedList";
  return null;
}

function listLine(line: string, kind: ListKind): { indent: number; text: string; done: boolean } {
  if (kind === "taskList") {
    const m = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.+)$/)!;
    return { indent: m[1]!.length, text: m[3]!, done: m[2]!.toLowerCase() === "x" };
  }
  const m = line.match(kind === "bulletList" ? /^(\s*)[-*]\s+(.+)$/ : /^(\s*)\d+[.)]\s+(.+)$/)!;
  return { indent: m[1]!.length, text: m[2]!, done: false };
}

// Builds one list starting at lines[start]. Items at the same indent join this list; a
// deeper-indented run nests inside the preceding item (bullet/ordered) or as a nested
// taskList (task lists, whose ADF schema only allows taskItem/taskList children).
function buildList(
  lines: string[],
  start: number,
  localIds: { value: number },
): [Record<string, unknown>, number] {
  const kind = listKindOf(lines[start]!)!;
  const baseIndent = listLine(lines[start]!, kind).indent;
  const items: Record<string, unknown>[] = [];
  let i = start;

  while (i < lines.length) {
    const lineKind = listKindOf(lines[i]!);
    if (lineKind === null) break;
    const indent = listLine(lines[i]!, lineKind).indent;
    if (indent < baseIndent) break;

    if (indent > baseIndent) {
      if (kind === "taskList" && lineKind !== "taskList") break;
      const [nested, next] = buildList(lines, i, localIds);
      if (kind === "taskList") {
        items.push(nested);
      } else {
        const last = items[items.length - 1];
        if (last) (last["content"] as Record<string, unknown>[]).push(nested);
      }
      i = next;
      continue;
    }

    if (lineKind !== kind) break;
    items.push(listItem(lines[i]!, kind, localIds));
    i++;
  }

  if (kind === "taskList") {
    return [{ type: "taskList", attrs: { localId: nextLocalId(localIds) }, content: items }, i];
  }
  return [{ type: kind, content: items }, i];
}

function listItem(
  line: string,
  kind: ListKind,
  localIds: { value: number },
): Record<string, unknown> {
  const parsed = listLine(line, kind);
  if (kind === "taskList") {
    return {
      type: "taskItem",
      attrs: { localId: nextLocalId(localIds), state: parsed.done ? "DONE" : "TODO" },
      content: inlineNodes(parsed.text),
    };
  }
  return {
    type: "listItem",
    content: [{ type: "paragraph", content: inlineNodes(parsed.text) }],
  };
}

function nextLocalId(localIds: { value: number }): string {
  localIds.value += 1;
  return `local-${localIds.value}`;
}

// GitHub-style pipe tables: a header row, a |---|---| separator (alignment colons
// tolerated, alignment itself ignored), then data rows until the first non-table line.
// Cells may not contain escaped pipes (\|); ragged rows are emitted as-is.
function isTableRow(line: string | undefined): boolean {
  return line !== undefined && /^\s*\|.*\|\s*$/.test(line);
}

function isTableSeparator(line: string | undefined): boolean {
  return line !== undefined && /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line);
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function buildTable(lines: string[], start: number): [Record<string, unknown>, number] {
  const rows: Record<string, unknown>[] = [tableRow(tableCells(lines[start]!), "tableHeader")];
  let i = start + 2; // skip the header and separator rows
  while (i < lines.length && isTableRow(lines[i]) && !isTableSeparator(lines[i])) {
    rows.push(tableRow(tableCells(lines[i]!), "tableCell"));
    i++;
  }
  return [{ type: "table", attrs: { layout: "default" }, content: rows }, i];
}

function tableRow(cells: string[], cellType: "tableHeader" | "tableCell"): Record<string, unknown> {
  return {
    type: "tableRow",
    content: cells.map((cell) => ({
      type: cellType,
      attrs: {},
      // ADF text nodes must be non-empty, so an empty cell gets an empty paragraph.
      content: [{ type: "paragraph", content: cell === "" ? [] : inlineNodes(cell) }],
    })),
  };
}

function codeBlock(code: string, language: string | undefined): Record<string, unknown> {
  return {
    type: "codeBlock",
    attrs: language ? { language } : {},
    content: code === "" ? [] : [{ type: "text", text: code }],
  };
}

function inlineNodes(text: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined && match[2] !== undefined) {
      nodes.push({
        type: "text",
        text: match[1],
        marks: [{ type: "link", attrs: { href: match[2] } }],
      });
    } else if (match[3] !== undefined) {
      nodes.push({ type: "text", text: match[3], marks: [{ type: "code" }] });
    } else if (match[4] !== undefined) {
      nodes.push({ type: "text", text: match[4], marks: [{ type: "strong" }] });
    } else if (match[5] !== undefined || match[6] !== undefined) {
      nodes.push({ type: "text", text: (match[5] ?? match[6])!, marks: [{ type: "em" }] });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push({ type: "text", text: text.slice(lastIndex) });
  }
  if (nodes.length === 0) {
    nodes.push({ type: "text", text });
  }
  return nodes;
}
