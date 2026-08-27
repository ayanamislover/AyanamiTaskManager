import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { ProjectRepository } from "@ayanami-task/storage-sqlite";
import { buildAyanamiServer } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("startup-recovery successor REST", () => {
  it("首个 mutation 回执公开 sessionRebound/newSession，旧与新 Session 都可精确重放", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-startup-successor-rest-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    try {
      const project = await service.createProject({
        name: "Startup successor REST",
        sourcePath: null,
        code: "SRREST",
      });
      const first = await service.begin({
        projectCode: project.code,
        mode: "project",
        agentId: "rest-recovery-agent",
        clientKind: "test",
        threadId: "rest-recovery-thread",
      });
      const repository = new ProjectRepository(await service.databases.openProject(project.code));
      repository.recoverStaleSessions("2999-01-01T00:00:00.000Z");
      const payload = {
        session: String(first.session),
        opId: "rest-recovery-record",
        kind: "FACT",
        title: "REST recovery",
        summary: "原子创建 successor",
      };
      const post = (body: Record<string, unknown>) =>
        app.inject({
          method: "POST",
          url: `/api/v1/projects/${project.code}/records`,
          headers: { authorization: "Bearer local-secret" },
          payload: body,
        });

      const created = await post(payload);
      const body = created.json() as Record<string, unknown>;
      expect(created.statusCode).toBe(201);
      expect(body).toMatchObject({
        sessionRebound: true,
        newSession: expect.any(String),
        session: expect.any(String),
      });
      expect(body.newSession).toBe(body.session);

      const replayOld = await post(payload);
      const replayNew = await post({ ...payload, session: body.newSession });
      expect(replayOld.statusCode).toBe(201);
      expect(replayNew.statusCode).toBe(201);
      expect(replayOld.json()).toMatchObject({ key: body.key, newSession: body.newSession });
      expect(replayNew.json()).toMatchObject({ key: body.key });

      const conflict = await post({ ...payload, summary: "不同 payload" });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
      expect(await service.listRecords(project.code, 20)).toHaveLength(1);
      expect(await service.listAgentSessions(project.code, 20)).toHaveLength(2);
    } finally {
      await app.close();
      service.close();
    }
  });

  it("候选歧义返回可操作 409 而非 500，且不执行领域写入", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-startup-successor-rest-ambiguous-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    try {
      const project = await service.createProject({
        name: "Ambiguous successor REST",
        sourcePath: null,
        code: "SRAMBIG",
      });
      const first = await service.begin({
        projectCode: project.code,
        mode: "project",
        agentId: "ambiguous-agent",
        clientKind: "test",
        role: "SUBAGENT",
      });
      const repository = new ProjectRepository(await service.databases.openProject(project.code));
      repository.recoverStaleSessions("2999-01-01T00:00:00.000Z");
      for (let index = 0; index < 2; index += 1) {
        repository.createSession({
          agentId: "ambiguous-agent",
          displayName: "Ambiguous Agent",
          clientKind: "test",
          role: "SUBAGENT",
          resume: true,
          predecessorSessionId: String(first.session),
        });
      }

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.code}/records`,
        headers: { authorization: "Bearer local-secret" },
        payload: {
          session: String(first.session),
          opId: "ambiguous-rest-record",
          kind: "FACT",
          title: "歧义候选",
          summary: "不应写入",
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: "SESSION_SUCCESSOR_AMBIGUOUS" },
      });
      expect(await service.listRecords(project.code, 20)).toHaveLength(0);
    } finally {
      await app.close();
      service.close();
    }
  });
});
