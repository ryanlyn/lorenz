import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { markdownToAdf } from "../src/adf.js";

function kids(node: Record<string, unknown>): Record<string, unknown>[] {
  return (node["content"] as Record<string, unknown>[] | undefined) ?? [];
}

function attr(node: Record<string, unknown>, key: string): unknown {
  return (node["attrs"] as Record<string, unknown> | undefined)?.[key];
}

test("markdownToAdf wraps the document and skips blank lines", () => {
  const doc = markdownToAdf("# Title\n\nHello **world**");
  assert.equal(doc["type"], "doc");
  assert.equal(doc["version"], 1);
  const blocks = kids(doc);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!["type"], "heading");
  assert.equal(attr(blocks[0]!, "level"), 1);
  assert.equal(blocks[1]!["type"], "paragraph");
  const inline = kids(blocks[1]!);
  assert.equal(inline[1]!["text"], "world");
  assert.deepEqual(inline[1]!["marks"], [{ type: "strong" }]);
});

test("markdownToAdf converts a fenced code block", () => {
  const block = kids(markdownToAdf("```ts\nconst x = 1;\n```"))[0]!;
  assert.equal(block["type"], "codeBlock");
  assert.deepEqual(block["attrs"], { language: "ts" });
  assert.equal(kids(block)[0]!["text"], "const x = 1;");
});

test("markdownToAdf converts GitHub task lists with checkbox state", () => {
  const list = kids(markdownToAdf("- [ ] todo\n- [x] done\n- [X] also done"))[0]!;
  assert.equal(list["type"], "taskList");
  assert.equal(typeof attr(list, "localId"), "string");
  const items = kids(list);
  assert.equal(items.length, 3);
  assert.equal(items[0]!["type"], "taskItem");
  assert.equal(attr(items[0]!, "state"), "TODO");
  assert.equal(attr(items[1]!, "state"), "DONE");
  assert.equal(attr(items[2]!, "state"), "DONE");
  assert.equal(kids(items[0]!)[0]!["text"], "todo");
});

test("markdownToAdf nests an indented task list as a child taskList", () => {
  const list = kids(markdownToAdf("- [ ] parent\n  - [x] child\n- [ ] sibling"))[0]!;
  const items = kids(list);
  assert.equal(items.length, 3); // parent item, nested taskList, sibling item
  assert.equal(items[0]!["type"], "taskItem");
  assert.equal(items[1]!["type"], "taskList");
  assert.equal(attr(kids(items[1]!)[0]!, "state"), "DONE");
  assert.equal(items[2]!["type"], "taskItem");
});

test("markdownToAdf nests an indented bullet list inside its parent item", () => {
  const list = kids(markdownToAdf("- parent a\n  - child a1\n- parent b"))[0]!;
  assert.equal(list["type"], "bulletList");
  const first = kids(list)[0]!;
  assert.equal(kids(first).length, 2); // paragraph + nested list
  assert.equal(kids(first)[0]!["type"], "paragraph");
  assert.equal(kids(first)[1]!["type"], "bulletList");
});

test("markdownToAdf keeps a task list separate from a following bullet list", () => {
  const blocks = kids(markdownToAdf("- [ ] task\n- plain bullet"));
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!["type"], "taskList");
  assert.equal(blocks[1]!["type"], "bulletList");
});
