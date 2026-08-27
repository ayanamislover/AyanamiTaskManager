import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository } from "../src/index.js";
import { captureAtmError } from "./typed-error-test-helpers.js";

describe("Record summary Unicode code point 存储边界", () => {
  it("接受 300 个 code point 与 200 个 emoji，并让 301 失败事务零落账", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-record-summary-storage-"));
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });

    try {
      const project = await manager.createProject({
        name: "Record summary storage",
        sourcePath: null,
        code: "RSSTORE",
      });
      const repository = new ProjectRepository(await manager.openProject(project.id));
      const session = repository.createSession({
        agentId: "record-summary-storage-test",
        displayName: "Record Summary Storage Test",
        clientKind: "test",
        role: "PRIMARY",
      });
      const actor = {
        type: "AGENT" as const,
        id: "record-summary-storage-test",
        sessionId: session.id,
      };
      const boundary = repository.createRecord(actor, "record-summary-300", {
        kind: "FACT",
        title: "300 code points",
        summary: "界".repeat(300),
      });
      const emoji = repository.createRecord(actor, "record-summary-200-emoji", {
        kind: "FACT",
        title: "200 emoji",
        summary: "😀".repeat(200),
      });
      const recordsBefore = repository.listRecords();
      const sequenceBefore = repository.delta(0, 100).currentSequence;

      expect(repository.getRecord(boundary.key).summary).toBe("界".repeat(300));
      expect(repository.getRecord(emoji.key).summary).toBe("😀".repeat(200));
      expect(
        captureAtmError(() =>
          repository.createRecord(actor, "record-summary-301", {
            kind: "FACT",
            title: "301 code points",
            summary: "😀".repeat(301),
            detail: "d".repeat(100_000),
            supersedes: boundary.key,
          }),
        ),
      ).toMatchObject({ code: "VALIDATION_ERROR", details: { field: "summary", max: 300 } });
      expect(repository.listRecords()).toEqual(recordsBefore);
      expect(repository.delta(0, 100).currentSequence).toBe(sequenceBefore);
      expect(repository.getRecord(boundary.key).status).toBe("ACTIVE");
    } finally {
      manager.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
