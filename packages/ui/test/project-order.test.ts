import { describe, expect, it } from "vitest";
import {
  moveProjectId,
  orderProjects,
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
});
