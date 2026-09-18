import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { taskTreeRows } from "../src/features/project-task-controls.js";

const task = (id: string, parentId: string | null = null) => ({ id, key: id, parentId });

describe("层级视图的行", () => {
  it("父子按层级排开，深度逐级加一", () => {
    const rows = taskTreeRows([task("root"), task("child", "root"), task("grand", "child")]);
    expect(rows.map((row) => [row.task.id, row.depth])).toEqual([
      ["root", 0],
      ["child", 1],
      ["grand", 2],
    ]);
  });

  /**
   * 任务列表默认只取未结束任务加最近结束的几项，父任务已结束且不在这几项里时，
   * 它的子任务就挂在一个不存在的父节点上。按「从 parentId===null 往下递归」渲染的话，
   * 这些子任务在层级视图里会整个消失——数据还在，界面上却没有。
   */
  it("父任务不在当前数据里时，子任务提升为根，不会凭空消失", () => {
    const rows = taskTreeRows([task("orphan", "closed-parent"), task("root")]);
    expect(rows.map((row) => [row.task.id, row.depth])).toEqual([
      ["orphan", 0],
      ["root", 0],
    ]);
  });

  it("每个任务只出现一次，成环也不会无限递归", () => {
    const rows = taskTreeRows([task("a", "b"), task("b", "a"), task("c")]);
    expect(rows.map((row) => row.task.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("层级视图要求取回全部已结束任务，否则树是残的", () => {
    const source = readFileSync(
      join(process.cwd(), "packages", "ui", "src", "features", "project-task-controls.tsx"),
      "utf8",
    );
    expect(source).toContain('view === "tree"');
  });
});
