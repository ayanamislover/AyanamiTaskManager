import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  it("doctor 状态按生命周期报告所有项目库计数和失败", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-api-doctor-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const active = await service.createProject({ name: "活动项目", sourcePath: null });
    const archived = await service.createProject({ name: "归档项目", sourcePath: null });
    const trashed = await service.createProject({ name: "垃圾箱项目", sourcePath: null });
    await service.archiveProject(archived.code);
    await service.trashProject(trashed.code);
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    try {
      const status = await app.inject({
        method: "GET",
        url: "/api/v1/system/status",
        headers: { authorization: "Bearer local-secret" },
      });

      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        ok: true,
        projectCount: 3,
        projectCounts: {
          ACTIVE: { total: 1, failed: 0 },
          ARCHIVED: { total: 1, failed: 0 },
          TRASHED: { total: 1, failed: 0 },
        },
        projectFailures: [],
      });
      expect(active.lifecycle).toBe("ACTIVE");
    } finally {
      await app.close();
      service.close();
    }
  });

  it("按 operationId 原子恢复同一 Session，并拒绝身份漂移", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-api-session-begin-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "REST atomic begin",
      sourcePath: null,
      code: "RBEGIN",
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    const headers = { authorization: "Bearer local-secret" };
    const payload = {
      operationId: "rest-session-begin-same-request",
      mode: "project",
      projectCode: project.code,
      agentId: "rest-atomic-begin",
      clientKind: "test",
      role: "OBSERVER",
      threadId: "thr_rest_exact",
      signals: {},
    };

    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers,
        payload,
      });
      const replay = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers,
        payload,
      });
      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(first.json().atomicBegin).toEqual({
        operationId: payload.operationId,
        disposition: "CREATED",
      });
      expect(replay.json().atomicBegin).toEqual({
        operationId: payload.operationId,
        disposition: "RECOVERED",
      });
      expect(replay.json().session).toBe(first.json().session);
      expect(await service.listAgentSessions(project.code)).toHaveLength(1);

      const conflict = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers,
        payload: { ...payload, threadId: "thr_rest_different" },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
      expect(await service.listAgentSessions(project.code)).toHaveLength(1);
    } finally {
      await app.close();
      service.close();
    }
  });

  it("在提交响应丢失、daemon 重启和凭据轮换后恢复同一 Session", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-api-session-restart-"));
    temporary.push(dataDir);
    const migrationsRoot = resolve(process.cwd(), "migrations");
    const payload = {
      operationId: "rest-session-begin-response-lost",
      mode: "project",
      projectCode: "RLOST",
      agentId: "rest-response-lost",
      clientKind: "test",
      role: "OBSERVER",
      threadId: "thr_response_lost",
      signals: {},
    };

    const firstService = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    await firstService.createProject({
      name: "REST response loss",
      sourcePath: null,
      code: "RLOST",
    });
    const firstApp = await buildAyanamiServer({ service: firstService, token: "first-secret" });
    const committed = await firstApp.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { authorization: "Bearer first-secret" },
      payload,
    });
    expect(committed.statusCode).toBe(201);
    const committedSession = String(committed.json().session);
    await firstApp.close();
    firstService.close();

    const recoveredService = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    const recoveredApp = await buildAyanamiServer({
      service: recoveredService,
      token: "rotated-secret",
    });
    try {
      const staleCredential = await recoveredApp.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers: { authorization: "Bearer first-secret" },
        payload,
      });
      expect(staleCredential.statusCode).toBe(401);

      const replay = await recoveredApp.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers: { authorization: "Bearer rotated-secret" },
        payload,
      });
      expect(replay.statusCode).toBe(201);
      expect(replay.json().atomicBegin).toEqual({
        operationId: payload.operationId,
        disposition: "RECOVERED",
      });
      expect(replay.json().session).toBe(committedSession);
      expect(await recoveredService.listAgentSessions("RLOST")).toHaveLength(1);
    } finally {
      await recoveredApp.close();
      recoveredService.close();
    }
  });

  it("REST begin 从 cwd 确定性采集并手动刷新持久化 Git context", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-api-git-context-"));
    temporary.push(root);
    const cwd = join(root, "repository");
    mkdirSync(cwd);
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
    git(["init"]);
    git(["config", "user.email", "atm@example.test"]);
    git(["config", "user.name", "ATM Test"]);
    writeFileSync(join(cwd, "tracked.txt"), "baseline\n", "utf8");
    git(["add", "tracked.txt"]);
    git(["commit", "-m", "baseline"]);
    const canonicalCwd = realpathSync.native(cwd);

    const dataDir = join(root, "data");
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    const headers = { authorization: "Bearer local-secret" };
    try {
      const project = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers,
        payload: { name: "REST Git context", sourcePath: cwd, code: "GREST" },
      });
      expect(project.statusCode).toBe(201);
      const begun = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers,
        payload: {
          mode: "project",
          projectCode: "GREST",
          agentId: "rest-git-context",
          clientKind: "test",
          role: "SUBAGENT",
          cwd,
          signals: {},
        },
      });
      expect(begun.statusCode).toBe(201);
      const sessionId = String(begun.json().session);
      const agents = await app.inject({
        method: "GET",
        url: "/api/v1/projects/GREST/agents",
        headers,
      });
      expect(agents.statusCode).toBe(200);
      const initial = (agents.json() as { items: Array<Record<string, unknown>> }).items.find(
        (item) => item.id === sessionId,
      );
      expect(initial).toMatchObject({
        cwd,
        lastSeenAt: expect.any(String),
        git: { available: true, worktreeRoot: canonicalCwd, dirty: false },
      });
      expect(initial?.git && (initial.git as Record<string, unknown>).head).toMatch(
        /^[0-9a-f]{40}$/u,
      );
      expect(typeof (initial?.git as Record<string, unknown> | undefined)?.branch).toBe("string");

      writeFileSync(join(cwd, "tracked.txt"), "dirty\n", "utf8");
      const refreshed = await app.inject({
        method: "POST",
        url: `/api/v1/projects/GREST/sessions/${sessionId}/git-context/refresh`,
        headers,
      });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json()).toMatchObject({
        updated: true,
        session: {
          id: sessionId,
          cwd,
          lastSeenAt: expect.any(String),
          git: { available: true, worktreeRoot: canonicalCwd, dirty: true },
        },
      });
    } finally {
      await app.close();
      service.close();
    }
  });

  it("在 WorkItem DTO 中往返 DISCOVERED_FROM 同批引用", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-api-discovered-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "REST 发现关系",
      sourcePath: null,
      code: "DREST",
    });
    const begun = await service.begin({ projectCode: project.code, agentId: "codex" });
    const objective = await service.createObjective(project.code, begun.session, {
      title: "验证 REST 关系",
      description: "",
      definitionOfDone: [],
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    const headers = { authorization: "Bearer local-secret" };
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/projects/DREST/work-items",
        headers,
        payload: {
          session: begun.session,
          opId: "rest-discovered-batch",
          items: [
            {
              clientRef: "follow-up",
              objectiveId: objective.id,
              discoveredFromRef: "origin",
              title: "REST 跟进项",
              type: "TASK",
              priority: "HIGH",
              status: "READY",
            },
            {
              clientRef: "origin",
              objectiveId: objective.id,
              title: "REST 原任务",
              type: "TASK",
              priority: "NORMAL",
              status: "READY",
            },
          ],
        },
      });
      expect(created.statusCode).toBe(201);
      const [followUp, origin] = created.json().items as Array<{ key: string }>;
      const detail = await app.inject({
        method: "GET",
        url: `/api/v1/projects/DREST/work-items/${followUp!.key}?view=full`,
        headers,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        relations: [
          expect.objectContaining({
            type: "DISCOVERED_FROM",
            direction: "OUTGOING",
            taskKey: origin!.key,
          }),
        ],
      });
    } finally {
      await app.close();
      service.close();
    }
  });

  it("创建 WorkItem 时在同一请求内持久化 assigneeAgentId", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-api-create-assignee-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "REST 创建即分派",
      sourcePath: null,
      code: "RASSIGN",
    });
    const begun = await service.begin({ projectCode: project.code, agentId: "codex" });
    const objective = await service.createObjective(project.code, begun.session, {
      title: "验证原子分派",
      description: "",
      definitionOfDone: [],
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    const headers = { authorization: "Bearer local-secret" };
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/projects/RASSIGN/work-items",
        headers,
        payload: {
          session: begun.session,
          opId: "rest-create-assigned",
          items: [
            {
              clientRef: "review",
              objectiveId: objective.id,
              title: "创建后直接交给 reviewer",
              type: "REVIEW",
              priority: "HIGH",
              status: "READY",
              assigneeAgentId: "claude-reviewer",
            },
          ],
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().items[0]).toMatchObject({
        assigneeAgentId: "claude-reviewer",
        status: "READY",
      });

      const stored = await app.inject({
        method: "GET",
        url: `/api/v1/projects/RASSIGN/work-items/${created.json().items[0].key}?view=context`,
        headers,
      });
      expect(stored.json()).toMatchObject({ assigneeAgentId: "claude-reviewer" });
    } finally {
      await app.close();
      service.close();
    }
  });

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
      const preflight = await app.inject({
        method: "OPTIONS",
        url: "/api/v1/settings/notification.mode",
        headers: {
          origin: "http://127.0.0.1:9999",
          "access-control-request-method": "PUT",
          "access-control-request-headers": "authorization,content-type",
        },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers["access-control-allow-methods"]).toContain("PUT");
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
      expect(attached.json().sourcePaths).toEqual([realpathSync.native(sourcePath)]);
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
      expect(response.json()).toEqual({ hits: [], nextCursor: null, hasMore: false });
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
        url: `/api/v1/projects/USER/ui/work-items/${task.key}`,
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
      expect(agents.json()).toEqual({ items: [], nextCursor: null, hasMore: false });
    } finally {
      await app.close();
      service.close();
    }
  });

  it("REST 接受较长进度摘要并在 500 字边界后拒绝", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-api-progress-summary-"));
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
        payload: { name: "进度摘要 API", sourcePath: null, code: "PSUM" },
      });
      const begun = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers,
        payload: {
          mode: "project",
          projectCode: "PSUM",
          agentId: "rest-summary-test",
          clientKind: "test",
          signals: {},
        },
      });
      expect(begun.statusCode).toBe(201);
      const base = {
        session: begun.json().session,
        scope: "project",
        completed: [],
        next: [],
        evidence: [],
      };
      const longEnough = await app.inject({
        method: "POST",
        url: "/api/v1/projects/PSUM/progress-updates",
        headers,
        payload: { ...base, opId: "rest-summary-300", summary: "进".repeat(300) },
      });
      expect(longEnough.statusCode).toBe(200);
      expect(longEnough.json()).toMatchObject({ summary: "进".repeat(300) });

      const tooLong = await app.inject({
        method: "POST",
        url: "/api/v1/projects/PSUM/progress-updates",
        headers,
        payload: { ...base, opId: "rest-summary-501", summary: "进".repeat(501) },
      });
      expect(tooLong.statusCode).toBeGreaterThanOrEqual(400);
      expect(tooLong.json()).toMatchObject({ error: { code: expect.any(String) } });
    } finally {
      await app.close();
      service.close();
    }
  });

  it("REST 透传 acceptance edit，并在 stale expectedFields 冲突时零写入", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-api-acceptance-edit-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "REST acceptance edit",
      sourcePath: null,
      code: "RAEDIT",
    });
    const begun = await service.begin({ projectCode: project.code, agentId: "rest-editor" });
    const objective = await service.createObjective(project.code, begun.session, {
      title: "REST acceptance",
      description: "",
      definitionOfDone: [],
    });
    const task = (
      await service.createWorkItems(project.code, begun.session, "create-rest-edit", [
        {
          clientRef: "task",
          objectiveId: objective.id,
          title: "可经 REST 修订验收标准",
          description: "",
          type: "TASK",
          priority: "HIGH",
          status: "READY",
          acceptance: ["旧 REST 验收"],
        },
      ])
    ).items[0]!;
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    const headers = { authorization: "Bearer local-secret" };
    try {
      const edited = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.code}/work-items/patch`,
        headers,
        payload: {
          session: begun.session,
          opId: "rest-acceptance-edit",
          items: [
            {
              taskKey: task.key,
              expectedVersion: task.version,
              expectedFields: { acceptance: ["旧 REST 验收"] },
              operation: "edit",
              acceptance: ["新 REST 验收"],
            },
          ],
        },
      });
      expect(edited.statusCode).toBe(200);
      expect(edited.json().items[0]).toMatchObject({ acceptance: ["新 REST 验收"] });
      const afterEdit = await service.getWorkItem(project.code, task.key);

      const conflict = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.code}/work-items/patch`,
        headers,
        payload: {
          session: begun.session,
          opId: "rest-acceptance-conflict",
          items: [
            {
              taskKey: task.key,
              expectedVersion: task.version,
              expectedFields: { acceptance: ["旧 REST 验收"] },
              operation: "edit",
              acceptance: ["不得覆盖"],
            },
          ],
        },
      });
      expect(conflict.statusCode).toBe(409);
      expect(await service.getWorkItem(project.code, task.key)).toMatchObject({
        acceptance: ["新 REST 验收"],
        version: afterEdit.version,
      });
      const delta = await service.delta(project.code, 0, 100);
      expect(delta.events.some((event) => event.opId === "rest-acceptance-conflict")).toBe(false);
    } finally {
      await app.close();
      service.close();
    }
  });
});
