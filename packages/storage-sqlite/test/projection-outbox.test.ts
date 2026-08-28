import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager } from "../src/manager.js";
import { ProjectRepository } from "../src/project-repository.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("Registry projection outbox", () => {
  it("Registry 已提交但 outbox 确认失败后重试不会复制同一项目事件", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-projection-outbox-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });

    try {
      const project = await manager.createProject({
        name: "投影去重",
        sourcePath: null,
        code: "POD",
      });
      const projectDatabase = await manager.openProject(project.id);
      const repository = new ProjectRepository(projectDatabase);
      const objective = repository.createObjective(
        { type: "SYSTEM", id: "projection-test", sessionId: null },
        {
          title: "同一事件只能投影一次",
          description: "",
          definitionOfDone: [],
        },
        "projection-outbox-crash-window",
      );
      const sourceEvent = projectDatabase.sqlite
        .prepare("SELECT id FROM events WHERE sequence = ?")
        .get(objective.sequence) as { id: string };
      projectDatabase.sqlite.exec(`
        CREATE TRIGGER fail_outbox_delivery_ack
        BEFORE UPDATE OF delivered_at ON outbox
        BEGIN
          SELECT RAISE(ABORT, 'injected outbox acknowledgement failure');
        END;
      `);

      await expect(manager.dispatchProject(project.id)).resolves.toMatchObject({
        delivered: 0,
        projection: { status: "DEFERRED", retryScheduled: true },
      });
      expect(
        projectDatabase.sqlite
          .prepare("SELECT COUNT(*) AS count FROM outbox WHERE delivered_at IS NULL")
          .get(),
      ).toMatchObject({ count: 1 });
      expect(projectedSourceEventCount(manager, sourceEvent.id)).toBe(1);
      expect(
        projectDatabase.sqlite
          .prepare("SELECT attempts, last_error FROM outbox WHERE delivered_at IS NULL")
          .get(),
      ).toMatchObject({
        attempts: 1,
        last_error: expect.stringContaining("injected outbox acknowledgement failure"),
      });
      const sequenceAfterFailedAck = (
        manager.registry.sqlite
          .prepare("SELECT current_sequence FROM app_meta WHERE singleton = 1")
          .get() as { current_sequence: number }
      ).current_sequence;

      projectDatabase.sqlite.exec("DROP TRIGGER fail_outbox_delivery_ack");
      await expect(manager.dispatchProject(project.id)).resolves.toMatchObject({
        delivered: 1,
        sequence: objective.sequence,
      });

      expect(projectedSourceEventCount(manager, sourceEvent.id)).toBe(1);
      expect(
        (
          manager.registry.sqlite
            .prepare("SELECT current_sequence FROM app_meta WHERE singleton = 1")
            .get() as { current_sequence: number }
        ).current_sequence,
      ).toBe(sequenceAfterFailedAck);
      expect(
        projectDatabase.sqlite
          .prepare("SELECT COUNT(*) AS count FROM outbox WHERE delivered_at IS NULL")
          .get(),
      ).toMatchObject({ count: 0 });
      expect(
        projectDatabase.sqlite.prepare("SELECT attempts, last_error FROM outbox").get(),
      ).toEqual({ attempts: 2, last_error: null });
    } finally {
      manager.close();
    }
  });

  it("drains more than one bounded outbox page before reporting APPLIED", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-projection-outbox-scale-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });

    try {
      const project = await manager.createProject({
        name: "Projection outbox scale",
        sourcePath: null,
        code: "POS",
      });
      const projectDatabase = await manager.openProject(project.id);
      const repository = new ProjectRepository(projectDatabase);
      const actor = { type: "SYSTEM" as const, id: "projection-scale", sessionId: null };
      for (let index = 0; index < 521; index += 1) {
        repository.createRecord(actor, `projection-scale-${index}`, {
          kind: "FACT",
          title: `Projection record ${index}`,
          summary: `Projection record ${index}`,
          importance: "NORMAL",
        });
      }

      const result = await manager.dispatchProject(project.id);
      expect(result).toMatchObject({
        delivered: 521,
        sequence: 521,
        projection: {
          status: "APPLIED",
          sourceSeq: 521,
          projectedSeq: 521,
          retryScheduled: false,
        },
      });
      expect(
        projectDatabase.sqlite
          .prepare("SELECT COUNT(*) AS count FROM outbox WHERE delivered_at IS NULL")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        manager.registry.sqlite
          .prepare("SELECT COUNT(*) AS count FROM global_events WHERE dedupe_key LIKE ?")
          .get(`project:${project.id}:event:%`),
      ).toEqual({ count: 521 });
      expect(
        manager.registry.sqlite
          .prepare(
            `SELECT source_sequence, projected_sequence, status
             FROM project_projection_state WHERE project_id = ?`,
          )
          .get(project.id),
      ).toEqual({ source_sequence: 521, projected_sequence: 521, status: "APPLIED" });
    } finally {
      manager.close();
    }
  });
});

function projectedSourceEventCount(manager: AyanamiDatabaseManager, sourceEventId: string): number {
  const rows = manager.registry.sqlite
    .prepare("SELECT payload_json FROM global_events WHERE type = 'objective.created'")
    .all() as Array<{ payload_json: string }>;
  return rows.filter((row) => {
    const payload = JSON.parse(row.payload_json) as { sourceEventId?: string };
    return payload.sourceEventId === sourceEventId;
  }).length;
}
