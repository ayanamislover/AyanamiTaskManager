import type Database from "better-sqlite3";
import { computeProgress } from "@ayanami-task/domain";
import { nowIso } from "@ayanami-task/protocol";

export class WorkItemMaintenance {
  readonly #sqlite: Database.Database;
  readonly #projectCode: string;

  constructor(sqlite: Database.Database) {
    this.#sqlite = sqlite;
    this.#projectCode = String(
      (
        sqlite.prepare("SELECT project_code FROM project_meta WHERE singleton = 1").get() as {
          project_code: string;
        }
      ).project_code,
    );
  }

  recordWorkItemLifecycleAt(workItemId: string, at: string, started: boolean): void {
    if (started) {
      this.#sqlite
        .prepare(
          `UPDATE work_items
           SET ever_claimed_at = COALESCE(ever_claimed_at, ?),
               last_started_at = CASE
                 WHEN last_started_at IS NULL OR last_started_at < ? THEN ?
                 ELSE last_started_at
               END
           WHERE id = ?`,
        )
        .run(at, at, at, workItemId);
      return;
    }
    this.#sqlite
      .prepare("UPDATE work_items SET ever_claimed_at = COALESCE(ever_claimed_at, ?) WHERE id = ?")
      .run(at, workItemId);
  }

  advanceWorkItemEvidenceAt(workItemId: string, at: string): void {
    this.#sqlite
      .prepare(
        `UPDATE work_items
         SET last_evidence_at = CASE
           WHEN last_evidence_at IS NULL OR last_evidence_at < ? THEN ?
           ELSE last_evidence_at
         END
         WHERE id = ?`,
      )
      .run(at, at, workItemId);
  }

  resolveActiveBlockers(workItemId: string, now: string): number {
    return this.#sqlite
      .prepare(
        `UPDATE blockers SET status = ?, resolved_at = ?, updated_at = ?, version = version + 1
         WHERE work_item_id = ? AND status = 'ACTIVE'`,
      )
      .run("RESOLVED", now, now, workItemId).changes;
  }

  recomputeWorkItem(id: string): number {
    const row = this.#sqlite.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as any;
    if (!row) return 0;
    const children = this.#sqlite
      .prepare(
        "SELECT computed_progress, weight, status FROM work_items WHERE parent_id = ? AND archived_at IS NULL",
      )
      .all(id) as any[];
    const checklist = this.#sqlite
      .prepare("SELECT status, weight FROM checklist_items WHERE work_item_id = ?")
      .all(id) as any[];
    const progress = computeProgress({
      status: row.status,
      children: children.map((child) => ({
        progress: child.computed_progress,
        weight: child.weight,
        cancelled: child.status === "CANCELLED",
      })),
      checklist: checklist
        .filter((item) => item.status !== "SKIPPED")
        .map((item) => ({ done: item.status === "DONE", weight: item.weight })),
      reported: row.reported_progress,
    });
    this.#sqlite
      .prepare(
        `UPDATE work_items SET computed_progress = ?, progress_source = ?,
         version = version + 1, updated_at = ? WHERE id = ?`,
      )
      .run(progress.value, progress.source, nowIso(), id);
    if (row.parent_id) this.recomputeWorkItem(row.parent_id);
    return progress.value;
  }

  upsertSearchDocument(
    entityType: string,
    entityId: string,
    entityKey: string,
    title: string,
    body: string,
  ): void {
    const now = nowIso();
    this.#sqlite
      .prepare(
        `INSERT INTO search_documents(entity_type, entity_id, entity_key, title, body, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET entity_key = excluded.entity_key,
           title = excluded.title, body = excluded.body, updated_at = excluded.updated_at`,
      )
      .run(entityType, entityId, entityKey, title, body, now);
    this.#sqlite
      .prepare("DELETE FROM search_documents_fts WHERE entity_type = ? AND entity_id = ?")
      .run(entityType, entityId);
    this.#sqlite
      .prepare(
        "INSERT INTO search_documents_fts(entity_type, entity_id, entity_key, title, body) VALUES (?, ?, ?, ?, ?)",
      )
      .run(entityType, entityId, entityKey, title, body);
  }

  refreshWorkItemSearchDocument(workItemId: string): void {
    const row = this.#sqlite
      .prepare("SELECT * FROM work_items WHERE id = ?")
      .get(workItemId) as any;
    if (!row) return;
    const relationRows = this.#sqlite
      .prepare(
        `SELECT relation.source_id, source.local_no AS source_local_no, source.title AS source_title,
                relation.target_id, target.local_no AS target_local_no, target.title AS target_title
         FROM work_item_relations relation
         JOIN work_items source ON source.id = relation.source_id
         JOIN work_items target ON target.id = relation.target_id
         WHERE relation.relation_type = 'DISCOVERED_FROM'
           AND (relation.source_id = ? OR relation.target_id = ?)
         ORDER BY relation.created_at`,
      )
      .all(workItemId, workItemId) as Array<{
      source_id: string;
      source_local_no: number;
      source_title: string;
      target_id: string;
      target_local_no: number;
      target_title: string;
    }>;
    const relationText = relationRows.map((relation) => {
      if (relation.source_id === workItemId) {
        return `工作中发现于 ${this.#projectCode}-T-${String(relation.target_local_no).padStart(4, "0")} ${relation.target_title}`;
      }
      return `工作中发现 ${this.#projectCode}-T-${String(relation.source_local_no).padStart(4, "0")} ${relation.source_title}`;
    });
    this.upsertSearchDocument(
      "WORK_ITEM",
      row.id,
      `${this.#projectCode}-T-${String(row.local_no).padStart(4, "0")}`,
      row.title,
      [row.description, ...relationText].filter(Boolean).join("\n"),
    );
  }
}
