import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function openChecklistTask(code: string, evidenceRequired = false) {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-workflow-composites-"));
  temporary.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const project = await service.createProject({ name: "组合工作流", sourcePath: null, code });
  const begun = await service.begin({
    projectCode: project.code,
    agentId: "workflow-agent",
    displayName: "Workflow Agent",
    role: "PRIMARY",
  });
  const objective = await service.createObjective(project.code, begun.session, {
    title: "组合原语",
    description: "",
    definitionOfDone: [],
  });
  const created = await service.createWorkItems(project.code, begun.session, "create-task", [
    {
      clientRef: "task",
      objectiveId: objective.id,
      title: "批量完成验收项",
      type: "TASK",
      priority: "HIGH",
      status: "READY",
      verificationRequired: true,
      checklist: [
        { title: "测试", evidenceRequired },
        { title: "类型检查", evidenceRequired },
        { title: "集成验证", evidenceRequired },
      ],
    },
  ]);
  const started = await service.patchWorkItems(project.code, begun.session, "start-task", [
    {
      taskKey: created.items[0]!.key,
      expectedVersion: created.items[0]!.version,
      operation: "start",
    },
  ]);
  const task = await service.getWorkItem(project.code, started.items[0]!.key, "full");
  return { service, project, session: begun.session, task };
}

describe("高频工作流组合原语", () => {
  it("批量 checklist 只接收一个任务版本并让任务版本只推进一次", async () => {
    const ctx = await openChecklistTask("CBATCH");
    try {
      const beforeVersion = ctx.task.version;
      const result = await ctx.service.updateChecklistBatch(
        ctx.project.code,
        ctx.session,
        "checklist-batch-success",
        {
          taskKey: ctx.task.key,
          expectedVersion: beforeVersion,
          items: ctx.task.checklist.map((item) => ({
            checklistId: item.id,
            status: "DONE" as const,
          })),
        },
      );

      expect(result).toMatchObject({
        opId: "checklist-batch-success",
        taskKey: ctx.task.key,
        taskVersion: beforeVersion + 1,
        taskProgress: 99,
        updatedCount: 3,
      });
      expect(result.checklist).toHaveLength(3);
      expect(result.checklist.every((item) => item.status === "DONE")).toBe(true);
      expect((await ctx.service.getWorkItem(ctx.project.code, ctx.task.key, "full")).version).toBe(
        beforeVersion + 1,
      );
    } finally {
      ctx.service.close();
    }
  });

  it("批量 checklist 任一项非法时整批回滚且同一 opId 可修正重试", async () => {
    const ctx = await openChecklistTask("CROLLBACK", true);
    try {
      const beforeVersion = ctx.task.version;
      const operationId = "checklist-batch-retry";
      await expect(
        ctx.service.updateChecklistBatch(ctx.project.code, ctx.session, operationId, {
          taskKey: ctx.task.key,
          expectedVersion: beforeVersion,
          items: [
            {
              checklistId: ctx.task.checklist[0]!.id,
              status: "DONE",
              evidence: ["first evidence"],
            },
            { checklistId: ctx.task.checklist[1]!.id, status: "DONE", evidence: [] },
          ],
        }),
      ).rejects.toMatchObject({
        code: "COMPLETION_GATE_FAILED",
        details: {
          reasons: [{ checklist_id: ctx.task.checklist[1]!.id, code: "EVIDENCE_REQUIRED" }],
        },
      });

      const unchanged = await ctx.service.getWorkItem(ctx.project.code, ctx.task.key, "full");
      expect(unchanged.version).toBe(beforeVersion);
      expect(
        unchanged.checklist.map((item) => ({ status: item.status, version: item.version })),
      ).toEqual([
        { status: "TODO", version: 0 },
        { status: "TODO", version: 0 },
        { status: "TODO", version: 0 },
      ]);

      const retry = await ctx.service.updateChecklistBatch(
        ctx.project.code,
        ctx.session,
        operationId,
        {
          taskKey: ctx.task.key,
          expectedVersion: beforeVersion,
          items: [
            {
              checklistId: ctx.task.checklist[0]!.id,
              status: "DONE",
              evidence: ["first evidence"],
            },
            {
              checklistId: ctx.task.checklist[1]!.id,
              status: "DONE",
              evidence: ["second evidence"],
            },
          ],
        },
      );
      expect(retry).toMatchObject({ taskVersion: beforeVersion + 1, updatedCount: 2 });
    } finally {
      ctx.service.close();
    }
  });

  it("verifyAndComplete 在一个事务内留下可审计的 VERIFYING 到 DONE 转移", async () => {
    const ctx = await openChecklistTask("VCOMPLETE");
    try {
      const checked = await ctx.service.updateChecklistBatch(
        ctx.project.code,
        ctx.session,
        "prepare-verified-task",
        {
          taskKey: ctx.task.key,
          expectedVersion: ctx.task.version,
          items: ctx.task.checklist.map((item) => ({
            checklistId: item.id,
            status: "DONE" as const,
          })),
        },
      );
      const result = await ctx.service.verifyAndComplete(
        ctx.project.code,
        ctx.session,
        "verify-and-complete-success",
        {
          taskKey: ctx.task.key,
          expectedVersion: checked.taskVersion,
        },
      );

      expect(result).toMatchObject({
        opId: "verify-and-complete-success",
        taskKey: ctx.task.key,
        fromStatus: "IN_PROGRESS",
        status: "DONE",
        fromVersion: checked.taskVersion,
        taskVersion: checked.taskVersion + 2,
        transitions: ["VERIFYING", "DONE"],
      });
      expect((await ctx.service.getWorkItem(ctx.project.code, ctx.task.key)).status).toBe("DONE");
    } finally {
      ctx.service.close();
    }
  });

  it("verifyAndComplete 门禁失败不留下 VERIFYING 半状态", async () => {
    const ctx = await openChecklistTask("VROLLBACK");
    try {
      const before = await ctx.service.getWorkItem(ctx.project.code, ctx.task.key, "full");
      await expect(
        ctx.service.verifyAndComplete(
          ctx.project.code,
          ctx.session,
          "verify-and-complete-gate-failure",
          { taskKey: ctx.task.key, expectedVersion: before.version },
        ),
      ).rejects.toMatchObject({
        code: "COMPLETION_GATE_FAILED",
        details: {
          reasons: expect.arrayContaining([
            { checklist_id: ctx.task.checklist[0]!.id, code: "CHECKLIST_INCOMPLETE" },
          ]),
        },
      });

      const unchanged = await ctx.service.getWorkItem(ctx.project.code, ctx.task.key, "full");
      expect(unchanged).toMatchObject({ status: "IN_PROGRESS", version: before.version });
      expect(unchanged.checklist.every((item) => item.status === "TODO")).toBe(true);
    } finally {
      ctx.service.close();
    }
  });
});
