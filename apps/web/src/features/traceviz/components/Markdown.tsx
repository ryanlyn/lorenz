import ReactMarkdown, { type UrlTransform } from "react-markdown";

import { SafeExternalLink, safeExternalHref } from "../../../shared/components/SafeExternalLink";

interface MarkdownProps {
  children: string;
  className?: string;
}

const markdownUrlTransform: UrlTransform = (url, key, node) => {
  if (key === "href" && node.tagName === "a") return url;
  return safeExternalHref(url) ?? undefined;
};

export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={className}>
      <ReactMarkdown
        urlTransform={markdownUrlTransform}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          h1: ({ children }) => <h1 className="mb-2 text-lg font-bold">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 text-base font-bold">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1 text-sm font-bold">{children}</h3>,
          ul: ({ children }) => <ul className="mb-2 list-disc pl-4 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 list-decimal pl-4 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="mb-0.5">{children}</li>,
          code: ({ children, className }) => {
            const isBlock = className?.includes("language-");
            if (isBlock) {
              return (
                <code className="block overflow-x-auto rounded bg-background p-2 text-xs">
                  {children}
                </code>
              );
            }
            return <code className="rounded bg-background px-1 py-0.5 text-xs">{children}</code>;
          },
          pre: ({ children }) => <pre className="mb-2 last:mb-0">{children}</pre>,
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-2 border-muted pl-3 italic last:mb-0">
              {children}
            </blockquote>
          ),
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          a: ({ children, href }) => (
            <SafeExternalLink href={href} className="text-accent-cyan underline">
              {children}
            </SafeExternalLink>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
