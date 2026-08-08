import { describe, expect, it } from "vitest";
import { computeProgress } from "../src/index.js";

describe("可解释进度", () => {
  it("按子任务、检查项、报告值的优先级计算并限制未完成项为 99", () => {
    expect(
      computeProgress({
        status: "IN_PROGRESS",
        children: [
          { progress: 100, weight: 1, cancelled: false },
          { progress: 0, weight: 3, cancelled: false },
          { progress: 0, weight: 9, cancelled: true },
        ],
        checklist: [{ done: true, weight: 99 }],
        reported: 90,
      }),
    ).toEqual({ value: 25, source: "CHILDREN" });
    expect(
      computeProgress({
        status: "IN_PROGRESS",
        children: [],
        checklist: [{ done: true, weight: 1 }],
        reported: 100,
      }),
    ).toEqual({ value: 99, source: "CHECKLIST" });
    expect(
      computeProgress({ status: "DONE", children: [], checklist: [], reported: null }),
    ).toEqual({
      value: 100,
      source: "NONE",
    });
  });
});
