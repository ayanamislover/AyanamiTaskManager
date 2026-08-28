import { copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openManagedDatabase } from "../src/database.js";
import { AyanamiDatabaseManager } from "../src/manager.js";
import { removeMigrationsAfter } from "./migration-test-helpers.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("Registry v5 projection reliability migration", () => {
  it("backfills state and only assigns the oldest historical duplicate a dedupe key", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-projection-v5-migration-"));
    temporary.push(root);
    const migrationsRoot = join(root, "migrations");
    cpSync(resolve(process.cwd(), "migrations"), migrationsRoot, { recursive: true });
    removeMigrationsAfter(migrationsRoot, "registry", 4);
    const dataDir = join(root, "data");
    const manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    const project = await manager.createProject({
      name: "v4 projection state",
      sourcePath: null,
      code: "PV4",
    });
    const payload = JSON.stringify({ projectId: project.id, sourceEventId: "source-event-1" });
    manager.registry.sqlite.transaction(() => {
      const insert = manager.registry.sqlite.prepare(
        `INSERT INTO global_events(
           sequence, type, aggregate_id, actor, payload_json, created_at
         ) VALUES (?, 'objective.created', ?, 'SYSTEM', ?, ?)`,
      );
      insert.run(100, project.id, payload, "2026-08-27T00:00:00.000Z");
      insert.run(101, project.id, payload, "2026-08-27T00:00:01.000Z");
      insert.run(102, project.id, "{malformed", "2026-08-27T00:00:02.000Z");
      manager.registry.sqlite
        .prepare("UPDATE app_meta SET current_sequence = 102 WHERE singleton = 1")
        .run();
      manager.registry.sqlite
        .prepare("UPDATE project_summary_cache SET project_sequence = 7 WHERE project_id = ?")
        .run(project.id);
    })();
    manager.close();

    copyFileSync(
      resolve(process.cwd(), "migrations", "registry", "0005_projection_reliability.sql"),
      join(migrationsRoot, "registry", "0005_projection_reliability.sql"),
    );
    const upgraded = await openManagedDatabase({
      path: join(dataDir, "registry", "registry.sqlite"),
      migrationDirectory: join(migrationsRoot, "registry"),
      backupDirectory: join(dataDir, "backups", "registry"),
    });
    try {
      expect(upgraded.schemaVersion).toBe(5);
      expect(
        upgraded.sqlite
          .prepare(
            `SELECT source_sequence, projected_sequence, status, last_error, retry_count
             FROM project_projection_state WHERE project_id = ?`,
          )
          .get(project.id),
      ).toEqual({
        source_sequence: 7,
        projected_sequence: 7,
        status: "APPLIED",
        last_error: null,
        retry_count: 0,
      });
      expect(
        upgraded.sqlite
          .prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN dedupe_key IS NOT NULL THEN 1 ELSE 0 END) AS keyed
             FROM global_events WHERE sequence IN (100, 101)`,
          )
          .get(),
      ).toEqual({ total: 2, keyed: 1 });
      expect(
        upgraded.sqlite
          .prepare("SELECT payload_json, dedupe_key FROM global_events WHERE sequence = 102")
          .get(),
      ).toEqual({ payload_json: "{malformed", dedupe_key: null });
      expect(
        upgraded.sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_global_events_dedupe_key'",
          )
          .get(),
      ).toEqual({ name: "idx_global_events_dedupe_key" });

      for (const statement of [
        "UPDATE project_projection_state SET source_sequence = -1 WHERE project_id = ?",
        "UPDATE project_projection_state SET projected_sequence = -1 WHERE project_id = ?",
        "UPDATE project_projection_state SET retry_count = -1 WHERE project_id = ?",
        `UPDATE project_projection_state SET status = 'APPLIED', projected_sequence = 6
         WHERE project_id = ?`,
      ]) {
        expect(() => upgraded.sqlite.prepare(statement).run(project.id)).toThrow();
      }
    } finally {
      upgraded.sqlite.close();
    }
  });

  it("seeds a new project at an exact APPLIED 0/0 state", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-projection-v5-seed-"));
    temporary.push(root);
    const manager = await AyanamiDatabaseManager.open({
      dataDir: root,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await manager.createProject({
        name: "Projection seed",
        sourcePath: null,
        code: "SEED",
      });
      expect(
        manager.registry.sqlite
          .prepare(
            `SELECT source_sequence, projected_sequence, status, retry_count
             FROM project_projection_state WHERE project_id = ?`,
          )
          .get(project.id),
      ).toEqual({
        source_sequence: 0,
        projected_sequence: 0,
        status: "APPLIED",
        retry_count: 0,
      });
    } finally {
      manager.close();
    }
  });
});
