import { appendFileSync, copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, openManagedDatabase, ProjectRepository } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("v10 Review workflow migration", () => {
  it("从 v9 添加 request/submission 审计表、计数器并守卫完整性与迁移哈希", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-review-workflow-migration-"));
    temporary.push(root);
    const dataDir = join(root, "data");
    const migrationsRoot = join(root, "migrations");
    cpSync(resolve(process.cwd(), "migrations"), migrationsRoot, { recursive: true });
    rmSync(join(migrationsRoot, "project", "0010_review_workflow.sql"));

    let manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    const project = await manager.createProject({
      name: "v9 Review workflow",
      sourcePath: null,
      code: "RVMIG",
    });
    const legacy = await manager.openProject(project.code);
    const repository = new ProjectRepository(legacy);
    const session = repository.createSession({
      agentId: "migration-author",
      displayName: "Migration Author",
      clientKind: "test",
      role: "PRIMARY",
    });
    const actor = { type: "AGENT" as const, id: "migration-author", sessionId: session.id };
    const objective = repository.createObjective(actor, {
      title: "Review 迁移",
      description: "",
      definitionOfDone: [],
    });
    const created = repository.createWorkItems(actor, "migration-review-tasks", [
      {
        clientRef: "parent",
        objectiveId: objective.id,
        title: "候选实现",
        type: "TASK",
        priority: "HIGH",
        status: "IN_PROGRESS",
        checklist: [{ title: "Review approved", evidenceRequired: true }],
      },
      {
        clientRef: "review",
        objectiveId: objective.id,
        parentRef: "parent",
        title: "独立 Review",
        type: "REVIEW",
        priority: "CRITICAL",
        status: "READY",
        assigneeAgentId: "migration-reviewer",
      },
    ]);
    const parent = repository.getWorkItem(created.items[0]!.key);
    manager.close();

    copyFileSync(
      resolve(process.cwd(), "migrations", "project", "0010_review_workflow.sql"),
      join(migrationsRoot, "project", "0010_review_workflow.sql"),
    );
    manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    try {
      const upgraded = await manager.openProject(project.code);
      expect(upgraded.schemaVersion).toBe(10);
      expect(upgraded.sqlite.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
      expect(upgraded.sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(
        upgraded.sqlite
          .prepare("SELECT name FROM counters WHERE name LIKE 'review_%' ORDER BY name")
          .all(),
      ).toEqual([{ name: "review_request" }, { name: "review_submission" }]);
      const upgradedRepository = new ProjectRepository(upgraded);
      const request = upgradedRepository.createReviewRequest(actor, "migration-review-request", {
        reviewTaskKey: created.items[1]!.key,
        expectedReviewTaskVersion: created.items[1]!.version,
        parentChecklistId: parent.checklist[0]!.id,
        expectedParentChecklistVersion: parent.checklist[0]!.version,
        expectedCandidateHashes: [{ name: "git_head", value: "a".repeat(40) }],
      });
      expect(upgradedRepository.getReviewRequest(request.request.key)).toMatchObject({
        key: "RVMIG-RR-0001",
        reviewTaskKey: created.items[1]!.key,
        parentTaskKey: created.items[0]!.key,
      });
    } finally {
      manager.close();
    }

    appendFileSync(join(migrationsRoot, "project", "0010_review_workflow.sql"), "\n-- tampered\n");
    await expect(
      openManagedDatabase({
        path: project.databasePath,
        migrationDirectory: join(migrationsRoot, "project"),
        backupDirectory: join(root, "tampered-backups"),
      }),
    ).rejects.toThrowError("MIGRATION_HASH_MISMATCH: 10");
  });
});
