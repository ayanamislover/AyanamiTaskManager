import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCancelledError } from "@tanstack/react-query";
import {
  cursorFetchResult,
  isActive,
  nextGeneration,
  pickOwnedEntry,
} from "../src/cursor-collection.js";

const sourcePath = join(process.cwd(), "packages", "ui", "src", "cursor-collection.ts");

function entry(owner: string, items: string[]) {
  return {
    owner,
    items,
    hasMore: false,
    loading: false,
    error: null,
    cursor: undefined,
    seenCursors: [],
  };
}

describe("列表数据的归属", () => {
  it("只接受属于当前 key 的那一份，按候选顺序取第一个命中", () => {
    const local = entry("tasks\u0000A", ["A-1"]);
    const cached = entry("tasks\u0000A", ["A-2"]);
    const other = entry("tasks\u0000B", ["B-1"]);

    expect(pickOwnedEntry("tasks\u0000A", local, cached)).toBe(local);
    // 本地那份属于别的 key 时（刚切过来），缓存里属于本 key 的要能顶上。
    expect(pickOwnedEntry("tasks\u0000A", other, cached)).toBe(cached);
    expect(pickOwnedEntry("tasks\u0000A", other, undefined, null)).toBeNull();
    expect(pickOwnedEntry("tasks\u0000B", other)).toBe(other);
    expect(pickOwnedEntry("tasks\u0000A")).toBeNull();
  });

  it("归属写在数据上，渲染与缓存接管都走同一判据", () => {
    const source = readFileSync(sourcePath, "utf8");
    for (const contract of [
      "pickOwnedEntry(key, entry, query.data)",
      "const owned = pickOwnedEntry(key, query.data);",
      "const current = pickOwnedEntry(key, entryRef.current) ?? emptyEntry<T>(key);",
      "if (next.owner !== keyRef.current) return;",
    ]) {
      expect(source).toContain(contract);
    }
    // 归属不能再挂回「哪次请求跑过」：命中新鲜缓存时 queryFn 根本不执行。
    expect(source).not.toContain("ownerRef");
  });
});

describe("被取代的那一轮读取", () => {
  const previous = entry("tasks\u0000A", ["A-1"]);

  it("作废时什么都不交，抛 CancelledError 让这一轮不留痕迹", () => {
    // 手里这份是开跑时拍下的快照：首轮被取代时它是空列表，刷新时它是上一版数据。
    // 两种都不能交出去——React Query 会把返回值当成功结果缓存，
    // 于是要么「成功读到 0 条」白屏，要么把界面上更新的那一份顶回旧版本。
    for (const snapshot of [
      { ...previous, items: [] as string[], loading: true },
      { ...previous, items: ["A-0"], loading: false },
    ]) {
      let thrown: unknown = null;
      try {
        cursorFetchResult({ ok: "stale" }, snapshot, false);
      } catch (error) {
        thrown = error;
      }
      expect(isCancelledError(thrown)).toBe(true);
    }
  });

  it("读完了照常结算", () => {
    const result = cursorFetchResult(
      {
        ok: true,
        state: { items: ["A-2"], hasMore: false, cursor: undefined, seenCursors: [], pageCount: 1 },
      },
      previous,
      false,
    );

    expect(result).toMatchObject({ items: ["A-2"], loading: false, error: null, hasMore: false });
  });

  it("一个 key 一个代数：开一轮新的不影响别的 key", () => {
    const generations = new Map<string, number>();
    const slow = nextGeneration(generations, "tasks\u0000SLOW");
    // 切到另一个项目：那边开新一轮，不该把 SLOW 这边还没读完的一轮判成作废。
    nextGeneration(generations, "tasks\u0000C");

    expect(isActive(generations, "tasks\u0000SLOW", slow)).toBe(true);
    // 同一个 key 再开一轮，前一轮才作废。
    const again = nextGeneration(generations, "tasks\u0000SLOW");
    expect(again).toBe(slow + 1);
    expect(isActive(generations, "tasks\u0000SLOW", slow)).toBe(false);
    expect(isActive(generations, "tasks\u0000SLOW", again)).toBe(true);
    // 没开过的 key 不算活跃，停用时的兜底代数也归它自己。
    expect(isActive(generations, "tasks\u0000NEW", 1)).toBe(false);
  });

  it("源码契约：作废按 key 计，切换项目不作废上一个项目的读取", () => {
    const source = readFileSync(sourcePath, "utf8");
    for (const contract of [
      "const generation = nextGeneration(generationsRef.current, key);",
      "const settled = cursorFetchResult(outcome, current, refreshing);",
      // 一轮读取可能跨过一次项目切换才读完，翻页要一直用开跑时那个 loader。
      "const load = loadRef.current;",
    ]) {
      expect(source).toContain(contract);
    }
    // 作废判据必须带上 key（换行由 Prettier 决定，这里不较真排版）。
    expect(source).toMatch(/isActive\(\s*generationsRef\.current,\s*key,\s*generation,?\s*\)/u);
    expect(source).not.toContain("loadRef.current(cursor)");
    // 作废的一轮一律不写界面：手里那份是开跑时的旧快照，提交回去会把新的顶没。
    expect(source).not.toMatch(/commit\([^)]*cursorFetchResult\(/u);
    expect(source).toContain('if (outcome.ok === "stale") return;');
    // 停用只挡显示，不改手里和缓存里的数据，重新打开才能立刻拿到完整结果。
    expect(source).toContain("const visible = !enabled");
    // 共用一个计数器时，切到别的 key 会把上一个 key 没读完的那一轮判成作废。
    expect(source).not.toMatch(/isActive\(generationRef/u);
    // 多项目版的 queryFn 返回的是共用的那张表，被接手的那一格还留着加载占位。
    expect(source).toContain(
      "if (settled.includes(false)) throw new CancelledError({ silent: true });",
    );
    // 多项目版按项目记代数：[X] 变成 [X, Y] 时两轮都在读 X，慢的那一轮不能清掉新的。
    expect(source).toMatch(
      /isActive\(\s*generationsRef\.current,\s*projectKey,\s*generation,?\s*\)/u,
    );
  });
});
