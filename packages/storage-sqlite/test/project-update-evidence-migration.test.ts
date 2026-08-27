import { appendFileSync, copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, openManagedDatabase, ProjectRepository } from "../src/index.js";
import { removeMigrationsAfter } from "./migration-test-helpers.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("v12 project update evidence migration", () => {
  it("从 v11 添加 evidence_json 默认值，并守卫读写、完整性与迁移哈希", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-project-evidence-migration-"));
    temporary.push(root);
    const dataDir = join(root, "data");
    const migrationsRoot = join(root, "migrations");
    cpSync(resolve(process.cwd(), "migrations"), migrationsRoot, { recursive: true });
    removeMigrationsAfter(migrationsRoot, "project", 11);

    let manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    const project = await manager.createProject({
      name: "v11 project evidence",
      sourcePath: null,
      code: "PEVMIG",
    });
    const legacy = await manager.openProject(project.code);
    const now = "2026-08-27T00:00:00.000Z";
    legacy.sqlite
      .prepare(
        `INSERT INTO project_updates(
           id, health, summary, completed_json, risks_json, next_json,
           from_sequence, to_sequence, status, actor, published_at, created_at, updated_at, op_id
         ) VALUES ('legacy-project-update', 'ON_TRACK', 'legacy', '[]', '[]', '[]',
                   0, 0, 'PUBLISHED', 'legacy-agent', ?, ?, ?, 'legacy-progress')`,
      )
      .run(now, now, now);
    manager.close();

    copyFileSync(
      resolve(process.cwd(), "migrations", "project", "0012_project_update_evidence.sql"),
      join(migrationsRoot, "project", "0012_project_update_evidence.sql"),
    );
    manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    try {
      const upgraded = await manager.openProject(project.code);
      expect(upgraded.schemaVersion).toBe(12);
      expect(upgraded.sqlite.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
      expect(upgraded.sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(
        upgraded.sqlite
          .prepare("SELECT evidence_json FROM project_updates WHERE id = 'legacy-project-update'")
          .get(),
      ).toEqual({ evidence_json: "[]" });
    } finally {
      manager.close();
    }

    copyFileSync(
      resolve(process.cwd(), "migrations", "project", "0013_project_update_session.sql"),
      join(migrationsRoot, "project", "0013_project_update_session.sql"),
    );
    manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    try {
      const current = await manager.openProject(project.code);
      const repository = new ProjectRepository(current);
      expect(repository.getProjectUpdate("legacy-project-update")).toMatchObject({
        opId: "legacy-progress",
        evidence: [],
        sessionId: null,
      });
      const session = repository.createSession({
        agentId: "evidence-agent",
        displayName: "Evidence Agent",
        clientKind: "test",
        role: "PRIMARY",
      });
      const published = repository.publishProjectUpdate(
        { type: "AGENT", id: "evidence-agent", sessionId: session.id },
        "typed-project-progress",
        {
          health: "ON_TRACK",
          summary: "typed evidence",
          evidence: [{ kind: "git_sha", value: "abc123" }],
        },
      );
      expect(repository.getProjectUpdate(published.id)).toMatchObject({
        evidence: [{ kind: "git_sha", value: "abc123" }],
      });
    } finally {
      manager.close();
    }

    appendFileSync(
      join(migrationsRoot, "project", "0012_project_update_evidence.sql"),
      "\n-- tampered\n",
    );
    await expect(
      openManagedDatabase({
        path: project.databasePath,
        migrationDirectory: join(migrationsRoot, "project"),
        backupDirectory: join(root, "tampered-backups"),
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_HASH_MISMATCH", details: { version: 12 } });
  });
});
