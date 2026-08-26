import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { buildAyanamiServer } from "../src/index.js";

describe("Record summary Unicode code point REST 边界", () => {
  it("接受 300 与 200 emoji，301 返回结构化长度且整次写入零落账", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-record-summary-rest-"));
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });

    try {
      const project = await service.createProject({
        name: "Record summary REST",
        sourcePath: null,
        code: "RSREST",
      });
      const begin = await service.begin({
        projectCode: project.code,
        mode: "project",
        agentId: "record-summary-rest-test",
        role: "PRIMARY",
        signals: {},
      });
      const postRecord = (opId: string, summary: string, detail = "") =>
        app.inject({
          method: "POST",
          url: `/api/v1/projects/${project.code}/records`,
          headers: { authorization: "Bearer local-secret" },
          payload: {
            session: String(begin.session),
            opId,
            kind: "FACT",
            title: "Unicode 摘要边界",
            summary,
            detail,
          },
        });

      expect((await postRecord("record-summary-rest-300", "界".repeat(300))).statusCode).toBe(201);
      expect((await postRecord("record-summary-rest-emoji", "😀".repeat(200))).statusCode).toBe(
        201,
      );
      const recordsBefore = await service.listRecords(project.code, 100);
      const sequenceBefore = (await service.delta(project.code, 0, 100)).currentSequence;
      const rejectedSummary = "😀".repeat(301);
      const rejected = await postRecord(
        "record-summary-rest-301",
        rejectedSummary,
        "d".repeat(100_000),
      );
      const body = rejected.json() as {
        error: {
          code: string;
          details?: { issues?: Array<Record<string, unknown>> };
        };
      };

      expect(rejected.statusCode).toBe(400);
      expect(body.error.code).toBe("INVALID_ARGUMENT");
      expect(body.error.details?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "summary", actual_length: 301, limit: 300 }),
        ]),
      );
      expect(JSON.stringify(body)).not.toContain(rejectedSummary);
      expect(await service.listRecords(project.code, 100)).toEqual(recordsBefore);
      expect((await service.delta(project.code, 0, 100)).currentSequence).toBe(sequenceBefore);
    } finally {
      await app.close();
      service.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
