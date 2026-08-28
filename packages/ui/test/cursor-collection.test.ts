import { describe, expect, it } from "vitest";
import { advanceCursorPage, type CursorCollectionState } from "../src/cursor-collection.js";

function state<T>(): CursorCollectionState<T> {
  return {
    items: [],
    hasMore: true,
    cursor: undefined,
    seenCursors: [],
    pageCount: 0,
  };
}

describe("cursor collection state", () => {
  it("retains committed items and resumes from the exact failed cursor without duplicates", () => {
    let current = state<number>();
    const requests: Array<string | undefined> = [];
    const pages: Record<string, { items: number[]; hasMore: boolean; nextCursor?: string }> = {
      first: { items: [1, 2], hasMore: true, nextCursor: "second" },
      second: { items: [3, 4], hasMore: false },
    };

    requests.push(current.cursor);
    let result = advanceCursorPage(current, { items: [1, 2], hasMore: true, nextCursor: "second" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    current = result.state;
    expect(current.items).toEqual([1, 2]);
    expect(current.cursor).toBe("second");

    // The network failure happens before page 2 is committed; retry must use
    // the saved cursor rather than starting over at the first page.
    const failedCursor = current.cursor;
    requests.push(failedCursor);
    expect(failedCursor).toBe("second");
    result = advanceCursorPage(current, pages.second);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    current = result.state;
    expect(requests).toEqual([undefined, "second"]);
    expect(current.items).toEqual([1, 2, 3, 4]);
    expect(new Set(current.items).size).toBe(current.items.length);
    expect(current.hasMore).toBe(false);
  });

  it("fails closed for malformed/repeated cursors and preserves the previous page", () => {
    let current = state<string>();
    const first = advanceCursorPage(current, {
      items: ["a"],
      hasMore: true,
      nextCursor: "next",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    current = first.state;

    const repeated = advanceCursorPage(current, {
      items: ["a"],
      hasMore: true,
      nextCursor: "next",
    });
    expect(repeated.ok).toBe(false);
    if (repeated.ok) return;
    expect(repeated.error.code).toBe("INVALID_RESPONSE");
    expect(repeated.error.details).toMatchObject({ reason: "REPEATED_CURSOR" });
    expect(repeated.state.items).toEqual(["a"]);

    const missing = advanceCursorPage(current, { items: ["b"], hasMore: true });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.details).toMatchObject({ reason: "MISSING_NEXT_CURSOR" });
    expect(missing.state.items).toEqual(["a"]);
  });

  it("reports bounded resume facts without committing an oversized page", () => {
    const current: CursorCollectionState<number> = {
      items: [1, 2],
      hasMore: true,
      cursor: "third-page",
      seenCursors: ["second-page", "third-page"],
      pageCount: 2,
    };
    const result = advanceCursorPage(
      current,
      { items: [3, 4], hasMore: true, nextCursor: "fourth-page" },
      { maxPages: 10, maxItems: 3 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state.items).toEqual([1, 2]);
    expect(result.error.details).toMatchObject({
      reason: "DRAIN_LIMIT_REACHED",
      itemCount: 2,
      resumeCursor: "third-page",
    });
  });
});
