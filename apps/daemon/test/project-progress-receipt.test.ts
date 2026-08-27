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
      const record = await service.createRecord(
        project.code,
        String(begin.session),
        "project-progress-record",
        {
          kind: "FACT",
          title: "Progress evidence record",
          summary: "REST project progress references this public record key.",
        },
      );
      const evidence = [
        { kind: "atm_task", value: task.key, note: "linked task" },
        { kind: "atm_record", value: record.key },
        { kind: "test_result", value: "project-progress:green" },
      ];
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
          evidence,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        opId: "structured-project-progress",
        evidence,
        unlinked: false,
        openWorkItems: [],
      });

      const updateId = String(response.json().id);
      const exact = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.code}/project-updates/${updateId}`,
        headers: { authorization: "Bearer local-secret" },
      });
      expect(exact.statusCode).toBe(200);
      expect(exact.json()).toMatchObject({
        id: updateId,
        opId: "structured-project-progress",
        evidence,
      });

      const trace = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.code}/operations/structured-project-progress?session=${encodeURIComponent(String(begin.session))}`,
        headers: { authorization: "Bearer local-secret" },
      });
      expect(trace.statusCode).toBe(200);
      expect(trace.json()).toMatchObject({
        opId: "structured-project-progress",
        projectUpdates: [expect.objectContaining({ id: updateId, evidence })],
      });

      const internalRecordId = (await service.getRecord(project.code, record.key)).id;
      const invalidEvidence = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.code}/progress-updates`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: String(begin.session),
          opId: "invalid-project-progress-evidence",
          scope: "project",
          summary: "Internal ids are not public evidence references",
          evidence: [{ kind: "atm_record", value: internalRecordId }],
        },
      });
      expect(invalidEvidence.statusCode).toBe(404);
      expect(invalidEvidence.json()).toMatchObject({
        error: { code: "RECORD_NOT_FOUND" },
      });
      expect(await service.listProjectUpdates(project.code)).toHaveLength(1);
      const missingTrace = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.code}/operations/invalid-project-progress-evidence`,
        headers: { authorization: "Bearer local-secret" },
      });
      expect(missingTrace.statusCode).toBe(404);
      expect(missingTrace.json()).toMatchObject({ error: { code: "OPERATION_NOT_FOUND" } });

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
