import { copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Session Git context migration", () => {
  it("从 v4 升级时保留旧 Session 并给予 unavailable 默认值", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-session-git-migration-"));
    temporary.push(root);
    const dataDir = join(root, "data");
    const migrationsRoot = join(root, "migrations");
    cpSync(resolve(process.cwd(), "migrations"), migrationsRoot, { recursive: true });
    for (const name of [
      "0005_session_git_context.sql",
      "0006_record_topics.sql",
      "0007_operation_trace.sql",
      "0008_work_item_phase_waiting.sql",
      "0009_structured_cancel.sql",
      "0010_review_workflow.sql",
    ]) {
      rmSync(join(migrationsRoot, "project", name));
    }

    let manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    const project = await manager.createProject({
      name: "Session Git migration",
      sourcePath: null,
      code: "GMIG",
    });
    const database = await manager.openProject(project.code);
    const now = new Date().toISOString();
    database.sqlite
      .prepare(
        `INSERT INTO agents(id, display_name, client_kind, capabilities_json, created_at, updated_at)
         VALUES ('legacy-agent', 'Legacy Agent', 'test', '[]', ?, ?)`,
      )
      .run(now, now);
    database.sqlite
      .prepare(
        `INSERT INTO agent_sessions(
           id, agent_id, role, work_state, connection_state, version, started_at, updated_at
         ) VALUES ('legacy-session', 'legacy-agent', 'PRIMARY', 'IDLE', 'CLOSED', 0, ?, ?)`,
      )
      .run(now, now);
    manager.close();

    for (const name of [
      "0005_session_git_context.sql",
      "0006_record_topics.sql",
      "0007_operation_trace.sql",
      "0008_work_item_phase_waiting.sql",
      "0009_structured_cancel.sql",
      "0010_review_workflow.sql",
    ]) {
      copyFileSync(
        resolve(process.cwd(), "migrations", "project", name),
        join(migrationsRoot, "project", name),
      );
    }
    manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    try {
      const upgraded = await manager.openProject(project.code);
      expect(upgraded.schemaVersion).toBe(10);
      expect(
        upgraded.sqlite
          .prepare(
            `SELECT git_available, git_repo_root, worktree_root, git_common_dir,
                    git_is_linked_worktree, git_detached, git_dirty, git_error
             FROM agent_sessions WHERE id = 'legacy-session'`,
          )
          .get(),
      ).toEqual({
        git_available: 0,
        git_repo_root: null,
        worktree_root: null,
        git_common_dir: null,
        git_is_linked_worktree: null,
        git_detached: null,
        git_dirty: null,
        git_error: null,
      });
    } finally {
      manager.close();
    }
  });
});
