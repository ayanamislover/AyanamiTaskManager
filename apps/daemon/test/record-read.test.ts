import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { buildAyanamiServer } from "../src/index.js";

describe("Record REST 读取面", () => {
  it("按公开 recordKey 精确读取完整记录", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-record-read-"));
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });

    try {
      const project = await service.createProject({
        name: "Record read",
        sourcePath: null,
        code: "RREAD",
      });
      const begin = await service.begin({
        projectCode: project.code,
        mode: "project",
        agentId: "record-read-test",
        role: "PRIMARY",
        signals: {},
      });
      const created = await service.createRecord(
        project.code,
        String(begin.session),
        "create-exact-record",
        {
          kind: "FACT",
          title: "精确读取",
          summary: "公开 key 可以直接读取",
          detail: "这是必须完整返回的详情。",
          topic: "record-read-plane",
          subjectKey: "RREAD-T-0001",
        },
      );
      const related = await service.createRecord(
        project.code,
        String(begin.session),
        "create-related-record",
        {
          kind: "LESSON",
          title: "关联记录",
          summary: "同一 topic 应自动关联",
          topic: "record-read-plane",
        },
      );
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.code}/records/${created.key}`,
        headers: { authorization: "Bearer local-secret" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        key: created.key,
        title: "精确读取",
        detail: "这是必须完整返回的详情。",
        topic: "record-read-plane",
        subjectKey: "RREAD-T-0001",
        relatedRecords: [related.key],
        opId: "create-exact-record",
      });

      const listResponse = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.code}/records?limit=10`,
        headers: { authorization: "Bearer local-secret" },
      });
      const page = listResponse.json() as {
        items: Array<Record<string, unknown>>;
        nextCursor: string | null;
        hasMore: boolean;
      };
      const listed = page.items.find((record) => record.key === created.key);
      expect(listResponse.statusCode).toBe(200);
      expect(page).toMatchObject({ nextCursor: null, hasMore: false });
      expect(listed).toMatchObject({
        key: created.key,
        topic: "record-read-plane",
        relatedRecords: [related.key],
        opId: "create-exact-record",
        sourceType: "AGENT",
        sourceActorId: "record-read-test",
        sourceSessionId: String(begin.session),
      });
      expect(listed).not.toHaveProperty("source_type");
      expect(listed).not.toHaveProperty("updated_at");

      const firstPage = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.code}/records?limit=1`,
        headers: { authorization: "Bearer local-secret" },
      });
      expect(firstPage.json()).toMatchObject({
        items: [expect.any(Object)],
        nextCursor: expect.stringMatching(/^rl1\./u),
        hasMore: true,
      });
      const invalidCursor = `${firstPage.json().nextCursor.slice(0, -1)}x`;
      const invalid = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.code}/records?limit=1&cursor=${encodeURIComponent(invalidCursor)}`,
        headers: { authorization: "Bearer local-secret" },
      });
      expect(invalid.statusCode).toBe(422);
      expect(invalid.json()).toMatchObject({ error: { code: "INVALID_CURSOR" } });
    } finally {
      await app.close();
      service.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
