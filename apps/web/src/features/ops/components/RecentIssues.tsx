import { useEffect, useState } from "react";

import { SectionCard, EmptyRow, IssueLink } from "../../../shared/components/ui";
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
    <SectionCard title="Recent issues" count={issues.length} dotClass="bg-accent-cyan">
      {issues.length === 0 ? (
        <EmptyRow label="No recent issues" />
      ) : (
        <div>
          {issues.map((issue) => (
            <div
              key={issue.issueId}
              className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5 transition-colors last:border-b-0 hover:bg-accent/[0.03]"
            >
              <div className="min-w-0 flex-1">
                <IssueLink
                  issueId={issue.issueId}
                  identifier={issue.issueIdentifier}
                  url={issue.url}
                />
                {issue.title && <p className="mt-0.5 truncate text-xs text-muted">{issue.title}</p>}
              </div>
              <span className="shrink-0 text-xs text-faint">
                {formatRelativeTime(issue.updatedAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
