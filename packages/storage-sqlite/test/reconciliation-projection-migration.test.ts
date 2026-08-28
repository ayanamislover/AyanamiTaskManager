import { appendFileSync, copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, openManagedDatabase, ProjectRepository } from "../src/index.js";
import { removeMigrationsAfter } from "./migration-test-helpers.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("v15 reconciliation projection migration", () => {
  it("preserves v14 data and deterministically backfills lifecycle and evidence timestamps", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-reconciliation-projection-migration-"));
    temporary.push(root);
    const dataDir = join(root, "data");
    const migrationsRoot = join(root, "migrations");
    cpSync(resolve(process.cwd(), "migrations"), migrationsRoot, { recursive: true });
    removeMigrationsAfter(migrationsRoot, "project", 14);

    let manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    const project = await manager.createProject({
      name: "v14 reconciliation projection",
      sourcePath: null,
      code: "RPMIG",
    });
    const legacy = await manager.openProject(project.code);
    const repository = new ProjectRepository(legacy);
    const firstSession = repository.createSession({
      agentId: "migration-author",
      displayName: "Migration Author",
      clientKind: "test",
      role: "PRIMARY",
    });
    const secondSession = repository.createSession({
      agentId: "migration-reviewer",
      displayName: "Migration Reviewer",
      clientKind: "test",
      role: "REVIEWER",
    });
    const actor = {
      type: "AGENT" as const,
      id: "migration-author",
      sessionId: firstSession.id,
    };
    const objective = repository.createObjective(actor, {
      title: "Reconcile projection",
      description: "",
      definitionOfDone: [],
    });
    const created = repository.createWorkItems(actor, "reconcile-migration-tasks", [
      {
        clientRef: "history",
        objectiveId: objective.id,
        title: "History-backed task",
        type: "TASK",
        priority: "HIGH",
        status: "IN_PROGRESS",
        checklist: [{ title: "Evidence", evidenceRequired: true }],
      },
      {
        clientRef: "fallback",
        objectiveId: objective.id,
        title: "Started-at fallback task",
        type: "TASK",
        priority: "NORMAL",
        status: "IN_PROGRESS",
      },
      {
        clientRef: "review",
        objectiveId: objective.id,
        parentRef: "history",
        title: "Review task",
        type: "REVIEW",
        priority: "HIGH",
        status: "READY",
      },
    ]);
    const history = repository.getWorkItem(created.items[0]!.key);
    const fallback = repository.getWorkItem(created.items[1]!.key);
    const review = repository.getWorkItem(created.items[2]!.key);
    const checklistId = history.checklist[0]!.id;
    const auditRecord = repository.createRecord(actor, "reconcile-review-record", {
      kind: "VERIFICATION",
      title: "Review evidence",
      summary: "Migration fixture",
      workItemKey: review.key,
    });
    const auditRecordId = (
      legacy.sqlite
        .prepare("SELECT id FROM records WHERE local_no = ?")
        .get(Number(auditRecord.key.match(/(\d+)$/u)![1])) as { id: string }
    ).id;

    const preservedUpdatedAt = "2026-08-27T00:30:00.000Z";
    legacy.sqlite
      .prepare("UPDATE work_items SET started_at = ?, version = 42, updated_at = ? WHERE id = ?")
      .run("2026-08-27T02:00:00.000Z", preservedUpdatedAt, history.id);
    legacy.sqlite
      .prepare("UPDATE work_items SET started_at = ? WHERE id = ?")
      .run("2026-08-27T11:00:00.000Z", fallback.id);
    legacy.sqlite
      .prepare("UPDATE agent_sessions SET closed_at = ? WHERE id = ?")
      .run("2026-08-27T05:00:00.000Z", firstSession.id);
    legacy.sqlite
      .prepare("UPDATE agent_sessions SET closed_at = ? WHERE id = ?")
      .run("2026-08-27T06:00:00.000Z", secondSession.id);

    const insertEvent = legacy.sqlite.prepare(
      `INSERT INTO events(
         id, sequence, type, actor_type, actor_id, session_id, aggregate_type,
         aggregate_id, causation_id, correlation_id, payload_json, created_at, op_id
       ) VALUES (?, ?, ?, 'AGENT', 'migration-author', ?, 'WORK_ITEM', ?, NULL, NULL, '{}', ?, ?)`,
    );
    insertEvent.run(
      "reconcile-claim",
      1001,
      "work.claimed",
      firstSession.id,
      history.id,
      "2026-08-27T01:00:00.000Z",
      "reconcile-claim",
    );
    insertEvent.run(
      "reconcile-start-first",
      1002,
      "work.started",
      firstSession.id,
      history.id,
      "2026-08-27T03:00:00.000Z",
      "reconcile-start-first",
    );
    insertEvent.run(
      "reconcile-start-second",
      1003,
      "work.started",
      secondSession.id,
      history.id,
      "2026-08-27T04:00:00.000Z",
      "reconcile-start-second",
    );

    legacy.sqlite
      .prepare(
        `INSERT INTO progress_updates(
           id, work_item_id, percent, progress_bucket, summary, summary_hash,
           completed_json, next_json, blocker_text, actor, session_id, created_at,
           evidence_json, op_id
         ) VALUES ('reconcile-progress', ?, 50, 50, 'proof', 'hash', '[]', '[]', NULL,
                   'migration-author', ?, ?, '["progress-proof"]', 'reconcile-progress')`,
      )
      .run(history.id, firstSession.id, "2026-08-27T07:00:00.000Z");
    legacy.sqlite
      .prepare(
        "UPDATE checklist_items SET evidence_json = '[\"check-proof\"]', updated_at = ? WHERE id = ?",
      )
      .run("2026-08-27T08:00:00.000Z", checklistId);
    legacy.sqlite
      .prepare(
        `INSERT INTO review_requests(
           id, local_no, review_work_item_id, parent_work_item_id, parent_checklist_id,
           parent_checklist_version, expected_candidate_hashes_json, created_by_agent_id,
           created_by_session_id, created_at, op_id
         ) VALUES ('reconcile-review-request', 1, ?, ?, ?, 0, '[]',
                   'migration-author', ?, ?, 'reconcile-review-request')`,
      )
      .run(review.id, history.id, checklistId, firstSession.id, "2026-08-27T08:30:00.000Z");
    legacy.sqlite
      .prepare(
        `INSERT INTO review_submissions(
           id, local_no, request_id, verdict, reviewed_hashes_json, evidence_json,
           record_id, reviewer_agent_id, reviewer_session_id, review_task_version,
           parent_checklist_version, created_at, op_id
         ) VALUES ('reconcile-review-submission', 1, 'reconcile-review-request', 'APPROVED',
                   '[]', '["review-proof"]', ?, 'migration-reviewer', ?, 0, 0, ?,
                   'reconcile-review-submission')`,
      )
      .run(auditRecordId, secondSession.id, "2026-08-27T09:00:00.000Z");
    legacy.sqlite
      .prepare(
        `INSERT INTO project_updates(
           id, health, summary, completed_json, risks_json, next_json, evidence_json,
           from_sequence, to_sequence, status, actor, published_at, created_at, updated_at,
           op_id, session_id
         ) VALUES ('reconcile-project-update', 'ON_TRACK', 'done', ?, '[]', '[]',
                   '["project-proof"]', 0, 0, 'PUBLISHED', 'migration-author', ?, ?, ?,
                   'reconcile-project-update', ?)`,
      )
      .run(
        JSON.stringify([{ text: "done", workItemKey: history.key }]),
        "2026-08-27T10:00:00.000Z",
        "2026-08-27T10:00:00.000Z",
        "2026-08-27T10:00:00.000Z",
        firstSession.id,
      );
    legacy.sqlite
      .prepare(
        `INSERT INTO project_updates(
           id, health, summary, completed_json, risks_json, next_json, evidence_json,
           from_sequence, to_sequence, status, actor, published_at, created_at, updated_at,
           op_id, session_id
         ) VALUES ('reconcile-legacy-project-update', 'ON_TRACK', 'legacy done', ?, '[]', '[]',
                   '["legacy-project-proof"]', 0, 0, 'PUBLISHED', 'migration-author', ?, ?, ?,
                   'reconcile-legacy-project-update', ?)`,
      )
      .run(
        JSON.stringify([fallback.key, "legacy completion text"]),
        "2026-08-27T10:30:00.000Z",
        "2026-08-27T10:30:00.000Z",
        "2026-08-27T10:30:00.000Z",
        firstSession.id,
      );
    manager.close();

    copyFileSync(
      resolve(process.cwd(), "migrations", "project", "0015_reconciliation_projection.sql"),
      join(migrationsRoot, "project", "0015_reconciliation_projection.sql"),
    );
    manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
    try {
      const upgraded = await manager.openProject(project.code);
      expect(upgraded.schemaVersion).toBe(15);
      expect(upgraded.sqlite.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
      expect(upgraded.sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(
        (upgraded.sqlite.pragma("table_info(work_items)") as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      ).toEqual(
        expect.arrayContaining([
          "ever_claimed_at",
          "last_started_at",
          "last_session_closed_at",
          "last_evidence_at",
        ]),
      );

      const upgradedRepository = new ProjectRepository(upgraded);
      expect(upgradedRepository.getWorkItem(history.key)).toMatchObject({
        everClaimedAt: "2026-08-27T01:00:00.000Z",
        lastStartedAt: "2026-08-27T04:00:00.000Z",
        lastSessionClosedAt: "2026-08-27T06:00:00.000Z",
        lastEvidenceAt: "2026-08-27T10:00:00.000Z",
        version: 42,
        updatedAt: preservedUpdatedAt,
      });
      expect(upgradedRepository.getWorkItem(fallback.key)).toMatchObject({
        everClaimedAt: "2026-08-27T11:00:00.000Z",
        lastStartedAt: "2026-08-27T11:00:00.000Z",
        lastSessionClosedAt: null,
        lastEvidenceAt: null,
      });
      expect(upgradedRepository.getWorkItem(review.key)).toMatchObject({
        everClaimedAt: null,
        lastStartedAt: null,
        lastSessionClosedAt: null,
        lastEvidenceAt: "2026-08-27T09:00:00.000Z",
      });
    } finally {
      manager.close();
    }

    const historical = new Database(project.databasePath);
    historical
      .prepare("UPDATE schema_migrations SET content_sha256 = ? WHERE version = 15")
      .run("046381e8fdfef46a32e0babe85aa49ac0ac2168eb324aaf34d3ce714ad331205");
    historical.close();
    const acceptedHistorical = await openManagedDatabase({
      path: project.databasePath,
      migrationDirectory: join(migrationsRoot, "project"),
      backupDirectory: join(root, "historical-hash-backups"),
    });
    expect(acceptedHistorical.schemaVersion).toBe(15);
    acceptedHistorical.sqlite.close();

    appendFileSync(
      join(migrationsRoot, "project", "0015_reconciliation_projection.sql"),
      "\n-- tampered\n",
    );
    await expect(
      openManagedDatabase({
        path: project.databasePath,
        migrationDirectory: join(migrationsRoot, "project"),
        backupDirectory: join(root, "tampered-backups"),
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_HASH_MISMATCH", details: { version: 15 } });
  });
});
