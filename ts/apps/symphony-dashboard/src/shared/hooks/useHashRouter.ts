import { useState, useEffect, useCallback } from "react";

export type Route = { view: "overview" } | { view: "trace"; issueId: string };

function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  const traceMatch = path.match(/^\/trace(?:\/(.+)?)?$/);
  if (traceMatch) {
    return { view: "trace", issueId: traceMatch[1] ? decodeURIComponent(traceMatch[1]) : "" };
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
