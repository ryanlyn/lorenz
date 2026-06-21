import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { useHashRouter } from "../src/shared/hooks/useHashRouter";

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

function RouteProbe() {
  const { route } = useHashRouter();
  return createElement("output", null, route.view === "trace" ? route.issueId : route.view);
}

function renderRoute() {
  return renderToString(createElement(RouteProbe));
}

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
    return;
  }

  Reflect.deleteProperty(globalThis, "window");
});

describe("useHashRouter", () => {
  it("falls back to overview for malformed trace hashes", () => {
    setHash("#/trace/%");

    let html = "";
    expect(() => {
      html = renderRoute();
    }).not.toThrow();
    expect(html).toContain("overview");
  });

  it("decodes valid trace hashes", () => {
    setHash("#/trace/MONO%2F389");

    expect(renderRoute()).toContain("MONO/389");
  });
});
