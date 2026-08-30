import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { format } from "prettier";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { createAtmTaskPatchTool } from "../src/tools/actions/task-patch.js";
import {
  compositeTaskPatchOperationNames,
  generateCompositeTaskPatchDocumentation,
  TASK_PATCH_COMPOSITE_DOCS,
  TASK_PATCH_COMPOSITE_DOCUMENTATION_BEGIN,
  TASK_PATCH_COMPOSITE_DOCUMENTATION_END,
} from "../src/task-patch-composite-contract.js";

const tool = createAtmTaskPatchTool({} as AyanamiTaskService);

function markedSection(content: string): string {
  const start = content.indexOf(TASK_PATCH_COMPOSITE_DOCUMENTATION_BEGIN);
  const finish = content.indexOf(TASK_PATCH_COMPOSITE_DOCUMENTATION_END);
  if (start < 0 || finish < start) throw new Error("TASK_PATCH_COMPOSITE_MARKERS_MISSING");
  return content.slice(start, finish + TASK_PATCH_COMPOSITE_DOCUMENTATION_END.length);
}

describe("composite 任务操作契约", () => {
  it("registry 里每个 composite 操作都有文档条目", () => {
    expect([...TASK_PATCH_COMPOSITE_DOCS].map((entry) => entry.operation).sort()).toEqual(
      [...compositeTaskPatchOperationNames()].sort(),
    );
  });

  // 示例是手写的，唯一防漂手段就是拿真实校验器过一遍：schema 一改，示例立刻红。
  it.each(TASK_PATCH_COMPOSITE_DOCS.map((entry) => [entry.operation, entry] as const))(
    "%s 的文档示例能通过 atm_task_patch 的真实校验",
    (_operation, entry) => {
      const result = tool.inputSchema.safeParse({
        project: "ATM",
        session: "01M17TQ289BXR6ZWFRVTE33TC2",
        op_id: "composite-doc-example",
        items: [entry.example],
      });
      expect(result.success ? null : JSON.stringify(result.error.issues)).toBeNull();
    },
  );

  it("阳性对照：示例少了必填字段就应该被拒", () => {
    const checklist = TASK_PATCH_COMPOSITE_DOCS.find(
      (entry) => entry.operation === "checklist_batch",
    );
    if (!checklist) throw new Error("MISSING_CHECKLIST_BATCH_DOC");
    const withoutItems = Object.fromEntries(
      Object.entries(checklist.example).filter(([key]) => key !== "checklist_items"),
    );
    const result = tool.inputSchema.safeParse({
      project: "ATM",
      session: "01M17TQ289BXR6ZWFRVTE33TC2",
      op_id: "composite-doc-negative",
      items: [withoutItems],
    });
    expect(result.success).toBe(false);
  });

  it("生成物与生成器保持一致", async () => {
    // 生成脚本写入前过了一道 prettier，这里必须用同一道，否则比的是排版差异而非内容漂移。
    const expected = markedSection(
      (await format(generateCompositeTaskPatchDocumentation(), { parser: "markdown" })).trim(),
    );
    expect(markedSection(readFileSync("docs/generated/work-item-operations.md", "utf8"))).toBe(
      expected,
    );
    expect(markedSection(readFileSync("ATM_AGENT_GUIDE.md", "utf8"))).toBe(expected);
  });
});

describe("atm_task_patch 的校验错误定位", () => {
  function firstIssue(items: unknown): { path: string; message: string } {
    const result = tool.inputSchema.safeParse({
      project: "ATM",
      session: "01M17TQ289BXR6ZWFRVTE33TC2",
      op_id: "error-path",
      items,
    });
    if (result.success) throw new Error("EXPECTED_VALIDATION_FAILURE");
    const issue = result.error.issues[0];
    if (!issue) throw new Error("EXPECTED_AT_LEAST_ONE_ISSUE");
    return { path: issue.path.join("."), message: issue.message };
  }

  // 曾经这些都只报 "No matching discriminator: operation" 并列出全部 16 个 operation——
  // 指着唯一写对的字段报错，调用方只能穷举形状。
  it("叶子类型错误指向该叶子，而不是 operation", () => {
    expect(
      firstIssue([
        {
          operation: "checklist_batch",
          task_key: "ATM-T-0001",
          expected_version: 4,
          checklist_items: [{ id: "C1", status: "DONE", evidence: "scratchpad/x.txt" }],
        },
      ]).path,
    ).toBe("items.0.checklist_items.0.evidence");
  });

  it("枚举错误指向该字段并列出合法取值", () => {
    const issue = firstIssue([
      {
        operation: "checklist_batch",
        task_key: "ATM-T-0001",
        expected_version: 4,
        checklist_items: [{ id: "C1", status: "FINISHED" }],
      },
    ]);
    expect(issue.path).toBe("items.0.checklist_items.0.status");
    expect(issue.message).toContain("TODO");
  });

  it("composite 与状态操作混批时给出成批规则，而不是类型错误", () => {
    const issue = firstIssue([
      { operation: "verify", task_key: "ATM-T-0001", expected_version: 1 },
      {
        operation: "checklist_batch",
        task_key: "ATM-T-0002",
        expected_version: 1,
        checklist_items: [{ id: "C1", status: "DONE" }],
      },
    ]);
    expect(issue.path).toBe("items");
    expect(issue.message).toContain("只允许一个元素");
  });

  // 另一个 agent 照 Guide 的「claim → start」写、漏掉 expected_version 时踩到过：
  // 当时同样只报 `→ at items`，看不出缺的是哪个字段。
  it("必填字段缺失指向该字段，而不是容器", () => {
    expect(firstIssue([{ operation: "claim", task_key: "ATM-T-0001" }]).path).toBe(
      "items.0.expected_version",
    );
    expect(firstIssue([{ operation: "start", expected_version: 3 }]).path).toBe("items.0.task_key");
    expect(
      firstIssue([{ operation: "block", task_key: "ATM-T-0001", expected_version: 3 }]).path,
    ).toBe("items.0.blocked_reason");
  });

  it("operation 确实写错时才指向 operation", () => {
    expect(
      firstIssue([{ operation: "checklist_nope", task_key: "ATM-T-0001", expected_version: 1 }])
        .path,
    ).toBe("items.0.operation");
  });
});
