import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IssueRecord } from "../src/features/traceviz/api/types";
import type { UseIssueSearchResult } from "../src/features/traceviz/hooks/useIssueSearch";

const mocks = vi.hoisted(() => ({
  useIssueSearch: vi.fn<() => UseIssueSearchResult>(),
}));

vi.mock("../src/features/traceviz/hooks/useIssueSearch", () => ({
  useIssueSearch: mocks.useIssueSearch,
}));

vi.mock("../src/features/traceviz/components/TraceView", async () => {
  const { createElement } = await import("react");

  return {
    TraceView({ issueId }: { issueId: string }) {
      return createElement("output", { "data-trace-issue-id": issueId }, issueId);
    },
  };
});

const { App } = await import("../src/App");
const { TraceList } = await import("../src/features/traceviz/components/TraceList");

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function setHash(hash: string) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { hash },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as Window,
  });
}

function issueSearchResult(issues: IssueRecord[]): UseIssueSearchResult {
  return {
    query: "",
    setQuery: vi.fn(),
    issues,
    searching: false,
    isSearchMode: false,
    noResults: false,
  };
}

function expectTextOrder(html: string, orderedText: string[]) {
  let previousIndex = -1;

  for (const text of orderedText) {
    const index = html.indexOf(text);
    expect(index).toBeGreaterThan(previousIndex);
    previousIndex = index;
  }
}

afterEach(() => {
  mocks.useIssueSearch.mockReset();

  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
    return;
  }

  Reflect.deleteProperty(globalThis, "window");
});

describe("trace browser routing", () => {
  it("passes decoded trace issue ids from App's hash route into TraceView", () => {
    setHash("#/trace/CAN%2F101");

    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain('data-trace-issue-id="CAN/101"');
    expect(html).toContain(">CAN/101</output>");
  });
});

describe("trace browser issue list", () => {
  it("renders recent issues in the production TraceList order", () => {
    mocks.useIssueSearch.mockReturnValue(
      issueSearchResult([
        {
          issueId: "issue-102",
          issueIdentifier: "CAN-102",
          title: "Most recent issue",
          url: null,
          updatedAt: 300,
        },
        {
          issueId: "issue-101",
          issueIdentifier: "CAN-101",
          title: "Older issue",
          url: "https://linear.app/mono-dev/issue/CAN-101",
          updatedAt: 200,
        },
        {
          issueId: "issue-104",
          issueIdentifier: "CAN-104",
          title: "Oldest issue",
          url: null,
          updatedAt: 100,
        },
      ]),
    );

    const html = renderToStaticMarkup(createElement(TraceList, { onSelect: vi.fn() }));

    expectTextOrder(html, ["CAN-102", "CAN-101", "CAN-104"]);
    expect(html).toContain("Most recent issue");
    expect(html).toContain("Older issue");
    expect(html).toContain("Oldest issue");
  });
});
