import { describe, expect, it } from "vitest";
import { WorkItemPatchInputSchema } from "../src/index.js";

describe("WorkItem expectedFields 协议", () => {
  it("只接受覆盖全部编辑字段的白名单 snapshot", () => {
    expect(
      WorkItemPatchInputSchema.safeParse({
        taskKey: "ATM-T-0001",
        expectedVersion: 1,
        operation: "edit",
        title: "新标题",
        description: "新描述",
        expectedFields: { title: "旧标题", description: "旧描述" },
      }).success,
    ).toBe(true);

    expect(
      WorkItemPatchInputSchema.safeParse({
        taskKey: "ATM-T-0001",
        expectedVersion: 1,
        operation: "edit",
        title: "新标题",
        description: "新描述",
        expectedFields: { title: "旧标题" },
      }).success,
    ).toBe(false);
  });

  it("拒绝白名单外字段、非 edit 操作和 assignee 宽松合并", () => {
    const invalid = [
      {
        taskKey: "ATM-T-0001",
        expectedVersion: 1,
        operation: "edit",
        title: "新标题",
        expectedFields: { title: "旧标题", assigneeAgentId: "old-agent" },
      },
      {
        taskKey: "ATM-T-0001",
        expectedVersion: 1,
        operation: "start",
        expectedFields: { title: "旧标题" },
      },
      {
        taskKey: "ATM-T-0001",
        expectedVersion: 1,
        operation: "edit",
        assigneeAgentId: "new-agent",
        expectedFields: { title: "旧标题" },
      },
    ];
    for (const input of invalid) {
      expect(WorkItemPatchInputSchema.safeParse(input).success).toBe(false);
    }
  });
});
