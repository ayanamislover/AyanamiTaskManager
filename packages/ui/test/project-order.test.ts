import { describe, expect, it } from "vitest";
import {
  mergeProjectOrder,
  moveProjectId,
  orderProjects,
  projectOrderAfterDrop,
  projectOrderAfterNudge,
  projectOrderFromSetting,
  reorderProjectIds,
} from "../src/project-order.js";

const projects = ["a", "b", "c", "d"].map((id) => ({ id, name: id.toUpperCase() }));

describe("项目手动顺序", () => {
  it("认不出来的设置值当作没排过，重复和非字符串一律丢掉", () => {
    expect(projectOrderFromSetting(undefined)).toEqual([]);
    expect(projectOrderFromSetting(null)).toEqual([]);
    expect(projectOrderFromSetting({ ids: "b,a" })).toEqual([]);
    expect(projectOrderFromSetting({ ids: ["b", "b", 7, "", "a"] })).toEqual(["b", "a"]);
  });

  it("排过的按顺序在前，没排过的留在后面且保持原有次序", () => {
    // 新建的项目不在顺序表里：既不能丢，也不该插到排好的队伍中间。
    expect(orderProjects(projects, ["c", "a"]).map((project) => project.id)).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
    expect(orderProjects(projects, []).map((project) => project.id)).toEqual(["a", "b", "c", "d"]);
    // 顺序表里有已经删掉的项目时，不会凭空多出来。
    expect(orderProjects(projects, ["zz", "d"]).map((project) => project.id)).toEqual([
      "d",
      "a",
      "b",
      "c",
    ]);
  });

  it("拖动落点：放到某一项之前，或者放到末尾", () => {
    const visible = ["a", "b", "c", "d"];
    expect(reorderProjectIds(visible, "d", "b")).toEqual(["a", "d", "b", "c"]);
    expect(reorderProjectIds(visible, "a", null)).toEqual(["b", "c", "d", "a"]);
    expect(reorderProjectIds(visible, "a", "a")).toEqual(visible);
    // 目标已经不在了（另一端刚删掉项目）就原样不动，别把它甩到末尾去。
    expect(reorderProjectIds(visible, "a", "zz")).toEqual(visible);
  });

  it("键盘上下挪一格，到头了不动", () => {
    const visible = ["a", "b", "c"];
    expect(moveProjectId(visible, "c", -1)).toEqual(["a", "c", "b"]);
    expect(moveProjectId(visible, "a", 1)).toEqual(["b", "a", "c"]);
    expect(moveProjectId(visible, "a", -1)).toEqual(visible);
    expect(moveProjectId(visible, "c", 1)).toEqual(visible);
    expect(moveProjectId(visible, "zz", 1)).toEqual(visible);
  });

  /**
   * 侧栏只列 ACTIVE 项目，重排后却把这一屏整份存成了 projects.order——归档项目的手动位置
   * 就此消失。原来的用例全都假设「visible 就是全量列表」，所以这条路一直没人走过。
   */
  it("这一屏只是子集时，没显示的项目留在原位", () => {
    // 全局 [c(归档), b, a]；侧栏只看得到 b、a。
    expect(mergeProjectOrder(["c", "b", "a"], ["a", "b"])).toEqual(["c", "a", "b"]);
    // 没排过的项目第一次排序：完整表是空的，这一屏就是全部。
    expect(mergeProjectOrder([], ["b", "a"])).toEqual(["b", "a"]);
    // 这一屏出现了完整表还没有的新项目，补在末尾而不是插队。
    expect(mergeProjectOrder(["c", "a"], ["a", "zz"])).toEqual(["c", "a", "zz"]);
    // 归档项目夹在中间时也守住自己的槽位。
    expect(mergeProjectOrder(["a", "c", "b"], ["b", "a"])).toEqual(["b", "c", "a"]);
  });

  it("存盘前算出来的是完整顺序表，不是这一屏", () => {
    // codex 在真实 Chromium 里复现的那一步：侧栏选中甲，按 Alt+↑，只想和乙调换。
    const stored = ["c", "b", "a"];
    const visible = ["b", "a"];
    expect(projectOrderAfterNudge(stored, visible, "a", -1)).toEqual(["c", "a", "b"]);
    expect(projectOrderAfterDrop(stored, visible, "a", "b")).toEqual(["c", "a", "b"]);
    // 拖到末尾同样不能把 c 甩掉。
    expect(projectOrderAfterDrop(stored, visible, "b", null)).toEqual(["c", "a", "b"]);
    // 这一屏就是全量时，行为和以前一致。
    expect(projectOrderAfterNudge(["a", "b", "c"], ["a", "b", "c"], "c", -1)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });
});
