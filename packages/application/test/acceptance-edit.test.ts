import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function openFixture(code: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-acceptance-edit-"));
  temporary.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const project = await service.createProject({ name: "验收标准编辑", sourcePath: null, code });
  const begun = await service.begin({ projectCode: project.code, agentId: "acceptance-editor" });
  const objective = await service.createObjective(project.code, begun.session, {
    title: "保留任务历史",
    description: "",
    definitionOfDone: [],
  });
  const parent = (
    await service.createWorkItems(project.code, begun.session, "create-parent", [
      {
        clientRef: "parent",
        objectiveId: objective.id,
        title: "可修订验收标准的任务",
        description: "",
        type: "TASK",
        priority: "HIGH",
        status: "READY",
        acceptance: ["旧的验收标准"],
        checklist: [{ title: "已存在的检查项", evidenceRequired: false, weight: 1 }],
      },
    ])
  ).items[0]!;
  const child = (
    await service.createWorkItems(project.code, begun.session, "create-child", [
      {
        clientRef: "child",
        objectiveId: objective.id,
        parentKey: parent.key,
        title: "已存在的子任务",
        description: "",
        type: "SUBTASK",
        priority: "NORMAL",
        status: "READY",
      },
    ])
  ).items[0]!;
  return { service, project, session: begun.session, parent, child };
}

