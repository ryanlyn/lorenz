import { useEffect, useState } from "react";
import { ExternalLink, FileText } from "lucide-react";

import { cn } from "../../../lib/utils";
import { SafeExternalLink } from "../../../shared/components/SafeExternalLink";
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
            <div
              key={issue.issueId}
              className={cn(
                "flex items-center gap-3 px-4 py-3",
                "transition-colors hover:bg-surface",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <a
                    href={`#/trace/${encodeURIComponent(issue.issueId)}`}
                    className="inline-flex items-center gap-1 truncate font-mono text-sm text-accent-blue hover:underline"
                    title="View trace"
                  >
                    <FileText className="h-3 w-3 shrink-0" />
                    {issue.issueIdentifier}
                  </a>
                  {issue.url && (
                    <SafeExternalLink
                      href={issue.url}
                      omitUnsafe
                      className="inline-flex items-center text-muted hover:text-foreground"
                      title="Open in tracker"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </SafeExternalLink>
                  )}
                </div>
                {issue.title && <p className="truncate text-xs text-muted">{issue.title}</p>}
              </div>
              <span className="shrink-0 text-xs text-muted">
                {formatRelativeTime(issue.updatedAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
