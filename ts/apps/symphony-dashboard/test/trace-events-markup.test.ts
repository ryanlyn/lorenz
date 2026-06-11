// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test } from "vitest";

import type { DisplayEvent } from "../src/features/traceviz/api/types";
import { Timeline } from "../src/features/traceviz/components/Timeline";
import { ThoughtEvent } from "../src/features/traceviz/components/events/ThoughtEvent";
import { ToolCallEvent } from "../src/features/traceviz/components/events/ToolCallEvent";
import { formatTimestamp } from "../src/lib/utils";

afterEach(() => {
  cleanup();
});

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

  test("renders unknown timeline events with raw payload", () => {
    const timestamp = "2026-06-04T10:00:02.000Z";
    const events: DisplayEvent[] = [
      {
        kind: "unknown",
        timestamp,
        raw: {
          kind: "legacy_agent_update",
          payload: {
            reason: "parser miss",
          },
        },
      },
    ];

    const html = renderToStaticMarkup(
      createElement(Timeline, {
        events,
        loading: false,
      }),
    );

    expect(html).toContain("Timeline (1 events)");
    expect(html).toContain("Unknown event");
    expect(html).toContain(formatTimestamp(timestamp));
    expect(html).toContain("legacy_agent_update");
    expect(html).toContain("parser miss");
  });

  test("keeps existing timeline events mounted during a refresh", () => {
    const events: DisplayEvent[] = [
      {
        kind: "turn_started",
        turnIndex: 1,
        timestamp: "2026-06-04T09:59:59.000Z",
      },
      {
        kind: "message",
        timestamp: "2026-06-04T10:00:00.000Z",
        text: "Existing trace event",
      },
    ];

    const html = renderToStaticMarkup(
      createElement(Timeline, {
        events,
        loading: true,
      }),
    );

    expect(html).toContain("Timeline (2 events)");
    expect(html).toContain("Existing trace event");
    expect(html).not.toContain("Loading events...");
  });

  test("keeps newest-first event rows mounted when an append shifts display order", () => {
    const longThought: DisplayEvent = {
      kind: "thought",
      timestamp: "2026-06-04T10:00:00.000Z",
      text: "This thought is long enough to be expandable. ".repeat(8),
    };
    const initialEvents: DisplayEvent[] = [
      {
        kind: "turn_started",
        turnIndex: 1,
        timestamp: "2026-06-04T09:59:59.000Z",
      },
      longThought,
    ];

    const { rerender } = render(
      createElement(Timeline, {
        events: initialEvents,
        loading: false,
      }),
    );

    const thoughtToggle = screen.getByRole("button", { name: "Toggle thought details" });
    fireEvent.click(thoughtToggle);

    expect(thoughtToggle.getAttribute("aria-expanded")).toBe("true");

    rerender(
      createElement(Timeline, {
        events: [
          ...initialEvents,
          {
            kind: "message",
            timestamp: "2026-06-04T10:00:01.000Z",
            text: "A later event arrives.",
          },
        ] satisfies DisplayEvent[],
        loading: false,
      }),
    );

    expect(
      screen.getByRole("button", { name: "Toggle thought details" }).getAttribute("aria-expanded"),
    ).toBe("true");
  });
});
