import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function openCancelFixture(code: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-structured-cancel-"));
  temporary.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const project = await service.createProject({ name: "结构化取消", sourcePath: null, code });
  const begun = await service.begin({ projectCode: project.code, agentId: "cancel-agent" });
  const objective = await service.createObjective(project.code, begun.session, {
    title: "取消关系",
    description: "",
    definitionOfDone: [],
  });
  const created = await service.createWorkItems(project.code, begun.session, "cancel-create", [
    {
      clientRef: "target",
      objectiveId: objective.id,
      title: "待取消任务",
      type: "TASK",
      priority: "HIGH",
      status: "READY",
    },
    {
      clientRef: "canonical",
      objectiveId: objective.id,
      title: "规范任务",
      type: "TASK",
      priority: "HIGH",
      status: "READY",
    },
    {
      clientRef: "replacement",
      objectiveId: objective.id,
      title: "替代任务",
      type: "TASK",
      priority: "HIGH",
      status: "READY",
    },
  ]);
  const [target, canonical, replacement] = created.items;
  const started = await service.patchWorkItems(project.code, begun.session, "cancel-start", [
    { taskKey: target!.key, expectedVersion: target!.version, operation: "start" },
  ]);
  return {
    service,
    project,
    session: begun.session,
    target: started.items[0]!,
    canonical: canonical!,
    replacement: replacement!,
  };
}

describe("结构化取消", () => {
  it("持久化公开任务引用并让相同 opId 精确重放、身份漂移冲突", async () => {
    const ctx = await openCancelFixture("SCANCEL");
    try {
      const patch = {
        taskKey: ctx.target.key,
        expectedVersion: ctx.target.version,
        operation: "cancel" as const,
        cancelReason: "与规范任务重复，已有替代实现",
        duplicateOf: ctx.canonical.key,
        supersededBy: ctx.replacement.key,
      };
      const first = await ctx.service.patchWorkItems(
        ctx.project.code,
        ctx.session,
        "structured-cancel",
        [patch],
      );
      const replay = await ctx.service.patchWorkItems(
        ctx.project.code,
        ctx.session,
        "structured-cancel",
        [patch],
      );

      expect(first).toMatchObject({
        opId: "structured-cancel",
        items: [
          {
            key: ctx.target.key,
            status: "CANCELLED",
            cancelReason: "与规范任务重复，已有替代实现",
            duplicateOf: ctx.canonical.key,
            supersededBy: ctx.replacement.key,
          },
        ],
      });
      expect(replay).toEqual(first);
      expect(
        await ctx.service.getWorkItem(ctx.project.code, ctx.target.key, "context"),
      ).toMatchObject({ status: "CANCELLED" });

      await expect(
        ctx.service.patchWorkItems(ctx.project.code, ctx.session, "structured-cancel", [
          { ...patch, cancelReason: "不同的幂等身份" },
        ]),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        details: { session_id: ctx.session, operation_id: "structured-cancel" },
      });
    } finally {
      ctx.service.close();
    }
  });

  it("严格拒绝跨项目、未知或自引用 task key，并让整批取消回滚", async () => {
    const ctx = await openCancelFixture("SCREF");
    try {
      await expect(
        ctx.service.patchWorkItems(ctx.project.code, ctx.session, "invalid-cancel-batch", [
          {
            taskKey: ctx.canonical.key,
            expectedVersion: ctx.canonical.version,
            operation: "cancel",
            cancelReason: "这条本可成功但必须随批次回滚",
          },
          {
            taskKey: ctx.target.key,
            expectedVersion: ctx.target.version,
            operation: "cancel",
            duplicateOf: "OTHER-T-0001",
          },
        ]),
      ).rejects.toMatchObject({
        code: "WORK_ITEM_NOT_FOUND",
        details: { entity: "WORK_ITEM", reference: "OTHER-T-0001" },
      });
      expect(
        await ctx.service.getWorkItem(ctx.project.code, ctx.canonical.key, "full"),
      ).toMatchObject({
        status: "READY",
        version: ctx.canonical.version,
      });

      await expect(
        ctx.service.patchWorkItems(ctx.project.code, ctx.session, "self-cancel-reference", [
          {
            taskKey: ctx.target.key,
            expectedVersion: ctx.target.version,
            operation: "cancel",
            duplicateOf: ctx.target.key,
          },
        ]),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        details: { task_key: ctx.target.key, issue: "self_reference" },
      });
      expect((await ctx.service.getWorkItem(ctx.project.code, ctx.target.key)).status).toBe(
        "IN_PROGRESS",
      );
    } finally {
      ctx.service.close();
    }
  });
});
