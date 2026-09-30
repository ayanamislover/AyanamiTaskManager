import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  advanceCursorPage,
  collectionRetryPlan,
  keepsViewWhileRefreshing,
  type CursorCollectionState,
} from "../src/cursor-collection.js";

const sourcePath = join(process.cwd(), "packages", "ui", "src", "cursor-collection.ts");

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

describe("读取失败后的重试方式", () => {
  it("首屏失败从头重读，已读到行则续读，没有剩页则整次刷新", () => {
    const failed = new Error("503");
    // 首屏就失败：一行都没有但还有页。以前被当成续读，续读要求已有行，按钮什么都不做。
    expect(collectionRetryPlan({ error: failed, hasMore: true, items: [] })).toBe("restart");
    expect(collectionRetryPlan({ error: failed, hasMore: true, items: [{ id: 1 }] })).toBe(
      "resume",
    );
    expect(collectionRetryPlan({ error: failed, hasMore: false, items: [{ id: 1 }] })).toBe(
      "refresh",
    );
    expect(collectionRetryPlan({ error: null, hasMore: true, items: [] })).toBe("none");
  });
});

describe("后台刷新不回到加载态", () => {
  it("已经完整读完的来源，哪怕是 0 条，刷新时也保留当前显示", () => {
    const settled = { loading: false, hasMore: false, error: null };
    // 空项目、空的临时任务列表：以前每 30 秒被清成骨架，总览退回「正在汇总」。
    expect(keepsViewWhileRefreshing({ ...settled, items: [] })).toBe(true);
    expect(keepsViewWhileRefreshing({ ...settled, items: [{ id: 1 }] })).toBe(true);
    // 读失败但手里有行：保留旧列表，只报错。
    expect(
      keepsViewWhileRefreshing({ items: [{ id: 1 }], loading: false, hasMore: true, error: 1 }),
    ).toBe(true);
  });

  it("还没读过、正在首读或首读失败且一行没有的，照旧显示加载态", () => {
    expect(
      keepsViewWhileRefreshing({ items: [], loading: false, hasMore: true, error: null }),
    ).toBe(false);
    expect(
      keepsViewWhileRefreshing({ items: [], loading: true, hasMore: false, error: null }),
    ).toBe(false);
    expect(
      keepsViewWhileRefreshing({ items: [], loading: false, hasMore: false, error: new Error() }),
    ).toBe(false);
  });

  it("源码契约：单来源与多来源两个 hook 都用同一个判据决定要不要清成加载态", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("const refreshing = !resume && keepsViewWhileRefreshing(current);");
    expect(source).toContain(
      "const refreshing = !resume && current !== null && keepsViewWhileRefreshing(current);",
    );
    // 只按「手里有没有行」判断，空的已结算列表每次刷新都会闪一下。
    expect(source).not.toMatch(/const refreshing = [^;]*items\.length > 0/u);
  });
});
