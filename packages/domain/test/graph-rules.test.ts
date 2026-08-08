import { describe, expect, it } from "vitest";
import { assertAcyclicDependency, assertParentMove } from "../src/index.js";

describe("工作项图约束", () => {
  it("拒绝依赖环、层级环和超过八层的父项移动", () => {
    const dependencies = new Map([
      ["A", ["B"]],
      ["B", ["C"]],
      ["C", []],
    ]);
    expect(() => assertAcyclicDependency("C", "A", dependencies)).toThrowError("DEPENDENCY_CYCLE");

    const parents = new Map<string, string | null>([
      ["root", null],
      ["child", "root"],
      ["leaf", "child"],
    ]);
    expect(() => assertParentMove("root", "leaf", parents)).toThrowError("HIERARCHY_CYCLE");

    const deep = new Map<string, string | null>();
    for (let index = 1; index <= 8; index += 1)
      deep.set(`n${index}`, index === 1 ? null : `n${index - 1}`);
    deep.set("moving", null);
    expect(() => assertParentMove("moving", "n8", deep)).toThrowError("HIERARCHY_DEPTH");
  });
});