describe("WorkItem acceptance edit", () => {
  it("整体替换 acceptance，并保留原 checklist 与子任务", async () => {
    const ctx = await openFixture("ACCEPT");
    try {
      const before = await ctx.service.getWorkItem(ctx.project.code, ctx.parent.key);
      const updated = await ctx.service.patchWorkItems(
        ctx.project.code,
        ctx.session,
        "replace-acceptance",
        [
          {
            taskKey: before.key,
            expectedVersion: before.version,
            expectedFields: { acceptance: ["旧的验收标准"] },
            operation: "edit",
            acceptance: ["新的验收标准", "新标准可独立验证"],
          },
        ],
      );

      expect(updated.items[0]?.acceptance).toEqual(["新的验收标准", "新标准可独立验证"]);
      const readBack = await ctx.service.getWorkItem(ctx.project.code, ctx.parent.key);
      expect(readBack.acceptance).toEqual(["新的验收标准", "新标准可独立验证"]);
      expect(readBack.checklist).toEqual(before.checklist);
      const childReadBack = await ctx.service.getWorkItem(ctx.project.code, ctx.child.key);
      expect(childReadBack.parentId).toBe(ctx.parent.id);
    } finally {
      ctx.service.close();
    }
  });

  it("在事件增量中保留 acceptance 改写前后值", async () => {
    const ctx = await openFixture("ACAUDIT");
    try {
      const before = await ctx.service.getWorkItem(ctx.project.code, ctx.parent.key);
      await ctx.service.patchWorkItems(ctx.project.code, ctx.session, "audit-acceptance", [
        {
          taskKey: before.key,
          expectedVersion: before.version,
          operation: "edit",
          acceptance: ["审计后的标准"],
        },
      ]);

      const delta = await ctx.service.delta(ctx.project.code, 0, 100, ["work.updated"]);
      const event = delta.events.find((candidate) => candidate.opId === "audit-acceptance");
      expect(event).toMatchObject({
        key: ctx.parent.key,
        changes: {
          acceptance: {
            before: ["旧的验收标准"],
            after: ["审计后的标准"],
          },
        },
      });
    } finally {
      ctx.service.close();
    }
  });

  it("目标字段已被并发修改时拒绝 stale expected_fields 且零写入", async () => {
    const ctx = await openFixture("ACCONFLICT");
    try {
      const base = await ctx.service.getWorkItem(ctx.project.code, ctx.parent.key);
      const concurrent = await ctx.service.patchWorkItems(
        ctx.project.code,
        ctx.session,
        "concurrent-acceptance",
        [
          {
            taskKey: base.key,
            expectedVersion: base.version,
            operation: "edit",
            acceptance: ["并发写入的标准"],
          },
        ],
      );

      await expect(
        ctx.service.patchWorkItems(ctx.project.code, ctx.session, "stale-acceptance", [
          {
            taskKey: base.key,
            expectedVersion: base.version,
            expectedFields: { acceptance: ["旧的验收标准"] },
            operation: "edit",
            acceptance: ["不应覆盖并发值"],
          },
        ]),
      ).rejects.toThrow(`VERSION_CONFLICT: ${base.key}`);
      expect(await ctx.service.getWorkItem(ctx.project.code, base.key)).toMatchObject({
        acceptance: ["并发写入的标准"],
        version: concurrent.items[0]?.version,
      });
      const delta = await ctx.service.delta(ctx.project.code, 0, 100);
      expect(delta.events.some((event) => event.opId === "stale-acceptance")).toBe(false);
    } finally {
      ctx.service.close();
    }
  });

  it("全局版本漂移但 acceptance 未变时按 expected_fields 安全合并", async () => {
    const ctx = await openFixture("ACMERGE");
    try {
      const base = await ctx.service.getWorkItem(ctx.project.code, ctx.parent.key);
      const concurrent = await ctx.service.patchWorkItems(
        ctx.project.code,
        ctx.session,
        "concurrent-description",
        [
          {
            taskKey: base.key,
            expectedVersion: base.version,
            operation: "edit",
            description: "其他 Agent 更新的描述",
          },
        ],
      );
      const merged = await ctx.service.patchWorkItems(
        ctx.project.code,
        ctx.session,
        "merge-acceptance",
        [
          {
            taskKey: base.key,
            expectedVersion: base.version,
            expectedFields: { acceptance: ["旧的验收标准"] },
            operation: "edit",
            acceptance: ["安全合并后的标准"],
          },
        ],
      );

      expect(merged.items[0]).toMatchObject({
        description: "其他 Agent 更新的描述",
        acceptance: ["安全合并后的标准"],
        version: concurrent.items[0]!.version + 1,
      });
      expect(merged.merges).toEqual([
        {
          taskKey: base.key,
          expectedVersion: base.version,
          actualVersion: concurrent.items[0]!.version,
          fields: ["acceptance"],
        },
      ]);
    } finally {
      ctx.service.close();
    }
  });

  it("批量编辑中任一任务非法时回滚此前的 acceptance 改写", async () => {
    const ctx = await openFixture("ACROLLBACK");
    try {
      const base = await ctx.service.getWorkItem(ctx.project.code, ctx.parent.key);
      await expect(
        ctx.service.patchWorkItems(ctx.project.code, ctx.session, "rollback-acceptance", [
          {
            taskKey: base.key,
            expectedVersion: base.version,
            operation: "edit",
            acceptance: ["本应随批次回滚"],
          },
          {
            taskKey: "ACROLLBACK-T-9999",
            expectedVersion: 0,
            operation: "edit",
            acceptance: ["不存在的任务"],
          },
        ]),
      ).rejects.toThrow();
      expect(await ctx.service.getWorkItem(ctx.project.code, base.key)).toMatchObject({
        acceptance: ["旧的验收标准"],
        version: base.version,
      });
      const delta = await ctx.service.delta(ctx.project.code, 0, 100);
      expect(delta.events.some((event) => event.opId === "rollback-acceptance")).toBe(false);
    } finally {
      ctx.service.close();
    }
  });

  it("同一 opId 重放返回同一结果，身份漂移则拒绝", async () => {
    const ctx = await openFixture("ACREPLAY");
    try {
      const base = await ctx.service.getWorkItem(ctx.project.code, ctx.parent.key);
      const patch = {
        taskKey: base.key,
        expectedVersion: base.version,
        operation: "edit" as const,
        acceptance: ["幂等后的标准"],
      };
      const first = await ctx.service.patchWorkItems(ctx.project.code, ctx.session, "same-op", [
        patch,
      ]);
      expect(
        await ctx.service.patchWorkItems(ctx.project.code, ctx.session, "same-op", [patch]),
      ).toEqual(first);
      await expect(
        ctx.service.patchWorkItems(ctx.project.code, ctx.session, "same-op", [
          { ...patch, acceptance: ["改变幂等身份"] },
        ]),
      ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
      const delta = await ctx.service.delta(ctx.project.code, 0, 100);
      expect(delta.events.filter((event) => event.opId === "same-op")).toHaveLength(1);
    } finally {
      ctx.service.close();
    }
  });
});
