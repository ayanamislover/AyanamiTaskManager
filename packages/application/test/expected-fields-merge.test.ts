import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function openMergeFixture(code: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-expected-fields-"));
  temporary.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const project = await service.createProject({ name: "字段级并发合并", sourcePath: null, code });
  const begun = await service.begin({ projectCode: project.code, agentId: "merge-agent" });
  const objective = await service.createObjective(project.code, begun.session, {
    title: "安全合并",
    description: "",
    definitionOfDone: [],
  });
  const created = await service.createWorkItems(project.code, begun.session, "merge-create", [
    {
      clientRef: "task",
      objectiveId: objective.id,
      title: "原始标题",
      description: "原始描述",
      type: "TASK",
      priority: "HIGH",
      status: "READY",
    },
  ]);
  return { service, project, session: begun.session, task: created.items[0]! };
}

describe("字段级 compare-and-swap 合并", () => {
  it("全局版本漂移但目标字段未变时安全合并，同字段已变时仍冲突", async () => {
    const ctx = await openMergeFixture("FMERGE");
    try {
      const base = ctx.task;
      const concurrent = await ctx.service.patchWorkItems(
        ctx.project.code,
        ctx.session,
        "edit-description",
        [
          {
            taskKey: base.key,
            expectedVersion: base.version,
            operation: "edit",
            description: "其他 Agent 更新的描述",
          },
        ],
      );
      const mergePatch = {
        taskKey: base.key,
        expectedVersion: base.version,
        expectedFields: { title: "原始标题" },
        operation: "edit" as const,
        title: "安全合并后的标题",
      };
      const merged = await ctx.service.patchWorkItems(
        ctx.project.code,
        ctx.session,
        "merge-title",
        [mergePatch],
      );

      expect(merged.items[0]).toMatchObject({
        title: "安全合并后的标题",
        description: "其他 Agent 更新的描述",
        version: concurrent.items[0]!.version + 1,
      });
      expect(merged.merges).toEqual([
        {
          taskKey: base.key,
          expectedVersion: base.version,
          actualVersion: concurrent.items[0]!.version,
          fields: ["title"],
        },
      ]);
      expect(
        await ctx.service.patchWorkItems(ctx.project.code, ctx.session, "merge-title", [
          mergePatch,
        ]),
      ).toEqual(merged);
      await expect(
        ctx.service.patchWorkItems(ctx.project.code, ctx.session, "merge-title", [
          { ...mergePatch, expectedFields: { title: "不同的幂等身份" } },
        ]),
      ).rejects.toThrow("IDEMPOTENCY_CONFLICT");

      await expect(
        ctx.service.patchWorkItems(ctx.project.code, ctx.session, "stale-title", [
          {
            taskKey: base.key,
            expectedVersion: base.version,
            expectedFields: { title: "原始标题" },
            operation: "edit",
            title: "不应覆盖新标题",
          },
        ]),
      ).rejects.toThrow(`VERSION_CONFLICT: ${base.key}`);
      expect((await ctx.service.getWorkItem(ctx.project.code, base.key)).title).toBe(
        "安全合并后的标题",
      );
    } finally {
      ctx.service.close();
    }
  });

  it("缺少任一被改字段快照、状态动作或 assignee 修改都保持严格版本锁", async () => {
    const ctx = await openMergeFixture("FSTRICT");
    try {
      const base = ctx.task;
      await ctx.service.patchWorkItems(ctx.project.code, ctx.session, "advance-version", [
        {
          taskKey: base.key,
          expectedVersion: base.version,
          operation: "edit",
          description: "推动全局版本但不动标题",
        },
      ]);

      const unsafePatches = [
        {
          taskKey: base.key,
          expectedVersion: base.version,
          expectedFields: { title: "原始标题" },
          operation: "edit",
          title: "不能部分合并",
          description: "缺少 description compare value",
        },
        {
          taskKey: base.key,
          expectedVersion: base.version,
          expectedFields: { title: "原始标题" },
          operation: "start",
        },
        {
          taskKey: base.key,
          expectedVersion: base.version,
          expectedFields: { title: "原始标题" },
          operation: "edit",
          assigneeAgentId: "other-agent",
        },
      ];
      for (const [index, patch] of unsafePatches.entries()) {
        await expect(
          ctx.service.patchWorkItems(ctx.project.code, ctx.session, `strict-stale-${index}`, [
            patch,
          ]),
        ).rejects.toThrow(`VERSION_CONFLICT: ${base.key}`);
      }

      expect(await ctx.service.getWorkItem(ctx.project.code, base.key)).toMatchObject({
        title: "原始标题",
        description: "推动全局版本但不动标题",
        assigneeAgentId: null,
        status: "READY",
      });
    } finally {
      ctx.service.close();
    }
  });
});
