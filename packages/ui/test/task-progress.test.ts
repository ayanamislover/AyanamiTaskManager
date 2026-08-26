import { describe, expect, it } from "vitest";
import { taskProgressPresentation } from "../src/task-progress.js";

describe("taskProgressPresentation", () => {
  it("同时解释派生进度、报告进度、分母和阻塞原因", () => {
    expect(
      taskProgressPresentation({
        status: "BLOCKED",
        phase: "VERIFYING",
        waitingOn: "AGENT",
        waitingFor: "等待 REVIEW-T-0002",
        blockedReason: "候选哈希未确认",
        progress: 40,
        reportedProgress: 90,
        progressSource: "CHECKLIST",
        checklist: [
          { title: "构建", status: "DONE", weight: 2 },
          { title: "复核", status: "DOING", weight: 3 },
        ],
      }),
    ).toEqual({
      phase: "VERIFYING",
      waitingOn: "AGENT",
      phaseLabel: "验收中 · 等待 Agent",
      computed: 40,
      reported: 90,
      source: "CHECKLIST",
      doneWeight: 2,
      totalWeight: 5,
      doneStages: 1,
      totalStages: 2,
      blocker: "候选哈希未确认",
    });
  });

  it("为旧 WAITING 状态提供明确的兼容推断", () => {
    expect(
      taskProgressPresentation({
        status: "WAITING_USER",
        progress: 10,
        progressSource: "REPORTED",
        checklist: [],
      }),
    ).toMatchObject({
      phase: "IN_PROGRESS",
      waitingOn: "USER",
      phaseLabel: "执行中 · 等待用户",
      totalWeight: 0,
      totalStages: 0,
    });
  });
});
