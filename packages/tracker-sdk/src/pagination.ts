export const TRACKER_PAGINATION_DEFAULT_MAX_PAGES = 100;
export const TRACKER_PAGINATION_DEFAULT_MAX_ITEMS = 5_000;

export interface TrackerPaginationLimits {
  maxPages?: number | undefined;
  maxItems?: number | undefined;
}

export interface TrackerPaginationGuardOptions {
  tracker: string;
  resource: string;
  limits?: TrackerPaginationLimits | undefined;
}

export class TrackerPaginationGuard {
  private readonly tracker: string;
  private readonly resource: string;
  private readonly maxPages: number;
  private readonly maxItems: number;
  private readonly seenCursors = new Set<string>();
  private pageCount = 0;
  private itemCount = 0;

  constructor(options: TrackerPaginationGuardOptions) {
    this.tracker = options.tracker;
    this.resource = options.resource;
    this.maxPages = positiveIntegerOrDefault(
      options.limits?.maxPages,
      TRACKER_PAGINATION_DEFAULT_MAX_PAGES,
    );
    this.maxItems = positiveIntegerOrDefault(
      options.limits?.maxItems,
      TRACKER_PAGINATION_DEFAULT_MAX_ITEMS,
    );
  }

  recordPage(): void {
    this.pageCount += 1;
    if (this.pageCount > this.maxPages) {
      throw this.error("page_limit_exceeded", `pages=${this.pageCount} max_pages=${this.maxPages}`);
    }
  }

  recordItems(count: number): void {
    if (!Number.isInteger(count) || count < 0) {
      throw this.error("invalid_item_count", `count=${count}`);
    }
    this.itemCount += count;
    if (this.itemCount > this.maxItems) {
      throw this.error("item_limit_exceeded", `items=${this.itemCount} max_items=${this.maxItems}`);
    }
  }

  nextCursor(value: unknown, cursorName: string): string {
    if (typeof value !== "string" || value.trim() === "") {
      throw this.error("malformed_cursor", `${cursorName} must be a non-empty string`);
    }
    if (this.seenCursors.has(value)) {
      throw this.error(
        "repeated_cursor",
        `${cursorName}=${summarizeCursor(value)} was returned more than once`,
      );
    }
    this.seenCursors.add(value);
    return value;
  }

  private error(code: string, details: string): Error {
    return new Error(`${this.tracker}_pagination_${code}: ${this.resource} ${details}`);
  }
}

export function createTrackerPaginationGuard(
  options: TrackerPaginationGuardOptions,
): TrackerPaginationGuard {
  return new TrackerPaginationGuard(options);
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function summarizeCursor(cursor: string): string {
  const json = JSON.stringify(cursor);
  if (json.length <= 120) return json;
  return `${json.slice(0, 117)}..."`;
}
