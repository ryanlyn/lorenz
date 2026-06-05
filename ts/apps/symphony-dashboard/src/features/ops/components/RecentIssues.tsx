import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";

import { cn } from "../../../lib/utils";
import type { IssueRecord } from "../../traceviz/api/types";
import { fetchRecentIssues } from "../../traceviz/api/client";

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

export function RecentIssues() {
  const [issues, setIssues] = useState<IssueRecord[]>([]);

  useEffect(() => {
    void fetchRecentIssues(5).then(setIssues);
  }, []);

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium text-foreground">Recent Issues</h3>
      </div>
      {issues.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted">No recent issues</div>
      ) : (
        <div className="divide-y divide-border">
          {issues.map((issue) => (
            <a
              key={issue.issueId}
              href={`#/trace/${encodeURIComponent(issue.issueId)}`}
              className={cn(
                "flex items-center gap-3 px-4 py-3",
                "transition-colors hover:bg-surface",
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
              {issue.url && (
                <ExternalLink aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted" />
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
