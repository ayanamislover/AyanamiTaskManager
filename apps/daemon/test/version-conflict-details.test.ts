import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { buildAyanamiServer } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("VERSION_CONFLICT 可操作详情", () => {
  it("返回冲突实体快照与相关最近变更，并让整个批次无写入无事件", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-version-details-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "版本冲突详情",
      sourcePath: null,
      code: "VDETAIL",
    });
    const begun = await service.begin({ projectCode: project.code, agentId: "version-agent" });
    const objective = await service.createObjective(project.code, begun.session, {
      title: "冲突诊断",
      description: "",
      definitionOfDone: [],
    });
    const created = await service.createWorkItems(project.code, begun.session, "create-conflicts", [
      {
        clientRef: "unrelated",
        objectiveId: objective.id,
        title: "批次中不应落库的任务",
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
      },
      {
        clientRef: "conflict",
        objectiveId: objective.id,
        title: "真正冲突的任务",
        description: "旧描述",
        type: "TASK",
        priority: "HIGH",
        status: "READY",
      },
    ]);
    const [unrelated, conflict] = created.items;
    const concurrent = await service.patchWorkItems(
      project.code,
      begun.session,
      "concurrent-change",
      [
        {
          taskKey: conflict!.key,
          expectedVersion: conflict!.version,
          operation: "edit",
          description: "服务端并发新描述",
        },
      ],
    );
    const sequenceBefore = (await service.delta(project.code, 0, 100)).currentSequence;
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.code}/work-items/patch`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: begun.session,
          opId: "conflicting-batch",
          items: [
            {
              taskKey: unrelated!.key,
              expectedVersion: unrelated!.version,
              operation: "edit",
              title: "绝不能落库",
            },
            {
              taskKey: conflict!.key,
              expectedVersion: conflict!.version,
              operation: "edit",
              description: "客户端陈旧覆盖",
            },
          ],
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          code: "VERSION_CONFLICT",
          message: "WorkItem 版本已变化",
          details: {
            entity: "WORK_ITEM",
            key: conflict!.key,
            expected: conflict!.version,
            actual: concurrent.items[0]!.version,
            task_key: conflict!.key,
            expected_version: conflict!.version,
            current_version: concurrent.items[0]!.version,
            current: {
              key: conflict!.key,
              version: concurrent.items[0]!.version,
              title: "真正冲突的任务",
              description: "服务端并发新描述",
              status: "READY",
            },
            recent_changes: expect.any(Array),
            changes_complete: false,
          },
        },
      });
      const details = response.json().error.details as {
        recent_changes: Array<{ key: string }>;
      };
      expect(details.recent_changes.length).toBeGreaterThan(0);
      expect(details.recent_changes.length).toBeLessThanOrEqual(6);
      expect(details.recent_changes.every((change) => change.key === conflict!.key)).toBe(true);

      expect(await service.getWorkItem(project.code, unrelated!.key)).toMatchObject({
        title: "批次中不应落库的任务",
        version: unrelated!.version,
      });
      expect((await service.delta(project.code, 0, 100)).currentSequence).toBe(sequenceBefore);
    } finally {
      await app.close();
      service.close();
    }
  });

  it("单项 checklist 冲突返回 typed code 并补充 checklist 与所属公开 task 快照", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-checklist-version-details-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "Checklist 版本冲突详情",
      sourcePath: null,
      code: "CVDETAIL",
    });
    const begun = await service.begin({ projectCode: project.code, agentId: "checklist-agent" });
    const objective = await service.createObjective(project.code, begun.session, {
      title: "Checklist 冲突诊断",
      description: "",
      definitionOfDone: [],
    });
    const created = await service.createWorkItems(project.code, begun.session, "create-checklist", [
      {
        clientRef: "task",
        objectiveId: objective.id,
        title: "含检查项任务",
        type: "TASK",
        priority: "HIGH",
        status: "READY",
        checklist: [{ title: "真实检查项" }],
      },
    ]);
    const task = await service.getWorkItem(project.code, created.items[0]!.key, "full");
    const checklist = task.checklist[0]!;
    await service.updateChecklist(project.code, begun.session, "concurrent-checklist", {
      checklistId: checklist.id,
      expectedVersion: checklist.version,
      status: "DOING",
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    try {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/projects/${project.code}/checklist/${checklist.id}`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: begun.session,
          opId: "stale-checklist",
          expectedVersion: checklist.version,
          status: "DONE",
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          code: "VERSION_CONFLICT",
          message: "检查项版本已变化",
          details: {
            entity: "CHECKLIST",
            key: checklist.id,
            expected: 0,
            actual: 1,
            checklist_id: checklist.id,
            task_key: task.key,
            expected_version: 0,
            current_version: 1,
            current: {
              id: checklist.id,
              task_key: task.key,
              title: "真实检查项",
              status: "DOING",
              version: 1,
            },
            recent_changes: expect.any(Array),
            changes_complete: false,
          },
        },
      });
      expect(
        (response.json().error.details.recent_changes as Array<{ key: string }>).every(
          (change) => change.key === checklist.id,
        ),
      ).toBe(true);
    } finally {
      await app.close();
      service.close();
    }
  });
});
