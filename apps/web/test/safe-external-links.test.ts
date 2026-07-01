// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { TicketInfo } from "../src/features/traceviz/api/types";
import { Markdown } from "../src/features/traceviz/components/Markdown";
import { TicketSelector } from "../src/features/traceviz/components/TicketSelector";
import { SafeExternalLink, safeExternalHref } from "../src/shared/components/SafeExternalLink";

describe("safe external dashboard links", () => {
  it.each([
    ["http://example.com/issue", "http://example.com/issue"],
    ["https://example.com/issue", "https://example.com/issue"],
    ["javascript:alert(1)", null],
    ["data:text/html,hi", null],
  ])("classifies %s", (href, expected) => {
    expect(safeExternalHref(href)).toBe(expected);
  });

  it.each([
    ["http://example.com/issue", true],
    ["https://example.com/issue", true],
    ["javascript:alert(1)", false],
    ["data:text/html,hi", false],
  ])("renders tracker URL %s with the shared safe-link component", (href, isNavigable) => {
    const html = renderToStaticMarkup(
      createElement(
        SafeExternalLink,
        { href, className: "external", title: "Open in tracker" },
        "Tracker",
      ),
    );

    if (isNavigable) {
      expect(html).toContain(`<a href="${href}"`);
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
      return;
    }

    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    expect(html).not.toContain('target="_blank"');
    expect(html).toContain("<span");
  });

  it("can omit unsafe tracker links while preserving safe anchors", () => {
    const unsafeHtml = renderToStaticMarkup(
      createElement(
        SafeExternalLink,
        { href: "javascript:alert(1)", omitUnsafe: true, title: "Open in tracker" },
        "Tracker",
      ),
    );
    const safeHtml = renderToStaticMarkup(
      createElement(
        SafeExternalLink,
        { href: "https://example.com/issue", omitUnsafe: true, title: "Open in tracker" },
        "Tracker",
      ),
    );

    expect(unsafeHtml).toBe("");
    expect(safeHtml).toContain('<a href="https://example.com/issue"');
  });

  it("routes Markdown links through the same allowlist", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        children:
          "[js](javascript:alert(1)) [data](data:text/html,hi) [http](http://example.com) [https](https://example.com)",
      }),
    );

    expect(html).toContain('<a href="http://example.com"');
    expect(html).toContain('<a href="https://example.com"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain('href=""');
    expect(html.match(/target="_blank"/g)).toHaveLength(2);
  });

  it("applies the allowlist to non-anchor Markdown URL attributes", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        children:
          "![js](javascript:alert(1)) ![data](data:text/html,hi) ![http](http://example.com/image.png) ![https](https://example.com/image.png)",
      }),
    );

    expect(html).toContain('src="http://example.com/image.png"');
    expect(html).toContain('src="https://example.com/image.png"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain('src=""');
  });

  it.each([
    ["http://example.com/issue", true],
    ["https://example.com/issue", true],
    ["javascript:alert(1)", false],
    ["data:text/html,hi", false],
  ])("renders tracker issue URL %s as navigable only when allowed", (href, isNavigable) => {
    const tickets: TicketInfo[] = [
      {
        issueId: "id-1",
        identifier: "TEST-1",
        title: "Tracker URL",
        url: href,
        status: "idle",
        turnCount: 1,
      },
    ];

    const html = renderToStaticMarkup(
      createElement(TicketSelector, {
        tickets,
        selectedId: "id-1",
        onSelect: vi.fn(),
      }),
    );

    if (isNavigable) {
      expect(html).toContain(`<a href="${href}"`);
      expect(html).toContain('target="_blank"');
      return;
    }

    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain("Linear");
  });
});
