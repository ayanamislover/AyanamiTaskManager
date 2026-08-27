import { appendFileSync, copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, openManagedDatabase, ProjectRepository } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("v9 structured cancel migration", () => {
  it("从 v8 添加可解引用取消字段并守卫迁移哈希", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-structured-cancel-migration-"));
    temporary.push(root);
    const dataDir = join(root, "data");
    const migrationsRoot = join(root, "migrations");
    cpSync(resolve(process.cwd(), "migrations"), migrationsRoot, { recursive: true });
    rmSync(join(migrationsRoot, "project", "0009_structured_cancel.sql"));
    rmSync(join(migrationsRoot, "project", "0010_review_workflow.sql"));
    rmSync(join(migrationsRoot, "project", "0011_session_close_reason.sql"));

    let manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    const project = await manager.createProject({
      name: "v8 structured cancel",
      sourcePath: null,
      code: "SCMIG",
    });
    const legacy = await manager.openProject(project.code);
    const repository = new ProjectRepository(legacy);
    const objective = repository.createObjective(
      { type: "USER", id: "USER", sessionId: null },
      { title: "取消迁移", description: "", definitionOfDone: [] },
    );
    const created = repository.createWorkItems(
      { type: "USER", id: "USER", sessionId: null },
      "migration-create",
      [
        {
          clientRef: "target",
          objectiveId: objective.id,
          title: "迁移后取消",
          type: "TASK",
          priority: "HIGH",
          status: "READY",
        },
        {
          clientRef: "canonical",
          objectiveId: objective.id,
          title: "规范任务",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
        },
        {
          clientRef: "replacement",
          objectiveId: objective.id,
          title: "替代任务",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
        },
      ],
    );
    manager.close();

    copyFileSync(
      resolve(process.cwd(), "migrations", "project", "0009_structured_cancel.sql"),
      join(migrationsRoot, "project", "0009_structured_cancel.sql"),
    );
    manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    try {
      const upgraded = await manager.openProject(project.code);
      expect(upgraded.schemaVersion).toBe(9);
      expect(upgraded.sqlite.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
      expect(upgraded.sqlite.pragma("foreign_key_check")).toEqual([]);
      const upgradedRepository = new ProjectRepository(upgraded);
      const actor = { type: "USER" as const, id: "USER", sessionId: null };
      const cancelled = upgradedRepository.patchWorkItems(actor, "migration-cancel", [
        {
          taskKey: created.items[0]!.key,
          expectedVersion: created.items[0]!.version,
          operation: "cancel",
          cancelReason: "迁移后结构化取消",
          duplicateOf: created.items[1]!.key,
          supersededBy: created.items[2]!.key,
        },
      ]).items[0]!;
      expect(cancelled).toMatchObject({
        cancelReason: "迁移后结构化取消",
        duplicateOf: created.items[1]!.key,
        supersededBy: created.items[2]!.key,
      });
    } finally {
      manager.close();
    }

    appendFileSync(
      join(migrationsRoot, "project", "0009_structured_cancel.sql"),
      "\n-- tampered\n",
    );
    await expect(
      openManagedDatabase({
        path: project.databasePath,
        migrationDirectory: join(migrationsRoot, "project"),
        backupDirectory: join(root, "tampered-backups"),
      }),
    ).rejects.toThrowError("MIGRATION_HASH_MISMATCH: 9");
  });
});
