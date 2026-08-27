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

describe("v11 Session close reason migration", () => {
  it("从 v10 添加 typed close reason，旧自由文本不回填并守卫完整性与迁移哈希", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-session-close-reason-migration-"));
    temporary.push(root);
    const dataDir = join(root, "data");
    const migrationsRoot = join(root, "migrations");
    cpSync(resolve(process.cwd(), "migrations"), migrationsRoot, { recursive: true });
    removeMigrationsAfter(migrationsRoot, "project", 10);

    let manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    const project = await manager.createProject({
      name: "v10 close reason",
      sourcePath: null,
      code: "CLOSEMIG",
    });
    const legacy = await manager.openProject(project.code);
    const repository = new ProjectRepository(legacy);
    const session = repository.createSession({
      agentId: "legacy-agent",
      displayName: "Legacy Agent",
      clientKind: "test",
      role: "PRIMARY",
    });
    legacy.sqlite
      .prepare(
        `UPDATE agent_sessions SET connection_state = 'CLOSED',
         retirement_reason = 'startup recovery: heartbeat expired' WHERE id = ?`,
      )
      .run(session.id);
    manager.close();

    copyFileSync(
      resolve(process.cwd(), "migrations", "project", "0011_session_close_reason.sql"),
      join(migrationsRoot, "project", "0011_session_close_reason.sql"),
    );
    manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    try {
      const upgraded = await manager.openProject(project.code);
      expect(upgraded.schemaVersion).toBe(11);
      expect(upgraded.sqlite.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
      expect(upgraded.sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(
        upgraded.sqlite
          .prepare("SELECT close_reason FROM agent_sessions WHERE id = ?")
          .get(session.id),
      ).toEqual({ close_reason: null });

      const upgradedRepository = new ProjectRepository(upgraded);
      const legacyInput = {
        kind: "FACT",
        title: "旧文本不能授权",
        summary: "必须 fail closed",
      };
      expect(
        captureAtmError(() =>
          upgradedRepository.executeSessionMutation(
            session.id,
            "legacy-text-recovery",
            "record.create",
            legacyInput,
            (actor) => upgradedRepository.createRecord(actor, "legacy-text-recovery", legacyInput),
          ),
        ),
      ).toMatchObject({
        code: "SESSION_CLOSED",
        details: { entity: "SESSION", reference: session.id },
      });
      expect(upgradedRepository.listRecords()).toHaveLength(0);

      const recoverable = upgradedRepository.createSession({
        agentId: "typed-agent",
        displayName: "Typed Agent",
        clientKind: "test",
        role: "PRIMARY",
      });
      upgradedRepository.recoverStaleSessions("2999-01-01T00:00:00.000Z");
      expect(upgradedRepository.getSession(recoverable.id).close_reason).toBe("HEARTBEAT_TIMEOUT");
    } finally {
      manager.close();
    }

    appendFileSync(
      join(migrationsRoot, "project", "0011_session_close_reason.sql"),
      "\n-- tampered\n",
    );
    await expect(
      openManagedDatabase({
        path: project.databasePath,
        migrationDirectory: join(migrationsRoot, "project"),
        backupDirectory: join(root, "tampered-backups"),
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_HASH_MISMATCH", details: { version: 11 } });
  });
});
