import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { ThoughtEvent } from "../src/features/traceviz/components/events/ThoughtEvent";
import { ToolCallEvent } from "../src/features/traceviz/components/events/ToolCallEvent";

describe("trace event markup", () => {
  test("renders long thought markdown outside native buttons", () => {
    const html = renderToStaticMarkup(
      createElement(ThoughtEvent, {
        event: {
          kind: "thought",
          timestamp: "2026-06-04T10:00:00.000Z",
          text: `${"This is a long thought with enough content to make the row expandable. ".repeat(4)}

[Open docs](https://example.com)

- one
- two`,
        },
      }),
    );

    expect(html).not.toContain("<button");
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("<p");
    expect(html).toContain("<a ");
  });

  test("renders tool call toggles without native buttons", () => {
    const html = renderToStaticMarkup(
      createElement(ToolCallEvent, {
        event: {
          kind: "tool_call",
          timestamp: "2026-06-04T10:00:01.000Z",
          toolName: "shell",
          input: { command: "echo hello" },
          output: "hello",
          isError: false,
          durationMs: 24,
          nestedEvents: [],
        },
      }),
    );

    expect(html).not.toContain("<button");
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Toggle shell details");
  });
});
