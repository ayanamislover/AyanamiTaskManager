import { describe, expect, it } from "vitest";
import {
  ChecklistUpdateInputSchema,
  ProgressAddInputSchema,
  WorkItemCreateInputSchema,
} from "../src/index.js";

describe("结构化证据与项目进度协议", () => {
  it("证据同时兼容字符串和可解引用的结构化形式", () => {
    const parsed = ChecklistUpdateInputSchema.parse({
      project: "ATM",
      session: "session",
      opId: "evidence",
      checklistId: "check",
      expectedVersion: 0,
      status: "DONE",
      evidence: [
        "packaged smoke 11/11",
        { kind: "git_sha", value: "abc123", note: "release candidate" },
        { kind: "atm_record", value: "ATM-R-001" },
        { kind: "atm_task", value: "ATM-T-0001" },
        { kind: "test_result", value: "vitest:green" },
        { kind: "url", value: "https://example.test/evidence" },
        { kind: "file", value: "R:/evidence/report.json" },
      ],
    });
    expect(parsed.evidence).toHaveLength(7);
    expect(() =>
      ChecklistUpdateInputSchema.parse({
        project: "ATM",
        session: "session",
        opId: "bad-evidence",
        checklistId: "check",
        expectedVersion: 0,
        status: "DONE",
        evidence: [{ kind: "unknown", value: "x" }],
      }),
    ).toThrow();
  });

  it("project progress completed 兼容字符串与 workItemKey 关联项", () => {
    const parsed = ProgressAddInputSchema.parse({
      project: "ATM",
      session: "session",
      opId: "completed",
      scope: "project",
      summary: "已完成",
      completed: ["历史文本", { text: "已完成子项", workItemKey: "ATM-T-0001" }],
      evidence: [
        { kind: "atm_task", value: "ATM-T-0001" },
        { kind: "atm_record", value: "ATM-R-001" },
      ],
    });
    expect(parsed.completed).toEqual([
      "历史文本",
      { text: "已完成子项", workItemKey: "ATM-T-0001" },
    ]);
    expect(parsed.evidence).toEqual([
      { kind: "atm_task", value: "ATM-T-0001" },
      { kind: "atm_record", value: "ATM-R-001" },
    ]);
  });

  it("创建工作项的协议原语可直接携带 assigneeAgentId", () => {
    expect(
      WorkItemCreateInputSchema.parse({
        clientRef: "review",
        objectiveId: "objective",
        title: "review",
        assigneeAgentId: "claude-reviewer",
      }).assigneeAgentId,
    ).toBe("claude-reviewer");
  });
});
