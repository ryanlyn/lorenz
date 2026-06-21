import { useState, useEffect, useCallback } from "react";

export type Route = { view: "overview" } | { view: "trace"; issueId: string };

function decodeTraceIssueId(issueId: string | undefined): string | null {
  if (!issueId) return "";

  try {
    return decodeURIComponent(issueId);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  const traceMatch = path.match(/^\/trace(?:\/(.+)?)?$/);
  if (traceMatch) {
    const issueId = decodeTraceIssueId(traceMatch[1]);
    if (issueId === null) return { view: "overview" };
    return { view: "trace", issueId };
  }
  return { view: "overview" };
}

export function useHashRouter() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    function handleHashChange() {
      setRoute(parseHash(window.location.hash));
    }
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const navigate = useCallback((path: string) => {
    window.location.hash = path;
  }, []);

  return { route, navigate };
}
