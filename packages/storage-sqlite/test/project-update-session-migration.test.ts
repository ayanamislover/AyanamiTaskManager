import { appendFileSync, copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, openManagedDatabase, ProjectRepository } from "../src/index.js";
import { removeMigrationsAfter } from "./migration-test-helpers.js";
import { captureAtmError } from "./typed-error-test-helpers.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("v13 project update Session migration", () => {
  it("adds nullable session ownership without guessing legacy rows and guards integrity/hash", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-project-session-migration-"));
    temporary.push(root);
    const dataDir = join(root, "data");
    const migrationsRoot = join(root, "migrations");
    cpSync(resolve(process.cwd(), "migrations"), migrationsRoot, { recursive: true });
    removeMigrationsAfter(migrationsRoot, "project", 12);

    let manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    const project = await manager.createProject({
      name: "v12 project update Session",
      sourcePath: null,
      code: "PUSMIG",
    });
    const legacy = await manager.openProject(project.code);
    const legacyRepository = new ProjectRepository(legacy);
    const session = legacyRepository.createSession({
      agentId: "project-session-agent",
      displayName: "Project Session Agent",
      clientKind: "test",
      role: "PRIMARY",
    });
    const otherSession = legacyRepository.createSession({
      agentId: "other-session-agent",
      displayName: "Other Session Agent",
      clientKind: "test",
      role: "SUBAGENT",
    });
    const now = "2026-08-27T01:00:00.000Z";
    legacy.sqlite
      .prepare(
        `INSERT INTO project_updates(
           id, health, summary, completed_json, risks_json, next_json, evidence_json,
           from_sequence, to_sequence, status, actor, published_at, created_at, updated_at, op_id
         ) VALUES ('legacy-project-update', 'ON_TRACK', 'legacy', '[]', '[]', '[]', '[]',
                   0, 0, 'PUBLISHED', 'project-session-agent', ?, ?, ?, 'shared-project-op')`,
      )
      .run(now, now, now);
    manager.close();

    copyFileSync(
      resolve(process.cwd(), "migrations", "project", "0013_project_update_session.sql"),
      join(migrationsRoot, "project", "0013_project_update_session.sql"),
    );
    manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    try {
      const upgraded = await manager.openProject(project.code);
      expect(upgraded.schemaVersion).toBe(13);
      expect(upgraded.sqlite.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
      expect(upgraded.sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(
        upgraded.sqlite
          .prepare("SELECT session_id FROM project_updates WHERE id = 'legacy-project-update'")
          .get(),
      ).toEqual({ session_id: null });

      const repository = new ProjectRepository(upgraded);
      expect(
        captureAtmError(() => repository.getOperationTrace("shared-project-op", session.id)),
      ).toMatchObject({
        code: "OPERATION_NOT_FOUND",
        details: { entity: "OPERATION", reference: "shared-project-op" },
      });
      const published = repository.publishProjectUpdate(
        { type: "AGENT", id: "project-session-agent", sessionId: session.id },
        "shared-project-op",
        { health: "ON_TRACK", summary: "new owned update" },
      );
      expect(repository.getProjectUpdate(published.id)).toMatchObject({
        sessionId: session.id,
      });
      expect(repository.getOperationTrace("shared-project-op", session.id)).toMatchObject({
        projectUpdates: [{ id: published.id, sessionId: session.id }],
      });
      expect(
        captureAtmError(() => repository.getOperationTrace("shared-project-op", otherSession.id)),
      ).toMatchObject({
        code: "OPERATION_NOT_FOUND",
        details: { entity: "OPERATION", reference: "shared-project-op" },
      });
    } finally {
      manager.close();
    }

    appendFileSync(
      join(migrationsRoot, "project", "0013_project_update_session.sql"),
      "\n-- tampered\n",
    );
    await expect(
      openManagedDatabase({
        path: project.databasePath,
        migrationDirectory: join(migrationsRoot, "project"),
        backupDirectory: join(root, "tampered-backups"),
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_HASH_MISMATCH", details: { version: 13 } });
  });
});
