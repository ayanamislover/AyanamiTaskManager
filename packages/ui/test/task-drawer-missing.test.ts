import { describe, expect, it } from "vitest";
import { missingDetails } from "../src/features/task-drawer.js";

describe("任务抽屉「尚未填写」", () => {
  it("空着的详情收成一行，填了的不列", () => {
    expect(
      missingDetails({ description: "", acceptance: [], checklist: [], relations: [] }),
    ).toEqual(["说明", "验收标准", "检查项", "任务关系"]);
    expect(
      missingDetails({
        description: "写了",
        acceptance: ["能跑"],
        checklist: [{ id: "c" }],
        relations: [{ type: "PARENT" }],
      }),
    ).toEqual([]);
    expect(missingDetails({ description: "写了", acceptance: undefined })).toEqual([
      "验收标准",
      "检查项",
      "任务关系",
    ]);
  });
});
