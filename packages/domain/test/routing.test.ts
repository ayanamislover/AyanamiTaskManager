import { describe, expect, it } from "vitest";
import { classifyTaskScope } from "../src/index.js";

describe("Quick Task 自动路由", () => {
  it("已有项目优先复用，复杂无项目工作才创建正式项目", () => {
    expect(classifyTaskScope({ matchedProject: true, explicitMode: "auto", signals: {} })).toEqual({
      scope: "project",
      score: 0,
      reason: "matched_project",
    });
    expect(
      classifyTaskScope({
        matchedProject: false,
        explicitMode: "auto",
        signals: { multiAgent: true },
      }),
    ).toMatchObject({ scope: "project", score: 3 });
    expect(
      classifyTaskScope({
        matchedProject: false,
        explicitMode: "auto",
        signals: { expectedMinutes: 10 },
      }),
    ).toMatchObject({ scope: "quick", score: 0 });
  });
});
