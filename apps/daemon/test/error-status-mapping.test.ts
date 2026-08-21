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

describe("永久性前置条件失败不能伪装成服务端故障", () => {
  // 带 op_id 的调用方就是崩溃重放控制器：它按状态码决定要不要再试一次。
  // 项目不存在是永久失败，重试一万次也不会变；回 500 等于叫它无限重试。
  // statusForCode 匹配的是 REQUIRED，而这条错误码写的是 REQUIRES，一个字母之差
  // 让它落到兜底的 500。
  it("op_id 指向不存在的项目时回 4xx，而真正的内部故障仍然回 500", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-status-map-"));
    temporary.push(dataDir);
    const migrationsRoot = resolve(process.cwd(), "migrations");
    const unmatchedRoot = join(dataDir, "unmatched-workspace");
    mkdirSync(unmatchedRoot);
    const service = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    const headers = { authorization: "Bearer local-secret" };

    try {
      const missingProject = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers,
        payload: {
          operationId: "status-map-missing-project",
          mode: "project",
          cwd: unmatchedRoot,
          agentId: "status-map",
          signals: {},
        },
      });
      expect(missingProject.statusCode).toBeLessThan(500);
      expect(missingProject.statusCode).toBeGreaterThanOrEqual(400);
      expect(missingProject.json()).toMatchObject({
        error: { code: "ATOMIC_BEGIN_REQUIRES_EXISTING_PROJECT" },
      });

      // 阳性对照：兜底的 500 必须还在，否则这条守卫只是把所有错误压成 4xx。
      const workspaceRoot = join(dataDir, "workspace");
      mkdirSync(workspaceRoot);
      const project = await service.createProject({
        name: "Status mapping",
        sourcePath: workspaceRoot,
        code: "SMAP",
      });
      const database = await service.databases.openProject(project.code);
      database.sqlite.exec(`
        CREATE TRIGGER reject_status_map_begin
        BEFORE INSERT ON idempotency_keys
        WHEN NEW.key = 'session-begin:status-map-internal'
        BEGIN
          SELECT RAISE(ABORT, 'injected publication failure');
        END;
      `);
      const internal = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers,
        payload: {
          operationId: "status-map-internal",
          mode: "project",
          projectCode: project.code,
          cwd: workspaceRoot,
          agentId: "status-map",
          signals: {},
        },
      });
      expect(internal.statusCode).toBe(500);
      expect(internal.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    } finally {
      await app.close();
      service.close();
    }
  }, 60_000);
});
