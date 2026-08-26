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

async function openRestTask(code: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-rest-workflow-composites-"));
  temporary.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const project = await service.createProject({ name: "REST 组合原语", sourcePath: null, code });
  const begun = await service.begin({ projectCode: project.code, agentId: "rest-workflow-agent" });
  const objective = await service.createObjective(project.code, begun.session, {
    title: "REST 组合原语",
    description: "",
    definitionOfDone: [],
  });
  const created = await service.createWorkItems(project.code, begun.session, "rest-create-task", [
    {
      clientRef: "task",
      objectiveId: objective.id,
      title: "REST 批量检查项",
      type: "TASK",
      priority: "HIGH",
      status: "READY",
      verificationRequired: true,
      checklist: [{ title: "测试" }, { title: "类型检查" }],
    },
  ]);
  const started = await service.patchWorkItems(project.code, begun.session, "rest-start-task", [
    {
      taskKey: created.items[0]!.key,
      expectedVersion: created.items[0]!.version,
      operation: "start",
    },
  ]);
  const task = await service.getWorkItem(project.code, started.items[0]!.key, "full");
  const app = await buildAyanamiServer({ service, token: "local-secret" });
  return { service, app, project, session: begun.session, task };
}

describe("REST 高频工作流组合原语", () => {
  it("用一个任务 expectedVersion 原子批量更新 checklist", async () => {
    const ctx = await openRestTask("RBATCH");
    try {
      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/api/v1/projects/${ctx.project.code}/checklist/batch`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: ctx.session,
          opId: "rest-checklist-batch",
          taskKey: ctx.task.key,
          expectedVersion: ctx.task.version,
          items: ctx.task.checklist.map((item) => ({
            checklistId: item.id,
            status: "DONE",
          })),
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        opId: "rest-checklist-batch",
        taskKey: ctx.task.key,
        taskVersion: ctx.task.version + 1,
        taskProgress: 99,
        updatedCount: 2,
      });
    } finally {
      await ctx.app.close();
      ctx.service.close();
    }
  });

  it("通过单个 REST 请求原子 verify_and_complete", async () => {
    const ctx = await openRestTask("RVCOMP");
    try {
      const checked = await ctx.service.updateChecklistBatch(
        ctx.project.code,
        ctx.session,
        "rest-prepare-complete",
        {
          taskKey: ctx.task.key,
          expectedVersion: ctx.task.version,
          items: ctx.task.checklist.map((item) => ({
            checklistId: item.id,
            status: "DONE" as const,
          })),
        },
      );
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/projects/${ctx.project.code}/work-items/${ctx.task.key}/verify-and-complete`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: ctx.session,
          opId: "rest-verify-and-complete",
          expectedVersion: checked.taskVersion,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        opId: "rest-verify-and-complete",
        taskKey: ctx.task.key,
        fromStatus: "IN_PROGRESS",
        status: "DONE",
        transitions: ["VERIFYING", "DONE"],
      });
    } finally {
      await ctx.app.close();
      ctx.service.close();
    }
  });
});
