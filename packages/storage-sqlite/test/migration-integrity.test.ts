import { appendFileSync, cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("迁移完整性", () => {
  for (const legacyVersion of [1, 2, 5]) {
    it(`从 v${legacyVersion} Registry 与项目库升级到当前 schema 并保留数据`, async () => {
      const root = mkdtempSync(join(tmpdir(), `atm-migration-v${legacyVersion}-`));
      temporary.push(root);
      const migrationsRoot = join(root, "migrations");
      cpSync(resolve(process.cwd(), "migrations"), migrationsRoot, { recursive: true });
      for (const scope of ["registry", "project"]) {
        for (const name of readdirSync(join(migrationsRoot, scope))) {
          if (Number(name.slice(0, 4)) > legacyVersion) {
            rmSync(join(migrationsRoot, scope, name));
          }
        }
      }
      const dataDir = join(root, "data");
      let manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
      const project = await manager.createProject({
        name: `v${legacyVersion} 升级保留项`,
        sourcePath: null,
        code: `MV${legacyVersion}`,
      });
      const legacyProject = await manager.openProject(project.code);
      legacyProject.sqlite
        .prepare(
          `INSERT INTO objectives(
             id, local_no, title, description, definition_of_done_json, status,
             weight, version, created_at, updated_at
           ) VALUES ('legacy-objective', 1, ?, '', '[]', 'ACTIVE', 1, 0, ?, ?)`,
        )
        .run(`v${legacyVersion} 目标`, "2026-08-26T00:00:00.000Z", "2026-08-26T00:00:00.000Z");
      manager.close();

      cpSync(resolve(process.cwd(), "migrations"), migrationsRoot, { recursive: true });
      manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
      try {
        expect(manager.registry.schemaVersion).toBe(3);
        const upgraded = await manager.openProject(project.code);
        expect(upgraded.schemaVersion).toBe(11);
        expect(
          upgraded.sqlite
            .prepare("SELECT title FROM objectives WHERE id = ?")
            .get("legacy-objective"),
        ).toEqual({ title: `v${legacyVersion} 目标` });
        expect(upgraded.sqlite.pragma("quick_check") as Array<{ quick_check: string }>).toEqual([
          { quick_check: "ok" },
        ]);
        expect(
          upgraded.sqlite
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get("engineering_project_metrics"),
        ).toEqual({ name: "engineering_project_metrics" });
        expect(
          (upgraded.sqlite.pragma("table_info(agent_sessions)") as Array<{ name: string }>).some(
            (column) => column.name === "git_repo_root",
          ),
        ).toBe(true);
        expect(
          (upgraded.sqlite.pragma("table_info(records)") as Array<{ name: string }>).map(
            (column) => column.name,
          ),
        ).toEqual(expect.arrayContaining(["topic", "subject_key"]));
        expect(upgraded.sqlite.pragma("foreign_key_check")).toEqual([]);
        expect(
          upgraded.sqlite
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('review_requests','review_submissions') ORDER BY name",
            )
            .all(),
        ).toEqual([{ name: "review_requests" }, { name: "review_submissions" }]);
        expect(
          (upgraded.sqlite.pragma("table_info(idempotency_keys)") as Array<{ name: string }>).map(
            (column) => column.name,
          ),
        ).toEqual(expect.arrayContaining(["op_id", "actor_session_id"]));
        expect(
          (upgraded.sqlite.pragma("table_info(work_items)") as Array<{ name: string }>).map(
            (column) => column.name,
          ),
        ).toEqual(
          expect.arrayContaining([
            "phase",
            "waiting_on",
            "phase_inferred",
            "cancel_reason",
            "duplicate_of_id",
            "superseded_by_id",
          ]),
        );
      } finally {
        manager.close();
      }
    });
  }

  it("已应用迁移内容被改写后拒绝重新打开数据库", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-migration-"));
    temporary.push(root);
    const migrationsRoot = join(root, "migrations");
    cpSync(resolve(process.cwd(), "migrations"), migrationsRoot, { recursive: true });
    const dataDir = join(root, "data");
    const manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    manager.close();
    appendFileSync(join(migrationsRoot, "registry", "0001_initial.sql"), "\n-- tampered\n");
    await expect(AyanamiDatabaseManager.open({ dataDir, migrationsRoot })).rejects.toThrowError(
      "MIGRATION_HASH_MISMATCH",
    );
  });
});
