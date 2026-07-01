import { Search, ExternalLink, Loader2 } from "lucide-react";

import { useIssueSearch } from "../hooks/useIssueSearch";
import { cn } from "../../../lib/utils";
import { safeExternalHref } from "../../../shared/components/SafeExternalLink";

interface TraceListProps {
  onSelect: (issueId: string) => void;
}

function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function TraceList({ onSelect }: TraceListProps) {
  const { query, setQuery, issues, searching, isSearchMode, noResults } = useIssueSearch();

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by ID or title…"
          className={cn(
            "w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-sm text-foreground",
            "placeholder:text-muted focus:border-accent-purple/50 focus:outline-none focus:ring-2 focus:ring-accent-purple/50",
          )}
        />
        {searching && (
          <Loader2
            aria-hidden="true"
            className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted"
          />
        )}
      </div>

      {isSearchMode ? (
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
          Results matching &ldquo;{query}&rdquo;
        </h2>
      ) : (
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Recent</h2>
      )}

      {noResults && <p className="py-8 text-center text-sm text-muted">No results</p>}

      {issues.length > 0 && (
        <div className="divide-y divide-border rounded-lg border border-border bg-card">
          {issues.map((issue) => (
            <button
              key={issue.issueId}
              onClick={() => onSelect(issue.issueId)}
              className={cn(
                "flex w-full items-center gap-3 px-4 py-3 text-left",
                "transition-colors hover:bg-muted/10",
                "focus:outline-none focus:bg-muted/10",
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {issue.issueIdentifier}
                </p>
                {issue.title && <p className="truncate text-xs text-muted">{issue.title}</p>}
              </div>
              <span className="shrink-0 text-xs text-muted">
                {formatRelativeTime(issue.updatedAt)}
              </span>
              {safeExternalHref(issue.url) && (
                <ExternalLink aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted" />
              )}
            </button>
          ))}
        </div>
      )}

      {!isSearchMode && issues.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm text-muted">No issues found</p>
          <p className="mt-1 text-xs text-muted/70">
            Issues will appear here once they are processed
          </p>
        </div>
      )}
    </div>
  );
}
