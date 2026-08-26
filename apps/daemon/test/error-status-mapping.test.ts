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
  it("Zod 参数错误返回 400 INVALID_ARGUMENT、聚合有界 issues 且不回显 payload", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-invalid-argument-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { authorization: "Bearer local-secret" },
        payload: {
          name: "",
          sourcePath: "",
          code: "bad code",
          coordinationMode: "CHAOS",
          secret_payload: "never-echo-this-value",
        },
      });
      const body = response.json() as {
        error: {
          code: string;
          message: string;
          details?: {
            issues?: Array<{ code: string; path: string; message: string }>;
            issue_count?: number;
            issues_truncated?: boolean;
          };
        };
      };

      expect(response.statusCode).toBe(400);
      expect(body.error.code).toBe("INVALID_ARGUMENT");
      expect(body.error.message).toBe("请求参数不合法");
      expect(body.error.details?.issue_count).toBeGreaterThanOrEqual(4);
      expect(body.error.details?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "name" }),
          expect.objectContaining({ path: "sourcePath" }),
          expect.objectContaining({ path: "code" }),
          expect.objectContaining({ path: "coordinationMode" }),
        ]),
      );
      expect(body.error.details?.issues?.length).toBeLessThanOrEqual(50);
      expect(JSON.stringify(body)).not.toContain("never-echo-this-value");
    } finally {
      await app.close();
      service.close();
    }
  });

  it("字符串超限 issue 返回实际长度与上限但不回显正文", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-length-diagnostic-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    const summary = `sensitive-${"x".repeat(301)}`;

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/projects/NOPE/records",
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: "session-does-not-matter",
          opId: "length-diagnostic",
          kind: "FACT",
          title: "长度诊断",
          summary,
          detail: "detail-does-not-matter",
          scope: "PROJECT",
        },
      });
      const body = response.json() as {
        error: {
          details?: { issues?: Array<Record<string, unknown>> };
        };
      };
      const issue = body.error.details?.issues?.find((candidate) => candidate.path === "summary");

      expect(response.statusCode).toBe(400);
      expect(issue).toMatchObject({ actual_length: summary.length, limit: 300 });
      expect(JSON.stringify(body)).not.toContain(summary);
      expect(JSON.stringify(body)).not.toContain("sensitive-");
    } finally {
      await app.close();
      service.close();
    }
  });

  it("VERSION_CONFLICT 返回 409 并提供当前版本", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-version-conflict-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const initialView = service.createSavedView({
      scope: "GLOBAL",
      name: "冲突视图",
      query: {},
      sort: {},
    });
    const view = service.updateSavedView(initialView.id, {
      expectedVersion: initialView.version,
      name: "服务端已更新",
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });

    try {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/saved-views/${view.id}`,
        headers: { authorization: "Bearer local-secret" },
        payload: { expectedVersion: initialView.version, name: "不会写入" },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          code: "VERSION_CONFLICT",
          details: {
            expected_version: initialView.version,
            current_version: view.version,
            version_gap: view.version - initialView.version,
          },
        },
      });
    } finally {
      await app.close();
      service.close();
    }
  });

  it("SESSION_CLOSED 返回 409 并提供 Session 标识", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-session-closed-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "Session closed mapping",
      sourcePath: null,
      code: "SCLOSE",
    });
    const begin = await service.begin({
      projectCode: project.code,
      mode: "project",
      agentId: "closed-session-test",
      role: "OBSERVER",
      signals: {},
    });
    const sessionId = String(begin.session);
    await service.forceCloseSessionAsUser(project.code, sessionId);
    const app = await buildAyanamiServer({ service, token: "local-secret" });

    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.code}/progress-updates`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: sessionId,
          opId: "closed-session-progress",
          scope: "project",
          summary: "不应写入",
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          code: "SESSION_CLOSED",
          details: { session_id: sessionId },
        },
      });
    } finally {
      await app.close();
      service.close();
    }
  });

  it("INVALID_TRANSITION 返回 409 并提供当前与目标状态", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-invalid-transition-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "Invalid transition mapping",
      sourcePath: null,
      code: "ITRANS",
    });
    const objective = await service.createObjectiveAsUser(project.code, "create-objective", {
      title: "状态机目标",
      description: "",
      definitionOfDone: [],
    });
    const created = await service.createWorkItemsAsUser(project.code, "create-ready-task", [
      {
        clientRef: "ready-task",
        objectiveId: objective.id,
        dependsOn: [],
        dependsOnRefs: [],
        title: "不可直接完成",
        description: "",
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
        acceptance: [],
        checklist: [],
        weight: 1,
        verificationRequired: false,
      },
    ]);
    const task = created.items[0]!;
    const begin = await service.begin({
      projectCode: project.code,
      mode: "project",
      agentId: "transition-test",
      role: "PRIMARY",
      signals: {},
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });

    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.code}/work-items/patch`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: String(begin.session),
          opId: "invalid-ready-to-blocked",
          items: [
            {
              taskKey: task!.key,
              expectedVersion: task!.version,
              operation: "block",
              blockedReason: "不能从 READY 直接阻塞",
            },
          ],
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          code: "INVALID_TRANSITION",
          details: { current_status: "READY", requested_status: "BLOCKED" },
        },
      });
    } finally {
      await app.close();
      service.close();
    }
  });

  it("PROJECT_NOT_FOUND 仅向已鉴权请求返回安全候选，且写操作不模糊路由", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-project-suggestion-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const alphaRoot = join(dataDir, "alpha-root");
    mkdirSync(alphaRoot);
    const alpha = await service.createProject({
      name: "Alpha workspace",
      sourcePath: alphaRoot,
      code: "ALPHA1",
    });
    for (const [code, name] of [
      ["ALPHA2", "Alpha companion"],
      ["ALPINE", "Alpine tools"],
      ["ALPHAB", "Alpha beta"],
      ["ALPHAC", "Alpha client"],
      ["ALPHAD", "Alpha daemon"],
      ["BETA", "Completely unrelated"],
    ] as const) {
      await service.createProject({ name, sourcePath: null, code });
    }
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    const headers = { authorization: "Bearer local-secret" };

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/projects/ALPHA",
        headers,
      });
      const body = response.json() as {
        error: {
          code: string;
          details?: {
            did_you_mean?: string | null;
            candidates?: Array<Record<string, unknown>>;
          };
        };
      };

      expect(response.statusCode).toBe(404);
      expect(body.error.code).toBe("PROJECT_NOT_FOUND");
      expect(body.error.details?.did_you_mean).toBe("ALPHA1");
      expect(body.error.details?.candidates?.length).toBeLessThanOrEqual(5);
      expect(body.error.details?.candidates).toContainEqual({
        code: "ALPHA1",
        name: "Alpha workspace",
      });
      for (const candidate of body.error.details?.candidates ?? []) {
        expect(Object.keys(candidate).sort()).toEqual(["code", "name"]);
      }
      expect(JSON.stringify(body)).not.toContain(alphaRoot);
      expect(JSON.stringify(body)).not.toContain(alpha.id);

      const unauthorized = await app.inject({ method: "GET", url: "/api/v1/projects/ALPHA" });
      expect(unauthorized.statusCode).toBe(401);
      expect(JSON.stringify(unauthorized.json())).not.toContain("candidates");

      const wrongWrite = await app.inject({
        method: "POST",
        url: "/api/v1/projects/ALPHA/paths",
        headers,
        payload: { path: join(dataDir, "must-not-attach") },
      });
      expect(wrongWrite.statusCode).toBe(404);
      expect(service.databases.getProject(alpha.code).sourcePaths).toEqual([alphaRoot]);
    } finally {
      await app.close();
      service.close();
    }
  });

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
