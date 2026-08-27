import { AtmError } from "@ayanami-task/errors";
import { describe, expect, it } from "vitest";
import { assertAcyclicDependency, assertParentMove } from "../src/index.js";

function captureAtmError(action: () => unknown): AtmError {
  try {
    action();
  } catch (error) {
    if (error instanceof AtmError) return error;
    throw error;
  }
  throw new Error("Expected action to throw AtmError");
}

describe("工作项图约束", () => {
  it("拒绝依赖环、层级环和超过八层的父项移动", () => {
    const dependencies = new Map([
      ["A", ["B"]],
      ["B", ["C"]],
      ["C", []],
    ]);
    expect(captureAtmError(() => assertAcyclicDependency("C", "A", dependencies))).toMatchObject({
      code: "DEPENDENCY_CYCLE",
      details: { task_id: "C", depends_on_id: "A", reason: "REACHES_TASK" },
    });

    const parents = new Map<string, string | null>([
      ["root", null],
      ["child", "root"],
      ["leaf", "child"],
    ]);
    expect(captureAtmError(() => assertParentMove("root", "leaf", parents))).toMatchObject({
      code: "HIERARCHY_CYCLE",
      details: { item_id: "root", parent_id: "leaf", reason: "PARENT_IS_DESCENDANT" },
    });

    const deep = new Map<string, string | null>();
    for (let index = 1; index <= 8; index += 1)
      deep.set(`n${index}`, index === 1 ? null : `n${index - 1}`);
    deep.set("moving", null);
    expect(captureAtmError(() => assertParentMove("moving", "n8", deep))).toMatchObject({
      code: "HIERARCHY_DEPTH",
      details: { item_id: "moving", parent_id: "n8", max_depth: 8, prospective_depth: 9 },
    });
  });
});
