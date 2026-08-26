import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { buildAyanamiServer } from "../src/index.js";

describe("项目进度 REST 回执", () => {
  it("结构化 completed 保留 camelCase workItemKey 并返回任务图回执", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-project-progress-receipt-"));
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });

    try {
      const project = await service.createProject({
        name: "Project progress receipt",
        sourcePath: null,
        code: "PGREST",
      });
      const objective = await service.createObjectiveAsUser(project.code, "receipt-objective", {
        title: "进度目标",
        description: "",
        definitionOfDone: [],
      });
      const created = await service.createWorkItemsAsUser(project.code, "receipt-task", [
        {
          clientRef: "receipt-task",
          objectiveId: objective.id,
          title: "已在本阶段覆盖",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
        },
      ]);
      const task = created.items[0]!;
      const begin = await service.begin({
        projectCode: project.code,
        mode: "project",
        agentId: "progress-receipt-test",
        role: "PRIMARY",
        signals: {},
      });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.code}/progress-updates`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: String(begin.session),
          opId: "structured-project-progress",
          scope: "project",
          summary: "完成一项可追溯工作",
          completed: [{ text: "完成任务图映射", workItemKey: task.key }],
          next: [],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        opId: "structured-project-progress",
        unlinked: false,
        openWorkItems: [],
      });

      const invalid = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.code}/progress-updates`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: String(begin.session),
          opId: "empty-structured-project-progress",
          scope: "project",
          summary: "对象字段不能绕过协议校验",
          completed: [{ text: "", workItemKey: task.key }],
        },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({
        error: {
          code: "INVALID_ARGUMENT",
          details: {
            issues: [expect.objectContaining({ path: "completed.0.text" })],
          },
        },
      });
    } finally {
      await app.close();
      service.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
