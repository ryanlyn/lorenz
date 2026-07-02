import { useEffect, useState } from "react";

import { useHashRouter } from "./shared/hooks/useHashRouter";
import { useOpsState } from "./features/ops/hooks/useOpsState";
import { OpsOverview } from "./features/ops/components/OpsOverview";
import { TraceView } from "./features/traceviz/components/TraceView";
import { AsciiAurora } from "./shared/components/AsciiAurora";
import { cn } from "./lib/utils";
import lorenzLogo from "./assets/lorenz-logo.png";

function NavLink({ href, active, children }: { href: string; active: boolean; children: string }) {
  return (
    <a
      href={href}
      className={cn(
        "rounded-full px-4 py-1.5 text-[13px] transition-colors",
        active
          ? "bg-gradient-to-br from-accent to-[#57c7b0] font-semibold text-[#071310]"
          : "text-muted hover:text-foreground",
      )}
    >
      {children}
    </a>
  );
}

/** True once the page is scrolled past the hero, to back the floating header. */
function useScrolled(threshold = 16): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);
  return scrolled;
}

export function App() {
  const { route, navigate } = useHashRouter();
  const { state: opsState, connected: opsConnected } = useOpsState();
  const scrolled = useScrolled();

  return (
    <div className="relative min-h-screen text-foreground">
      <AsciiAurora />
      <div className="relative">
        <div className="h-0.5 bg-gradient-to-r from-[#0e7d64] via-30% via-accent to-[#1c5f74]" />
        <header
          className={cn(
            "sticky top-0 z-50 border-b transition-colors duration-300",
            scrolled
              ? "border-border/60 bg-background/80 backdrop-blur-md"
              : "border-transparent bg-transparent",
          )}
        >
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-7 px-4">
            <a href="#/" className="flex items-center gap-2.5">
              <img src={lorenzLogo} alt="" className="h-7 w-auto" />
              <h1 className="text-[17px] font-semibold tracking-tight">Lorenz</h1>
            </a>
            <nav className="flex items-center gap-0.5 rounded-full border border-border/70 bg-card/50 p-[3px] backdrop-blur-sm">
              <NavLink href="#/" active={route.view === "overview"}>
                Overview
              </NavLink>
              <NavLink href="#/trace/" active={route.view === "trace"}>
                Issues
              </NavLink>
            </nav>
            <div
              className={cn(
                "ml-auto flex items-center gap-2 text-xs",
                opsConnected ? "text-muted" : "text-accent-amber",
              )}
            >
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  opsConnected
                    ? "bg-accent shadow-[0_0_10px_var(--color-accent)]"
                    : "animate-pulse bg-accent-amber",
                )}
              />
              {opsConnected ? "Streaming live" : "Connecting…"}
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-4 py-6">
          {route.view === "overview" && <OpsOverview state={opsState} connected={opsConnected} />}
          {route.view === "trace" && (
            <TraceView issueId={route.issueId} onBack={() => navigate("/")} />
          )}
        </main>
      </div>
    </div>
  );
}
