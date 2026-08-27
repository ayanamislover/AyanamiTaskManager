import { appendFileSync, copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, openManagedDatabase, ProjectRepository } from "../src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("v8 工作阶段与等待对象迁移", () => {
  it("把 v7 WAITING_AGENT 回填为可识别的 IN_PROGRESS 推断阶段", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-phase-migration-"));
    temporary.push(root);
    const dataDir = join(root, "data");
    const migrationsRoot = join(root, "migrations");
    cpSync(resolve(process.cwd(), "migrations"), migrationsRoot, { recursive: true });
    rmSync(join(migrationsRoot, "project", "0008_work_item_phase_waiting.sql"));
    rmSync(join(migrationsRoot, "project", "0009_structured_cancel.sql"));
    rmSync(join(migrationsRoot, "project", "0010_review_workflow.sql"));
    rmSync(join(migrationsRoot, "project", "0011_session_close_reason.sql"));
    rmSync(join(migrationsRoot, "project", "0012_project_update_evidence.sql"));
    rmSync(join(migrationsRoot, "project", "0013_project_update_session.sql"));

    let manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    const project = await manager.createProject({
      name: "v7 waiting migration",
      sourcePath: null,
      code: "PWMIG",
    });
    const database = await manager.openProject(project.code);
    const now = "2026-08-26T00:00:00.000Z";
    database.sqlite
      .prepare(
        `INSERT INTO objectives(
           id, local_no, title, description, definition_of_done_json, status,
           weight, version, created_at, updated_at
         ) VALUES ('phase-objective', 1, '阶段目标', '', '[]', 'ACTIVE', 1, 0, ?, ?)`,
      )
      .run(now, now);
    database.sqlite
      .prepare(
        `INSERT INTO work_items(
           id, local_no, objective_id, type, title, status, priority, sort_key,
           waiting_for, version, created_at, updated_at
         ) VALUES ('legacy-waiting', 1, 'phase-objective', 'TASK', '旧等待任务',
                   'WAITING_AGENT', 'HIGH', 1000, 'legacy reviewer', 0, ?, ?)`,
      )
      .run(now, now);
    manager.close();

    copyFileSync(
      resolve(process.cwd(), "migrations", "project", "0008_work_item_phase_waiting.sql"),
      join(migrationsRoot, "project", "0008_work_item_phase_waiting.sql"),
    );
    manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    try {
      const upgraded = await manager.openProject(project.code);
      expect(upgraded.schemaVersion).toBe(8);
      expect(upgraded.sqlite.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
      expect(upgraded.sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(new ProjectRepository(upgraded).getWorkItem("PWMIG-T-0001")).toMatchObject({
        status: "WAITING_AGENT",
        phase: "IN_PROGRESS",
        waitingOn: "AGENT",
        waitingFor: "legacy reviewer",
        phaseInferred: true,
      });
      const repository = new ProjectRepository(upgraded);
      const session = repository.createSession({
        agentId: "migration-agent",
        displayName: "Migration Agent",
        clientKind: "test",
        role: "SUBAGENT",
      });
      const resumed = repository.patchWorkItems(
        { type: "AGENT", id: "migration-agent", sessionId: session.id },
        "resume-legacy-wait",
        [
          {
            taskKey: "PWMIG-T-0001",
            expectedVersion: 0,
            operation: "reopen",
          },
        ],
      ).items[0]!;
      expect(resumed).toMatchObject({
        status: "IN_PROGRESS",
        phase: "IN_PROGRESS",
        waitingOn: null,
        waitingFor: null,
        phaseInferred: false,
      });
    } finally {
      manager.close();
    }

    appendFileSync(
      join(migrationsRoot, "project", "0008_work_item_phase_waiting.sql"),
      "\n-- tampered\n",
    );
    await expect(
      openManagedDatabase({
        path: project.databasePath,
        migrationDirectory: join(migrationsRoot, "project"),
        backupDirectory: join(root, "tampered-backups"),
      }),
    ).rejects.toThrowError("MIGRATION_HASH_MISMATCH: 8");
  });
});
