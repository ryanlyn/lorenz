import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "../../../../lib/utils";

import { eventTargetIsAnchor, isActivationKey } from "./interactiveRow";

interface EventRowProps {
  /** Rail dot color class. */
  dotClass: string;
  time: string;
  icon: ReactNode;
  /** One-line primary content; truncated when the row is expandable. */
  title: ReactNode;
  /** Right-aligned compact metadata. */
  meta?: ReactNode;
  ariaLabel?: string;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  /** Detail block below the row; stays mounted while collapsed so markup survives. */
  detail?: ReactNode;
}

/**
 * Uniform compact timeline row: a dot on the shared vertical rail, a mono
 * timestamp column, one line of content, and an optional expandable detail.
 */
export function EventRow({
  dotClass,
  time,
  icon,
  title,
  meta,
  ariaLabel,
  expandable = false,
  expanded = false,
  onToggle,
  detail,
}: EventRowProps) {
  const handleClick = (clickEvent: MouseEvent<HTMLDivElement>) => {
    if (eventTargetIsAnchor(clickEvent.target)) return;
    onToggle?.();
  };

  const handleKeyDown = (keyboardEvent: KeyboardEvent<HTMLDivElement>) => {
    if (eventTargetIsAnchor(keyboardEvent.target)) return;
    if (!isActivationKey(keyboardEvent.key)) return;
    keyboardEvent.preventDefault();
    onToggle?.();
  };

  const header = (
    <div className="flex min-h-8 items-center gap-2.5 py-1 pr-4">
      <span className="w-[64px] shrink-0 font-mono text-[11px] tabular-nums text-faint">
        {time}
      </span>
      <span aria-hidden="true" className="flex shrink-0 items-center">
        {icon}
      </span>
      <div className={cn("min-w-0 flex-1", expandable && !expanded && "truncate")}>{title}</div>
      {meta && <span className="ml-auto flex shrink-0 items-center gap-2">{meta}</span>}
      {expandable && (
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-3 w-3 shrink-0 text-faint transition-transform",
            expanded && "rotate-180",
          )}
        />
      )}
    </div>
  );

  return (
    <div
      className={cn(
        "relative pl-9 transition-colors",
        expanded
          ? "bg-accent/[0.05] shadow-[inset_2px_0_0_var(--color-accent)]"
          : "hover:bg-accent/[0.03]",
      )}
    >
      <span aria-hidden="true" className="absolute bottom-0 left-4 top-0 w-px bg-border" />
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-[13px] top-[15px] h-[7px] w-[7px] rounded-full ring-2 ring-background",
          dotClass,
        )}
      />
      {expandable ? (
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          aria-label={ariaLabel}
          className="cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          onClick={handleClick}
          onKeyDown={handleKeyDown}
        >
          {header}
        </div>
      ) : (
        header
      )}
      {detail && <div className={cn("pb-2.5 pr-4 pt-0.5", !expanded && "hidden")}>{detail}</div>}
    </div>
  );
}
