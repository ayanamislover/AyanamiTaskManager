import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository } from "../src/index.js";
import { removeMigrationsAfter } from "./migration-test-helpers.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("MIGRATION_FAILED project recovery", () => {
  it("retries a healthy v14 database, accepts legacy completed strings and restores ACTIVE", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-migration-recovery-"));
    temporary.push(root);
    const dataDir = join(root, "data");
    const migrationsRoot = join(root, "migrations");
    cpSync(resolve(process.cwd(), "migrations"), migrationsRoot, { recursive: true });
    removeMigrationsAfter(migrationsRoot, "project", 14);

    let manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    const project = await manager.createProject({
      name: "Migration recovery",
      sourcePath: null,
      code: "MREC",
    });
    const database = await manager.openProject(project.code);
    const repository = new ProjectRepository(database);
    const session = repository.createSession({
      agentId: "migration-recovery",
      displayName: "Migration Recovery",
      clientKind: "test",
      role: "PRIMARY",
    });
    const actor = { type: "AGENT" as const, id: "migration-recovery", sessionId: session.id };
    const objective = repository.createObjective(actor, {
      title: "Recover",
      description: "",
      definitionOfDone: [],
    });
    const task = repository.createWorkItems(actor, "migration-recovery-task", [
      {
        clientRef: "legacy",
        objectiveId: objective.id,
        title: "Legacy completed entry",
        type: "TASK",
        priority: "NORMAL",
        status: "IN_PROGRESS",
      },
    ]).items[0]!;
    database.sqlite
      .prepare(
        `INSERT INTO project_updates(
           id, health, summary, completed_json, risks_json, next_json, evidence_json,
           from_sequence, to_sequence, status, actor, published_at, created_at, updated_at,
           op_id, session_id
         ) VALUES ('legacy-update', 'ON_TRACK', 'legacy', ?, '[]', '[]', '["proof"]',
                   0, 0, 'PUBLISHED', 'migration-recovery', ?, ?, ?, 'legacy-update', ?)`,
      )
      .run(
        JSON.stringify([task.key, "legacy completion text"]),
        "2026-08-28T00:00:00.000Z",
        "2026-08-28T00:00:00.000Z",
        "2026-08-28T00:00:00.000Z",
        session.id,
      );
    manager.close();

    const registryPath = join(dataDir, "registry", "registry.sqlite");
    const registry = new Database(registryPath);
    registry
      .prepare("UPDATE projects SET lifecycle = 'MIGRATION_FAILED' WHERE id = ?")
      .run(project.id);
    registry.close();
    cpSync(resolve(process.cwd(), "migrations", "project"), join(migrationsRoot, "project"), {
      recursive: true,
    });

    manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    try {
      expect(manager.getProject(project.code).lifecycle).toBe("ACTIVE");
      const recovered = await manager.openProject(project.code);
      expect(recovered.schemaVersion).toBe(18);
      expect(recovered.sqlite.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
      expect(
        manager.registry.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM global_events WHERE type = 'project.migration_recovered' AND aggregate_id = ?",
          )
          .get(project.id),
      ).toEqual({ count: 1 });
      expect(
        (await manager.doctor()).projects.find((entry) => entry.code === project.code),
      ).toMatchObject({ lifecycle: "ACTIVE", ok: true });

      manager.registry.sqlite
        .prepare("UPDATE projects SET lifecycle = 'MIGRATION_FAILED' WHERE id = ?")
        .run(project.id);
      expect(
        (await manager.doctor()).projects.find((entry) => entry.code === project.code),
      ).toMatchObject({
        lifecycle: "MIGRATION_FAILED",
        ok: false,
        quickCheck: true,
        foreignKeys: true,
      });
    } finally {
      manager.close();
    }
  });
});
