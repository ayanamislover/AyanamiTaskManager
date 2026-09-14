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

describe("知识库 REST", () => {
  it("零项目可创建、搜索、读取、编辑、归档并查看历史", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-knowledge-api-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "knowledge-secret" });
    const headers = { authorization: "Bearer knowledge-secret" };
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/knowledge",
        headers,
        payload: {
          opId: "api-knowledge-create",
          expectedVersion: 0,
          slug: "sqlite-paths",
          title: "SQLite 路径约定",
          summary: "Windows 路径校验与身份比较。",
          useWhen: "迁移或启动恢复时。",
          tags: ["sqlite", "windows"],
          appliesTo: ["Windows"],
          bodyMarkdown: "# 路径\n\n使用规范化绝对路径。",
          sourceRefs: [],
        },
      });
      expect(created.statusCode).toBe(201);
      const entry = created.json() as {
        id: string;
        version: number;
        revision: number;
        revisionId: string;
      };
      expect(entry).toMatchObject({ version: 1, revision: 1, revisionId: expect.any(String) });

      const searched = await app.inject({
        method: "GET",
        url: "/api/v1/knowledge?query=sqlite&limit=5&maxChars=5000",
        headers,
      });
      expect(searched.statusCode).toBe(200);
      expect(searched.json()).toMatchObject({
        hits: [expect.objectContaining({ id: entry.id, title: "SQLite 路径约定" })],
        hasMore: false,
        nextCursor: null,
      });
      expect(searched.json().hits[0]).not.toHaveProperty("bodyMarkdown");

      const current = await app.inject({
        method: "GET",
        url: `/api/v1/knowledge/${entry.id}?maxChars=600000`,
        headers,
      });
      expect(current.statusCode).toBe(200);
      expect(current.json()).toMatchObject({
        id: entry.id,
        revision: 1,
        bodyMarkdown: "# 路径\n\n使用规范化绝对路径。",
        toc: [{ id: "h-1", title: "路径", level: 1 }],
        truncated: false,
        nextCursor: null,
      });

      const updated = await app.inject({
        method: "PATCH",
        url: `/api/v1/knowledge/${entry.id}`,
        headers,
        payload: {
          opId: "api-knowledge-edit",
          expectedVersion: 1,
          expectedRevisionId: entry.revisionId,
          slug: "sqlite-paths",
          title: "SQLite 路径约定（更新）",
          summary: "更新后的路径校验约定。",
          useWhen: "迁移、启动恢复或备份时。",
          tags: ["sqlite", "windows", "backup"],
          aliases: [],
          appliesTo: ["Windows"],
          bodyMarkdown: "# 新路径\n\n正文版本二。",
          sourceRefs: [],
        },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({
        id: entry.id,
        revision: 2,
        version: 2,
        revisionId: expect.any(String),
      });

      const history = await app.inject({
        method: "GET",
        url: `/api/v1/knowledge/${entry.id}/history`,
        headers,
      });
      expect(history.statusCode).toBe(200);
      expect(history.json()).toMatchObject({
        revisions: [
          expect.objectContaining({ revision: 2, title: "SQLite 路径约定（更新）" }),
          expect.objectContaining({ revision: 1, title: "SQLite 路径约定" }),
        ],
        nextRevision: null,
      });
      expect(history.json().revisions[0]).not.toHaveProperty("bodyMarkdown");

      const archived = await app.inject({
        method: "POST",
        url: `/api/v1/knowledge/${entry.id}/archive`,
        headers,
        payload: {
          opId: "api-knowledge-archive",
          expectedVersion: 2,
          expectedRevisionId: updated.json().revisionId,
          archived: true,
        },
      });
      expect(archived.statusCode).toBe(200);
      expect(archived.json()).toMatchObject({ id: entry.id, archived: true, version: 3 });
      const hidden = await app.inject({
        method: "GET",
        url: "/api/v1/knowledge?query=sqlite",
        headers,
      });
      expect(hidden.json().hits).toEqual([]);
      const firstRevisionId = String(history.json().revisions[1].revisionId);
      const explicit = await app.inject({
        method: "GET",
        url: `/api/v1/knowledge/${entry.id}?revisionId=${firstRevisionId}`,
        headers,
      });
      expect(explicit.statusCode).toBe(200);
      expect(explicit.json()).toMatchObject({ revision: 1, archived: true });
      const legacyRevision = await app.inject({
        method: "GET",
        url: `/api/v1/knowledge/${entry.id}?revision=1`,
        headers,
      });
      expect(legacyRevision.statusCode).toBe(400);
      expect(legacyRevision.json()).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
    } finally {
      await app.close();
      service.close();
    }
  });

  it("保存重试返回同一修订，版本冲突和无效 cursor 使用结构化错误", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-knowledge-api-errors-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "knowledge-secret" });
    const headers = { authorization: "Bearer knowledge-secret" };
    try {
      const payload = {
        opId: "api-knowledge-idempotent",
        expectedVersion: 0,
        slug: "one",
        title: "一个条目",
        summary: "摘要",
        bodyMarkdown: "正文",
      };
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/knowledge",
        headers,
        payload,
      });
      const replay = await app.inject({
        method: "POST",
        url: "/api/v1/knowledge",
        headers,
        payload,
      });
      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());

      const conflict = await app.inject({
        method: "POST",
        url: "/api/v1/knowledge",
        headers,
        payload: { ...payload, title: "另一个标题" },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
      const versionConflict = await app.inject({
        method: "POST",
        url: "/api/v1/knowledge",
        headers,
        payload: { ...payload, opId: "api-knowledge-stale", slug: "one", expectedVersion: 1 },
      });
      expect(versionConflict.statusCode).toBe(409);
      expect(versionConflict.json()).toMatchObject({ error: { code: "VERSION_CONFLICT" } });

      const firstPage = await app.inject({
        method: "GET",
        url: "/api/v1/knowledge?limit=1&maxChars=5000",
        headers,
      });
      const cursor = firstPage.json().nextCursor;
      expect(cursor).toBeNull();
      const invalid = await app.inject({
        method: "GET",
        url: "/api/v1/knowledge?cursor=k1.invalid.invalid",
        headers,
      });
      expect(invalid.statusCode).toBe(422);
      expect(invalid.json()).toMatchObject({ error: { code: "INVALID_CURSOR" } });
    } finally {
      await app.close();
      service.close();
    }
  });

  it("Record 提炼预览只读且携带稳定项目、Record 与版本引用", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-knowledge-api-preview-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "知识来源项目",
      sourcePath: null,
      code: "SRC",
    });
    const record = await service.createRecordAsUser(project.code, "api-preview-record", {
      kind: "FACT",
      title: "来源事实",
      summary: "可共享的来源摘要",
      detail: "可编辑的 Markdown 草稿正文",
      scope: "PROJECT",
    });
    const app = await buildAyanamiServer({ service, token: "knowledge-secret" });
    const headers = { authorization: "Bearer knowledge-secret" };
    try {
      const preview = await app.inject({
        method: "GET",
        url: `/api/v1/knowledge/preview-record?project=${project.code}&record=${encodeURIComponent(record.key)}`,
        headers,
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({
        title: "来源事实",
        summary: "可共享的来源摘要",
        bodyMarkdown: "可编辑的 Markdown 草稿正文",
        sourceRef: {
          type: "project_record",
          reference: record.key,
          projectId: project.id,
          recordId: expect.any(String),
          sourceVersion: expect.any(Number),
        },
      });
      const missing = await app.inject({
        method: "GET",
        url: "/api/v1/knowledge/preview-record",
        headers,
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
      expect((await service.knowledge.search({})).hits).toEqual([]);
    } finally {
      await app.close();
      service.close();
    }
  });
});
