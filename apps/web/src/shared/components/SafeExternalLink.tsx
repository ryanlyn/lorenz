import type { ReactNode } from "react";

const SAFE_EXTERNAL_LINK_PROTOCOLS = new Set(["http:", "https:"]);

export function safeExternalHref(href: string | null | undefined): string | null {
  const trimmed = href?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    return SAFE_EXTERNAL_LINK_PROTOCOLS.has(url.protocol.toLowerCase()) ? trimmed : null;
  } catch {
    return null;
  }
}

interface SafeExternalLinkProps {
  href: string | null | undefined;
  children: ReactNode;
  className?: string;
  unsafeClassName?: string;
  title?: string;
  omitUnsafe?: boolean;
}

export function SafeExternalLink({
  href,
  children,
  className,
  unsafeClassName,
  title,
  omitUnsafe = false,
}: SafeExternalLinkProps) {
  const safeHref = safeExternalHref(href);

  if (safeHref === null) {
    if (omitUnsafe) return null;

    return (
      <span className={unsafeClassName} title={title}>
        {children}
      </span>
    );
  }

  return (
    <a
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      title={title}
    >
      {children}
    </a>
  );
}
