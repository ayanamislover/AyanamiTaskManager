import type { AtmBaseErrorDetails, AtmErrorCode } from "@ayanami-task/errors";

export type AyanamiClientErrorLike = {
  new (input: {
    code: AtmErrorCode;
    message: string;
    status: number;
    details?: AtmBaseErrorDetails | null;
  }): Error;
};

class CursorDrainError extends Error {
  readonly code = "INVALID_RESPONSE";
  readonly status = 502;
  readonly details: AtmBaseErrorDetails;

  constructor(input: { message: string; details: AtmBaseErrorDetails }) {
    super(input.message);
    this.name = "CursorDrainError";
    this.details = input.details;
  }
}

/** The common shape consumed by every cursor-backed collection endpoint. */
export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type CursorDrainOptions = {
  /** Maximum number of network pages to consume before requiring an explicit resume. */
  maxPages?: number;
  /** Maximum number of items to retain; a hit is an error, never a silent truncation. */
  maxItems?: number;
  /** Optional cursor from which a compatibility drain should start. */
  initialCursor?: string;
};

const DEFAULT_DRAIN_MAX_PAGES = 100;
const DEFAULT_DRAIN_MAX_ITEMS = 10_000;

function drainLimitError(
  ErrorClass: AyanamiClientErrorLike,
  entity: string,
  maxPages: number,
  maxItems: number,
  pageCount: number,
  itemCount: number,
  resumeCursor: string | null,
): Error {
  return new ErrorClass({
    code: "INVALID_RESPONSE",
    message: `${entity} 分页读取达到安全上限（pages=${maxPages}, items=${maxItems}），请使用 resume cursor 继续`,
    status: 502,
    details: {
      entity,
      reason: "DRAIN_LIMIT_REACHED",
      maxPages,
      maxItems,
      pageCount,
      itemCount,
      resumeCursor,
    },
  });
}

/**
 * Consume a cursor endpoint without allowing malformed pagination or an
 * unbounded response to turn into a hidden partial result.
 */
export async function drainCursorPages<T>(
  loadPage: (cursor?: string) => Promise<CursorPage<T>>,
  options: CursorDrainOptions & { entity?: string; errorClass?: AyanamiClientErrorLike } = {},
): Promise<T[]> {
  const ErrorClass = options.errorClass ?? (CursorDrainError as unknown as AyanamiClientErrorLike);
  const entity = options.entity ?? "CURSOR_PAGE";
  const maxPages = options.maxPages ?? DEFAULT_DRAIN_MAX_PAGES;
  const maxItems = options.maxItems ?? DEFAULT_DRAIN_MAX_ITEMS;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new ErrorClass({
      code: "INVALID_RESPONSE",
      message: `${entity} maxPages 必须是正整数`,
      status: 502,
      details: { entity, reason: "INVALID_DRAIN_LIMIT", field: "maxPages" },
    });
  }
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new ErrorClass({
      code: "INVALID_RESPONSE",
      message: `${entity} maxItems 必须是正整数`,
      status: 502,
      details: { entity, reason: "INVALID_DRAIN_LIMIT", field: "maxItems" },
    });
  }

  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor = options.initialCursor;
  if (cursor !== undefined) seenCursors.add(cursor);
  let pageCount = 0;
  for (;;) {
    if (pageCount >= maxPages) {
      throw drainLimitError(
        ErrorClass,
        entity,
        maxPages,
        maxItems,
        pageCount,
        items.length,
        cursor ?? null,
      );
    }
    const page = await loadPage(cursor);
    pageCount += 1;
    if (!page || !Array.isArray(page.items) || typeof page.hasMore !== "boolean") {
      throw new ErrorClass({
        code: "INVALID_RESPONSE",
        message: `${entity} 返回了无效分页响应`,
        status: 502,
        details: { entity, reason: "INVALID_PAGE" },
      });
    }
    if (items.length + page.items.length > maxItems) {
      throw drainLimitError(
        ErrorClass,
        entity,
        maxPages,
        maxItems,
        pageCount,
        items.length,
        cursor ?? null,
      );
    }
    items.push(...page.items);
    if (!page.hasMore) return items;
    if (typeof page.nextCursor !== "string" || page.nextCursor.length === 0) {
      throw new ErrorClass({
        code: "INVALID_RESPONSE",
        message: `${entity} 分页声明 hasMore=true 但未返回 nextCursor`,
        status: 502,
        details: { entity, reason: "MISSING_NEXT_CURSOR" },
      });
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new ErrorClass({
        code: "INVALID_RESPONSE",
        message: `${entity} 分页返回了重复 cursor`,
        status: 502,
        details: { entity, reason: "REPEATED_CURSOR", resumeCursor: page.nextCursor },
      });
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
