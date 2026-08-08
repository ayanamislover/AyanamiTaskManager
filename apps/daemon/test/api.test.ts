import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { buildAyanamiServer } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("REST 边界", () => {
  it("提供保存视图和设置的版本化 API", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-api-settings-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    const headers = { authorization: "Bearer local-secret" };
    try {
      await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers,
        payload: { name: "视图 API", sourcePath: null, code: "VAPI" },
      });
      const view = await app.inject({
        method: "POST",
        url: "/api/v1/saved-views",
        headers,
        payload: {
          scope: "PROJECT",
          project: "VAPI",
          name: "已阻塞",
          query: { status: "BLOCKED" },
          sort: {},
        },
      });
      expect(view.statusCode).toBe(201);
      expect(
        (
          await app.inject({ method: "GET", url: "/api/v1/saved-views?project=VAPI", headers })
        ).json(),
      ).toContainEqual(expect.objectContaining({ name: "已阻塞", version: 0 }));
      const setting = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/backup.policy",
        headers,
        payload: { value: { enabled: true, dailyKeep: 7 }, expectedVersion: -1 },
      });
      expect(setting.statusCode).toBe(200);
      expect(setting.json()).toMatchObject({ key: "backup.policy", version: 0 });
      const metrics = await app.inject({
        method: "GET",
        url: "/api/v1/projects/VAPI/engineering-metrics",
        headers,
      });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.json()).toMatchObject({ available: false, reason: "NO_SOURCE_PATH" });
      const sourcePath = join(dataDir, "source");
      mkdirSync(sourcePath);
      const attached = await app.inject({
        method: "POST",
        url: "/api/v1/projects/VAPI/paths",
        headers,
        payload: { path: sourcePath, primary: true },
      });
      expect(attached.statusCode).toBe(200);
      expect(attached.json().sourcePaths).toEqual([resolve(sourcePath)]);
    } finally {
      await app.close();
      service.close();
    }
  });

  it("只接受本地 token，并让项目写入和读取走同一应用服务", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-api-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    try {
      expect((await app.inject({ method: "GET", url: "/api/v1/projects" })).statusCode).toBe(401);
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { authorization: "Bearer local-secret" },
        payload: { name: "API 测试", sourcePath: null },
      });
      expect(created.statusCode).toBe(201);
      const listed = await app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: { authorization: "Bearer local-secret" },
      });
      expect(listed.json()).toMatchObject([{ name: "API 测试", lifecycle: "ACTIVE" }]);
    } finally {
      await app.close();
      service.close();
    }
  });

  it("把 URL 查询参数规范化为协议数字类型", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-api-query-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/search?query=%E5%A4%87%E4%BB%BD%E6%81%A2%E5%A4%8D&limit=20",
        headers: { authorization: "Bearer local-secret" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ hits: [] });
    } finally {
      await app.close();
      service.close();
    }
  });

  it("通过同一应用服务提供项目备份目录与恢复入口", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-api-backup-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    const headers = { authorization: "Bearer local-secret" };
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers,
        payload: { name: "备份 API", sourcePath: null, code: "BAPI" },
      });
      expect(created.statusCode).toBe(201);
      const backup = await app.inject({
        method: "POST",
        url: "/api/v1/backups",
        headers,
        payload: { scope: "PROJECT", project: "BAPI" },
      });
      expect(backup.statusCode).toBe(201);
      const listed = await app.inject({
        method: "GET",
        url: "/api/v1/backups?project=BAPI",
        headers,
      });
      expect(listed.json()).toContainEqual(
        expect.objectContaining({ id: backup.json().id, verifiedAt: expect.any(String) }),
      );
      const restored = await app.inject({
        method: "POST",
        url: `/api/v1/backups/${backup.json().id}/restore`,
        headers,
      });
      expect(restored.statusCode).toBe(200);
      expect(restored.json().project).toMatchObject({ code: "BAPI", lifecycle: "ACTIVE" });
    } finally {
      await app.close();
      service.close();
    }
  });

  it("提供 Markdown 预览应用和三种项目导出格式", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-api-data-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    const headers = { authorization: "Bearer local-secret" };
    try {
      await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers,
        payload: { name: "交换 API", sourcePath: null, code: "DATA" },
      });
      const payload = {
        project: "DATA",
        sourceName: "agenttask.md",
        content: "# 交付\n- [ ] 导出",
      };
      const preview = await app.inject({
        method: "POST",
        url: "/api/v1/imports/agenttask-md/preview",
        headers,
        payload,
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({ taskCount: 1, alreadyImported: false });
      const applied = await app.inject({
        method: "POST",
        url: "/api/v1/imports/agenttask-md/apply",
        headers,
        payload: { ...payload, expectedSha256: preview.json().sha256 },
      });
      expect(applied.statusCode).toBe(200);
      expect(applied.json()).toMatchObject({ importedTasks: 1 });
      for (const format of ["aytproj", "json", "csv"]) {
        const exported = await app.inject({
          method: "GET",
          url: `/api/v1/exports/DATA?format=${format}`,
          headers,
        });
        expect(exported.statusCode).toBe(200);
        expect(exported.json()).toMatchObject({
          format,
          projectCode: "DATA",
          sha256: expect.any(String),
        });
      }
    } finally {
      await app.close();
      service.close();
    }
  });

  it("桌面用户写入使用 USER actor，不伪造 Agent 会话", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-api-user-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    const headers = { authorization: "Bearer local-secret" };
    try {
      await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers,
        payload: { name: "用户操作", sourcePath: null, code: "USER" },
      });
      const objective = await app.inject({
        method: "POST",
        url: "/api/v1/projects/USER/ui/objectives",
        headers,
        payload: {
          opId: "user-objective-1",
          title: "真实用户",
          description: "",
          definitionOfDone: [],
        },
      });
      expect(objective.statusCode).toBe(201);
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/projects/USER/ui/work-items",
        headers,
        payload: {
          opId: "user-task-1",
          items: [
            {
              clientRef: "one",
              objectiveId: objective.json().id,
              title: "用户任务",
              status: "READY",
            },
          ],
        },
      });
      expect(created.statusCode).toBe(201);
      const task = created.json().items[0];
      const started = await app.inject({
        method: "POST",
        url: "/api/v1/projects/USER/ui/work-items/patch",
        headers,
        payload: {
          opId: "user-start-1",
          items: [{ taskKey: task.key, expectedVersion: task.version, operation: "start" }],
        },
      });
      expect(started.statusCode).toBe(200);
      const detail = await app.inject({
        method: "GET",
        url: `/api/v1/projects/USER/work-items/${task.key}`,
        headers,
      });
      expect(detail.json()).toMatchObject({
        status: "IN_PROGRESS",
        assigneeAgentId: "USER",
        claimedBySessionId: null,
      });
      const agents = await app.inject({
        method: "GET",
        url: "/api/v1/projects/USER/agents",
        headers,
      });
      expect(agents.json()).toEqual([]);
    } finally {
      await app.close();
      service.close();
    }
  });
});
